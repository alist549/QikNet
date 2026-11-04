import config from "../../config/sync.config.json" with { type: "json" };
import { maskPhone, sendSmsCampaign } from "../../src/sms.mjs";
import { createRuijieClient } from "./ruijie.mjs";
import { createBudget, delay, formatError, log, requiredEnv, splitList } from "./shared.mjs";

export const SYNC_REPORT_KEY = "last-sync-report";
const SMS_ATTEMPTS = 2;
const REFILL_LABELS = {
  "2 Hours Voucher": "2Hr",
  "6 Hours Voucher": "6Hr",
  "Full Day Voucher": "Day",
  "Weekly Voucher": "Week",
};

// Port of src/sync.mjs (API path only). Each low voucher group is created in
// Ruijie and uploaded to QikNet before the next one starts, so a run that
// stops early to stay within the free-plan request limit never leaves
// generated vouchers behind. The next scheduled run continues the work.
export async function runSync(env, {
  dryRun = true,
  branches = [],
  sendHealthySms = true,
  fetchImpl = fetch,
  settleDelayMs = 30_000,
} = {}) {
  const budget = createBudget(undefined, fetchImpl);
  const selected = new Set(branches.map((name) => name.toLowerCase()));
  const report = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    dryRun,
    status: "running",
    inventory: [],
    inventoryAfter: [],
    actions: [],
    deferred: [],
    sms: [],
    errors: [],
    subrequests: 0,
  };

  const stockRecipients = dryRun ? [] : splitList(requiredEnv(env, "STOCK_REPORT_RECIPIENT"));
  const qiknet = createQikNetClient({
    baseUrl: env.QIKNET_API_BASE_URL,
    email: requiredEnv(env, "QIKNET_EMAIL"),
    password: requiredEnv(env, "QIKNET_PASSWORD"),
    fetchImpl: budget.fetch,
  });
  const ruijie = createRuijieClient({
    baseUrl: env.RUIJIE_API_BASE_URL,
    appId: requiredEnv(env, "RUIJIE_API_APP_ID"),
    secret: requiredEnv(env, "RUIJIE_API_SECRET"),
    fetchImpl: budget.fetch,
  });

  try {
    log(`Starting voucher sync (${dryRun ? "DRY RUN" : "LIVE"}).`);
    report.inventory = await qiknet.inventory();
    const work = buildWorkList(report.inventory, selected, report);
    log(`QikNet reported ${work.length} low voucher group(s).`);

    if (work.length === 0) {
      report.status = report.errors.length ? "completed-with-errors" : "healthy";
    } else {
      for (const [index, item] of work.entries()) {
        const requestedCount = item.qiknetAvailable < config.stockPolicy.criticalBelow
          ? config.stockPolicy.criticalBatchSize
          : config.stockPolicy.batchSize;
        const uploadedBranches = new Set(report.actions.filter((a) => a.status === "uploaded").map((a) => a.branch));
        uploadedBranches.add(item.branch.qiknetName);
        const itemCost = ruijie.setupCost(item.ruijieGroup, item.branch.ruijieProject)
          + (dryRun ? 0 : Math.ceil(requestedCount / 100) + 1);
        // Keep enough requests for the after-upload inventory check and the refill SMS.
        const reserve = dryRun ? 0 : 1 + stockRecipients.length * uploadedBranches.size * SMS_ATTEMPTS;
        if (itemCost + reserve > budget.remaining()) {
          report.deferred = work.slice(index).map((entry) => ({ branch: entry.branch.qiknetName, voucherGroup: entry.qiknetGroup }));
          log(`Deferring ${report.deferred.length} voucher group(s) to the next run to stay within the request limit.`);
          break;
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
          voucherCount: 0,
          source: "ruijie-api",
          status: "pending",
        };
        report.actions.push(action);
        try {
          if (dryRun) {
            await ruijie.checkVoucherProfile({ projectName: item.branch.ruijieProject, groupName: item.ruijieGroup });
            action.status = "dry-run";
            log(`[DRY RUN] ${item.branch.qiknetName} / ${item.qiknetGroup}: would create ${requestedCount} voucher(s).`);
            continue;
          }
          // Ruijie cannot see when a voucher imported into QikNet has been used,
          // so reusing "unused" Ruijie codes causes duplicates. Always create fresh codes.
          const vouchers = await ruijie.createVouchers({
            projectName: item.branch.ruijieProject,
            groupName: item.ruijieGroup,
            quantity: requestedCount,
            comment: `QikNet automated refill: ${item.branch.qiknetName} / ${item.qiknetGroup}`,
          });
          action.voucherCount = vouchers.length;
          action.status = "exported";
          action.qiknetImportedRows = await qiknet.upload(item, vouchers);
          action.status = "uploaded";
          log(`Updated ${item.branch.qiknetName} / ${item.qiknetGroup} with ${action.qiknetImportedRows} voucher(s).`);
        } catch (error) {
          action.status = action.status === "exported" ? "upload-failed" : "failed";
          recordItemError(report, item, error);
        }
      }

      if (report.actions.some((action) => action.status === "uploaded")) {
        // QikNet updates inventory asynchronously after a text import.
        await delay(settleDelayMs);
        report.inventoryAfter = await qiknet.inventory();
        verifyReplenishmentTargets(report);
      }
      if (dryRun) report.status = report.errors.length ? "completed-with-errors" : "dry-run-complete";
      else if (report.errors.length) report.status = "completed-with-errors";
      else report.status = report.deferred.length ? "partial" : "updated";
    }
  } catch (error) {
    report.status = "failed";
    report.errors.push({ message: formatError(error) });
    log(`FATAL: ${formatError(error)}`);
  }

  if (!dryRun) {
    const messages = buildRefillMessages(report);
    if (!messages.length && sendHealthySms && report.status === "healthy") {
      messages.push({ branch: "All branches", message: "QikNet: All stock levels are OK." });
    }
    for (const refill of messages) {
      for (const recipient of stockRecipients) {
        try {
          await sendSmsCampaign({
            token: requiredEnv(env, "SMSPOP_TOKEN"),
            campaignUrl: config.sms.campaignUrl,
            senderId: config.sms.senderId,
            recipient,
            campaignName: refill.branch === "All branches" ? "QikNet Stock Healthy" : `QikNet Refill - ${refill.branch}`,
            message: refill.message,
            retries: SMS_ATTEMPTS,
            retryDelayMs: Number(env.RETRY_DELAY_MS ?? 5_000),
            fetchImpl: budget.fetch,
          });
          report.sms.push({ branch: refill.branch, recipient: maskPhone(recipient), messageLength: refill.message.length, status: "sent" });
        } catch (error) {
          report.sms.push({ branch: refill.branch, recipient: maskPhone(recipient), status: "failed", message: formatError(error) });
          report.errors.push({ message: `Refill SMS failed for ${refill.branch} / ${maskPhone(recipient)}: ${formatError(error)}` });
        }
      }
    }
  }

  report.completedAt = new Date().toISOString();
  report.subrequests = budget.used;
  await env.STATE.put(SYNC_REPORT_KEY, JSON.stringify(report));
  log(`Voucher sync finished: ${report.status}, ${report.errors.length} error(s), ${budget.used} request(s).`);
  return report;
}

function createQikNetClient({ baseUrl, email, password, fetchImpl }) {
  const base = String(baseUrl || "https://qiknet-backend-164518585796.us-central1.run.app/api").replace(/\/$/, "");
  let tokenPromise;

  async function request(apiPath, { method = "GET", body, authenticate = true, timeoutMs = 30_000 } = {}) {
    const headers = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (authenticate) headers.authorization = `Bearer ${await token()}`;
    const response = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`QikNet API request failed (${result.message ?? result.error ?? `HTTP ${response.status}`}).`);
    return result;
  }

  function token() {
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const result = await request("/auth/login", { method: "POST", body: { email, password }, authenticate: false });
        const value = result.token ?? result.accessToken ?? result.data?.token ?? result.data?.accessToken;
        if (!value) throw new Error("QikNet API authentication succeeded without returning a token.");
        return value;
      })();
    }
    return tokenPromise;
  }

  async function inventory() {
    const result = await request("/super/dashboard");
    const dashboard = result.data && !result.branchInventory ? result.data : result;
    if (!Array.isArray(dashboard.branchInventory)) throw new Error("QikNet API dashboard did not include branch inventory.");
    const records = dashboard.branchInventory.map((branch) => {
      const groups = {};
      for (const [label, mapping] of Object.entries(config.voucherGroups)) {
        const group = branch.voucherGroups?.find((entry) => entry.voucherType === mapping.qiknetType);
        groups[label] = { count: Number(group?.total ?? 0), status: group?.isLow ? "Low" : "Available", low: Boolean(group?.isLow) };
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

  async function upload(item, vouchers) {
    if (!item.qiknetBranchCode) throw new Error(`QikNet branch code is missing for ${item.branch.qiknetName}.`);
    const result = await request(`/super/branches/${encodeURIComponent(item.qiknetBranchCode)}/inventory/text`, {
      method: "POST",
      timeoutMs: 120_000,
      body: { voucherType: config.voucherGroups[item.qiknetGroup].qiknetType, voucherCodes: vouchers.join(",") },
    });
    const outcome = result.data && result.importedRows == null ? result.data : result;
    const importedRows = Number(outcome.importedRows);
    if (!Number.isFinite(importedRows) || importedRows <= 0) {
      throw new Error(`QikNet API imported ${Number.isFinite(importedRows) ? importedRows : "an unknown number of"} vouchers.`);
    }
    return importedRows;
  }

  return { inventory, upload };
}

function buildWorkList(inventory, selected, report) {
  const work = [];
  for (const branch of config.branches) {
    if (!branch.enabled) continue;
    if (selected.size && !selected.has(branch.qiknetName.toLowerCase())) continue;
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
          ruijieGroup: config.voucherGroups[qiknetGroup].ruijieGroup,
          qiknetAvailable: state.count,
          qiknetStatus: state.status,
          target: config.stockPolicy.target,
        });
      }
    }
  }
  return work;
}

function verifyReplenishmentTargets(report) {
  for (const action of report.actions.filter((entry) => entry.status === "uploaded")) {
    const branch = report.inventoryAfter.find((entry) => entry.branchName.toLowerCase() === action.branch.toLowerCase());
    const after = branch?.groups?.[action.voucherGroup]?.count;
    action.qiknetAvailableAfter = Number.isFinite(after) ? after : null;
    if (!Number.isFinite(after)) {
      report.errors.push({ branch: action.branch, voucherGroup: action.voucherGroup, message: "Could not verify the post-upload QikNet stock count." });
    } else if (after < config.stockPolicy.target) {
      report.errors.push({ branch: action.branch, voucherGroup: action.voucherGroup, message: `Stock reached ${after}, below the target of ${config.stockPolicy.target}.` });
    }
  }
}

function buildRefillMessages(report) {
  const byBranch = new Map();
  for (const action of report.actions) {
    if (action.status !== "uploaded" || !Number.isFinite(action.qiknetAvailableAfter)) continue;
    if (action.qiknetAvailableAfter <= action.qiknetAvailableBefore || action.qiknetAvailableAfter < config.stockPolicy.target) continue;
    if (!byBranch.has(action.branch)) byBranch.set(action.branch, []);
    byBranch.get(action.branch).push(action);
  }
  return [...byBranch.entries()].map(([branch, actions]) => {
    const changes = actions.map((action) => `${REFILL_LABELS[action.voucherGroup] ?? action.voucherGroup} ${action.qiknetAvailableBefore}>${action.qiknetAvailableAfter}`);
    let message = `QikNet refill - ${branch}: ${changes.join("; ")}.`;
    if (message.length > 160) message = `${message.slice(0, 157)}...`;
    return { branch, message };
  });
}

function recordItemError(report, item, error) {
  const message = formatError(error);
  report.errors.push({ branch: item.branch.qiknetName, voucherGroup: item.qiknetGroup, message });
  log(`ERROR ${item.branch.qiknetName} / ${item.qiknetGroup}: ${message}`);
}
