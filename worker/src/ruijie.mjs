import { delay, formatError, walkObjects } from "./shared.mjs";

// Ruijie's fixed public login token for the OAuth client endpoint; it is not
// an account secret. The account is identified by the app id and secret.
const PUBLIC_LOGIN_TOKEN = "d63dss0a81e4415a889ac5b78fsc904a";

export function createRuijieClient({ baseUrl, appId, secret, fetchImpl, retryDelayMs = 1_500 }) {
  const base = String(baseUrl || "https://cloud-eu.ruijienetworks.com").replace(/\/$/, "");
  let tokenPromise;
  let identityPromise;
  let treePromise;
  const profileCache = new Map();
  const profiledFor = new Set();

  async function accessToken() {
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const response = await fetchImpl(`${base}/service/api/oauth20/client/access_token?token=${PUBLIC_LOGIN_TOKEN}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appid: appId, secret }),
          signal: AbortSignal.timeout(20_000),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.code !== 0 || !result.accessToken) {
          throw new Error(`Ruijie API authentication failed (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
        }
        return result.accessToken;
      })();
      tokenPromise.catch(() => {
        tokenPromise = undefined;
      });
    }
    return tokenPromise;
  }

  async function request(pathname, { method = "GET", params = {}, body, attempts = 1 } = {}) {
    const token = await accessToken();
    let lastFailure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const url = new URL(pathname, base);
        url.searchParams.set("access_token", token);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
        const response = await fetchImpl(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.code === 0) return result;
        lastFailure = `HTTP ${response.status}, API code ${result.code ?? "unknown"}`;
      } catch (error) {
        lastFailure = formatError(error);
        if (/budget/i.test(lastFailure)) break;
      }
      if (attempt < attempts) await delay(attempt * retryDelayMs);
    }
    const detail = params.common_type ? ` (${params.common_type})` : "";
    throw new Error(`Ruijie API request failed for ${pathname}${detail}: ${lastFailure}.`);
  }

  // Project lookups read the tree once per run. The monitor keeps the lenient
  // match it has always used; voucher creation insists on one exact match.
  async function projectTree() {
    if (!treePromise) {
      treePromise = (async () => {
        const tree = await request("/service/api/group/single/tree", { params: { depth: "BUILDING" }, attempts: 2 });
        const lenient = new Map();
        const strict = new Map();
        walkObjects(tree, (value) => {
          const name = value.name ?? value.groupName ?? value.projectName;
          const groupId = value.groupId ?? value.id;
          if (name != null && groupId != null) lenient.set(String(name), groupId);
          if (value.name != null && value.groupId != null) {
            if (!strict.has(value.name)) strict.set(value.name, []);
            strict.get(value.name).push(value.groupId);
          }
        });
        return { lenient, strict };
      })();
    }
    return treePromise;
  }

  async function monitorProjectId(projectName) {
    return (await projectTree()).lenient.get(projectName);
  }

  async function projectId(projectName) {
    const ids = (await projectTree()).strict.get(projectName) ?? [];
    if (ids.length !== 1) throw new Error(`Expected one Ruijie project named '${projectName}', found ${ids.length}.`);
    return ids[0];
  }

  async function identity() {
    if (!identityPromise) {
      identityPromise = (async () => {
        const account = await request("/service/api/org/account/info");
        if (!account.account || !account.userName) throw new Error("Ruijie API account identity was incomplete.");
        return { tenantName: account.account, userName: account.userName };
      })();
    }
    return identityPromise;
  }

  async function voucherProfile(groupId, groupName) {
    const key = `${groupId}:${groupName}`;
    if (!profileCache.has(key)) {
      const result = await request(`/service/api/intl/usergroup/list/${encodeURIComponent(groupId)}`, {
        params: { pageIndex: 0, pageSize: 1000 },
      });
      const records = Array.isArray(result.data) ? result.data : [];
      const matches = records.filter((record) => record.name === groupName || record.userGroupName === groupName);
      if (matches.length !== 1 || matches[0].id == null || !matches[0].authProfileId) {
        throw new Error(`Expected one complete Ruijie voucher profile named '${groupName}', found ${matches.length}.`);
      }
      profileCache.set(key, { userGroupId: matches[0].id, authProfileId: matches[0].authProfileId });
    }
    return profileCache.get(key);
  }

  // How many requests the next voucher-group refill needs before it is cached.
  function setupCost(groupName, projectName) {
    let cost = 0;
    if (!tokenPromise) cost += 1;
    if (!identityPromise) cost += 1;
    if (!treePromise) cost += 1;
    if (!profiledFor.has(`${projectName}\u0000${groupName}`)) cost += 1;
    return cost;
  }

  async function createVouchers({ projectName, groupName, quantity, comment }) {
    const groupId = await projectId(projectName);
    const profile = await voucherProfile(groupId, groupName);
    profiledFor.add(`${projectName}\u0000${groupName}`);
    const { tenantName, userName } = await identity();
    const vouchers = [];
    for (let remaining = quantity; remaining > 0; remaining -= 100) {
      const batch = Math.min(100, remaining);
      const result = await request(
        `/service/api/intlSamVoucher/create/${encodeURIComponent(tenantName)}/${encodeURIComponent(userName)}/${encodeURIComponent(groupId)}`,
        {
          method: "POST",
          body: { quantity: batch, profile: profile.authProfileId, userGroupId: profile.userGroupId, comment },
        },
      );
      if (result.voucherData?.code !== 0) {
        throw new Error(`Ruijie voucher creation failed (voucher API code ${result.voucherData?.code ?? "unknown"}).`);
      }
      const created = result.voucherData?.list?.map((voucher) => voucher.codeNo).filter(Boolean) ?? [];
      if (created.length !== batch) throw new Error(`Ruijie API created ${created.length} of ${batch} requested vouchers.`);
      vouchers.push(...created);
    }
    return vouchers;
  }

  // Read-only check used by dry runs: resolves the project and voucher profile.
  async function checkVoucherProfile({ projectName, groupName }) {
    const groupId = await projectId(projectName);
    await voucherProfile(groupId, groupName);
    profiledFor.add(`${projectName}\u0000${groupName}`);
  }

  return { request, monitorProjectId, projectId, setupCost, createVouchers, checkVoucherProfile };
}
