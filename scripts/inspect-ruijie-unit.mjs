const appId = process.env.RUIJIE_API_APP_ID?.trim();
const secret = process.env.RUIJIE_API_SECRET?.trim();
const baseUrl = (process.env.RUIJIE_API_BASE_URL || "https://cloud-eu.ruijienetworks.com").replace(/\/$/, "");
if (!appId || !secret) throw new Error("Ruijie API credentials are missing.");

const auth = await fetch(`${baseUrl}/service/api/oauth20/client/access_token?token=d63dss0a81e4415a889ac5b78fsc904a`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ appid: appId, secret }),
  signal: AbortSignal.timeout(20_000),
}).then((response) => response.json());
if (auth.code !== 0 || !auth.accessToken) throw new Error(`Ruijie authentication failed (API code ${auth.code ?? "unknown"}).`);

async function apiGet(path, params = {}) {
  const url = new URL(path, baseUrl);
  url.searchParams.set("access_token", auth.accessToken);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) {
    throw new Error(`${path} failed (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
  }
  return result;
}

function walk(value, found = []) {
  if (!value || typeof value !== "object") return found;
  const name = value.name ?? value.groupName ?? value.projectName;
  const id = value.groupId ?? value.id;
  if (name && id && /jambanja|hotspot\s*2/i.test(String(name))) found.push({ name, groupId: id });
  for (const child of Object.values(value)) walk(child, found);
  return found;
}

const tree = await apiGet("/service/api/group/single/tree", { depth: "BUILDING" });
const account = await apiGet("/service/api/org/account/info");
console.log(`Account metadata fields: ${listKeyPaths(account).filter((path) => /tenant|user|account|email|name/i.test(path)).join(", ")}`);
for (const key of ["account", "userName", "defaultTenant", "defaultAccount"]) {
  const value = account[key];
  console.log(`- ${key}: ${value && typeof value === "object" ? `object keys [${Object.keys(value).join(", ")}]` : typeof value}`);
}
const matches = [...new Map(walk(tree).map((entry) => [String(entry.groupId), entry])).values()];
if (!matches.length) throw new Error("Jambanja was not found in the Ruijie group tree.");
console.log("Matching Ruijie projects:");
for (const match of matches) console.log(`- ${match.name} (groupId ${match.groupId})`);

for (const match of matches) {
  const groups = await apiGet(`/service/api/intl/usergroup/list/${encodeURIComponent(match.groupId)}`, {
    pageIndex: "1",
    pageSize: "100",
  });
  const safeEntities = [];
  walkMetadata(groups, safeEntities);
  const unique = [...new Map(safeEntities.map((entry) => [JSON.stringify(entry), entry])).values()];
  console.log(`Voucher/user-group metadata for ${match.name}:`);
  for (const entry of unique) console.log(`- ${JSON.stringify(entry)}`);
}

function walkMetadata(value, found) {
  if (!value || typeof value !== "object") return;
  const name = value.name ?? value.userGroupName ?? value.authProfileName ?? value.profileName;
  const id = value.userGroupId ?? value.authProfileId ?? value.profileId ?? value.id;
  if (name && id) {
    found.push({
      name: String(name),
      id: String(id),
      recordId: value.id == null ? undefined : String(value.id),
      userGroupId: value.userGroupId == null ? undefined : String(value.userGroupId),
      authProfileId: value.authProfileId == null ? undefined : String(value.authProfileId),
      profileId: value.profileId == null ? undefined : String(value.profileId),
    });
  }
  for (const child of Object.values(value)) walkMetadata(child, found);
}

function listKeyPaths(value, prefix = "", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    found.push(path);
    if (child && typeof child === "object" && !Array.isArray(child)) listKeyPaths(child, path, found);
  }
  return found;
}
