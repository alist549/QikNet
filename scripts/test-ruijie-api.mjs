const appId = process.env.RUIJIE_API_APP_ID?.trim();
const secret = process.env.RUIJIE_API_SECRET?.trim();
const configuredBase = process.env.RUIJIE_API_BASE_URL?.trim().replace(/\/$/, "");
const bases = [...new Set([
  configuredBase,
  "https://cloud-eu.ruijienetworks.com",
  "https://cloud-as.ruijienetworks.com",
].filter(Boolean))];

if (!appId || !secret) {
  throw new Error("Set RUIJIE_API_APP_ID and RUIJIE_API_SECRET in .env before running this probe.");
}

const publicLoginToken = "d63dss0a81e4415a889ac5b78fsc904a";
let authenticated;

for (const baseUrl of bases) {
  try {
    const response = await fetch(
      `${baseUrl}/service/api/oauth20/client/access_token?token=${publicLoginToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appid: appId, secret }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.code === 0 && result.accessToken) {
      authenticated = { baseUrl, accessToken: result.accessToken };
      console.log(`Ruijie API authentication succeeded on ${baseUrl}.`);
      break;
    }
    console.log(`Ruijie API authentication was rejected on ${baseUrl} (HTTP ${response.status}, API code ${result.code ?? "unknown"}).`);
  } catch (error) {
    console.log(`Ruijie API host ${baseUrl} could not be reached (${error.name}).`);
  }
}

if (!authenticated) {
  throw new Error("Ruijie API authentication failed on every supported regional host.");
}

const accountUrl = new URL("/service/api/org/account/info", authenticated.baseUrl);
accountUrl.searchParams.set("access_token", authenticated.accessToken);
const accountResponse = await fetch(accountUrl, { signal: AbortSignal.timeout(20_000) });
const accountResult = await accountResponse.json().catch(() => ({}));

if (!accountResponse.ok || accountResult.code !== 0) {
  throw new Error(`Token was issued, but the read-only account probe failed (HTTP ${accountResponse.status}, API code ${accountResult.code ?? "unknown"}).`);
}

console.log("Read-only Ruijie account probe succeeded. API access is operational.");
