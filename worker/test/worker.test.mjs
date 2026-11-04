import assert from "node:assert/strict";
import test from "node:test";
import config from "../../config/sync.config.json" with { type: "json" };
import worker from "../src/index.mjs";
import { runMonitor, STATE_KEY } from "../src/monitor.mjs";
import { runSync } from "../src/sync.mjs";

const enabled = config.branches.filter((branch) => branch.enabled);

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    STATE: memoryKv(),
    RUIJIE_API_APP_ID: "app",
    RUIJIE_API_SECRET: "secret",
    QIKNET_EMAIL: "ops@example.com",
    QIKNET_PASSWORD: "pw",
    SMSPOP_TOKEN: "sms-token",
    STOCK_REPORT_RECIPIENT: "263770000001",
    DEFAULT_OUTAGE_RECIPIENTS: "263770000002,263770000003",
    SPECIAL_OUTAGE_RECIPIENT: "263770000004",
    MANUAL_RUN_TOKEN: "manual-token",
    RETRY_DELAY_MS: "0",
    ...overrides,
  };
}

// A fake of the Ruijie, QikNet and SMSPop APIs the Worker talks to.
function fakeApis({ downProject, lowGroups = [], uploadsSettle = true } = {}) {
  const calls = [];
  const sms = [];
  const created = [];
  const uploads = [];
  let voucherSeq = 0;
  const groupIds = new Map(enabled.map((branch, index) => [branch.ruijieProject, 1000 + index]));
  const stock = new Map();
  for (const branch of enabled) {
    for (const label of Object.keys(config.voucherGroups)) {
      const low = lowGroups.some(([b, g]) => b === branch.qiknetName && g === label);
      stock.set(`${branch.qiknetName}|${label}`, low ? 40 : 500);
    }
  }

  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.hostname}${url.pathname}`);

    if (url.pathname.endsWith("/oauth20/client/access_token")) return respond({ code: 0, accessToken: "ruijie-token" });
    if (url.pathname.endsWith("/group/single/tree")) {
      return respond({ code: 0, groups: [...groupIds].map(([name, groupId]) => ({ name, groupId })) });
    }
    if (url.pathname.endsWith("/maint/devices")) {
      const project = [...groupIds].find(([, id]) => String(id) === url.searchParams.get("group_id"))[0];
      const type = url.searchParams.get("common_type");
      if (type === "BRIDGE") return respond({ code: 0, deviceList: [] });
      const status = project === downProject && type === "AP" ? "OFF" : "ON";
      return respond({ code: 0, deviceList: [{ onlineStatus: status }, { onlineStatus: status }] });
    }
    if (url.pathname.endsWith("/org/account/info")) return respond({ code: 0, account: "tenant", userName: "user" });
    if (url.pathname.includes("/intl/usergroup/list/")) {
      return respond({
        code: 0,
        data: Object.values(config.voucherGroups).map((group, index) => ({ id: index + 1, name: group.ruijieGroup, authProfileId: `p${index}` })),
      });
    }
    if (url.pathname.includes("/intlSamVoucher/create/")) {
      const { quantity } = JSON.parse(init.body);
      const list = Array.from({ length: quantity }, () => ({ codeNo: `V${(voucherSeq += 1)}` }));
      created.push(quantity);
      return respond({ code: 0, voucherData: { code: 0, list } });
    }
    if (url.pathname.endsWith("/auth/login")) return respond({ token: "qiknet-token" });
    if (url.pathname.endsWith("/super/dashboard")) {
      return respond({
        branchInventory: enabled.map((branch) => ({
          branchCode: branch.stationCode,
          branchName: branch.qiknetName,
          voucherGroups: Object.entries(config.voucherGroups).map(([label, group]) => ({
            voucherType: group.qiknetType,
            total: stock.get(`${branch.qiknetName}|${label}`),
          })),
        })),
      });
    }
    if (url.pathname.includes("/inventory/text")) {
      const body = JSON.parse(init.body);
      const branch = enabled.find((entry) => entry.stationCode === decodeURIComponent(url.pathname.split("/").at(-3)));
      const label = Object.keys(config.voucherGroups).find((key) => config.voucherGroups[key].qiknetType === body.voucherType);
      const count = body.voucherCodes.split(",").length;
      uploads.push({ branch: branch.qiknetName, label, count });
      if (uploadsSettle) stock.set(`${branch.qiknetName}|${label}`, stock.get(`${branch.qiknetName}|${label}`) + count);
      return respond({ importedRows: count });
    }
    if (url.hostname === "smspop.co.zw") {
      sms.push(JSON.parse(init.body));
      return respond({ ok: true });
    }
    return respond({ message: "unexpected" }, 404);
  }

  return { fetchImpl, calls, sms, created, uploads };
}

test("monitor reads every station, stays within the free-plan limit, and stays silent when all are up", async () => {
  const env = baseEnv();
  const apis = fakeApis();
  const report = await runMonitor(env, { sendSms: true, fetchImpl: apis.fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.equal(report.stations.length, enabled.length);
  assert.ok(report.stations.every((station) => station.status === "up"));
  assert.equal(apis.sms.length, 0);
  assert.ok(report.subrequests <= 50, `used ${report.subrequests}`);
  assert.ok(env.STATE.store.has(STATE_KEY));
});

test("monitor alerts once per cycle for a down station and keeps state in KV", async () => {
  const env = baseEnv();
  const apis = fakeApis({ downProject: "QikNet HotSpot 2: Jambanja" });
  const start = new Date("2026-11-04T10:00:00Z");

  const first = await runMonitor(env, { sendSms: true, fetchImpl: apis.fetchImpl, now: () => start });
  assert.deepEqual(first.errors, []);
  // Unit M is a special branch: two default recipients plus the special one.
  assert.equal(apis.sms.length, 3);
  assert.match(apis.sms[0].message, /Unit M is DOWN \(AP 0\/2\)/);

  const again = await runMonitor(env, { sendSms: true, fetchImpl: apis.fetchImpl, now: () => new Date("2026-11-04T10:15:00Z") });
  assert.equal(again.notifications.length, 0, "no repeat inside the 60-minute window");

  const later = await runMonitor(env, { sendSms: true, fetchImpl: apis.fetchImpl, now: () => new Date("2026-11-04T11:01:00Z") });
  assert.equal(later.notifications.length, 3, "repeats once the next alert is due");
});

test("monitor with SMS off never calls SMSPop", async () => {
  const env = baseEnv({ SMSPOP_TOKEN: "" });
  const apis = fakeApis({ downProject: "QikNet HotSpot 1: Unit L" });
  const report = await runMonitor(env, { sendSms: false, fetchImpl: apis.fetchImpl });
  assert.equal(apis.sms.length, 0);
  assert.equal(report.stations.find((s) => s.branchName === "Unit L").status, "down");
});

test("dry-run sync reads only and creates nothing", async () => {
  const env = baseEnv();
  const apis = fakeApis({ lowGroups: [["Unit M", "2 Hours Voucher"], ["Makoni", "Weekly Voucher"]] });
  const report = await runSync(env, { dryRun: true, fetchImpl: apis.fetchImpl, settleDelayMs: 0 });
  assert.equal(report.status, "dry-run-complete");
  assert.equal(report.actions.length, 2);
  assert.equal(apis.created.length, 0);
  assert.equal(apis.uploads.length, 0);
  assert.equal(apis.sms.length, 0);
  assert.ok(apis.calls.every((call) => call.startsWith("GET") || call.includes("access_token") || call.includes("/auth/login")));
});

test("live sync refills low groups, verifies stock and sends a refill SMS", async () => {
  const env = baseEnv();
  const apis = fakeApis({ lowGroups: [["Unit M", "2 Hours Voucher"], ["Unit M", "Weekly Voucher"]] });
  const report = await runSync(env, { dryRun: false, fetchImpl: apis.fetchImpl, settleDelayMs: 0 });
  assert.deepEqual(report.errors, []);
  assert.equal(report.status, "updated");
  assert.deepEqual(apis.uploads.map((u) => u.count), [200, 200]);
  assert.equal(apis.sms.length, 1);
  assert.equal(apis.sms[0].message, "QikNet refill - Unit M: 2Hr 40>240; Week 40>240.");
  assert.ok(!JSON.stringify(report).includes("V1,"), "voucher codes are not stored in the report");
});

test("a large refill is split across runs instead of exceeding the request limit", async () => {
  const lowGroups = enabled.flatMap((branch) => Object.keys(config.voucherGroups).map((label) => [branch.qiknetName, label]));
  const env = baseEnv();
  const apis = fakeApis({ lowGroups });
  const first = await runSync(env, { dryRun: false, fetchImpl: apis.fetchImpl, settleDelayMs: 0 });
  assert.equal(first.status, "partial");
  assert.ok(first.deferred.length > 0);
  assert.ok(first.subrequests <= 50, `used ${first.subrequests}`);

  let runs = 1;
  let last = first;
  while (last.status === "partial" && runs < 20) {
    last = await runSync(env, { dryRun: false, fetchImpl: apis.fetchImpl, settleDelayMs: 0, sendHealthySms: false });
    assert.ok(last.subrequests <= 50, `used ${last.subrequests}`);
    runs += 1;
  }
  assert.equal(apis.uploads.length, lowGroups.length);
  console.log(`  ${lowGroups.length} low groups took ${runs} runs`);
});

test("healthy live sync sends the all-OK SMS only on the main run", async () => {
  const apis = fakeApis();
  await runSync(baseEnv(), { dryRun: false, fetchImpl: apis.fetchImpl, sendHealthySms: false });
  assert.equal(apis.sms.length, 0);
  await runSync(baseEnv(), { dryRun: false, fetchImpl: apis.fetchImpl, sendHealthySms: true });
  assert.equal(apis.sms.length, 1);
  assert.equal(apis.sms[0].message, "QikNet: All stock levels are OK.");
});

test("manual endpoints require the token and refuse an unconfirmed live sync", async () => {
  const env = baseEnv();
  const denied = await worker.fetch(new Request("https://w.example/status"), env);
  assert.equal(denied.status, 401);
  const wrong = await worker.fetch(new Request("https://w.example/status", { headers: { authorization: "Bearer nope" } }), env);
  assert.equal(wrong.status, 401);
  const headers = { authorization: "Bearer manual-token" };
  const status = await worker.fetch(new Request("https://w.example/status", { headers }), env);
  assert.equal(status.status, 200);
  const live = await worker.fetch(new Request("https://w.example/run/sync?dry_run=false", { method: "POST", headers }), env);
  assert.equal(live.status, 400);
});
