// Cloudflare's free Workers plan allows 50 outbound requests per invocation.
// Every fetch goes through a budget so a run can stop cleanly before it hits
// that limit, and the next scheduled run picks up the remaining work.
export const FREE_PLAN_SUBREQUESTS = 50;

// Must match the [triggers] crons in wrangler.toml.
// Every 30 minutes, off the blocker's 5-minute marks, to spare the Ruijie API quota.
export const MONITOR_CRON = "7,37 * * * *";
// 05:30 and 17:30 Africa/Harare, with follow-ups at :38, :46 and :54 that finish any
// voucher groups deferred to stay within the free-plan request limit.
export const SYNC_CRON = "30,38,46,54 3,15 * * *";
// Non-payer blocker every 5 minutes. The 22:00 UTC run (00:00 Africa/Harare)
// first releases the day's blocks and sends the day-end report.
export const BLOCKER_CRON = "*/5 * * * *";

export function createBudget(limit = FREE_PLAN_SUBREQUESTS, fetchImpl = fetch) {
  let used = 0;
  return {
    get used() {
      return used;
    },
    remaining() {
      return limit - used;
    },
    fetch(input, init) {
      if (used >= limit) {
        return Promise.reject(new Error(`Subrequest budget of ${limit} was reached.`));
      }
      used += 1;
      return fetchImpl(input, init);
    },
  };
}

export function requiredEnv(env, name) {
  const value = env[name];
  if (value == null || String(value).trim() === "") throw new Error(`Missing required Worker secret: ${name}`);
  return String(value).trim();
}

export function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function splitList(value) {
  return [...new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function walkObjects(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) walkObjects(child, visitor);
}

export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
