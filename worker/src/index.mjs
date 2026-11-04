import { MONITOR_REPORT_KEY, runMonitor } from "./monitor.mjs";
import { SYNC_REPORT_KEY, runSync } from "./sync.mjs";
// Every named export of this entry module must be a Workers handler, so the
// cron constants live in shared.mjs.
import { MONITOR_CRON, SYNC_CRON, parseBoolean, splitList } from "./shared.mjs";

export default {
  async scheduled(event, env) {
    if (event.cron === MONITOR_CRON) {
      const report = await runMonitor(env, { sendSms: parseBoolean(env.MONITOR_SEND_SMS, false) });
      if (report.errors.length) throw new Error(`Station monitor finished with ${report.errors.length} error(s).`);
      return;
    }
    if (event.cron === SYNC_CRON) {
      const firstOfWindow = new Date(event.scheduledTime).getUTCMinutes() === 30;
      const report = await runSync(env, {
        dryRun: !parseBoolean(env.SYNC_LIVE, false),
        // Only the main run sends the "all stock OK" SMS; follow-ups stay quiet.
        sendHealthySms: firstOfWindow,
      });
      if (report.errors.length) throw new Error(`Voucher sync finished with ${report.errors.length} error(s).`);
      return;
    }
    console.warn(`Unrecognised cron trigger: ${event.cron}`);
  },

  // Manual runs and status, protected by the MANUAL_RUN_TOKEN secret:
  //   GET  /status
  //   POST /run/monitor?send_sms=false
  //   POST /run/sync?dry_run=true&branches=Unit%20M
  //   POST /run/sync?dry_run=false&confirm_live_upload=true
  async fetch(request, env) {
    if (!env.MANUAL_RUN_TOKEN || !(await authorised(request, env.MANUAL_RUN_TOKEN))) {
      return json({ error: "Unauthorised." }, 401);
    }
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status") {
      const [monitor, sync] = await Promise.all([
        env.STATE.get(MONITOR_REPORT_KEY, "json"),
        env.STATE.get(SYNC_REPORT_KEY, "json"),
      ]);
      return json({ monitor, sync });
    }

    if (request.method === "POST" && url.pathname === "/run/monitor") {
      return json(await runMonitor(env, { sendSms: parseBoolean(url.searchParams.get("send_sms"), false) }));
    }

    if (request.method === "POST" && url.pathname === "/run/sync") {
      const dryRun = parseBoolean(url.searchParams.get("dry_run"), true);
      if (!dryRun && !parseBoolean(url.searchParams.get("confirm_live_upload"), false)) {
        return json({ error: "A live sync needs confirm_live_upload=true." }, 400);
      }
      return json(await runSync(env, {
        dryRun,
        branches: splitList(url.searchParams.get("branches")),
        sendHealthySms: false,
      }));
    }

    return json({ error: "Not found." }, 404);
  },
};

async function authorised(request, expected) {
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare digests so the check takes the same time whatever is supplied.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
