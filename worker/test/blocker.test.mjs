import assert from "node:assert/strict";
import test from "node:test";
import { decideTargets, isHarareMidnight, normaliseMac, blockHours, checkHealth, dueBlocks, RULES, seedOffences, shouldKick } from "../src/blocker.mjs";
import { rsaEncrypt } from "../src/console.mjs";

const now = new Date("2026-11-04T20:00:00Z");
const site = { groupId: 1, name: "Unit N" };
const portalSsids = ["QIKNET FAST UNLIMITED WIFI"];
const client = (mac, extra = {}) => ({
  mac,
  ssid: "QIKNET FAST UNLIMITED WIFI",
  flowUpDown: 0,
  downRate: 0,
  upRate: 0,
  onlineTime: now.getTime() - 60 * 60_000,
  ...extra,
});

test("paid devices are never blocked, however much they use", () => {
  const { targets, counts } = decideTargets([client("aaaa.bbbb.cccc", { flowUpDown: 900 * 1048576, downRate: 5e6 })], {
    site, portalSsids, paidMacs: new Set(["aaaabbbbcccc"]), allowList: new Set(), now,
  });
  assert.equal(targets.length, 0);
  assert.equal(counts.paid, 1);
});

test("unpaid devices are blocked for data used or live speed, not for idling", () => {
  const clients = [
    client("0000.0000.0001", { flowUpDown: RULES.minDataBytes }),
    client("0000.0000.0002", { downRate: 60_000 }),
    client("0000.0000.0003", { downRate: 60_000, onlineTime: now.getTime() - 2 * 60_000 }),
    client("0000.0000.0004", { flowUpDown: 1_000_000, downRate: 10_000 }),
  ];
  const { targets } = decideTargets(clients, { site, portalSsids, paidMacs: new Set(), allowList: new Set(), now });
  assert.deepEqual(targets.map((t) => t.mac), ["000000000001", "000000000002"]);
});

test("devices whose voucher expired are only blocked while actually moving data", () => {
  const clients = [
    client("0000.0000.0001", { flowUpDown: 500 * 1048576 }),
    client("0000.0000.0002", { flowUpDown: 500 * 1048576, downRate: 80_000 }),
  ];
  const { targets } = decideTargets(clients, {
    site, portalSsids, paidMacs: new Set(), expiredMacs: new Set(["000000000001", "000000000002"]), allowList: new Set(), now,
  });
  assert.deepEqual(targets.map((t) => t.mac), ["000000000002"]);
});

test("allow list and already-blocked devices are skipped", () => {
  const clients = [client("0000.0000.0001", { flowUpDown: 1e9 }), client("0000.0000.0002", { flowUpDown: 1e9 })];
  const { targets } = decideTargets(clients, {
    site, portalSsids, paidMacs: new Set(), allowList: new Set(["000000000001"]), alreadyBlocked: { "1:000000000002": {} }, now,
  });
  assert.equal(targets.length, 0);
});

test("password networks keep the two oldest devices and block the rest", () => {
  const cam = (mac, minutesAgo) => client(mac, { ssid: "QikCam", onlineTime: now.getTime() - minutesAgo * 60_000 });
  const { targets } = decideTargets([cam("0000.0000.0001", 300), cam("0000.0000.0002", 5), cam("0000.0000.0003", 100)], {
    site, portalSsids, paidMacs: new Set(), allowList: new Set(), now,
  });
  assert.deepEqual(targets.map((t) => t.mac), ["000000000002"]);
});

test("midnight is 22:00 UTC", () => {
  assert.equal(isHarareMidnight(new Date("2026-11-04T22:00:00Z")), true);
  assert.equal(isHarareMidnight(new Date("2026-11-04T22:20:00Z")), false);
  assert.equal(isHarareMidnight(new Date("2026-11-04T00:00:00Z")), false);
});

test("MACs normalise across formats and the login password encrypts to a 512-bit block", () => {
  assert.equal(normaliseMac("2A:BB:65:4D:00:6B"), normaliseMac("2abb.654d.006b"));
  assert.equal(atob(rsaEncrypt("secret-password", "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKjeUvf/EGSrhYUApZlJRYYsYIkWQu5tcPc8bkWVqnlAFrJlVWmvgD5zd9Sevi7qNIl9+1NvNlFcqiUGgsevCNMCAwEAAQ==")).length, 64);
});

test("expired vouchers are not active; vouchers without an expiry are", async () => {
  const { activeCodes } = await import("../src/blocker.mjs");
  const codes = activeCodes([
    { voucherCode: "live01", status: 2, expiryTime: now.getTime() + 60_000 },
    { voucherCode: "old001", status: 2, expiryTime: now.getTime() - 60_000 },
    { voucherCode: "staff1", status: 2 },
    { voucherCode: "unused", status: 1 },
  ], now);
  assert.deepEqual([...codes].sort(), ["live01", "staff1"]);
});

test("grace period is 12 hours after expiry", () => {
  assert.equal(RULES.expiryGraceHours, 12);
});

test("kicks a sign-in still online an hour or more after its voucher expired", () => {
  const now = new Date("2026-11-05T17:00:00Z");
  const hoursAgo = (h) => now.getTime() - h * 3_600_000;
  assert.equal(shouldKick({ onlineStatus: 1 }, hoursAgo(1.5), now), true);
  assert.equal(shouldKick({ onlineStatus: 1 }, hoursAgo(20), now), true);
  assert.equal(shouldKick({ onlineStatus: 1 }, hoursAgo(0.5), now), false);
  assert.equal(shouldKick({ onlineStatus: 1 }, hoursAgo(-2), now), false);
  assert.equal(shouldKick({ onlineStatus: 0 }, hoursAgo(3), now), false);
  assert.equal(shouldKick({ onlineStatus: 1 }, null, now), false);
});

test("blocks get longer for repeat offenders, up to 72 hours", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(blockHours), [12, 24, 48, 72, 72]);
});

test("only blocks whose time is up are released", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  const { due, keep } = dueBlocks(
    { "1:a": { mac: "a", releaseAt: "2026-11-07T09:00:00Z" }, "1:b": { mac: "b", releaseAt: "2026-11-07T11:00:00Z" } },
    now,
  );
  assert.deepEqual(due.map((e) => e.mac), ["a"]);
  assert.deepEqual(Object.keys(keep), ["1:b"]);
});

test("offence counts are seeded one per day blocked", () => {
  const offences = seedOffences([
    { mac: "a", at: "2026-11-05T10:00:00Z" },
    { mac: "a", at: "2026-11-06T10:00:00Z" },
    { mac: "a", at: "2026-11-06T12:00:00Z" },
    { mac: "b", at: "2026-11-06T12:00:00Z" },
  ]);
  assert.equal(offences.a.count, 2);
  assert.equal(offences.b.count, 1);
});

test("health alert: one SMS after 3 failed runs, one when it recovers", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, status: "success", code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { BLOCKER_REPORT_SMS: "true", SMSPOP_TOKEN: "t", STOCK_REPORT_RECIPIENT: "263770000000", RETRY_DELAY_MS: "0" };
  const state = {};
  const run = (at, errors) => checkHealth(env, state, { checkedAt: at, errors }, { fetchImpl });
  await run("2026-11-06T16:20:00Z", [{ message: "boom" }]);
  await run("2026-11-06T16:25:00Z", [{ message: "boom" }]);
  assert.equal(sent.length, 0);
  await run("2026-11-06T16:30:00Z", [{ message: "boom" }]);
  assert.equal(sent.length, 1);
  await run("2026-11-06T16:35:00Z", [{ message: "boom" }]);
  assert.equal(sent.length, 1);
  await run("2026-11-06T16:40:00Z", []);
  assert.equal(sent.length, 2);
  await run("2026-11-06T16:45:00Z", []);
  assert.equal(sent.length, 2);
  assert.equal(state.health.failures, 0);
});

test("repeat offenders are blocked at the lower data limit", () => {
  const clients = [
    client("0000.0000.0001", { flowUpDown: 3 * 1048576 }),
    client("0000.0000.0002", { flowUpDown: 3 * 1048576 }),
  ];
  const { targets } = decideTargets(clients, {
    site, portalSsids, paidMacs: new Set(), allowList: new Set(), now,
    offences: { "000000000001": { count: 1, last: now.toISOString() } },
  });
  assert.deepEqual(targets.map((t) => t.mac), ["000000000001"]);
  assert.match(targets[0].reason, /blocked before/);
});
