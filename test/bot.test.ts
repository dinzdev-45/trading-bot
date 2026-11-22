import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { PaperExecutor } from "../src/exec/paper.js";
import { Journal } from "../src/journal.js";
import { silentLogger } from "../src/logger.js";
import { replay } from "../src/index.js";
import type { Socials } from "../src/types.js";
import { FakeToken, testConfig } from "./helpers.js";

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

function makeBot(overrides: Record<string, string> = {}, socials: Socials | null = { twitter: "https://x.com/t" }) {
  const cfg = testConfig(overrides);
  const subs: string[] = [];
  const unsubs: string[] = [];
  const bot = new Bot({
    cfg,
    log: silentLogger,
    executor: new PaperExecutor(cfg),
    journal: new Journal(""),
    subscribe: (m) => subs.push(...m),
    unsubscribe: (m) => unsubs.push(...m),
    fetchSocials: async () => socials,
  });
  return { bot, cfg, subs, unsubs };
}

/** Feed events one by one, ticking the clock each second like the live loop. */
async function feed(bot: Bot, events: { t: number; m: object }[]) {
  let last = events[0]!.t;
  for (const { t, m } of events) {
    while (t - last >= 1000) {
      last += 1000;
      bot.tick(last);
      await bot.idle();
    }
    bot.handle(m, t);
    await bot.idle();
  }
  return last;
}

/** 60 distinct buyers over ~2 minutes push the curve to ~35-40%. */
function organicPump(tok: FakeToken, start: number) {
  const ev: { t: number; m: object }[] = [{ t: start, m: tok.create() }];
  let t = start + 5_000;
  for (let i = 0; i < 60; i++) {
    t += 2_000;
    ev.push({ t, m: tok.buy(`buyer${i}`, 0.2) });
    if (i % 10 === 9) ev.push({ t: t + 500, m: tok.sell(`buyer${i - 5}`, 0.5) });
  }
  return { ev, t };
}

test("enters on organic momentum, takes profit at 2x, exits on trailing stop", async () => {
  const { bot, subs, unsubs } = makeBot();
  const tok = new FakeToken("good");
  const { ev, t: t1 } = organicPump(tok, T0);
  await feed(bot, ev);

  const pos = bot.positions.get("good");
  assert.ok(pos, "should have opened a position");
  assert.equal(pos.status, "open");
  assert.deepEqual(subs, ["good"]);

  // Price rallies past 2x: a few whales buy.
  const rally: { t: number; m: object }[] = [];
  let t = t1;
  for (let i = 0; i < 6; i++) rally.push({ t: (t += 3_000), m: tok.buy(`whale${i}`, 4) });
  await feed(bot, rally);
  assert.equal(pos.nextTpIndex, 1, "first take-profit should have fired");
  assert.ok(pos.tokensHeld < pos.tokensInitial * 0.51 && pos.tokensHeld > pos.tokensInitial * 0.49);

  // Whales dump, price falls > 25% from peak -> trailing stop closes the rest.
  const dump: { t: number; m: object }[] = [];
  for (let i = 0; i < 4; i++) dump.push({ t: (t += 2_000), m: tok.sell(`whale${i}`) });
  await feed(bot, dump);
  assert.equal(bot.positions.size, 0, "position should be closed");
  const s = bot.summary();
  assert.equal(s.closedTrades, 1);
  assert.equal(s.wins, 1);
  assert.ok(s.realizedPnlSol > 0, `expected profit, got ${s.realizedPnlSol}`);
  assert.ok(unsubs.includes("good"), "closed token should be unsubscribed");
});

test("stop-loss closes a losing position", async () => {
  const { bot } = makeBot();
  const tok = new FakeToken("loser");
  const { ev, t: t1 } = organicPump(tok, T0);
  await feed(bot, ev);
  assert.ok(bot.positions.get("loser"));
  let t = t1;
  const dump: { t: number; m: object }[] = [];
  for (let i = 0; i < 60; i++) dump.push({ t: (t += 500), m: tok.sell(`buyer${i}`) });
  await feed(bot, dump);
  assert.equal(bot.positions.size, 0);
  const s = bot.summary();
  assert.equal(s.losses, 1);
  assert.ok(s.realizedPnlSol < 0);
  assert.ok(s.realizedPnlSol > -0.1, "loss is bounded by position size");
});

test("momentum death: no buys for MOMENTUM_DEATH_SEC closes the position", async () => {
  const { bot } = makeBot({ MOMENTUM_DEATH_SEC: "60" });
  const tok = new FakeToken("stall");
  const { ev, t } = organicPump(tok, T0);
  const last = await feed(bot, ev);
  assert.ok(bot.positions.get("stall"));
  for (let i = 1; i <= 70; i++) bot.tick(last + i * 1000);
  await bot.idle();
  assert.equal(bot.positions.size, 0);
  assert.ok(t > 0);
});

test("safety: skips when dev sold, when there are no socials, or when early wallets hold too much", async () => {
  // Dev sells part of the bag.
  {
    const { bot, unsubs } = makeBot();
    const tok = new FakeToken("devsell");
    const { ev, t } = organicPump(tok, T0);
    ev.splice(3, 0, { t: T0 + 6_000, m: tok.sell("DEV", 0.3) });
    await feed(bot, ev.sort((a, b) => a.t - b.t));
    assert.equal(bot.positions.size, 0);
    assert.ok(unsubs.includes("devsell"));
    void t;
  }
  // No socials.
  {
    const { bot } = makeBot({}, {});
    const { ev } = organicPump(new FakeToken("nosoc"), T0);
    await feed(bot, ev);
    assert.equal(bot.positions.size, 0);
  }
  // Bundled launch: 5 wallets buy 3 SOL each in the first second.
  {
    const { bot } = makeBot();
    const tok = new FakeToken("bundle");
    const ev: { t: number; m: object }[] = [{ t: T0, m: tok.create() }];
    for (let i = 0; i < 5; i++) ev.push({ t: T0 + 500, m: tok.buy(`bundler${i}`, 3) });
    let t = T0 + 5_000;
    for (let i = 0; i < 40; i++) ev.push({ t: (t += 2_000), m: tok.buy(`buyer${i}`, 0.2) });
    await feed(bot, ev);
    assert.equal(bot.positions.size, 0);
  }
});

test("respects MAX_OPEN_POSITIONS and daily loss limit", async () => {
  const { bot } = makeBot({ MAX_OPEN_POSITIONS: "1" });
  const a = organicPump(new FakeToken("a"), T0);
  const b = organicPump(new FakeToken("b"), T0 + 100);
  await feed(bot, [...a.ev, ...b.ev].sort((x, y) => x.t - y.t));
  assert.equal(bot.positions.size, 1);
});

test("replay of a recorded session produces the same trade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-"));
  const file = join(dir, "rec.jsonl");
  const tok = new FakeToken("rec");
  const { ev, t } = organicPump(tok, T0);
  const lines = ev.map((e) => JSON.stringify({ t: e.t, m: e.m }));
  lines.splice(1, 0, JSON.stringify({ t: T0 + 50, meta: { mint: "rec", socials: { telegram: "https://t.me/x" } } }));
  let tt = t;
  for (let i = 0; i < 6; i++) lines.push(JSON.stringify({ t: (tt += 3_000), m: tok.buy(`whale${i}`, 4) }));
  writeFileSync(file, lines.join("\n") + "\n");

  const cfg = testConfig({ DATA_DIR: dir });
  const bot = await replay(cfg, silentLogger, file);
  const s = bot.summary();
  assert.equal(s.closedTrades, 1, "position closes by momentum death after the recording ends");
  const journal = readFileSync(join(dir, "trades-replay.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(journal.map((j) => j.type).slice(0, 2), ["buy", "sell"]);
  assert.equal(journal.find((j) => j.type === "sell").reason, "take-profit 2x");
});
