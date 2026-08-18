const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;

export async function sendSmsCampaign({
  token,
  campaignUrl,
  senderId,
  recipient,
  message,
  campaignName,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!token) throw new Error("SMSPOP_TOKEN is missing.");
  if (!/^263\d{9}$/.test(recipient)) throw new Error(`Invalid Zimbabwe SMS recipient: ${maskPhone(recipient)}`);
  if (!message?.trim()) throw new Error("SMS message is empty.");

  const payload = {
    name: campaignName,
    message: message.trim(),
    sender_id: senderId,
    contact_import_method: "manual",
    manual_contacts: recipient,
  };

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(campaignUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "QikNet-Automation/1.0",
          Connection: "close",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const raw = await response.text();
      let result = null;
      try {
        result = raw ? JSON.parse(raw) : null;
      } catch {
        result = raw || null;
      }

      if (!response.ok) {
        throw new Error(`SMSPop returned HTTP ${response.status}: ${summarizeResponse(result)}`);
      }

      return { recipient: maskPhone(recipient), status: response.status, result };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(5_000);
    }
  }

  throw lastError ?? new Error("SMS sending failed.");
}

export function maskPhone(phone) {
  return `*******${String(phone).slice(-4)}`;
}

function summarizeResponse(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
