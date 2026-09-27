import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { maskPhone, sendSmsCampaign } from "./sms.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "sync.config.json");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const REPORT_DIR = path.join(ROOT, "reports");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const allowQikNetUpload = parseBoolean(process.env.ALLOW_QIKNET_UPLOAD, false);
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
  ruijieApiAppId: requiredEnv("RUIJIE_API_APP_ID"),
  ruijieApiSecret: requiredEnv("RUIJIE_API_SECRET"),
};
const ruijieApiBaseUrl = String(process.env.RUIJIE_API_BASE_URL || "https://cloud-eu.ruijienetworks.com").replace(/\/$/, "");
const qiknetApiBaseUrl = String(process.env.QIKNET_API_BASE_URL || "https://qiknet-backend-164518585796.us-central1.run.app/api").replace(/\/$/, "");
let ruijieSessionPromise;
let qiknetTokenPromise;
const ruijieGroupCache = new Map();
const ruijieProfileCache = new Map();

const report = {
  startedAt: new Date().toISOString(),
  completedAt: null,
  dryRun,
  status: "running",
  inventory: [],
  inventoryAfter: [],
  actions: [],
  sms: [],
  errors: [],
};

if (!dryRun && !allowQikNetUpload) {
  throw new Error("Live QikNet upload is locked. Set both DRY_RUN=false and ALLOW_QIKNET_UPLOAD=true to enable it.");
}

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(REPORT_DIR, { recursive: true });

try {
  log(`Starting daily voucher sync (${dryRun ? "DRY RUN" : "LIVE"})`);

  const inventory = await readQikNetApiInventory();
  report.inventory = inventory;

  const work = buildWorkList(inventory);
  log(`QikNet reported ${work.length} low voucher group(s).`);

  if (work.length === 0) {
    report.status = "healthy";
  } else {
    if (dryRun) {
      for (const item of work) {
        try {
          const action = await exportRuijieItem(item);
          action.status = "dry-run";
          report.actions.push(action);
          log(`[DRY RUN] ${item.branch.qiknetName} / ${item.qiknetGroup}: would create ${action.requestedCount} voucher(s).`);
        } catch (error) {
          recordItemError(item, error);
        }
      }
      report.status = report.errors.length ? "completed-with-errors" : "dry-run-complete";
    } else {
      const exported = [];
      for (const item of work) {
        try {
          const action = await exportRuijieItem(item);
          action.status = "exported";
          report.actions.push(action);
          exported.push({ item, action });
        } catch (error) {
          recordItemError(item, error);
        }
      }

      for (const { item, action } of exported) {
        try {
          const upload = await uploadQikNetApiInventory(item, action.vouchers);
          action.qiknetImportedRows = upload.importedRows;
          action.status = "uploaded";
          log(`Updated ${item.branch.qiknetName} / ${item.qiknetGroup}.`);
        } catch (error) {
          action.status = "upload-failed";
          recordItemError(item, error);
        }
      }

      if (report.actions.some((action) => action.status === "uploaded")) {
        // QikNet accepts the text upload immediately but updates inventory
        // asynchronously; Unit M consistently settled within this window.
        await delay(30_000);
        report.inventoryAfter = await readQikNetApiInventory();
        verifyReplenishmentTargets(report.inventoryAfter);
      }
      report.status = report.errors.length ? "completed-with-errors" : "updated";
    }
  }
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: formatError(error) });
  process.exitCode = 1;
  log(`FATAL: ${formatError(error)}`);
} finally {
  report.completedAt = new Date().toISOString();

  if (!dryRun) {
    const stockRecipients = splitRecipients(requiredEnv("STOCK_REPORT_RECIPIENT"));
    const refillMessages = buildBranchRefillMessages();
    if (refillMessages.length === 0 && report.status === "healthy" && report.errors.length === 0) {
      refillMessages.push({ branch: "All branches", message: "QikNet: All stock levels are OK." });
    }
    for (const refill of refillMessages) {
      for (const recipient of stockRecipients) {
        try {
          await sendSmsCampaign({
            token: process.env.SMSPOP_TOKEN,
            campaignUrl: config.sms.campaignUrl,
            senderId: config.sms.senderId,
            recipient,
            campaignName: refill.branch === "All branches"
              ? "QikNet Stock Healthy"
              : `QikNet Refill - ${refill.branch}`,
            message: refill.message,
          });
          report.sms.push({
            branch: refill.branch,
            recipient: maskPhone(recipient),
            messageLength: refill.message.length,
            status: "sent",
          });
        } catch (error) {
          report.sms.push({ branch: refill.branch, recipient: maskPhone(recipient), status: "failed", message: formatError(error) });
          report.errors.push({ message: `Refill SMS failed for ${refill.branch} / ${maskPhone(recipient)}: ${formatError(error)}` });
        }
      }
    }
  }

  const reportPath = path.join(REPORT_DIR, `sync-${safeTimestamp(report.startedAt)}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`Report written to ${reportPath}`);

  if (report.errors.length) process.exitCode = 1;
}

async function getQikNetToken() {
  if (!qiknetTokenPromise) {
    qiknetTokenPromise = (async () => {
      const result = await qiknetApiRequest("/auth/login", {
        method: "POST",
        body: { email: credentials.qiknetEmail, password: credentials.qiknetPassword },
        authenticate: false,
      });
      const token = result.token ?? result.accessToken ?? result.data?.token ?? result.data?.accessToken;
      if (!token) throw new Error("QikNet API authentication succeeded without returning a token.");
      return token;
    })();
  }
  return qiknetTokenPromise;
}

async function qiknetApiRequest(apiPath, { method = "GET", body, authenticate = true } = {}) {
  const headers = { accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  if (authenticate) headers.authorization = `Bearer ${await getQikNetToken()}`;
  const response = await fetch(`${qiknetApiBaseUrl}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.message ?? result.error ?? `HTTP ${response.status}`;
    throw new Error(`QikNet API request failed (${detail}).`);
  }
  return result;
}

async function readQikNetApiInventory() {
  log("Reading QikNet branch inventory through the API.");
  const result = await qiknetApiRequest("/super/dashboard");
  const dashboard = result.data && !result.branchInventory ? result.data : result;
  if (!Array.isArray(dashboard.branchInventory)) {
    throw new Error("QikNet API dashboard did not include branch inventory.");
  }
  const records = dashboard.branchInventory.map((branch) => {
    const groups = {};
    for (const [label, voucherType] of Object.entries(config.voucherGroups)) {
      const group = branch.voucherGroups?.find((entry) => entry.voucherType === voucherType);
      const count = Number(group?.total ?? 0);
      groups[label] = { count, status: group?.isLow ? "Low" : "Available", low: Boolean(group?.isLow) };
    }
    return {
      branchCode: branch.branchCode,
      branchName: branch.branchName,
      totalAvailable: Number(branch.totalAvailable ?? Object.values(groups).reduce((sum, group) => sum + group.count, 0)),
      groups,
    };
  });
  if (!records.length) throw new Error("QikNet API returned no branch inventory records.");
  return records;
}

async function uploadQikNetApiInventory(item, vouchers) {
  if (!item.qiknetBranchCode) throw new Error(`QikNet branch code is missing for ${item.branch.qiknetName}.`);
  const result = await qiknetApiRequest(`/super/branches/${encodeURIComponent(item.qiknetBranchCode)}/inventory/text`, {
    method: "POST",
    body: {
      voucherType: config.voucherGroups[item.qiknetGroup],
      voucherCodes: vouchers.join(","),
    },
  });
  const upload = result.data && result.importedRows == null ? result.data : result;
  const importedRows = Number(upload.importedRows);
  if (!Number.isFinite(importedRows) || importedRows <= 0) {
    throw new Error(`QikNet API imported ${Number.isFinite(importedRows) ? importedRows : "an unknown number of"} vouchers.`);
  }
  log(`QikNet API imported ${importedRows} fresh voucher(s) for ${item.branch.qiknetName} / ${item.qiknetGroup}.`);
  return { ...upload, importedRows };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loginQikNet(page) {
  log("Signing in to QikNet.");
  await page.goto(config.qiknet.loginUrl, { waitUntil: "domcontentloaded" });

  const email = page.getByLabel("Email", { exact: true });
  const dashboard = page.getByText("QikNet Control Center", { exact: true });
  let initialState;
  try {
    initialState = await Promise.any([
      email.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "login"),
      dashboard.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "ready"),
    ]);
  } catch {
    throw new Error("Neither the QikNet sign-in form nor dashboard became visible.");
  }

  if (initialState === "login") {
    await enterCredentialsHumanly(
      page,
      email,
      page.getByLabel("Password", { exact: true }),
      credentials.qiknetEmail,
      credentials.qiknetPassword,
      "QikNet",
    );
    await page.getByRole("button", { name: "Login", exact: true }).click();
  }

  await waitForQikNetDashboardOrLoginError(page);
}

async function loginRuijie(page) {
  log("Signing in to Ruijie Cloud.");
  const email = page.getByPlaceholder("Email Address (Account)");
  const stationMarker = page.getByText("QikNet HotSpot", { exact: false }).first();
  const initialState = await openRuijieProjects(page, email, stationMarker);

  if (initialState === "login") {
    const cookieAccept = page.getByRole("button", { name: "Accept", exact: true });
    if (await cookieAccept.isVisible().catch(() => false)) await cookieAccept.click();
    await enterCredentialsHumanly(
      page,
      email,
      page.getByPlaceholder("Password"),
      credentials.ruijieEmail,
      credentials.ruijiePassword,
      "Ruijie",
    );
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await waitForStationOrLoginError(page, stationMarker);
  }

  const updateDialogClose = page.getByRole("button", { name: "Close", exact: true });
  if (await updateDialogClose.isVisible().catch(() => false)) await updateDialogClose.click();
}

async function readQikNetInventory(page) {
  log("Reading QikNet branch inventory.");
  await page.goto(config.qiknet.inventoryUrl, { waitUntil: "domcontentloaded" });
  await dismissQikNetUploadModal(page);
  await page.getByRole("heading", { name: /Inventory By Branch/ }).waitFor({ state: "visible" });
  await page.getByText(/available vouchers/i).first().waitFor({ state: "visible", timeout: navigationTimeout });

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

  if (!records.length) {
    throw new Error(`No QikNet inventory cards were parsed. Visible inventory: ${sanitizePageText(pageSummary).slice(0, 1_500)}`);
  }

  return records;
}

async function readQikNetInventoryWithRetry(page, label) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withTimeout(readQikNetInventory(page), 120_000, label);
    } catch (error) {
      lastError = error;
      log(`${label} was not ready (attempt ${attempt}/3): ${formatError(error)}`);
      if (attempt < 3) await page.waitForTimeout(2_000);
    }
  }

  throw lastError ?? new Error(`${label} failed after 3 attempts.`);
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
          qiknetBranchCode: record.branchCode,
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
  for (const candidate of page.context().pages()) {
    if (candidate !== page) await candidate.close().catch(() => {});
  }
  const email = page.getByPlaceholder("Email Address (Account)");
  const stationMarker = page.getByText("QikNet HotSpot", { exact: false }).first();
  const state = await openRuijieProjects(page, email, stationMarker);
  if (state !== "ready") throw new Error("Ruijie returned to the sign-in page during voucher export.");

  const projectRow = page.getByRole("row").filter({ hasText: item.branch.ruijieProject });
  if ((await projectRow.count()) !== 1) {
    throw new Error(`Expected one Ruijie project named '${item.branch.ruijieProject}', found ${await projectRow.count()}.`);
  }

  const projectsPage = page;
  let openedProjectPage = null;
  for (let attempt = 1; attempt <= 3 && !openedProjectPage; attempt += 1) {
    await dismissRuijieReleaseOverlay(page);
    await projectRow.getByRole("img", { name: "Go to this project" }).click({
      force: true,
      noWaitAfter: true,
    });

    const attemptDeadline = Date.now() + 15_000;
    while (!openedProjectPage && Date.now() < attemptDeadline) {
      const candidates = [...page.context().pages()].reverse();
      for (const candidate of candidates) {
        const projectMenu = candidate.getByText("Auth & Accounts", { exact: true });
        if (await projectMenu.isVisible().catch(() => false)) {
          openedProjectPage = candidate;
          break;
        }
      }
      if (!openedProjectPage) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!openedProjectPage) log(`Ruijie project click did not open ${item.qiknetGroup} (attempt ${attempt}/3).`);
  }

  if (!openedProjectPage) {
    const visibleUrls = page.context().pages().map((candidate) => candidate.url()).join(", ");
    throw new Error(`Ruijie project menu did not become visible. Open pages: ${visibleUrls}`);
  }
  page = openedProjectPage;
  log(`Ruijie project menu opened for ${item.qiknetGroup}.`);

  await dismissRuijieReleaseOverlay(page);
  const authMenu = page.getByText("Auth & Accounts", { exact: true });
  const userManagement = page.getByRole("link", { name: "User Management", exact: true });
  let userManagementVisible = false;
  for (let attempt = 1; attempt <= 3 && !userManagementVisible; attempt += 1) {
    await authMenu.click({ force: true });
    userManagementVisible = await userManagement
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!userManagementVisible) log(`Ruijie Auth menu did not expand (attempt ${attempt}/3).`);
  }
  if (!userManagementVisible) throw new Error("Ruijie User Management menu did not become visible.");
  await userManagement.click({
    force: true,
    noWaitAfter: true,
  });

  const voucherDeadline = Date.now() + navigationTimeout;
  let voucherPage = null;
  while (!voucherPage && Date.now() < voucherDeadline) {
    const candidates = [...page.context().pages()].reverse();
    for (const candidate of candidates) {
      const candidateTab = candidate.getByRole("tab", { name: "Voucher", exact: true });
      if (await candidateTab.isVisible().catch(() => false)) {
        voucherPage = candidate;
        break;
      }
    }
    if (!voucherPage) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!voucherPage) {
    const visibleUrls = page.context().pages().map((candidate) => candidate.url()).join(", ");
    throw new Error(`Ruijie Voucher tab did not become visible. Open pages: ${visibleUrls}`);
  }
  page = voucherPage;
  const voucherTab = page.getByRole("tab", { name: "Voucher", exact: true });
  await voucherTab.click();
  log(`Ruijie Voucher tab opened for ${item.qiknetGroup}.`);

  const panel = page.getByRole("tabpanel", { name: "Voucher" });
  const search = panel.locator('input[placeholder="Voucher/User group"]:visible').last();
  await search.fill(item.ruijieGroup);
  await search.press("Enter");
  log(`Ruijie voucher group selected for ${item.qiknetGroup}.`);

  await panel.getByRole("button", { name: "filter" }).click();
  await page.getByRole("menuitem", { name: "Not used", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(700);

  const countText = await panel.getByText(/\d+\s+in total/i).last().innerText();
  const sourceCount = Number(countText.match(/(\d+)\s+in total/i)?.[1] ?? 0);
  if (!sourceCount) throw new Error("Ruijie returned no unused vouchers for this group.");
  log(`Ruijie reported ${sourceCount} unused voucher(s) for ${item.qiknetGroup}.`);

  const requestedCount = item.qiknetAvailable < config.stockPolicy.criticalBelow
    ? config.stockPolicy.criticalBatchSize
    : config.stockPolicy.batchSize;
  const vouchers = await collectRuijieVoucherCodes(page, panel, Math.min(requestedCount, sourceCount));
  if (!vouchers.length) throw new Error("No unused voucher codes could be read from the Ruijie table.");
  log(`Collected ${vouchers.length} Ruijie voucher code(s) for ${item.qiknetGroup}.`);

  const action = {
    branch: item.branch.qiknetName,
    stationCode: item.branch.stationCode,
    voucherGroup: item.qiknetGroup,
    sourceProject: item.branch.ruijieProject,
    sourceGroup: item.ruijieGroup,
    qiknetAvailableBefore: item.qiknetAvailable,
    qiknetStatusBefore: item.qiknetStatus,
    target: item.target,
    sourceCount,
    requestedCount,
    voucherCount: vouchers.length,
    status: "exported",
  };
  // Voucher codes are bearer credentials. Keep them available in memory for the
  // upload, but make sure JSON.stringify(report) cannot persist them.
  Object.defineProperty(action, "vouchers", { value: vouchers, enumerable: false });
  if (page !== projectsPage) await page.close().catch(() => {});
  return action;
}

async function collectRuijieVoucherCodes(page, panel, limit) {
  const codes = new Set();
  let previousPageSignature = "";

  for (let pageNumber = 1; pageNumber <= 30 && codes.size < limit; pageNumber += 1) {
    // Element UI renders header/body as sibling tables. Extract both in one
    // browser-side pass to avoid expensive Playwright locator enumeration.
    const snapshot = await panel.evaluate((root) => {
      const visible = (element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const headers = [...root.querySelectorAll("th")]
        .filter(visible)
        .map((cell) => cell.textContent?.trim() ?? "");
      const bodyTable = [...root.querySelectorAll("table")]
        .filter(visible)
        .find((candidate) => candidate.querySelector("tbody tr"));
      const rows = bodyTable
        ? [...bodyTable.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")]
          .map((cell) => cell.textContent?.trim() ?? ""))
        : [];
      return { headers, rows };
    });
    if (!snapshot.rows.length) throw new Error("Ruijie voucher table body was not found.");
    const headers = snapshot.headers;
    const codeColumn = headers.findIndex((value) => /voucher\s*(code|number)|^code$/i.test(value));
    if (codeColumn < 0) {
      throw new Error(`Ruijie voucher-code column was not found. Table columns: ${headers.join(", ")}`);
    }

    const pageCodes = snapshot.rows.map((row) => row[codeColumn] ?? "").filter(Boolean);
    const signature = pageCodes.join("|");
    if (pageNumber > 1 && signature === previousPageSignature) break;
    previousPageSignature = signature;

    for (const code of pageCodes) {
      if (/^[A-Za-z0-9_-]{4,64}$/.test(code)) codes.add(code);
      if (codes.size >= limit) break;
    }
    if (codes.size >= limit) break;

    const antNext = panel.locator("li.ant-pagination-next:visible").last();
    const elementNext = panel.locator(".el-pagination .btn-next:visible").last();
    const nextButton = (await antNext.isVisible().catch(() => false))
      ? antNext.locator("button, a").first()
      : (await elementNext.isVisible().catch(() => false))
        ? elementNext
        : panel.getByRole("button", { name: /next/i }).locator(":visible").last();
    if (!(await nextButton.isVisible().catch(() => false))) break;
    const disabled = await nextButton.isDisabled().catch(() => false)
      || (await antNext.getAttribute("class").catch(() => "") ?? "").includes("disabled");
    if (disabled) break;
    await nextButton.click();
    await page.waitForTimeout(700);
  }

  return [...codes].slice(0, limit);
}

async function uploadQikNetInventory(page, item, vouchers) {
  await page.goto(config.qiknet.inventoryUrl, { waitUntil: "domcontentloaded" });
  await dismissQikNetUploadModal(page);
  await page.getByRole("heading", { name: /Inventory By Branch/ }).waitFor({ state: "visible" });
  const card = await findQikNetBranchCardWithRetry(page, item.branch.qiknetName);

  await card.getByRole("button", { name: "Add inventory", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  const overlay = page.locator("div.fixed.inset-0.z-50").last();
  await overlay.waitFor({ state: "visible" });
  const scope = await dialog.isVisible().catch(() => false)
    ? dialog
    : await overlay.isVisible().catch(() => false) ? overlay : page;
  await scope.getByRole("heading", { name: item.branch.qiknetName, exact: true }).waitFor({ state: "visible" });

  const textMode = scope.getByRole("button", { name: "Text upload", exact: true });
  await textMode.waitFor({ state: "visible" });
  await textMode.click({ force: true });
  await page.waitForTimeout(500);

  const labelledGroupSelect = scope.getByLabel(/voucher.*group|profile|category/i).first();
  const groupSelect = await labelledGroupSelect.isVisible().catch(() => false)
    ? labelledGroupSelect
    : scope.getByRole("combobox").first();
  if (await groupSelect.isVisible().catch(() => false)) {
    await groupSelect.selectOption({ label: item.qiknetGroup });
  } else {
    throw new Error("QikNet voucher-group selector was not found in the text-upload form.");
  }

  const voucherText = scope.locator('textarea:visible, [contenteditable="true"]:visible').last();
  const textUploadButton = scope.getByRole("button", { name: /upload.*text.*voucher/i }).last();
  const fileInput = scope.locator('input[type="file"]');
  const acceptsTextFile = await textUploadButton.isVisible().catch(() => false)
    || /text|txt|csv/i.test(await fileInput.getAttribute("accept").catch(() => "") ?? "");
  let temporaryTextPath;
  if (await voucherText.isVisible().catch(() => false)) {
    await voucherText.fill(vouchers.join(","));
  } else if (acceptsTextFile && await fileInput.count()) {
    temporaryTextPath = path.join(DOWNLOAD_DIR, `qiknet-vouchers-${Date.now()}.txt`);
    await writeFile(temporaryTextPath, vouchers.join(","), "utf8");
    await fileInput.setInputFiles(temporaryTextPath);
  } else {
    const controls = await scope.getByRole("button").allInnerTexts().catch(() => []);
    const modeClass = await textMode.getAttribute("class").catch(() => "unknown");
    throw new Error(`QikNet text-upload controls were not activated. Text button class: ${modeClass}. Visible buttons: ${controls.join(", ")}`);
  }

  const uploadButton = scope
    .getByRole("button", { name: /upload.*(text.*)?voucher|add.*voucher|save/i })
    .last();
  const uploadingButton = scope.getByRole("button", { name: /uploading/i }).last();
  const uploadAlreadyStarted = await uploadingButton.isVisible().catch(() => false);
  if (!uploadAlreadyStarted && !(await uploadButton.isVisible().catch(() => false))) {
    const controls = await scope.getByRole("button").allInnerTexts().catch(() => []);
    throw new Error(`QikNet text voucher submit button was not found. Visible buttons: ${controls.join(", ")}`);
  }
  try {
    if (!uploadAlreadyStarted) await uploadButton.click();
    const uploadStarted = await uploadingButton.waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (uploadStarted) {
      await uploadingButton.waitFor({ state: "hidden", timeout: 90_000 });
    }
    await page.waitForTimeout(1_500);
  } finally {
    if (temporaryTextPath) await unlink(temporaryTextPath).catch(() => {});
  }

  const visibleText = await page.locator("body").innerText();
  if (/upload failed|could not upload|invalid file|error occurred/i.test(visibleText)) {
    throw new Error("QikNet reported a text voucher upload error.");
  }
  await dismissQikNetUploadModal(page);
}

async function dismissQikNetUploadModal(page) {
  const overlay = page.locator("div.fixed.inset-0.z-50").last();
  if (!(await overlay.isVisible().catch(() => false))) return;

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
  if (await overlay.isVisible().catch(() => false)) {
    const closeButton = overlay.locator("button").first();
    if (await closeButton.isVisible().catch(() => false)) await closeButton.click({ force: true });
  }
  const closed = await overlay.waitFor({ state: "hidden", timeout: 3_000 }).then(() => true).catch(() => false);
  if (!closed) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
}

async function findQikNetBranchCard(page, branchName) {
  await page.locator("main article article").filter({ hasText: "available vouchers" }).first()
    .waitFor({ state: "visible", timeout: 15_000 });
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

async function findQikNetBranchCardWithRetry(page, branchName) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await findQikNetBranchCard(page, branchName);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        log(`QikNet branch cards were not ready for ${branchName} (attempt ${attempt}/3).`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: /Inventory By Branch/ }).waitFor({ state: "visible" });
      }
    }
  }
  throw lastError;
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

function buildBranchRefillMessages() {
  const labels = {
    "2 Hours Voucher": "2Hr",
    "Daily Voucher": "Day",
    "2 Days Voucher": "2Day",
    "Weekly Voucher": "Week",
    "Monthly Voucher": "Month",
  };
  const byBranch = new Map();
  for (const action of report.actions) {
    if (action.status !== "uploaded" || !Number.isFinite(action.qiknetAvailableAfter)) continue;
    if (action.qiknetAvailableAfter <= action.qiknetAvailableBefore
      || action.qiknetAvailableAfter < config.stockPolicy.target) continue;
    if (!byBranch.has(action.branch)) byBranch.set(action.branch, []);
    byBranch.get(action.branch).push(action);
  }

  return [...byBranch.entries()].map(([branch, actions]) => {
    const changes = actions.map((action) =>
      `${labels[action.voucherGroup] ?? action.voucherGroup} ${action.qiknetAvailableBefore}>${action.qiknetAvailableAfter}`);
    const message = `QikNet refill - ${branch}: ${changes.join("; ")}.`;
    if (message.length > 160) {
      throw new Error(`Refill SMS for ${branch} exceeds 160 characters (${message.length}).`);
    }
    return { branch, message };
  });
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

function splitRecipients(value) {
  return [...new Set(String(value).split(",").map((recipient) => recipient.trim()).filter(Boolean))];
}

async function createPortalContext(browserInstance) {
  const portalContext = await browserInstance.newContext({
    acceptDownloads: true,
    timezoneId: "Africa/Harare",
    locale: "en-ZW",
  });
  portalContext.setDefaultTimeout(actionTimeout);
  portalContext.setDefaultNavigationTimeout(navigationTimeout);
  return portalContext;
}

async function exportRuijieItem(item) {
  return createRuijieApiVouchers(item);
}

async function getRuijieSession() {
  if (!ruijieSessionPromise) {
    ruijieSessionPromise = (async () => {
      const response = await fetch(`${ruijieApiBaseUrl}/service/api/oauth20/client/access_token?token=d63dss0a81e4415a889ac5b78fsc904a`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appid: credentials.ruijieApiAppId, secret: credentials.ruijieApiSecret }),
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.code !== 0 || !result.accessToken) {
        throw new Error(`Ruijie API authentication failed (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
      }
      const account = await ruijieApiRequest("/service/api/org/account/info", { accessToken: result.accessToken });
      if (!account.account || !account.userName) throw new Error("Ruijie API account identity was incomplete.");
      return { accessToken: result.accessToken, tenantName: account.account, userName: account.userName };
    })();
  }
  return ruijieSessionPromise;
}

async function ruijieApiRequest(pathname, { accessToken, method = "GET", params = {}, body } = {}) {
  const url = new URL(pathname, ruijieApiBaseUrl);
  url.searchParams.set("access_token", accessToken);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) {
    throw new Error(`Ruijie API request failed (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
  }
  return result;
}

async function getRuijieProjectId(projectName, accessToken) {
  if (ruijieGroupCache.has(projectName)) return ruijieGroupCache.get(projectName);
  const tree = await ruijieApiRequest("/service/api/group/single/tree", {
    accessToken,
    params: { depth: "BUILDING" },
  });
  const matches = [];
  walkObjects(tree, (value) => {
    if (value?.name === projectName && value.groupId != null) matches.push(value.groupId);
  });
  if (matches.length !== 1) throw new Error(`Expected one Ruijie API project named '${projectName}', found ${matches.length}.`);
  ruijieGroupCache.set(projectName, matches[0]);
  return matches[0];
}

async function getRuijieVoucherProfile(groupId, groupName, accessToken) {
  const key = `${groupId}:${groupName}`;
  if (ruijieProfileCache.has(key)) return ruijieProfileCache.get(key);
  const result = await ruijieApiRequest(`/service/api/intl/usergroup/list/${encodeURIComponent(groupId)}`, {
    accessToken,
    params: { pageIndex: 0, pageSize: 1000 },
  });
  const records = Array.isArray(result.data) ? result.data : [];
  const matches = records.filter((record) => record.name === groupName || record.userGroupName === groupName);
  if (matches.length !== 1 || matches[0].id == null || !matches[0].authProfileId) {
    throw new Error(`Expected one complete Ruijie API voucher profile named '${groupName}', found ${matches.length}.`);
  }
  const profile = { userGroupId: matches[0].id, authProfileId: matches[0].authProfileId };
  ruijieProfileCache.set(key, profile);
  return profile;
}

async function createRuijieApiVouchers(item) {
  const requestedCount = item.qiknetAvailable < config.stockPolicy.criticalBelow
    ? config.stockPolicy.criticalBatchSize
    : config.stockPolicy.batchSize;
  const session = await getRuijieSession();
  const groupId = await getRuijieProjectId(item.branch.ruijieProject, session.accessToken);
  const profile = await getRuijieVoucherProfile(groupId, item.ruijieGroup, session.accessToken);
  const comment = `QikNet automated refill: ${item.branch.qiknetName} / ${item.qiknetGroup}`;
  const vouchers = [];

  if (!dryRun) {
    // Ruijie cannot see when a voucher imported into QikNet has been consumed.
    // Reusing codes that Ruijie still labels "unused" therefore causes QikNet to
    // reject most of a refill as duplicates. Always create fresh codes instead.
    for (let remaining = requestedCount; remaining > 0; remaining -= 100) {
      const quantity = Math.min(100, remaining);
      const result = await ruijieApiRequest(
        `/service/api/intlSamVoucher/create/${encodeURIComponent(session.tenantName)}/${encodeURIComponent(session.userName)}/${encodeURIComponent(groupId)}`,
        {
          accessToken: session.accessToken,
          method: "POST",
          body: {
            quantity,
            profile: profile.authProfileId,
            userGroupId: profile.userGroupId,
            comment,
          },
        },
      );
      if (result.voucherData?.code !== 0) {
        throw new Error(`Ruijie voucher creation failed (voucher API code ${result.voucherData?.code ?? "unknown"}).`);
      }
      const created = result.voucherData?.list?.map((voucher) => voucher.codeNo).filter(Boolean) ?? [];
      if (created.length !== quantity) throw new Error(`Ruijie API created ${created.length} of ${quantity} requested vouchers.`);
      vouchers.push(...created);
    }
    log(`Ruijie API created ${vouchers.length} fresh voucher(s) for ${item.qiknetGroup}.`);
  }

  const action = {
    branch: item.branch.qiknetName,
    stationCode: item.branch.stationCode,
    voucherGroup: item.qiknetGroup,
    sourceProject: item.branch.ruijieProject,
    sourceGroup: item.ruijieGroup,
    qiknetAvailableBefore: item.qiknetAvailable,
    qiknetStatusBefore: item.qiknetStatus,
    target: item.target,
    requestedCount,
    voucherCount: vouchers.length,
    source: "ruijie-api",
    status: dryRun ? "dry-run" : "generated",
  };
  Object.defineProperty(action, "vouchers", { value: vouchers, enumerable: false });
  return action;
}

function walkObjects(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) walkObjects(child, visitor);
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} exceeded ${Math.round(timeoutMs / 1_000)} seconds.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function recordItemError(item, error) {
  const message = formatError(error);
  report.errors.push({
    branch: item.branch.qiknetName,
    voucherGroup: item.qiknetGroup,
    message,
  });
  log(`ERROR ${item.branch.qiknetName} / ${item.qiknetGroup}: ${message}`);
}

async function openRuijieProjects(page, email, stationMarker) {
  await page.bringToFront();
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(config.ruijie.projectsUrl, { waitUntil: "commit", timeout: navigationTimeout });
      return await Promise.any([
        email.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "login"),
        stationMarker.waitFor({ state: "visible", timeout: navigationTimeout }).then(() => "ready"),
      ]);
    } catch (error) {
      lastError = error;
      log(`Ruijie projects page was not ready (attempt ${attempt}/3).`);
      if (attempt < 3) await page.waitForTimeout(attempt * 2_000);
    }
  }

  throw new Error(`Neither the Ruijie sign-in form nor station overview became visible after 3 attempts: ${formatError(lastError)}`);
}

async function dismissRuijieReleaseOverlay(page) {
  const overlay = page.locator(".version-wrapper");
  if (!await overlay.isVisible().catch(() => false)) return;

  const closeControl = overlay.locator('[aria-label="close"], .anticon-close, button').first();
  if (await closeControl.isVisible().catch(() => false)) {
    await closeControl.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await overlay.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
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

async function waitForQikNetDashboardOrLoginError(page) {
  const dashboard = page.getByText("QikNet Control Center", { exact: true });
  const feedback = page.locator('[role="alert"], .alert');
  const deadline = Date.now() + navigationTimeout;
  while (Date.now() < deadline) {
    if (/\/super(?:#|$)/.test(page.url()) && await dashboard.isVisible().catch(() => false)) return;
    const messages = (await feedback.allTextContents().catch(() => []))
      .map((value) => sanitizePageText(value))
      .filter(Boolean);
    if (messages.length) throw new Error(`QikNet login response: ${messages.join(" | ").slice(0, 500)}`);
    await page.waitForTimeout(250);
  }

  const currentUrl = new URL(page.url());
  const safeLocation = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.hash}`;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const summary = sanitizePageText(bodyText).slice(0, 700);
  throw new Error(`QikNet dashboard did not become visible at ${safeLocation}. Visible page: ${summary || "(blank)"}`);
}

async function describeRuijiePage(page) {
  const currentUrl = new URL(page.url());
  const safeLocation = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.hash}`;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const summary = sanitizeRuijieText(bodyText).slice(0, 700);
  return `Ruijie station names did not become visible at ${safeLocation}. Visible page: ${summary || "(blank)"}`;
}

function sanitizeRuijieText(value) {
  return sanitizePageText(value);
}

function sanitizePageText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]")
    .replace(/\b\d{8,}\b/g, "[number hidden]")
    .replace(/\s+/g, " ")
    .trim();
}

async function enterCredentialsHumanly(page, emailField, passwordField, emailValue, passwordValue, provider) {
  await page.waitForTimeout(randomInteger(700, 1_300));
  await emailField.fill("");
  await emailField.click();
  log(`Entering the ${provider} account at human pace.`);
  await page.keyboard.type(emailValue, { delay: randomInteger(65, 105) });
  await page.waitForTimeout(randomInteger(450, 900));
  await passwordField.fill("");
  await passwordField.click();
  log(`Entering the ${provider} password at human pace.`);
  await page.keyboard.type(passwordValue, { delay: randomInteger(70, 115) });
  await page.waitForTimeout(randomInteger(700, 1_300));
  log(`${provider} credentials entered; submitting the form.`);
}

function randomInteger(minimum, maximum) {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
