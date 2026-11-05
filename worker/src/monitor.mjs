import config from "../../config/sync.config.json" with { type: "json" };
import { maskPhone, sendSmsCampaign } from "../../src/sms.mjs";
import { createRuijieClient } from "./ruijie.mjs";
import { createBudget, formatError, log, requiredEnv, splitList } from "./shared.mjs";

export const STATE_KEY = "station-state";
export const MONITOR_REPORT_KEY = "last-monitor-report";

const COMPONENT_TYPES = [
  ["AP", "AP"],
  ["SWITCH", "Switch"],
  ["GATEWAY", "Gateway"],
  ["BRIDGE", "Wireless Bridge"],
];

const HARARE_OFFSET_MINUTES = 120;

// Alert policy, from Worker vars (wrangler.toml):
//   MONITOR_CONFIRM_CHECKS  checks in a row before a station counts as down, or as back up (default 2)
//   MONITOR_QUIET_HOURS     Harare hours with no DOWN/BACK UP SMS, e.g. "22-7"; empty = none
//   MONITOR_SUMMARY_HOUR    Harare hour of the morning SMS listing stations still down; empty = none
export function alertPolicy(env = {}) {
  const confirmChecks = Math.max(1, Number.parseInt(env.MONITOR_CONFIRM_CHECKS ?? "2", 10) || 2);
  const quiet = String(env.MONITOR_QUIET_HOURS ?? "").match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  const summaryHour = String(env.MONITOR_SUMMARY_HOUR ?? "").trim() === "" ? null : Number(env.MONITOR_SUMMARY_HOUR);
  return {
    confirmChecks,
    quietStart: quiet ? Number(quiet[1]) % 24 : null,
    quietEnd: quiet ? Number(quiet[2]) % 24 : null,
    summaryHour: Number.isInteger(summaryHour) && summaryHour >= 0 && summaryHour < 24 ? summaryHour : null,
  };
}

function harareParts(date) {
  const shifted = new Date(date.getTime() + HARARE_OFFSET_MINUTES * 60_000);
  return { hour: shifted.getUTCHours(), day: shifted.toISOString().slice(0, 10) };
}

export function isQuietTime(date, policy) {
  if (policy.quietStart == null || policy.quietStart === policy.quietEnd) return false;
  const { hour } = harareParts(date);
  return policy.quietStart < policy.quietEnd
    ? hour >= policy.quietStart && hour < policy.quietEnd
    : hour >= policy.quietStart || hour < policy.quietEnd;
}

// Reads every enabled station through the Ruijie API and keeps incident state in
// Workers KV. To keep SMS down to what matters:
//   - a station must fail MONITOR_CONFIRM_CHECKS checks in a row before anyone is told;
//   - each outage gets one DOWN SMS and, once it is confirmed up again, one BACK UP SMS
//     (only to people who got the DOWN SMS); down <-> degraded or a single good check
//     in the middle does not start a new outage;
//   - nothing is sent in quiet hours; instead the morning summary lists stations still
//     down and the ones that came back overnight. The summary repeats daily for as long
//     as a station stays down, which replaces the old 1-4 hourly reminders.
export async function runMonitor(env, { sendSms, fetchImpl = fetch, now = () => new Date() } = {}) {
  const budget = createBudget(undefined, fetchImpl);
  const checkedAtDate = now();
  const policy = alertPolicy(env);
  const quiet = isQuietTime(checkedAtDate, policy);
  const { hour, day } = harareParts(checkedAtDate);
  const report = {
    checkedAt: checkedAtDate.toISOString(),
    sendSms,
    policy,
    quiet,
    summarySent: false,
    stations: [],
    notifications: [],
    errors: [],
    subrequests: 0,
  };

  const smsToken = sendSms ? requiredEnv(env, "SMSPOP_TOKEN") : env.SMSPOP_TOKEN;
  const defaultRecipients = splitList(sendSms ? requiredEnv(env, "DEFAULT_OUTAGE_RECIPIENTS") : env.DEFAULT_OUTAGE_RECIPIENTS);
  const specialRecipient = sendSms ? requiredEnv(env, "SPECIAL_OUTAGE_RECIPIENT") : env.SPECIAL_OUTAGE_RECIPIENT;

  const previousState = (await env.STATE.get(STATE_KEY, "json")) ?? { stations: {} };
  const nextState = {
    lastSummaryDay: previousState.lastSummaryDay ?? null,
    overnightRecoveries: [...(previousState.overnightRecoveries ?? [])],
    stations: {},
  };

  const send = async (recipient, branch, kind, message) => {
    try {
      await sendSmsCampaign({
        token: smsToken,
        campaignUrl: config.sms.campaignUrl,
        senderId: config.sms.senderId,
        recipient,
        campaignName: `QikNet Station ${kind} ${branch}`,
        message,
        retries: 2,
        retryDelayMs: Number(env.RETRY_DELAY_MS ?? 5_000),
        fetchImpl: budget.fetch,
      });
      report.notifications.push({ branch, kind, recipient: maskPhone(recipient), status: "sent" });
      return true;
    } catch (error) {
      report.errors.push({ branch, kind, recipient: maskPhone(recipient), message: formatError(error) });
      return false;
    }
  };

  try {
    const ruijie = createRuijieClient({
      baseUrl: env.RUIJIE_API_BASE_URL,
      appId: requiredEnv(env, "RUIJIE_API_APP_ID"),
      secret: requiredEnv(env, "RUIJIE_API_SECRET"),
      fetchImpl: budget.fetch,
      retryDelayMs: env.RETRY_DELAY_MS == null ? 1_500 : Number(env.RETRY_DELAY_MS),
    });
    const stations = await readStations(ruijie);
    const entries = stations.map((station) => {
      const recipients = recipientsFor(station.branchName, defaultRecipients, specialRecipient);
      const previous = migrate(previousState.stations?.[station.projectName] ?? {}, recipients);
      const failing = station.status !== "up";
      const entry = {
        station,
        recipients,
        state: {
          branchName: station.branchName,
          status: station.status,
          components: station.components,
          failingChecks: failing ? previous.failingChecks + 1 : 0,
          upChecks: failing ? 0 : previous.upChecks + 1,
          incident: previous.incident,
        },
      };
      if (failing && !entry.state.incident) {
        entry.state.incident = { startedAt: report.checkedAt, confirmed: false, notified: [] };
      }
      const incident = entry.state.incident;
      if (incident && failing && entry.state.failingChecks >= policy.confirmChecks) incident.confirmed = true;
      return entry;
    });

    // Morning summary: one SMS per recipient, the first run in the summary hour each day.
    const summaryDue = sendSms && policy.summaryHour != null && hour === policy.summaryHour && nextState.lastSummaryDay !== day;
    if (summaryDue) {
      const people = new Map();
      for (const entry of entries) {
        for (const recipient of entry.recipients) {
          if (!people.has(recipient)) people.set(recipient, { down: [], recovered: [] });
          if (entry.state.incident?.confirmed && entry.station.status !== "up") people.get(recipient).down.push(entry);
        }
      }
      for (const recovery of nextState.overnightRecoveries) {
        for (const masked of recovery.notified) {
          const recipient = [...people.keys()].find((candidate) => maskPhone(candidate) === masked);
          if (recipient) people.get(recipient).recovered.push(recovery.branchName);
        }
      }
      let allSent = true;
      for (const [recipient, { down, recovered }] of people) {
        if (!down.length && !recovered.length) continue;
        const ok = await send(recipient, "all", "Summary", buildSummaryMessage(down, recovered, checkedAtDate));
        allSent &&= ok;
        if (ok) {
          for (const entry of down) addNotified(entry.state.incident, recipient);
        }
      }
      // A failed recipient is retried individually below (DOWN SMS); don't resend the summary to everyone.
      nextState.lastSummaryDay = day;
      nextState.overnightRecoveries = [];
      report.summarySent = allSent;
    }

    for (const entry of entries) {
      const { station, state, recipients } = entry;
      const incident = state.incident;
      const failing = station.status !== "up";

      if (incident && failing && incident.confirmed && sendSms && !quiet) {
        for (const recipient of recipients) {
          if (incident.notified.includes(maskPhone(recipient))) continue;
          if (await send(recipient, station.branchName, "Down", buildDownMessage(station, incident, checkedAtDate))) {
            addNotified(incident, recipient);
          }
        }
      }

      // In quiet hours with no morning summary, hold the BACK UP SMS until quiet hours end.
      const holdRecovery = quiet && policy.summaryHour == null && incident?.notified.length && sendSms;
      if (incident && !failing && state.upChecks >= policy.confirmChecks && !holdRecovery) {
        // Outage over. Tell whoever heard about it; never-announced blips end silently.
        if (incident.notified.length && sendSms) {
          if (quiet) {
            nextState.overnightRecoveries.push({ branchName: station.branchName, notified: incident.notified });
          } else {
            for (const recipient of recipients) {
              if (incident.notified.includes(maskPhone(recipient))) {
                await send(recipient, station.branchName, "Up", buildUpMessage(station, incident, checkedAtDate));
              }
            }
          }
        }
        state.incident = null;
      }

      nextState.stations[station.projectName] = state;
      report.stations.push({
        ...station,
        failingChecks: state.failingChecks,
        incident: state.incident,
      });
    }
  } catch (error) {
    report.errors.push({ message: formatError(error) });
    log(`Station monitor failed: ${formatError(error)}`);
  }

  report.subrequests = budget.used;
  if (Object.keys(nextState.stations).length) {
    nextState.stations = Object.fromEntries(Object.entries(nextState.stations).sort(([a], [b]) => a.localeCompare(b)));
    await env.STATE.put(STATE_KEY, JSON.stringify(nextState));
  }
  await env.STATE.put(MONITOR_REPORT_KEY, JSON.stringify(report));
  log(`Monitor checked ${report.stations.length} station(s), sent ${report.notifications.length} SMS, ${report.errors.length} error(s), ${budget.used} request(s).`);
  return report;
}

// Accepts both the current state shape and the old tiered-reminder one, so the
// first run after deploying doesn't re-announce outages people already know about.
function migrate(previous, recipients) {
  if ("incident" in previous || "failingChecks" in previous) {
    return {
      failingChecks: Number(previous.failingChecks ?? 0),
      upChecks: Number(previous.upChecks ?? 0),
      incident: previous.incident ? { ...previous.incident, notified: [...(previous.incident.notified ?? [])] } : null,
    };
  }
  const failing = previous.status != null && previous.status !== "up";
  const alerted = Number(previous.alertCount ?? 0) > 0;
  // alertCount > 0 means at least one full round reached everyone already.
  const notified = alerted ? recipients.map(maskPhone).sort() : [...(previous.cycleNotifiedRecipients ?? [])].sort();
  return {
    failingChecks: failing ? 99 : 0,
    upChecks: failing ? 0 : 99,
    incident: failing && (alerted || notified.length)
      ? { startedAt: previous.incidentStartedAt ?? null, confirmed: true, notified, migrated: alerted }
      : null,
  };
}

function addNotified(incident, recipient) {
  const masked = maskPhone(recipient);
  if (!incident.notified.includes(masked)) incident.notified = [...incident.notified, masked].sort();
}

async function readStations(ruijie) {
  const stations = [];
  for (const branch of config.branches.filter((entry) => entry.enabled)) {
    const groupId = await ruijie.monitorProjectId(branch.ruijieProject);
    if (groupId == null) throw new Error(`Ruijie API project was not found: ${branch.ruijieProject}.`);
    const components = [];
    for (const [commonType, name] of COMPONENT_TYPES) {
      const result = await ruijie.request("/service/api/maint/devices", {
        params: { common_type: commonType, group_id: groupId, page: 1, per_page: 100 },
        attempts: 2,
      });
      const devices = result.deviceList ?? result.data?.list ?? result.dataList ?? result.list ?? [];
      if (!devices.length) continue;
      const online = devices.filter((device) => String(device.onlineStatus ?? device.status ?? "").toUpperCase() === "ON").length;
      components.push({ name, online, total: devices.length });
    }
    if (!components.length) throw new Error(`Ruijie API returned no devices for ${branch.ruijieProject}.`);
    const offline = components.some((component) => component.online === 0 && component.total > 0);
    const degraded = components.some((component) => component.online < component.total);
    const status = offline ? "down" : degraded ? "degraded" : "up";
    stations.push({ branchName: branch.qiknetName, projectName: branch.ruijieProject, status, components });
  }
  return stations;
}

function recipientsFor(branchName, defaultRecipients, specialRecipient) {
  const recipients = [...defaultRecipients];
  if (specialRecipient && config.sms.specialBranches.includes(branchName)) recipients.push(specialRecipient);
  return [...new Set(recipients)];
}

function formatHarare(date, withDay = true) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Harare",
    ...(withDay ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

function faultSummary(station) {
  return station.components
    .filter((component) => component.online < component.total)
    .map((component) => `${component.name} ${component.online}/${component.total}`)
    .join(", ");
}

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function buildDownMessage(station, incident, checkedAt) {
  const since = incident.startedAt ? ` since ${formatHarare(new Date(incident.startedAt))}` : "";
  return `QikNet ALERT: ${station.branchName} is ${station.status.toUpperCase()} (${faultSummary(station)})${since}. You'll get one SMS when it is back up.`;
}

function buildUpMessage(station, incident, checkedAt) {
  const after = incident.startedAt ? ` after ${formatDuration((checkedAt - new Date(incident.startedAt)) / 60_000)}` : "";
  return `QikNet: ${station.branchName} is BACK UP${after}. Checked ${formatHarare(checkedAt)}.`;
}

function buildSummaryMessage(down, recovered, checkedAt) {
  const parts = [`QikNet morning check ${formatHarare(checkedAt)}:`];
  if (down.length) {
    const list = down
      .map(({ station, state }) => {
        const since = state.incident?.startedAt ? ` since ${formatHarare(new Date(state.incident.startedAt))}` : "";
        return `${station.branchName}${since}`;
      })
      .join(", ");
    parts.push(`still DOWN: ${list}.`);
  } else {
    parts.push("all stations up.");
  }
  if (recovered.length) parts.push(`Back up overnight: ${[...new Set(recovered)].join(", ")}.`);
  return parts.join(" ");
}
