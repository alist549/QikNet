import assert from "node:assert/strict";
import test from "node:test";
import { decideTargets, isHarareMidnight, normaliseMac, RULES } from "../src/blocker.mjs";
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

test("grace period: a recent sign-in counts as paid even after the voucher expired", async () => {
  const { RULES: rules } = await import("../src/blocker.mjs");
  assert.equal(rules.recentCustomerHours, 48);
});
