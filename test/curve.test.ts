import { test } from "node:test";
import assert from "node:assert/strict";
import { curveProgress, quoteBuy, quoteSell, spotPrice } from "../src/curve.js";

const P = { initialVirtualTokens: 1_073_000_000, realTokensForSale: 793_100_000, feeBps: 125 };

test("curve progress spans 0..1", () => {
  assert.equal(curveProgress(1_073_000_000, P), 0);
  assert.equal(curveProgress(1_073_000_000 - 793_100_000, P), 1);
  assert.ok(Math.abs(curveProgress(1_073_000_000 - 396_550_000, P) - 0.5) < 1e-9);
});

test("buy then sell loses roughly two fees", () => {
  const r = { vSol: 40, vTokens: 800_000_000 };
  const b = quoteBuy(r, 1, P.feeBps);
  assert.ok(b.tokens > 0);
  assert.ok(spotPrice(b.after) > spotPrice(r));
  const s = quoteSell(b.after, b.tokens, P.feeBps);
  assert.ok(s.sol < 1 && s.sol > 0.97, `got ${s.sol}`);
});
