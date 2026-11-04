// Ruijie Cloud web console client. Some things (portal sign-ins, the Wi-Fi
// blocklist) are only available through the console, not the open API, so this
// signs in the same way the browser does (CAS single sign-on) and then calls
// the console's /webproxy/common/api endpoint with the session cookie.

const DEFAULT_BASE = "https://cloud-eu.ruijienetworks.com";

// Public key the Ruijie login page uses to encrypt the password (JSEncrypt,
// RSA PKCS#1 v1.5). From /sso/assets/ssologin/js/init.intl.js.
const LOGIN_PUBLIC_KEY =
  "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKjeUvf/EGSrhYUApZlJRYYsYIkWQu5tcPc8bkWVqnlAFrJlVWmvgD5zd9Sevi7qNIl9+1NvNlFcqiUGgsevCNMCAwEAAQ==";

export class RuijieConsole {
  constructor({ user, password, baseUrl = DEFAULT_BASE, fetchImpl = fetch }) {
    this.user = user;
    this.password = password;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.cookies = new Map();
  }

  async login() {
    const service = `${this.baseUrl}/webproxy/sso/back?rewrite=off&back=${encodeURIComponent(`${this.baseUrl}/macc5/adminIntl/`)}`;
    const loginUrl = `${this.baseUrl}/sso/login?service=${encodeURIComponent(service)}`;

    const page = await this.request(loginUrl);
    const html = await page.text();
    const form = {};
    for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(match[0])?.[1];
      if (name) form[name] = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
    }
    if (!form.lt || !form.execution) throw new Error("Ruijie sign-in page did not include the login form.");

    const encrypted = rsaEncrypt(this.password, LOGIN_PUBLIC_KEY);
    const validate = await this.request(`${this.baseUrl}/sso/validate/password`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify({ account: this.user, password: encrypted }),
    });
    const check = await validate.json().catch(() => ({}));
    // Never retry a rejected password: repeated failures can lock the account.
    if (check.code !== 0) throw new Error(`Ruijie console rejected the sign-in (code ${check.code}: ${check.msg ?? "no message"}).`);
    if (check.isOpen2FA) throw new Error("Ruijie console account has two-factor sign-in turned on; the blocker can't sign in.");

    const body = new URLSearchParams({
      ...form,
      username: this.user,
      password: encrypted,
      selectedCloud: check.area ?? form.selectedCloud ?? "",
      timeZone: "Africa/Harare",
    });
    const submitted = await this.request(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    let next = submitted.headers.get("location");
    if (!next || !next.includes("ticket=")) throw new Error(`Ruijie sign-in did not return a ticket (HTTP ${submitted.status}).`);
    // Follow the ticket redirect, which sets the /webproxy SESSION cookie.
    for (let hop = 0; hop < 3 && next && next.includes("/webproxy/"); hop += 1) {
      const response = await this.request(new URL(next, this.baseUrl).toString());
      next = response.headers.get("location");
    }
    if (!this.cookies.has("SESSION")) throw new Error("Ruijie sign-in finished without a console session.");
  }

  // Calls a console API through /webproxy/common/api, the way the web app does.
  async api(api, { method = "GET", querys = {}, params, module = "default" } = {}) {
    const payload = { api, method, module, querys: { ...querys, lang: "en", cloudType: "smb" }, authParams: { api, method } };
    if (params !== undefined) payload.params = params;
    const response = await this.request(`${this.baseUrl}/webproxy/common/api?${api}`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: `${this.baseUrl}/macc5/adminIntl/` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Ruijie console ${method} ${api} returned HTTP ${response.status}.`);
    return response.json();
  }

  async request(url, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await this.fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of readSetCookies(response.headers)) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    return response;
  }
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  if (typeof headers.getAll === "function") return headers.getAll("set-cookie");
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

// ---- RSA PKCS#1 v1.5 encryption (what JSEncrypt does), using BigInt ----

export function rsaEncrypt(text, publicKeyBase64) {
  const { modulus, exponent } = parseSpki(base64ToBytes(publicKeyBase64));
  const k = Math.ceil(modulus.toString(16).length / 2);
  const message = new TextEncoder().encode(text);
  if (message.length > k - 11) throw new Error("Password is too long for the Ruijie login key.");
  const block = new Uint8Array(k);
  block[1] = 2;
  const padding = k - message.length - 3;
  const random = new Uint8Array(padding);
  crypto.getRandomValues(random);
  for (let i = 0; i < padding; i += 1) {
    while (random[i] === 0) random[i] = crypto.getRandomValues(new Uint8Array(1))[0];
    block[2 + i] = random[i];
  }
  block.set(message, k - message.length);
  const cipher = modPow(bytesToBigInt(block), exponent, modulus);
  return bytesToBase64(bigIntToBytes(cipher, k));
}

function parseSpki(der) {
  // SubjectPublicKeyInfo -> BIT STRING -> RSAPublicKey SEQUENCE { n, e }
  let offset = 0;
  const read = () => {
    const tag = der[offset++];
    let length = der[offset++];
    if (length & 0x80) {
      const bytes = length & 0x7f;
      length = 0;
      for (let i = 0; i < bytes; i += 1) length = (length << 8) | der[offset++];
    }
    const start = offset;
    offset += length;
    return { tag, start, length };
  };
  const outer = read();
  offset = outer.start;
  const algorithm = read();
  void algorithm;
  const bitString = read();
  offset = bitString.start + 1; // skip the "unused bits" byte
  const rsaKey = read();
  offset = rsaKey.start;
  const n = read();
  const e = read();
  return {
    modulus: bytesToBigInt(der.subarray(n.start, n.start + n.length)),
    exponent: bytesToBigInt(der.subarray(e.start, e.start + e.length)),
  };
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
