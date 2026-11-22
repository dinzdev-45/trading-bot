import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseTakeProfitLevels } from "../src/config.js";

test("defaults to paper mode", () => {
  const c = loadConfig({});
  assert.equal(c.MODE, "paper");
  assert.deepEqual(c.takeProfitLevels, [{ multiple: 2, fraction: 0.5 }]);
});

test("live mode needs explicit confirmation and a key", () => {
  assert.throws(() => loadConfig({ MODE: "live" }), /LIVE_TRADING_CONFIRM/);
  assert.throws(() => loadConfig({ MODE: "live", LIVE_TRADING_CONFIRM: "I_UNDERSTAND_REAL_MONEY" }), /WALLET_PRIVATE_KEY/);
});

test("take-profit ladder parsing", () => {
  assert.deepEqual(parseTakeProfitLevels("4:0.25, 2:0.5"), [
    { multiple: 2, fraction: 0.5 },
    { multiple: 4, fraction: 0.25 },
  ]);
  assert.throws(() => parseTakeProfitLevels("2:0.8,3:0.5"), /at most 1/);
  assert.throws(() => parseTakeProfitLevels("0.5:0.5"), /Invalid/);
});

test("rejects inverted progress window", () => {
  assert.throws(() => loadConfig({ MIN_CURVE_PROGRESS: "0.8", MAX_CURVE_PROGRESS: "0.5" }), /lower than/);
});
