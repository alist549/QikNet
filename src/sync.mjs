import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { maskPhone, sendSmsCampaign } from "./sms.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "sync.config.json");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const REPORT_DIR = path.join(ROOT, "reports");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const headless = parseBoolean(process.env.HEADLESS, true);
const actionTimeout = parsePositiveInteger(process.env.ACTION_TIMEOUT_MS, 20_000);
const navigationTimeout = parsePositiveInteger(process.env.NAVIGATION_TIMEOUT_MS, 45_000);
const selectedBranches = new Set(
  String(process.env.SYNC_BRANCHES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const credentials = {
  qiknetEmail: requiredEnv("QIKNET_EMAIL"),
  qiknetPassword: requiredEnv("QIKNET_PASSWORD"),
  ruijieEmail: requiredEnv("RUIJIE_EMAIL"),
  ruijiePassword: requiredEnv("RUIJIE_PASSWORD"),
};

const report = {
  startedAt: new Date().toISOString(),
  completedAt: null,
  dryRun,
  status: "running",
  inventory: [],
  inventoryAfter: [],
  actions: [],
  sms: null,
  errors: [],
};

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(REPORT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless,
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
});

const context = await browser.newContext({
  acceptDownloads: true,
  timezoneId: "Africa/Harare",
  locale: "en-ZW",
});
context.setDefaultTimeout(actionTimeout);
context.setDefaultNavigationTimeout(navigationTimeout);

const qiknetPage = await context.newPage();
const ruijiePage = await context.newPage();

try {
  log(`Starting daily voucher sync (${dryRun ? "DRY RUN" : "LIVE"})`);

  await loginQikNet(qiknetPage);
  const inventory = await readQikNetInventory(qiknetPage);
  report.inventory = inventory;

  const work = buildWorkList(inventory);
  log(`QikNet reported ${work.length} low voucher group(s).`);

  if (work.length === 0) {
    report.status = "healthy";
  } else {
    await loginRuijie(ruijiePage);

    for (const item of work) {
      try {
        const action = await prepareRuijieExport(ruijiePage, item);

        if (dryRun) {
          action.status = "dry-run";
          report.actions.push(action);
          log(`[DRY RUN] ${item.branch.qiknetName} / ${item.qiknetGroup}: ${action.sourceCount} unused source voucher(s).`);
          continue;
        }

        await uploadQikNetInventory(qiknetPage, item, action.filePath);
        action.status = "uploaded";
        report.actions.push(action);
        log(`Updated ${item.branch.qiknetName} / ${item.qiknetGroup}.`);
      } catch (error) {
        const message = formatError(error);
        report.errors.push({
          branch: item.branch.qiknetName,
          voucherGroup: item.qiknetGroup,
          message,
        });
        log(`ERROR ${item.branch.qiknetName} / ${item.qiknetGroup}: ${message}`);
      }
    }

    if (!dryRun && report.actions.some((action) => action.status === "uploaded")) {
      await qiknetPage.waitForTimeout(1_000);
      report.inventoryAfter = await readQikNetInventory(qiknetPage);
      verifyReplenishmentTargets(report.inventoryAfter);
    }

    report.status = report.errors.length ? "completed-with-errors" : dryRun ? "dry-run-complete" : "updated";
  }
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: formatError(error) });
  process.exitCode = 1;
  log(`FATAL: ${formatError(error)}`);
} finally {
  report.completedAt = new Date().toISOString();

  if (!dryRun) {
    try {
      await sendSmsCampaign({
        token: process.env.SMSPOP_TOKEN,
        campaignUrl: config.sms.campaignUrl,
        senderId: config.sms.senderId,
        recipient: requiredEnv("STOCK_REPORT_RECIPIENT"),
        campaignName: "QikNet Daily Voucher Stock Report",
        message: buildStockReportMessage(),
      });
      report.sms = { recipient: maskPhone(requiredEnv("STOCK_REPORT_RECIPIENT")), status: "sent" };
    } catch (error) {
      report.sms = { recipient: "configured stock-report recipient", status: "failed", message: formatError(error) };
      report.errors.push({ message: `Stock report SMS failed: ${formatError(error)}` });
    }
  }

  const reportPath = path.join(REPORT_DIR, `sync-${safeTimestamp(report.startedAt)}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
  log(`Report written to ${reportPath}`);

  if (report.errors.length) process.exitCode = 1;
}

async function loginQikNet(page) {
  log("Signing in to QikNet.");
  await page.goto(config.qiknet.loginUrl, { waitUntil: "domcontentloaded" });

  const email = page.getByLabel("Email", { exact: true });
  if (await email.isVisible().catch(() => false)) {
    await email.fill(credentials.qiknetEmail);
    await page.getByLabel("Password", { exact: true }).fill(credentials.qiknetPassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
  }

  await page.waitForURL(/\/super(?:#|$)/, { timeout: navigationTimeout });
  await page.getByText("QikNet Control Center", { exact: true }).waitFor({ state: "visible" });
}

async function loginRuijie(page) {
  log("Signing in to Ruijie Cloud.");
  await page.goto(config.ruijie.projectsUrl, { waitUntil: "domcontentloaded" });

  const cookieAccept = page.getByRole("button", { name: "Accept", exact: true });
  if (await cookieAccept.isVisible().catch(() => false)) await cookieAccept.click();

  const email = page.getByPlaceholder("Email Address (Account)");
  if (await email.isVisible().catch(() => false)) {
    await email.fill(credentials.ruijieEmail);
    await page.getByPlaceholder("Password").fill(credentials.ruijiePassword);
    await page.getByRole("button", { name: "Login", exact: true }).click();
  }

  await page.waitForURL(/adminIntl\/#\/monitor_overview_global_menu/, { timeout: navigationTimeout });
  await page.getByText("Projects", { exact: true }).waitFor({ state: "visible" });

  const updateDialogClose = page.getByRole("button", { name: "Close", exact: true });
  if (await updateDialogClose.isVisible().catch(() => false)) await updateDialogClose.click();
}

async function readQikNetInventory(page) {
  log("Reading QikNet branch inventory.");
  await page.goto(config.qiknet.inventoryUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Inventory By Branch/ }).waitFor({ state: "visible" });

  const records = [];
  const pageSummary = await page.locator("main").innerText();
  const totalPages = Number(pageSummary.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] ?? 1);

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > 1) {
      await page.locator("main").getByRole("button", { name: String(pageNumber), exact: true }).click();
      await page.waitForTimeout(350);
    }

    const cards = page.locator("main article article").filter({ hasText: "available vouchers" });
    const cardCount = await cards.count();

    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index);
      const cardText = await card.innerText();
      const branchName = (await card.locator("strong").first().innerText()).trim();
      const totalAvailable = Number(cardText.match(/(\d+)\s+available vouchers/i)?.[1] ?? 0);
      const groups = {};

      for (const groupName of Object.keys(config.voucherGroups)) {
        groups[groupName] = parseVoucherGroup(cardText, groupName);
      }

      records.push({ branchName, totalAvailable, groups });
    }
  }

  return records;
}

function buildWorkList(inventory) {
  const work = [];

  for (const branch of config.branches) {
    if (!branch.enabled) continue;
    if (selectedBranches.size && !selectedBranches.has(branch.qiknetName.toLowerCase())) continue;

    const record = inventory.find((entry) => entry.branchName.toLowerCase() === branch.qiknetName.toLowerCase());
    if (!record) {
      report.errors.push({ branch: branch.qiknetName, message: "Branch was not found in QikNet inventory." });
      continue;
    }

    for (const [qiknetGroup, state] of Object.entries(record.groups)) {
      if (state.count < config.stockPolicy.minimum) {
        work.push({
          branch,
          qiknetGroup,
          ruijieGroup: config.voucherGroups[qiknetGroup],
          qiknetAvailable: state.count,
          qiknetStatus: state.status,
          target: config.stockPolicy.target,
        });
      }
    }
  }

  return work;
}

async function prepareRuijieExport(page, item) {
  log(`Reading Ruijie stock for ${item.branch.ruijieProject} / ${item.ruijieGroup}.`);
  await page.goto(config.ruijie.projectsUrl, { waitUntil: "domcontentloaded" });
  await page.getByText("Projects", { exact: true }).waitFor({ state: "visible" });

  const projectRow = page.getByRole("row").filter({ hasText: item.branch.ruijieProject });
  if ((await projectRow.count()) !== 1) {
    throw new Error(`Expected one Ruijie project named '${item.branch.ruijieProject}', found ${await projectRow.count()}.`);
  }

  await projectRow.getByRole("img", { name: "Go to this project" }).click();
  await page.waitForURL(/#\/monitor_project_workbarn_menu/, { timeout: navigationTimeout });

  await page.getByText("Auth & Accounts", { exact: true }).click();
  await page.getByRole("link", { name: "User Management", exact: true }).click();
  await page.waitForURL(/#\/config_group_userManagement_menu/, { timeout: navigationTimeout });
  await page.getByRole("tab", { name: "Voucher", exact: true }).click();

  const panel = page.getByRole("tabpanel", { name: "Voucher" });
  const search = panel.getByPlaceholder("Voucher/User group");
  await search.fill(item.ruijieGroup);
  await search.press("Enter");

  await panel.getByRole("button", { name: "filter" }).click();
  await page.getByRole("menuitem", { name: "Not used", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(700);

  const countText = await panel.locator("li").filter({ hasText: "in total" }).innerText();
  const sourceCount = Number(countText.match(/(\d+)\s+in total/i)?.[1] ?? 0);
  if (!sourceCount) throw new Error("Ruijie returned no unused vouchers for this group.");

  const fileName = `${slug(item.branch.qiknetName)}-${slug(item.qiknetGroup)}-${Date.now()}.xlsx`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  const downloadPromise = page.waitForEvent("download", { timeout: navigationTimeout });
  await panel.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(filePath);

  return {
    branch: item.branch.qiknetName,
    stationCode: item.branch.stationCode,
    voucherGroup: item.qiknetGroup,
    sourceProject: item.branch.ruijieProject,
    sourceGroup: item.ruijieGroup,
    qiknetAvailableBefore: item.qiknetAvailable,
    qiknetStatusBefore: item.qiknetStatus,
    target: item.target,
    sourceCount,
    filePath,
    status: "exported",
  };
}

async function uploadQikNetInventory(page, item, filePath) {
  await page.goto(config.qiknet.inventoryUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Inventory By Branch/ }).waitFor({ state: "visible" });
  const card = await findQikNetBranchCard(page, item.branch.qiknetName);

  await card.getByRole("button", { name: "Add inventory", exact: true }).click();
  await page.getByRole("heading", { name: item.branch.qiknetName, exact: true }).waitFor({ state: "visible" });

  const excelTab = page.getByRole("button", { name: "Excel upload", exact: true });
  if (await excelTab.isVisible().catch(() => false)) await excelTab.click();

  const fileInput = page.locator('input[type="file"]');
  if (await fileInput.count()) {
    await fileInput.setInputFiles(filePath);
  } else {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose File", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);
  }

  await page.getByRole("button", { name: "Upload Excel vouchers", exact: true }).click();
  await page.waitForTimeout(1_200);

  const visibleText = await page.locator("body").innerText();
  if (/upload failed|could not upload|invalid file|error occurred/i.test(visibleText)) {
    throw new Error("QikNet reported an Excel upload error.");
  }
}

async function findQikNetBranchCard(page, branchName) {
  const summary = await page.locator("main").innerText();
  const totalPages = Number(summary.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] ?? 1);

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > 1) {
      await page.locator("main").getByRole("button", { name: String(pageNumber), exact: true }).click();
      await page.waitForTimeout(300);
    }

    const card = page
      .locator("main article article")
      .filter({ hasText: "available vouchers" })
      .filter({ has: page.locator("strong", { hasText: branchName }) });

    if ((await card.count()) === 1) return card;
  }

  throw new Error(`QikNet branch '${branchName}' was not found.`);
}

function parseVoucherGroup(cardText, groupName) {
  const escaped = escapeRegExp(groupName);
  const detailed = cardText.match(new RegExp(`${escaped}\\s*\\n\\s*(\\d+)\\s*\\n\\s*([^\\n]+)`, "i"));
  const summary = cardText.match(new RegExp(`${escaped}:\\s*(\\d+)`, "i"));
  const count = Number(detailed?.[1] ?? summary?.[1] ?? 0);
  const status = String(detailed?.[2] ?? "Unknown").trim();
  const low = /low|critical|replenish|attention|out of stock/i.test(status);
  return { count, status, low };
}

function verifyReplenishmentTargets(inventoryAfter) {
  for (const action of report.actions.filter((entry) => entry.status === "uploaded")) {
    const branch = inventoryAfter.find((entry) => entry.branchName.toLowerCase() === action.branch.toLowerCase());
    const availableAfter = branch?.groups?.[action.voucherGroup]?.count;
    action.qiknetAvailableAfter = Number.isFinite(availableAfter) ? availableAfter : null;

    if (!Number.isFinite(availableAfter)) {
      report.errors.push({
        branch: action.branch,
        voucherGroup: action.voucherGroup,
        message: "Could not verify the post-upload QikNet stock count.",
      });
    } else if (availableAfter < config.stockPolicy.target) {
      report.errors.push({
        branch: action.branch,
        voucherGroup: action.voucherGroup,
        message: `Stock reached ${availableAfter}, below the target of ${config.stockPolicy.target}.`,
      });
    }
  }
}

function buildStockReportMessage() {
  const uploaded = report.actions.filter((action) => action.status === "uploaded");
  const verified = uploaded.filter((action) => Number.isFinite(action.qiknetAvailableAfter));
  const belowTarget = verified.filter((action) => action.qiknetAvailableAfter < config.stockPolicy.target);
  const checked = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Harare",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  if (uploaded.length === 0 && report.errors.length === 0) {
    return `QikNet stock report: all monitored voucher groups are at or above ${config.stockPolicy.minimum}. Checked ${checked}.`;
  }

  return `QikNet stock report: ${uploaded.length} group(s) replenished; ${belowTarget.length} below target ${config.stockPolicy.target}; ${report.errors.length} error(s). Checked ${checked}.`;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function safeTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
