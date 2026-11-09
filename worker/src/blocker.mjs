import config from "../../config/sync.config.json" with { type: "json" };
import { maskPhone, sendSmsCampaign } from "../../src/sms.mjs";
import { RuijieConsole } from "./console.mjs";
import { createBudget, formatError, log, requiredEnv, splitList } from "./shared.mjs";

// Blocks devices that use the hotspot without paying, through the Ruijie web
// console's per-site Wi-Fi blocklist. Runs every 5 minutes.
//
// A device on a portal SSID is treated as paid only when its MAC signed in on
// the portal in the last 7 days (the longest voucher) with a voucher that is
// still active: in use (status 2) and not past its expiry time. A device whose
// voucher has expired counts as unpaid, unless it expired less than 12 hours
// ago (grace period for recent customers).
// - Never had a voucher: blocked once it has used 10 MB or is moving more than
//   50 kbps right now (the portal alone shouldn't let it do either).
// - Had a voucher that has now expired: blocked only if it is moving more than
//   50 kbps right now. Its data counter includes time it paid for, and a device
//   that is just sitting on the portal must still be able to buy a new voucher.
//
// A portal sign-in still shown online 1 hour or more after its voucher expired
// is kicked off (the console's "Kick Offline"), so the device must enter a new
// voucher. Kicking only ends the portal session; it doesn't block the device.
//
// On SSIDs without the portal (password networks such as QikCam), at most
// MAX_PASSWORD_DEVICES devices are allowed; newer extra devices are blocked.
//
// Every MAC this job blocks is recorded in KV with how many times it has been
// blocked. The block is lifted after 12 hours the first time, 24 hours the
// second, 48 hours the third and 72 hours from then on
// Africa/Harare. MACs blocked by hand in the console are never touched.

export const BLOCKER_STATE_KEY = "blocker-state";
export const BLOCKER_REPORT_KEY = "last-blocker-report";
export const BLOCKER_DAY_REPORT_KEY = "last-blocker-day-report";

export const RULES = {
  paidWindowDays: 7,
  // Grace period: a device whose voucher expired less than this long ago is
  // still treated as a customer (Ruijie can take a while to cut expired
  // vouchers off).
  expiryGraceHours: 12,
  // A portal sign-in that is still online this long after its voucher expired
  // is kicked off, so the device has to enter a new voucher to get back on.
  kickAfterExpiryHours: 1,
  maxKicksPerSitePerRun: 5,
  // Most expired-voucher lookups per site per run; devices past the limit are
  // left alone this run rather than blocked blind.
  maxExpiryLookupsPerSite: 4,
  minDataBytes: 10 * 1024 * 1024,
  // Devices blocked before (offence on record) get a much lower limit: they
  // have shown they can get online without a voucher.
  repeatOffenderDataBytes: 2 * 1024 * 1024,
  liveRateBps: 50_000,
  liveRateMinConnectedMinutes: 10,
  maxPasswordDevices: 2,
  // Safety stop: if a site suddenly shows more than this many devices to block,
  // something is probably wrong with the data, so the site is skipped.
  maxBlocksPerSitePerRun: 25,
  // Most blocks added per site per run, heaviest users first.
  blocksPerSitePerRun: 12,
  portalSsidCacheHours: 6,
  // How long a block lasts, by how many times the device has been blocked:
  // 1st 12 h, 2nd 24 h, 3rd 48 h, 4th and later 72 h (the maximum).
  blockHours: [12, 24, 48, 72],
  // A device's offence count is forgotten after this many days without one.
  offenceMemoryDays: 30,
  // Requests kept back from releases so blocking carries on while a big batch
  // of releases is spread over several runs.
  siteCheckReserve: 30,
  loginPauseMinutes: 30,
  // Health alert: one SMS after this many runs in a row with errors (15 min),
  // and one SMS when a run is clean again.
  alertAfterFailedRuns: 3,
};

const HARARE_OFFSET_MINUTES = 120;

export async function runBlocker(env, { live, fetchImpl = fetch, now = () => new Date() } = {}) {
  const budget = createBudget(undefined, fetchImpl);
  const startedAt = now();
  const report = {
    checkedAt: startedAt.toISOString(),
    live,
    released: [],
    kicked: [],
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
    // Reuse the console session between runs so the job doesn't sign in every
    // 5 minutes; sign in again only when the session has expired.
    // A rejected password is never retried straight away: repeated failures
    // can lock the account. Sign-in waits loginPauseMinutes after a rejection.
    const signIn = async () => {
      if (state.loginPausedUntil && Date.parse(state.loginPausedUntil) > startedAt.getTime()) {
        throw new Error(`Ruijie sign-in paused until ${state.loginPausedUntil} after the password was rejected.`);
      }
      try {
        await ruijie.login();
        delete state.loginPausedUntil;
      } catch (error) {
        if (/rejected the sign-in|two-factor/i.test(error.message)) {
          state.loginPausedUntil = new Date(startedAt.getTime() + RULES.loginPauseMinutes * 60_000).toISOString();
        }
        throw error;
      }
    };
    if (state.session?.cookies) ruijie.importCookies(state.session.cookies);
    else await signIn();
    try {
      await ruijie.ensureSession();
    } catch (error) {
      if (!error.sessionExpired) throw error;
      ruijie.cookies.clear();
      await signIn();
    }
    if (ruijie.loggedInThisRun) state.session = { cookies: ruijie.exportCookies(), at: now().toISOString() };

    // First run with offence counts: seed them from the days already on record
    // (each day a device was blocked counts once).
    if (!state.offences) {
      const lastDay = await env.STATE.get(BLOCKER_DAY_REPORT_KEY, "json");
      state.offences = seedOffences([...(lastDay?.blocked ?? []), ...(state.day.blocked ?? [])]);
    }
    for (const entry of Object.values(state.blocked ?? {})) {
      if (entry.releaseAt) continue;
      state.offences[entry.mac] ??= { count: 1, last: startedAt.toISOString() };
      // Time is counted from now, so an existing block lasts its full length.
      entry.offence = state.offences[entry.mac].count;
      entry.releaseAt = new Date(startedAt.getTime() + blockHours(entry.offence) * 3_600_000).toISOString();
    }
    const forgetBefore = new Date(startedAt.getTime() - RULES.offenceMemoryDays * 86_400_000).toISOString();
    for (const [mac, offence] of Object.entries(state.offences)) if (offence.last < forgetBefore) delete state.offences[mac];

    // 1. Release the blocks that have served their time.
    const { due, keep } = dueBlocks(state.blocked ?? {}, startedAt);
    if (due.length) {
      state.pendingRelease = [...(state.pendingRelease ?? []), ...due];
      state.blocked = keep;
    }
    if (state.pendingRelease?.length) {
      const still = [];
      for (const entry of state.pendingRelease) {
        // Leave enough requests to still check every site this run.
        if (budget.remaining() < RULES.siteCheckReserve) {
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
    const sites = ruijie.sites ?? (await listSites(ruijie));
    for (const site of sites) {
      if (budget.remaining() < 5) {
        report.errors.push({ site: site.name, message: "Skipped: out of request budget for this run." });
        continue;
      }
      try {
        const summary = await checkSite(ruijie, site, { state, allowList, now: startedAt });
        report.sites.push(summary.site);
        await kickExpired(ruijie, summary.kicks, { live, report, budget });
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
        // A MAC blocked again before its release went through must not be
        // released afterwards.
        const reblocked = new Set(targets.map((target) => target.mac));
        state.pendingRelease = (state.pendingRelease ?? []).filter((entry) => entry.groupId !== site.groupId || !reblocked.has(entry.mac));
        for (const target of targets) {
          const key = `${site.groupId}:${target.mac}`;
          const serving = state.blocked[key];
          if (serving) {
            // Still serving a block (it was removed from the list by hand): keep its time.
            target.offence = serving.offence;
            target.releaseAt = serving.releaseAt;
          } else {
            const count = (state.offences[target.mac]?.count ?? 0) + 1;
            state.offences[target.mac] = { count, last: startedAt.toISOString() };
            target.offence = count;
            target.releaseAt = new Date(startedAt.getTime() + blockHours(count) * 3_600_000).toISOString();
          }
          state.blocked[key] = target;
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
  state.day.kicked = (state.day.kicked ?? 0) + report.kicked.filter((kick) => !kick.dryRun).length;
  state.day.runs += 1;
  if (report.errors.length) state.day.errors += report.errors.length;

  await checkHealth(env, state, report, { fetchImpl });

  report.subrequests = budget.used;
  // One KV write per run (the free plan allows 1,000 writes a day): the latest
  // report and the console session live inside the state record.
  state.lastReport = report;
  await env.STATE.put(BLOCKER_STATE_KEY, JSON.stringify(state));
  log(`Blocker: ${report.kicked.length} kicked, ${report.blocked.length} blocked, ${report.wouldBlock.length} would block, ${report.released.length} released, ${report.errors.length} error(s), ${budget.used} requests.`);
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
    totalKicked: day.kicked ?? 0,
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
    day.kicked ? `Expired vouchers kicked off the portal: ${day.kicked}` : null,
    day.errors ? `Errors during the day: ${day.errors}` : null,
    "Blocks last 12h, 24h, 48h, then 72h for repeat offenders.",
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

// Sends one SMS when runs have kept failing and one when they work again.
export async function checkHealth(env, state, report, { fetchImpl }) {
  const health = (state.health ??= { failures: 0 });
  if (report.errors.length) {
    health.failures += 1;
    health.since ??= report.checkedAt;
    health.lastError = `${report.errors[0].site ? `${report.errors[0].site}: ` : ""}${report.errors[0].message}`;
    if (health.failures >= RULES.alertAfterFailedRuns && !health.alerted) {
      const message = [
        "QikNet blocker ALERT: not working properly.",
        `Failing since ${harareTime(health.since)} (${health.failures} runs).`,
        `Error: ${health.lastError}`.slice(0, 200),
      ].join("\n");
      health.alerted = (await sendBlockerSms(env, "QikNet Blocker Alert", message, fetchImpl)) ? report.checkedAt : null;
      report.healthAlert = health.alerted ? "sent" : "failed";
    }
    return;
  }
  if (health.alerted) {
    const minutes = Math.round((Date.parse(report.checkedAt) - Date.parse(health.since)) / 60_000);
    await sendBlockerSms(env, "QikNet Blocker Recovered", `QikNet blocker is working again (down about ${minutes} min, since ${harareTime(health.since)}).`, fetchImpl);
    report.healthAlert = "recovered";
  }
  state.health = { failures: 0, lastOk: report.checkedAt };
}

async function sendBlockerSms(env, campaignName, message, fetchImpl) {
  if (!/^true$/i.test(String(env.BLOCKER_REPORT_SMS ?? ""))) return false;
  try {
    await sendSmsCampaign({
      token: requiredEnv(env, "SMSPOP_TOKEN"),
      campaignUrl: config.sms.campaignUrl,
      senderId: config.sms.senderId,
      recipient: String(env.BLOCKER_REPORT_RECIPIENT || requiredEnv(env, "STOCK_REPORT_RECIPIENT")).trim(),
      campaignName,
      message,
      retries: 1,
      retryDelayMs: Number(env.RETRY_DELAY_MS ?? 5_000),
      fetchImpl,
    });
    return true;
  } catch (error) {
    log(`Blocker SMS failed: ${formatError(error)}`);
    return false;
  }
}

function harareTime(iso) {
  return new Date(Date.parse(iso) + HARARE_OFFSET_MINUTES * 60_000).toISOString().slice(11, 16);
}

export async function listSites(ruijie) {
  const result = await ruijie.api("/maint/network/common/list?page_index=1&page_size=100", { querys: { version: 1 } });
  if (result.code !== 0) throw new Error(`Project list failed: ${result.msg}`);
  return (result.dataList ?? []).map((project) => ({
    groupId: project.buildingId,
    name: String(project.name).replace(/^QikNet HotSpot \d+:\s*/i, ""),
    online: Number(project.onCount ?? 0) > 0,
  }));
}

async function checkSite(ruijie, site, { state, allowList, now }) {
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
  const active = await activeVoucherCodes(ruijie, site.groupId, now);
  const paidMacs = new Set(
    records.filter((record) => active.has(String(record.account ?? "").toLowerCase())).map((record) => normaliseMac(record.userMac)),
  );

  // Devices online now whose recent voucher(s) are no longer active: look up
  // when the newest one expired, and keep them as customers inside the grace period.
  const onlineMacs = new Set(clients.map((client) => normaliseMac(client.mac)));
  const newestCode = new Map();
  for (const record of records) {
    const mac = normaliseMac(record.userMac);
    if (paidMacs.has(mac) || !onlineMacs.has(mac)) continue;
    const previous = newestCode.get(mac);
    if (!previous || Number(record.loginTimes) > previous.at) newestCode.set(mac, { code: record.account, at: Number(record.loginTimes), record });
  }
  let lookups = 0;
  const kicks = [];
  for (const [mac, { code, record }] of newestCode) {
    if (lookups >= RULES.maxExpiryLookupsPerSite) {
      paidMacs.add(mac); // not checked this run, so don't risk blocking a customer
      continue;
    }
    lookups += 1;
    const expiry = await voucherExpiry(ruijie, site.groupId, code);
    if (expiry == null || expiry > now.getTime() - RULES.expiryGraceHours * 3_600_000) paidMacs.add(mac);
    if (shouldKick(record, expiry, now) && kicks.length < RULES.maxKicksPerSitePerRun) {
      kicks.push({ site: site.name, groupId: site.groupId, mac, code, expiredHoursAgo: Math.round(((now.getTime() - expiry) / 3_600_000) * 10) / 10, record });
    }
  }

  const expiredMacs = new Set(records.map((record) => normaliseMac(record.userMac)).filter((mac) => !paidMacs.has(mac)));
  // What the console's blocklist actually holds right now. Entries can be
  // removed by hand in the console, so a device blocked earlier may be back
  // online and must be blocked again.
  const blocklist = await ruijie.api(`/homescene/mac_filter/${site.groupId}`);
  if (blocklist.code !== 0 || !Array.isArray(blocklist.list)) throw new Error(`Blocklist read failed: ${blocklist.msg ?? "no data"}`);
  const alreadyBlocked = Object.fromEntries(blocklist.list.map((entry) => [`${site.groupId}:${normaliseMac(entry.mac)}`, true]));
  summary.listed = blocklist.list.length;
  const decision = decideTargets(clients, { site, portalSsids, paidMacs, expiredMacs, allowList, alreadyBlocked, offences: state.offences ?? {}, now });
  Object.assign(summary, decision.counts);
  if (decision.targets.length > RULES.maxBlocksPerSitePerRun) {
    throw new Error(`${decision.targets.length} devices to block is above the safety limit of ${RULES.maxBlocksPerSitePerRun}; nothing blocked at this site.`);
  }
  const targets = [...decision.targets].sort((a, b) => b.usedMb - a.usedMb).slice(0, RULES.blocksPerSitePerRun);
  summary.toKick = kicks.length;
  return { site: summary, targets, kicks };
}

// A sign-in should be kicked when the portal still shows it online although its
// voucher expired at least kickAfterExpiryHours ago.
export function shouldKick(record, expiry, now) {
  if (Number(record?.onlineStatus) !== 1 || !(expiry > 0)) return false;
  return now.getTime() - expiry >= RULES.kickAfterExpiryHours * 3_600_000;
}

// Ends portal sessions whose voucher has expired, the same as the console's
// "Kick Offline" button. The device stays connected to the Wi-Fi but has to
// enter a new voucher on the portal.
async function kickExpired(ruijie, kicks, { live, report, budget }) {
  for (const { record, ...kick } of kicks ?? []) {
    if (!live) {
      report.kicked.push({ ...kick, dryRun: true });
      continue;
    }
    if (budget.remaining() < 5) break;
    try {
      const result = await ruijie.api("/samTransfer/kick/user/offline", {
        method: "POST",
        params: { group_id: kick.groupId, account: record.account, auth_type: record.authType, mac: record.userMac, id: record.id },
      });
      if (result.code !== 0) throw new Error(result.msg ?? `code ${result.code}`);
      report.kicked.push(kick);
    } catch (error) {
      report.errors.push({ site: kick.site, mac: kick.mac, message: `Kick failed: ${formatError(error)}` });
    }
  }
}

// Pure decision logic, kept separate so it can be tested.
export function decideTargets(clients, { site, portalSsids, paidMacs, expiredMacs = new Set(), allowList, alreadyBlocked = {}, offences = {}, now }) {
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
        const repeat = Number(offences[mac]?.count ?? 0) > 0;
        const dataLimit = repeat ? RULES.repeatOffenderDataBytes : RULES.minDataBytes;
        if (!expired && usedBytes >= dataLimit) reasons.push(`used ${Math.round(usedBytes / 1048576)} MB, ${label}${repeat ? ", blocked before" : ""}`);
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

// Voucher lists come from the web console rather than the open API: the open
// API has a request quota ("Too many requests", code 44) that the blocker used
// up on 2026-11-06, which also starves the station monitor and stock sync.
async function consoleVouchers(ruijie, groupId, querys) {
  const result = await ruijie.api(`/intlSamVoucher/getList/${encodeURIComponent(ruijie.user)}/${encodeURIComponent(groupId)}`, { querys });
  if (result.code !== 0 || !Array.isArray(result.voucherData?.list)) {
    throw new Error(`Voucher list failed: ${result.msg ?? result.voucherData?.msg ?? "no data"}`);
  }
  return result.voucherData.list;
}

// Vouchers that are in use (status 2) and not yet expired. A voucher without an
// expiry time (such as Staff) counts as active.
async function activeVoucherCodes(ruijie, groupId, now) {
  return activeCodes(await consoleVouchers(ruijie, groupId, { start: 0, pageSize: 1000, status: 2 }), now);
}

// Expiry time (ms) of one voucher, or null if it has none or can't be found.
async function voucherExpiry(ruijie, groupId, code) {
  const list = await consoleVouchers(ruijie, groupId, { start: 0, pageSize: 10, name: code });
  const voucher = list.find((entry) => String(entry.voucherCode).toLowerCase() === String(code).toLowerCase());
  const expiry = Number(voucher?.expiryTime);
  return expiry > 0 ? expiry : null;
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

// Offence counts from earlier block records: one per Harare day blocked.
export function seedOffences(records) {
  const days = {};
  for (const record of records) {
    if (!record?.mac || !record.at) continue;
    (days[record.mac] ??= new Set()).add(harareDate(new Date(record.at)));
  }
  const offences = {};
  for (const [mac, set] of Object.entries(days)) {
    offences[mac] = { count: set.size, last: new Date().toISOString() };
  }
  return offences;
}

// Hours a block lasts for a device's nth offence.
export function blockHours(count) {
  return RULES.blockHours[Math.min(Math.max(count, 1), RULES.blockHours.length) - 1];
}

// Splits recorded blocks into those whose time is up and those that stay.
export function dueBlocks(blocked, now) {
  const due = [];
  const keep = {};
  for (const [key, entry] of Object.entries(blocked)) {
    if (entry.releaseAt && Date.parse(entry.releaseAt) <= now.getTime()) due.push(entry);
    else keep[key] = entry;
  }
  return { due, keep };
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

