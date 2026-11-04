import config from "../../config/sync.config.json" with { type: "json" };
import { maskPhone, sendSmsCampaign } from "../../src/sms.mjs";
import { RuijieConsole } from "./console.mjs";
import { createRuijieClient } from "./ruijie.mjs";
import { createBudget, formatError, log, requiredEnv, splitList } from "./shared.mjs";

// Blocks devices that use the hotspot without paying, through the Ruijie web
// console's per-site Wi-Fi blocklist. Runs every 20 minutes.
//
// A device on a portal SSID is treated as paid only when its MAC signed in on
// the portal in the last 7 days (the longest voucher) with a voucher that is
// still active: in use (status 2) and not past its expiry time. A device whose
// voucher has expired counts as unpaid.
// - Never had a voucher: blocked once it has used 20 MB or is moving more than
//   50 kbps right now (the portal alone shouldn't let it do either).
// - Had a voucher that has now expired: blocked only if it is moving more than
//   50 kbps right now. Its data counter includes time it paid for, and a device
//   that is just sitting on the portal must still be able to buy a new voucher.
//
// On SSIDs without the portal (password networks such as QikCam), at most
// MAX_PASSWORD_DEVICES devices are allowed; newer extra devices are blocked.
//
// Every MAC this job blocks is recorded in KV and released at 00:00
// Africa/Harare. MACs blocked by hand in the console are never touched.

export const BLOCKER_STATE_KEY = "blocker-state";
export const BLOCKER_REPORT_KEY = "last-blocker-report";
export const BLOCKER_DAY_REPORT_KEY = "last-blocker-day-report";

export const RULES = {
  paidWindowDays: 7,
  minDataBytes: 20 * 1024 * 1024,
  liveRateBps: 50_000,
  liveRateMinConnectedMinutes: 10,
  maxPasswordDevices: 2,
  // Safety stop: if a site suddenly shows more than this many devices to block,
  // something is probably wrong with the data, so the site is skipped.
  maxBlocksPerSitePerRun: 12,
  portalSsidCacheHours: 6,
};

const HARARE_OFFSET_MINUTES = 120;

export async function runBlocker(env, { live, release = false, fetchImpl = fetch, now = () => new Date() } = {}) {
  const budget = createBudget(undefined, fetchImpl);
  const startedAt = now();
  const report = {
    checkedAt: startedAt.toISOString(),
    live,
    released: [],
    blocked: [],
    wouldBlock: [],
    sites: [],
    errors: [],
    subrequests: 0,
  };
  const state = (await env.STATE.get(BLOCKER_STATE_KEY, "json")) ?? emptyState();
  const allowList = new Set(splitList(env.BLOCKER_ALLOW_MACS).map(normaliseMac));

  try {
    const ruijie = new RuijieConsole({
      user: requiredEnv(env, "RUIJIE_WEB_USER"),
      password: requiredEnv(env, "RUIJIE_WEB_PASSWORD"),
      baseUrl: env.RUIJIE_API_BASE_URL,
      fetchImpl: budget.fetch,
    });
    await ruijie.login();
    const openApi = createRuijieClient({
      baseUrl: env.RUIJIE_API_BASE_URL,
      appId: requiredEnv(env, "RUIJIE_API_APP_ID"),
      secret: requiredEnv(env, "RUIJIE_API_SECRET"),
      fetchImpl: budget.fetch,
      retryDelayMs: env.RETRY_DELAY_MS == null ? 1_500 : Number(env.RETRY_DELAY_MS),
    });

    // 1. At 00:00 Harare, release everything this job blocked during the day.
    if (release || state.pendingRelease?.length) {
      if (release) {
        state.pendingRelease = [...(state.pendingRelease ?? []), ...Object.values(state.blocked ?? {})];
        state.blocked = {};
      }
      const still = [];
      for (const entry of state.pendingRelease) {
        if (budget.remaining() < 6) {
          still.push(entry);
          continue;
        }
        if (!live) {
          report.released.push({ ...entry, dryRun: true });
          continue;
        }
        try {
          const result = await ruijie.api(`/enet/conf/group/${entry.groupId}/mac_filter`, {
            method: "DELETE",
            querys: { group_id: entry.groupId, mac: dottedMac(entry.mac), type: "global" },
          });
          if (result.code !== 0 && !/not exist|no data/i.test(result.msg ?? "")) throw new Error(result.msg ?? `code ${result.code}`);
          report.released.push(entry);
        } catch (error) {
          report.errors.push({ site: entry.site, mac: entry.mac, message: `Release failed: ${formatError(error)}` });
          still.push(entry);
        }
      }
      state.pendingRelease = still;
    }

    // 2. Check every site.
    const sites = await listSites(ruijie);
    for (const site of sites) {
      if (budget.remaining() < 5) {
        report.errors.push({ site: site.name, message: "Skipped: out of request budget for this run." });
        continue;
      }
      try {
        const summary = await checkSite(ruijie, openApi, site, { state, allowList, now: startedAt });
        report.sites.push(summary.site);
        const targets = summary.targets;
        if (!targets.length) continue;
        if (!live) {
          report.wouldBlock.push(...targets);
          continue;
        }
        const result = await ruijie.api(`/enet/conf/group/${site.groupId}/mac_filter`, {
          method: "POST",
          params: { type: "deny", macList: targets.map((target) => ({ mac: colonMac(target.mac) })) },
        });
        if (result.code !== 0) throw new Error(result.msg ?? `code ${result.code}`);
        for (const target of targets) {
          state.blocked[`${site.groupId}:${target.mac}`] = target;
          report.blocked.push(target);
        }
      } catch (error) {
        report.errors.push({ site: site.name, message: formatError(error) });
      }
    }
  } catch (error) {
    report.errors.push({ message: formatError(error) });
  }

  // Keep a running tally for the day-end report.
  state.day.blocked.push(...report.blocked.map(({ site, mac, reason, ssid }) => ({ site, mac, reason, ssid, at: report.checkedAt })));
  state.day.runs += 1;
  if (report.errors.length) state.day.errors += report.errors.length;

  report.subrequests = budget.used;
  await env.STATE.put(BLOCKER_STATE_KEY, JSON.stringify(state));
  await env.STATE.put(BLOCKER_REPORT_KEY, JSON.stringify(report));
  log(`Blocker: ${report.blocked.length} blocked, ${report.wouldBlock.length} would block, ${report.released.length} released, ${report.errors.length} error(s), ${budget.used} requests.`);
  return report;
}

// Builds the day-end summary, sends it as one SMS if configured, and starts a new day.
export async function finishBlockerDay(env, { sendSms, fetchImpl = fetch, now = () => new Date() } = {}) {
  const state = (await env.STATE.get(BLOCKER_STATE_KEY, "json")) ?? emptyState();
  const day = state.day;
  const bySite = {};
  for (const entry of day.blocked) bySite[entry.site] = (bySite[entry.site] ?? 0) + 1;
  const summary = {
    day: day.date,
    finishedAt: now().toISOString(),
    totalBlocked: day.blocked.length,
    bySite,
    runs: day.runs,
    errors: day.errors,
    blocked: day.blocked,
  };
  const lines = Object.entries(bySite).sort((a, b) => b[1] - a[1]).map(([site, count]) => `${site}: ${count}`);
  summary.message = [
    `QikNet blocker report ${day.date}`,
    `Non-paying devices blocked: ${day.blocked.length}`,
    ...(lines.length ? lines : ["No devices blocked."]),
    day.errors ? `Errors during the day: ${day.errors}` : null,
    "All blocks released at 00:00.",
  ].filter(Boolean).join("\n");

  if (sendSms) {
    try {
      const recipient = String(env.BLOCKER_REPORT_RECIPIENT || requiredEnv(env, "STOCK_REPORT_RECIPIENT")).trim();
      await sendSmsCampaign({
        token: requiredEnv(env, "SMSPOP_TOKEN"),
        campaignUrl: config.sms.campaignUrl,
        senderId: config.sms.senderId,
        recipient,
        campaignName: `QikNet Blocker Report ${day.date}`,
        message: summary.message,
        retries: 2,
        retryDelayMs: Number(env.RETRY_DELAY_MS ?? 5_000),
        fetchImpl,
      });
      summary.sms = { recipient: maskPhone(recipient), status: "sent" };
    } catch (error) {
      summary.sms = { status: "failed", message: formatError(error) };
    }
  }

  state.day = newDay(now());
  await env.STATE.put(BLOCKER_STATE_KEY, JSON.stringify(state));
  await env.STATE.put(BLOCKER_DAY_REPORT_KEY, JSON.stringify(summary));
  return summary;
}

async function listSites(ruijie) {
  const result = await ruijie.api("/maint/network/common/list?page_index=1&page_size=100", { querys: { version: 1 } });
  if (result.code !== 0) throw new Error(`Project list failed: ${result.msg}`);
  return (result.dataList ?? []).map((project) => ({
    groupId: project.buildingId,
    name: String(project.name).replace(/^QikNet HotSpot \d+:\s*/i, ""),
    online: Number(project.onCount ?? 0) > 0,
  }));
}

async function checkSite(ruijie, openApi, site, { state, allowList, now }) {
  const summary = { name: site.name, online: 0, paid: 0, unpaid: 0, toBlock: 0 };
  if (!site.online) return { site: { ...summary, skipped: "AP offline" }, targets: [] };

  const current = await ruijie.api("/network/current/user/global/page", {
    module: "logbiz",
    querys: { group_id: site.groupId, page_index: 1, page_size: 200 },
  });
  if (current.code !== 0) throw new Error(`Client list failed: ${current.msg}`);
  const clients = current.list ?? [];
  summary.online = clients.length;
  if (!clients.length) return { site: summary, targets: [] };

  const portalSsids = await portalSsidsFor(ruijie, site, state, now);
  if (!portalSsids.length) throw new Error("No portal SSID found; skipping this site to be safe.");

  const since = new Date(now.getTime() - RULES.paidWindowDays * 86_400_000);
  const auth = await ruijie.api("/samTransfer/authuserinfos/bypage", {
    method: "POST",
    params: {
      group_id: site.groupId,
      tenant_name: ruijie.user,
      page: 1,
      size: 1000,
      login_time: harareTimestamp(since),
      login_time_end: "",
    },
  });
  const records = auth?.data?.result?.list;
  if (auth.code !== 0 || !Array.isArray(records)) throw new Error(`Voucher sign-in list failed: ${auth.msg ?? "no data"}`);
  const total = Number(auth.data.result.total ?? records.length);
  if (total > records.length) throw new Error(`Voucher sign-in list was cut short (${records.length} of ${total}); skipping to be safe.`);
  const active = await activeVoucherCodes(openApi, site.groupId, now);
  const paidMacs = new Set(
    records.filter((record) => active.has(String(record.account ?? "").toLowerCase())).map((record) => normaliseMac(record.userMac)),
  );

  const expiredMacs = new Set(records.map((record) => normaliseMac(record.userMac)).filter((mac) => !paidMacs.has(mac)));
  const decision = decideTargets(clients, { site, portalSsids, paidMacs, expiredMacs, allowList, alreadyBlocked: state.blocked ?? {}, now });
  Object.assign(summary, decision.counts);
  if (decision.targets.length > RULES.maxBlocksPerSitePerRun) {
    throw new Error(`${decision.targets.length} devices to block is above the safety limit of ${RULES.maxBlocksPerSitePerRun}; nothing blocked at this site.`);
  }
  return { site: summary, targets: decision.targets };
}

// Pure decision logic, kept separate so it can be tested.
export function decideTargets(clients, { site, portalSsids, paidMacs, expiredMacs = new Set(), allowList, alreadyBlocked = {}, now }) {
  const counts = { paid: 0, unpaid: 0, toBlock: 0 };
  const targets = [];
  const portal = new Set(portalSsids);
  const bySsid = new Map();
  for (const client of clients) {
    const ssid = String(client.ssid ?? "");
    if (!bySsid.has(ssid)) bySsid.set(ssid, []);
    bySsid.get(ssid).push(client);
  }

  for (const [ssid, group] of bySsid) {
    if (portal.has(ssid)) {
      for (const client of group) {
        const mac = normaliseMac(client.mac);
        if (paidMacs.has(mac)) {
          counts.paid += 1;
          continue;
        }
        counts.unpaid += 1;
        if (allowList.has(mac) || alreadyBlocked[`${site.groupId}:${mac}`]) continue;
        const usedBytes = Number(client.flowUpDown ?? 0);
        const rate = Math.max(Number(client.downRate ?? 0), Number(client.upRate ?? 0));
        const connectedMinutes = client.onlineTime ? (now.getTime() - Number(client.onlineTime)) / 60_000 : 0;
        const expired = expiredMacs.has(mac);
        const label = expired ? "voucher expired" : "no voucher";
        const reasons = [];
        if (!expired && usedBytes >= RULES.minDataBytes) reasons.push(`used ${Math.round(usedBytes / 1048576)} MB, ${label}`);
        if (rate > RULES.liveRateBps && connectedMinutes >= RULES.liveRateMinConnectedMinutes) {
          reasons.push(`${Math.round(rate / 1000)} kbps right now, ${label}`);
        }
        if (reasons.length) targets.push(target(site, client, mac, ssid, reasons.join(", ")));
      }
    } else if (ssid) {
      // Password network without the portal: keep the oldest devices, block the rest.
      const ordered = [...group].sort((a, b) => Number(a.onlineTime ?? 0) - Number(b.onlineTime ?? 0));
      const allowed = ordered.filter((client) => allowList.has(normaliseMac(client.mac)));
      const others = ordered.filter((client) => !allowList.has(normaliseMac(client.mac)));
      const room = Math.max(0, RULES.maxPasswordDevices - allowed.length);
      for (const client of others.slice(room)) {
        const mac = normaliseMac(client.mac);
        if (alreadyBlocked[`${site.groupId}:${mac}`]) continue;
        targets.push(target(site, client, mac, ssid, `more than ${RULES.maxPasswordDevices} devices on ${ssid}`));
      }
    }
  }
  counts.toBlock = targets.length;
  return { counts, targets };
}

function target(site, client, mac, ssid, reason) {
  return {
    site: site.name,
    groupId: site.groupId,
    mac,
    ssid,
    name: client.terminalName || client.userName || "",
    usedMb: Math.round(Number(client.flowUpDown ?? 0) / 1048576),
    reason,
  };
}

// Vouchers that are in use (status 2) and not yet expired. A voucher without an
// expiry time (such as Staff) counts as active.
async function activeVoucherCodes(openApi, groupId, now) {
  openApi.identity ??= openApi.request("/service/api/org/account/info");
  const identity = await openApi.identity;
  if (!identity.account) throw new Error("Ruijie API account lookup failed.");
  const result = await openApi.request(
    `/service/api/intlSamVoucher/getList/${encodeURIComponent(identity.account)}/${encodeURIComponent(groupId)}`,
    { params: { start: 0, pageSize: 1000, status: 2 } },
  );
  const list = result.voucherData?.list;
  if (!Array.isArray(list)) throw new Error("Active voucher list was missing; skipping this site to be safe.");
  return activeCodes(list, now);
}

export function activeCodes(list, now) {
  return new Set(
    list
      .filter((voucher) => Number(voucher.status) === 2 && !(Number(voucher.expiryTime) > 0 && Number(voucher.expiryTime) <= now.getTime()))
      .map((voucher) => String(voucher.voucherCode ?? "").toLowerCase())
      .filter(Boolean),
  );
}

async function portalSsidsFor(ruijie, site, state, now) {
  const cached = state.portalSsids?.[site.groupId];
  if (cached && now.getTime() - cached.at < RULES.portalSsidCacheHours * 3_600_000) return cached.ssids;
  const ability = await ruijie.api(`/intl/auth/v2/ability/${site.groupId}`, { querys: { show_temp_nbr: 1 } });
  if (ability.code !== 0) throw new Error(`Portal settings lookup failed: ${ability.msg}`);
  const ssids = [];
  for (const binding of ability.data?.bindingInfoList ?? []) {
    for (const detail of binding.configDetailList ?? []) if (detail.ssidName) ssids.push(detail.ssidName);
  }
  state.portalSsids = { ...(state.portalSsids ?? {}), [site.groupId]: { at: now.getTime(), ssids } };
  return ssids;
}

function emptyState(at = new Date()) {
  return { blocked: {}, pendingRelease: [], portalSsids: {}, day: newDay(at) };
}

function newDay(at) {
  return { date: harareDate(at), blocked: [], runs: 0, errors: 0 };
}

// True for the run that lands on 00:00 Africa/Harare (22:00 UTC).
export function isHarareMidnight(date) {
  const harare = new Date(date.getTime() + HARARE_OFFSET_MINUTES * 60_000);
  return harare.getUTCHours() === 0 && harare.getUTCMinutes() < 5;
}

function harareDate(date) {
  return new Date(date.getTime() + HARARE_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

function harareTimestamp(date) {
  return new Date(date.getTime() + HARARE_OFFSET_MINUTES * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

export function normaliseMac(mac) {
  return String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

function dottedMac(mac) {
  const hex = normaliseMac(mac);
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

function colonMac(mac) {
  return normaliseMac(mac).match(/../g).join(":");
}

