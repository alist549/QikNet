import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { maskPhone, sendSmsCampaign } from "./sms.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "sync.config.json");
const STATE_PATH = path.join(ROOT, "state", "station-status.json");
const REPORT_DIR = path.join(ROOT, "reports", "monitor");
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));

const sendSms = parseBoolean(process.env.SEND_SMS, true);
const headless = parseBoolean(process.env.HEADLESS, true);
const actionTimeout = parsePositiveInteger(process.env.ACTION_TIMEOUT_MS, 20_000);
const navigationTimeout = parsePositiveInteger(process.env.NAVIGATION_TIMEOUT_MS, 45_000);
const ruijieEmail = requiredEnv("RUIJIE_EMAIL");
const ruijiePassword = requiredEnv("RUIJIE_PASSWORD");
const smsToken = sendSms ? requiredEnv("SMSPOP_TOKEN") : process.env.SMSPOP_TOKEN;
const defaultOutageRecipients = requiredEnv("DEFAULT_OUTAGE_RECIPIENTS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const specialOutageRecipient = requiredEnv("SPECIAL_OUTAGE_RECIPIENT");

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

const browser = await chromium.launch({
  headless,
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
});
const context = await browser.newContext({ timezoneId: "Africa/Harare", locale: "en-ZW" });
context.setDefaultTimeout(actionTimeout);
context.setDefaultNavigationTimeout(navigationTimeout);
const page = await context.newPage();

try {
  await loginRuijie(page);
  const stations = await readStationStatuses(page);

  for (const station of stations) {
    const previous = previousState.stations?.[station.projectName] ?? {};
    const alerting = ["down", "degraded"].includes(station.status);
    const sameIncident = alerting && previous.status === station.status;
    const notifiedRecipients = sameIncident ? [...(previous.notifiedRecipients ?? [])] : [];
    const requiredRecipients = recipientsFor(station.branchName);
    const pendingRecipients = alerting
      ? requiredRecipients.filter((recipient) => !notifiedRecipients.includes(maskPhone(recipient)))
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
          notifiedRecipients.push(maskPhone(recipient));
          report.notifications.push({ branch: station.branchName, recipient: maskPhone(recipient), status: "sent" });
        } catch (error) {
          report.errors.push({ branch: station.branchName, recipient: maskPhone(recipient), message: formatError(error) });
        }
      }
    }

    nextState.stations[station.projectName] = {
      branchName: station.branchName,
      status: station.status,
      components: station.components,
      notifiedRecipients: alerting ? notifiedRecipients.sort() : [],
    };
    report.stations.push(station);
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
  await browser.close();
  if (report.errors.length) process.exitCode = 1;
}

async function loginRuijie(page) {
  console.log("Opening the Ruijie Cloud projects page...");
  await page.goto(config.ruijie.projectsUrl, { waitUntil: "domcontentloaded" });
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if (await accept.isVisible().catch(() => false)) await accept.click();

  const email = page.getByPlaceholder("Email Address (Account)");
  if (await email.isVisible().catch(() => false)) {
    console.log("Ruijie sign-in form found; signing in...");
    await email.fill(ruijieEmail);
    await page.getByPlaceholder("Password").fill(ruijiePassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
  } else {
    console.log("Ruijie sign-in form not shown; checking the existing page session...");
  }

  await page.waitForURL(/adminIntl\/#\/monitor_overview_global_menu/, { timeout: navigationTimeout });
  const close = page.getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page
    .getByRole("row")
    .filter({ hasText: "QikNet HotSpot" })
    .first()
    .waitFor({ state: "visible", timeout: navigationTimeout });
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
  if (config.sms.specialBranches.includes(branchName)) recipients.push(specialOutageRecipient);
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

function escapeWorkflowCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
