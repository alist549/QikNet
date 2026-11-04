import config from "../../config/sync.config.json" with { type: "json" };
import { addMinutes, isAlertDue, nextAlertDelayMinutes } from "../../src/alert-schedule.mjs";
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

// Port of src/monitor.mjs: reads every enabled station through the Ruijie API,
// keeps incident state in Workers KV, and sends tiered outage SMS alerts.
export async function runMonitor(env, { sendSms, fetchImpl = fetch, now = () => new Date() } = {}) {
  const budget = createBudget(undefined, fetchImpl);
  const report = {
    checkedAt: now().toISOString(),
    sendSms,
    stations: [],
    notifications: [],
    errors: [],
    subrequests: 0,
  };

  const smsToken = sendSms ? requiredEnv(env, "SMSPOP_TOKEN") : env.SMSPOP_TOKEN;
  const defaultRecipients = splitList(sendSms ? requiredEnv(env, "DEFAULT_OUTAGE_RECIPIENTS") : env.DEFAULT_OUTAGE_RECIPIENTS);
  const specialRecipient = sendSms ? requiredEnv(env, "SPECIAL_OUTAGE_RECIPIENT") : env.SPECIAL_OUTAGE_RECIPIENT;

  const previousState = (await env.STATE.get(STATE_KEY, "json")) ?? { stations: {} };
  const nextState = { stations: {} };

  try {
    const ruijie = createRuijieClient({
      baseUrl: env.RUIJIE_API_BASE_URL,
      appId: requiredEnv(env, "RUIJIE_API_APP_ID"),
      secret: requiredEnv(env, "RUIJIE_API_SECRET"),
      fetchImpl: budget.fetch,
      retryDelayMs: env.RETRY_DELAY_MS == null ? 1_500 : Number(env.RETRY_DELAY_MS),
    });
    const stations = await readStations(ruijie);

    for (const station of stations) {
      const previous = previousState.stations?.[station.projectName] ?? {};
      const alerting = ["down", "degraded"].includes(station.status);
      const sameIncident = alerting && previous.status === station.status;
      const requiredRecipients = recipientsFor(station.branchName, defaultRecipients, specialRecipient);
      let alertCount = sameIncident ? Number(previous.alertCount ?? 0) : 0;
      let lastAlertAt = sameIncident ? previous.lastAlertAt ?? null : null;
      let nextAlertAt = sameIncident ? previous.nextAlertAt ?? null : null;
      let cycleNotified = sameIncident ? [...(previous.cycleNotifiedRecipients ?? [])] : [];
      const alertDue = alerting && isAlertDue(report.checkedAt, alertCount, nextAlertAt);
      const pending = alertDue ? requiredRecipients.filter((recipient) => !cycleNotified.includes(maskPhone(recipient))) : [];

      if (sendSms) {
        for (const recipient of pending) {
          try {
            await sendSmsCampaign({
              token: smsToken,
              campaignUrl: config.sms.campaignUrl,
              senderId: config.sms.senderId,
              recipient,
              campaignName: `QikNet Station Alert ${station.branchName}`,
              message: buildAlertMessage(station, now()),
              retries: 2,
              retryDelayMs: Number(env.RETRY_DELAY_MS ?? 5_000),
              fetchImpl: budget.fetch,
            });
            cycleNotified.push(maskPhone(recipient));
            report.notifications.push({ branch: station.branchName, recipient: maskPhone(recipient), status: "sent" });
          } catch (error) {
            report.errors.push({ branch: station.branchName, recipient: maskPhone(recipient), message: formatError(error) });
          }
        }

        const requiredMasked = requiredRecipients.map(maskPhone);
        if (alertDue && requiredMasked.every((recipient) => cycleNotified.includes(recipient))) {
          alertCount += 1;
          lastAlertAt = report.checkedAt;
          nextAlertAt = addMinutes(report.checkedAt, nextAlertDelayMinutes(alertCount));
          cycleNotified = [];
        }
      }

      nextState.stations[station.projectName] = {
        branchName: station.branchName,
        status: station.status,
        components: station.components,
        alertCount: alerting ? alertCount : 0,
        lastAlertAt: alerting ? lastAlertAt : null,
        nextAlertAt: alerting ? nextAlertAt : null,
        cycleNotifiedRecipients: alerting ? cycleNotified.sort() : [],
      };
      report.stations.push({ ...station, alertCount, nextAlertAt, alertDue });
    }
  } catch (error) {
    report.errors.push({ message: formatError(error) });
    log(`Station monitor failed: ${formatError(error)}`);
  }

  report.subrequests = budget.used;
  if (Object.keys(nextState.stations).length) {
    const sorted = Object.fromEntries(Object.entries(nextState.stations).sort(([a], [b]) => a.localeCompare(b)));
    await env.STATE.put(STATE_KEY, JSON.stringify({ stations: sorted }));
  }
  await env.STATE.put(MONITOR_REPORT_KEY, JSON.stringify(report));
  log(`Monitor checked ${report.stations.length} station(s), sent ${report.notifications.length} SMS, ${report.errors.length} error(s), ${budget.used} request(s).`);
  return report;
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

function buildAlertMessage(station, checkedAt) {
  const summary = station.components
    .filter((component) => component.online < component.total)
    .map((component) => `${component.name} ${component.online}/${component.total}`)
    .join(", ");
  const checked = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Harare",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(checkedAt);
  return `QikNet ALERT: ${station.branchName} is ${station.status.toUpperCase()} (${summary}). Checked ${checked}.`;
}
