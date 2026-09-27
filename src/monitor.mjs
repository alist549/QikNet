import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { maskPhone, sendSmsCampaign } from "./sms.mjs";
import { addMinutes, isAlertDue, nextAlertDelayMinutes } from "./alert-schedule.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "sync.config.json");
const STATE_PATH = process.env.STATION_STATE_PATH
  ? path.resolve(process.env.STATION_STATE_PATH)
  : path.join(ROOT, "state", "station-status.json");
const REPORT_DIR = path.join(ROOT, "reports", "monitor");
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));

const sendSms = parseBoolean(process.env.SEND_SMS, true);
const ruijieApiAppId = requiredEnv("RUIJIE_API_APP_ID");
const ruijieApiSecret = requiredEnv("RUIJIE_API_SECRET");
const ruijieApiBaseUrl = String(process.env.RUIJIE_API_BASE_URL || "https://cloud-eu.ruijienetworks.com").replace(/\/$/, "");
const smsToken = sendSms ? requiredEnv("SMSPOP_TOKEN") : process.env.SMSPOP_TOKEN;
const defaultOutageRecipients = (sendSms ? requiredEnv("DEFAULT_OUTAGE_RECIPIENTS") : process.env.DEFAULT_OUTAGE_RECIPIENTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const specialOutageRecipient = sendSms ? requiredEnv("SPECIAL_OUTAGE_RECIPIENT") : process.env.SPECIAL_OUTAGE_RECIPIENT;

await mkdir(path.dirname(STATE_PATH), { recursive: true });
await mkdir(REPORT_DIR, { recursive: true });

const previousState = await readJson(STATE_PATH, { stations: {} });
const nextState = { stations: {} };
const report = {
  checkedAt: new Date().toISOString(),
  sendSms,
  stations: [],
  notifications: [],
  errors: [],
};

try {
  const stations = await readStationStatusesApi();

  for (const station of stations) {
    const previous = previousState.stations?.[station.projectName] ?? {};
    const alerting = ["down", "degraded"].includes(station.status);
    const sameIncident = alerting && previous.status === station.status;
    const requiredRecipients = recipientsFor(station.branchName);
    let alertCount = sameIncident ? Number(previous.alertCount ?? 0) : 0;
    let lastAlertAt = sameIncident ? previous.lastAlertAt ?? null : null;
    let nextAlertAt = sameIncident ? previous.nextAlertAt ?? null : null;
    let cycleNotifiedRecipients = sameIncident ? [...(previous.cycleNotifiedRecipients ?? [])] : [];
    const alertDue = alerting && isAlertDue(report.checkedAt, alertCount, nextAlertAt);
    const pendingRecipients = alertDue
      ? requiredRecipients.filter((recipient) => !cycleNotifiedRecipients.includes(maskPhone(recipient)))
      : [];

    if (sendSms) {
      for (const recipient of pendingRecipients) {
        try {
          await sendSmsCampaign({
            token: smsToken,
            campaignUrl: config.sms.campaignUrl,
            senderId: config.sms.senderId,
            recipient,
            campaignName: `QikNet Station Alert ${station.branchName}`,
            message: buildAlertMessage(station),
          });
          cycleNotifiedRecipients.push(maskPhone(recipient));
          report.notifications.push({ branch: station.branchName, recipient: maskPhone(recipient), status: "sent" });
        } catch (error) {
          report.errors.push({ branch: station.branchName, recipient: maskPhone(recipient), message: formatError(error) });
        }
      }

      const requiredMasked = requiredRecipients.map(maskPhone);
      const cycleComplete = alertDue && requiredMasked.every((recipient) => cycleNotifiedRecipients.includes(recipient));
      if (cycleComplete) {
        alertCount += 1;
        lastAlertAt = report.checkedAt;
        nextAlertAt = addMinutes(report.checkedAt, nextAlertDelayMinutes(alertCount));
        cycleNotifiedRecipients = [];
      }
    }

    nextState.stations[station.projectName] = {
      branchName: station.branchName,
      status: station.status,
      components: station.components,
      alertCount: alerting ? alertCount : 0,
      lastAlertAt: alerting ? lastAlertAt : null,
      nextAlertAt: alerting ? nextAlertAt : null,
      cycleNotifiedRecipients: alerting ? cycleNotifiedRecipients.sort() : [],
    };
    report.stations.push({ ...station, alertCount, nextAlertAt, alertDue });
  }
} catch (error) {
  const message = formatError(error);
  report.errors.push({ message });
  console.error(`Station monitor failed: ${message}`);
  console.error(`::error title=Ruijie station monitor failed::${escapeWorkflowCommand(message)}`);
} finally {
  const stableState = sortState(nextState);
  if (Object.keys(stableState.stations).length) {
    await writeFile(STATE_PATH, `${JSON.stringify(stableState, null, 2)}\n`, "utf8");
  }
  await writeFile(
    path.join(REPORT_DIR, `monitor-${safeTimestamp(report.checkedAt)}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (report.errors.length) process.exitCode = 1;
}

async function getRuijieApiSession() {
  const response = await fetch(`${ruijieApiBaseUrl}/service/api/oauth20/client/access_token?token=d63dss0a81e4415a889ac5b78fsc904a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appid: ruijieApiAppId, secret: ruijieApiSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0 || !result.accessToken) {
    throw new Error(`Ruijie API authentication failed (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
  }
  return result.accessToken;
}

async function ruijieApiGet(apiPath, accessToken, params = {}) {
  const url = new URL(apiPath, ruijieApiBaseUrl);
  url.searchParams.set("access_token", accessToken);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) {
    throw new Error(`Ruijie API request failed for ${apiPath} (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
  }
  return result;
}

async function readStationStatusesApi() {
  console.log("Reading Ruijie station status through the API...");
  const accessToken = await getRuijieApiSession();
  const tree = await ruijieApiGet("/service/api/group/single/tree", accessToken, { depth: "BUILDING" });
  const projects = new Map();
  walkObjects(tree, (value) => {
    const name = value.name ?? value.groupName ?? value.projectName;
    const groupId = value.groupId ?? value.id;
    if (name && groupId != null) projects.set(String(name), groupId);
  });

  const componentTypes = [
    ["AP", "AP"],
    ["SWITCH", "Switch"],
    ["GATEWAY", "Gateway"],
    ["BRIDGE", "Wireless Bridge"],
  ];
  const stations = [];

  for (const branch of config.branches.filter((entry) => entry.enabled)) {
    const groupId = projects.get(branch.ruijieProject);
    if (groupId == null) throw new Error(`Ruijie API project was not found: ${branch.ruijieProject}.`);
    const components = [];
    for (const [commonType, name] of componentTypes) {
      const result = await ruijieApiGet("/service/api/maint/devices", accessToken, {
        common_type: commonType,
        group_id: groupId,
        page: 1,
        per_page: 100,
      });
      const devices = result.deviceList ?? result.data?.list ?? result.dataList ?? result.list ?? [];
      if (!devices.length) continue;
      const online = devices.filter((device) => String(device.onlineStatus ?? device.status ?? "").toUpperCase() === "ON").length;
      components.push({ name, online, total: devices.length });
    }
    if (!components.length) throw new Error(`Ruijie API returned no devices for ${branch.ruijieProject}.`);
    const hasOfflineComponent = components.some((component) => component.online === 0 && component.total > 0);
    const hasDegradedComponent = components.some((component) => component.online < component.total);
    const status = hasOfflineComponent ? "down" : hasDegradedComponent ? "degraded" : "up";
    stations.push({ branchName: branch.qiknetName, projectName: branch.ruijieProject, status, components });
  }
  return stations;
}

function walkObjects(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) walkObjects(child, visitor);
}

async function loginRuijie(page) {
  console.log("Opening the Ruijie Cloud projects page...");
  await page.goto(config.ruijie.projectsUrl, { waitUntil: "domcontentloaded" });
  const email = page.getByPlaceholder("Email Address (Account)");
  const stationMarker = page.getByText("QikNet HotSpot", { exact: false }).first();

  let initialState;
  try {
    initialState = await Promise.any([
      email.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "login"),
      stationMarker.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "ready"),
    ]);
  } catch {
    throw new Error("Neither the Ruijie sign-in form nor the QikNet station overview became visible.");
  }

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if (initialState === "login") {
    console.log("Ruijie sign-in form found; signing in...");
    if (await accept.isVisible().catch(() => false)) await accept.click();
    await enterCredentialsHumanly(page, email, page.getByPlaceholder("Password"), ruijieEmail, ruijiePassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await waitForStationOrLoginError(page, stationMarker);
  } else {
    console.log("Ruijie already has an authenticated station overview.");
  }

  const close = page.getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
  console.log("Ruijie QikNet station rows are ready.");
}

async function readStationStatuses(page) {
  const rows = page.getByRole("row").filter({ hasText: "QikNet HotSpot" });
  const count = await rows.count();
  if (!count) throw new Error("No QikNet projects were found in the Ruijie overview.");

  const componentColumns = [
    [4, "Gateway"],
    [5, "Switch"],
    [6, "AP"],
    [7, "Wireless Bridge"],
    [8, "Home Router"],
    [9, "Firewall"],
    [10, "AC"],
  ];
  const stations = [];

  for (let index = 0; index < count; index += 1) {
    const cells = (await rows.nth(index).getByRole("cell").allTextContents()).map((value) => value.trim());
    const projectName = cells[1];
    const branch = config.branches.find((entry) => entry.enabled && entry.ruijieProject === projectName);
    if (!branch) continue;

    const components = componentColumns.flatMap(([cellIndex, name]) => {
      const match = cells[cellIndex]?.match(/^(\d+)\/(\d+)$/);
      if (!match) return [];
      return [{ name, online: Number(match[1]), total: Number(match[2]) }];
    });
    if (!components.length) {
      throw new Error(`No device availability counts were found for ${projectName}.`);
    }

    const hasOfflineComponent = components.some((component) => component.online === 0 && component.total > 0);
    const hasDegradedComponent = components.some((component) => component.online < component.total);
    const status = hasOfflineComponent ? "down" : hasDegradedComponent ? "degraded" : "up";
    stations.push({ branchName: branch.qiknetName, projectName, status, components });
  }

  return stations;
}

function recipientsFor(branchName) {
  const recipients = [...defaultOutageRecipients];
  if (specialOutageRecipient && config.sms.specialBranches.includes(branchName)) recipients.push(specialOutageRecipient);
  return [...new Set(recipients)];
}

function buildAlertMessage(station) {
  const deviceSummary = station.components
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
  }).format(new Date());
  return `QikNet ALERT: ${station.branchName} is ${station.status.toUpperCase()} (${deviceSummary}). Checked ${checked}.`;
}

function sortState(state) {
  return {
    stations: Object.fromEntries(Object.entries(state.stations).sort(([left], [right]) => left.localeCompare(right))),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function describeRuijiePage(page) {
  const currentUrl = new URL(page.url());
  const safeLocation = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.hash}`;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const summary = sanitizeRuijieText(bodyText).slice(0, 700);
  return `Ruijie station names did not become visible at ${safeLocation}. Visible page: ${summary || "(blank)"}`;
}

async function waitForStationOrLoginError(page, stationMarker) {
  const feedback = page.locator("#logintip, #msg, .rui-validator-tip, .alert");
  const deadline = Date.now() + navigationTimeout;
  while (Date.now() < deadline) {
    if (await stationMarker.isVisible().catch(() => false)) return;
    const messages = (await feedback.allTextContents().catch(() => []))
      .map((value) => sanitizeRuijieText(value))
      .filter((value) => value && !/^(logging in|please wait)/i.test(value));
    if (messages.length) throw new Error(`Ruijie login response: ${messages.join(" | ").slice(0, 500)}`);
    await page.waitForTimeout(250);
  }
  throw new Error(await describeRuijiePage(page));
}

function sanitizeRuijieText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]")
    .replace(/\b\d{8,}\b/g, "[number hidden]")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeWorkflowCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

async function enterCredentialsHumanly(page, emailField, passwordField, emailValue, passwordValue) {
  await page.waitForTimeout(randomInteger(700, 1_300));
  await emailField.fill("");
  await emailField.click();
  console.log("Entering the Ruijie account at human pace...");
  await page.keyboard.type(emailValue, { delay: randomInteger(65, 105) });
  await page.waitForTimeout(randomInteger(450, 900));
  await passwordField.fill("");
  await passwordField.click();
  console.log("Entering the Ruijie password at human pace...");
  await page.keyboard.type(passwordValue, { delay: randomInteger(70, 115) });
  await page.waitForTimeout(randomInteger(700, 1_300));
  console.log("Ruijie credentials entered; submitting the form.");
}

function randomInteger(minimum, maximum) {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}
