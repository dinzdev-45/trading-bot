import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { loadConfig, parseWalletList } from "../src/config.js";
import { PaperExecutor } from "../src/exec/paper.js";
import { Journal } from "../src/journal.js";
import { silentLogger } from "../src/logger.js";
import type { CoinInfo } from "../src/types.js";
import { FakeToken, testConfig } from "./helpers.js";

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const WHALE = "WhqeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const WHALE2 = "WhqeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";

function makeBot(overrides: Record<string, string> = {}, coinInfo?: (mint: string) => Promise<CoinInfo | null>) {
  const cfg = testConfig({ COPY_WALLETS: `Big:${WHALE},${WHALE2}`, ...overrides });
  const journal: Record<string, unknown>[] = [];
  const j = new Journal("");
  j.onWrite((e) => journal.push(e as Record<string, unknown>));
  const subs: string[] = [];
  const bot = new Bot({
    cfg,
    log: silentLogger,
    executor: new PaperExecutor(cfg),
    journal: j,
    subscribe: (m) => subs.push(...m),
    unsubscribe: () => {},
    fetchSocials: async () => ({ twitter: "https://x.com/t" }),
    fetchCoinInfo: coinInfo,
  });
  return { bot, cfg, journal, subs };
}

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

/** Fresh token, a few organic buys, then the whale buys at ~10s. */
function whaleEntry(tok: FakeToken, whaleSol = 2) {
  const ev: { t: number; m: object }[] = [{ t: T0, m: tok.create() }];
  let t = T0 + 4_000;
  for (let i = 0; i < 5; i++) ev.push({ t: (t += 1_000), m: tok.buy(`b${i}`, 0.2) });
  ev.push({ t: (t += 1_000), m: tok.buy(WHALE, whaleSol) });
  return { ev, t };
}

test("wallet list parsing: labels, comments, files, bad addresses", () => {
  assert.deepEqual(parseWalletList(`Big:${WHALE}, ${WHALE2}  # second\n# comment\n`), [
    { address: WHALE, label: "Big" },
    { address: WHALE2, label: "Whqe…BBB2" },
  ]);
  assert.throws(() => parseWalletList("not-an-address"), /Invalid wallet/);
  const dir = mkdtempSync(join(tmpdir(), "whales-"));
  const file = join(dir, "whales.txt");
  writeFileSync(file, `${WHALE} smart money\n${WHALE2}\n`);
  const cfg = loadConfig({ COPY_WALLETS_FILE: file, COPY_WALLETS: `X:${WHALE}` });
  assert.equal(cfg.copyWallets.length, 2);
  assert.equal(cfg.copyWallets.find((w) => w.address === WHALE)!.label, "smart money");
  assert.equal(loadConfig({}).copyWallets.length, 0);
});

test("copies a whale's buy early (before the momentum zone) and exits when the whale dumps", async () => {
  const { bot, journal } = makeBot();
  const tok = new FakeToken("cpy");
  const { ev, t } = whaleEntry(tok);
  await feed(bot, ev);
  const pos = bot.positions.get("cpy");
  assert.ok(pos, "should copy the whale");
  assert.equal(pos.source, "copy");
  assert.equal(pos.whaleLabel, "Big");
  assert.equal(journal[0]!.type, "buy");
  assert.equal(journal[0]!.source, "copy");

  // Price runs a bit, then the whale sells everything -> we follow.
  const more: { t: number; m: object }[] = [];
  let tt = t;
  for (let i = 0; i < 5; i++) more.push({ t: (tt += 1_000), m: tok.buy(`c${i}`, 0.5) });
  more.push({ t: (tt += 1_000), m: tok.sell(WHALE, 1) });
  await feed(bot, more);
  assert.equal(bot.positions.size, 0, "copy position closed with the whale");
  const close = journal.find((e) => e.type === "close")!;
  assert.equal(close.source, "copy");
  assert.match(String((close.reasons as string[]).at(-1)), /whale Big sold 100%/);
  const w = bot.summary().whales.find((x) => x.address === WHALE)!;
  assert.equal(w.copied, 1);
  assert.equal(w.buys, 1);
  assert.equal(w.sells, 1);
});

test("a small whale sell is mirrored proportionally", async () => {
  const { bot } = makeBot();
  const tok = new FakeToken("part");
  const { ev, t } = whaleEntry(tok);
  await feed(bot, ev);
  const pos = bot.positions.get("part")!;
  const before = pos.tokensHeld;
  await feed(bot, [{ t: t + 1_000, m: tok.sell(WHALE, 0.25) }]);
  assert.equal(pos.status, "open");
  assert.ok(Math.abs(pos.tokensHeld / before - 0.75) < 0.01, `held ${pos.tokensHeld / before}`);
});

test("skips: tiny whale buys, bundled launches, whale-is-dev, and other wallets", async () => {
  {
    const { bot } = makeBot();
    await feed(bot, whaleEntry(new FakeToken("tiny"), 0.1).ev);
    assert.equal(bot.positions.size, 0);
    assert.match(bot.summary().whales[0]!.lastNote, /whale buy 0.10 SOL/);
  }
  {
    const { bot } = makeBot();
    const tok = new FakeToken("bund");
    const ev: { t: number; m: object }[] = [{ t: T0, m: tok.create() }];
    for (let i = 0; i < 5; i++) ev.push({ t: T0 + 500, m: tok.buy(`bundler${i}`, 3) });
    ev.push({ t: T0 + 6_000, m: tok.buy(WHALE, 2) });
    await feed(bot, ev);
    assert.equal(bot.positions.size, 0);
    assert.match(bot.summary().whales[0]!.lastNote, /early\/bundle/);
  }
  {
    const { bot } = makeBot();
    const tok = new FakeToken("devw", WHALE);
    const ev: { t: number; m: object }[] = [{ t: T0, m: tok.create(0.1) }, { t: T0 + 5_000, m: tok.buy(WHALE, 2) }];
    await feed(bot, ev);
    assert.equal(bot.positions.size, 0);
  }
  {
    const { bot } = makeBot();
    const tok = new FakeToken("other");
    await feed(bot, [{ t: T0, m: tok.create() }, { t: T0 + 5_000, m: tok.buy("someone", 5) }]);
    assert.equal(bot.positions.size, 0);
  }
});

test("adopts a token the bot never saw launch, using coin info for metadata", async () => {
  let asked = "";
  const { bot, subs } = makeBot({}, async (mint) => {
    asked = mint;
    return { symbol: "LATE", creator: "DEVX", socials: { twitter: "https://x.com/late" } };
  });
  const tok = new FakeToken("late");
  tok.create(); // created while the bot was offline
  const m = tok.buy(WHALE, 2);
  await feed(bot, [{ t: T0, m }]);
  assert.equal(asked, "late");
  assert.deepEqual(subs, ["late"]);
  const pos = bot.positions.get("late");
  assert.ok(pos, "should copy after coin info arrives");
  assert.equal(pos.symbol, "LATE");
  assert.equal(bot.tracker.tokens.get("late")!.dev, "DEVX");
  assert.equal(bot.tracker.tokens.get("late")!.adopted, true);
});

test("the same trade arriving twice (token + account subscription) is handled once", async () => {
  const { bot } = makeBot();
  const tok = new FakeToken("dup");
  const { ev } = whaleEntry(tok);
  const whaleBuy = ev.at(-1)!;
  ev.push({ t: whaleBuy.t, m: whaleBuy.m });
  await feed(bot, ev);
  assert.equal(bot.summary().whales[0]!.buys, 1);
  assert.equal(bot.positions.size, 1);
});

test("copy positions are capped and momentum can be switched off", async () => {
  const { bot } = makeBot({ COPY_MAX_OPEN_POSITIONS: "1", MOMENTUM_ENABLED: "false" });
  const a = whaleEntry(new FakeToken("ca"));
  const b = whaleEntry(new FakeToken("cb"));
  await feed(bot, [...a.ev, ...b.ev.map((e) => ({ ...e, t: e.t + 100 }))].sort((x, y) => x.t - y.t));
  assert.equal(bot.positions.size, 1);
  assert.match(bot.summary().whales[0]!.lastNote, /max 1 copy positions/);
  assert.deepEqual(bot.summary().strategies, { momentum: false, copy: true });
});

test("COPY_REQUIRE_SOCIALS waits for metadata, then gives up after the TTL", async () => {
  const cfg = testConfig({ COPY_WALLETS: WHALE, COPY_REQUIRE_SOCIALS: "true", COPY_SIGNAL_TTL_SEC: "5" });
  let release: (v: null) => void = () => {};
  const bot = new Bot({
    cfg,
    log: silentLogger,
    executor: new PaperExecutor(cfg),
    journal: new Journal(""),
    subscribe: () => {},
    unsubscribe: () => {},
    fetchSocials: () => new Promise((r) => (release = r)),
  });
  const tok = new FakeToken("slow");
  bot.handle(tok.create(), T0);
  bot.handle(tok.buy(WHALE, 2), T0 + 4_000);
  assert.equal(bot.positions.size, 0);
  for (let i = 1; i <= 7; i++) bot.tick(T0 + 4_000 + i * 1000);
  assert.equal(bot.positions.size, 0);
  assert.match(bot.summary().whales[0]!.lastNote, /metadata not available/);
  release(null);
  await bot.idle();
});

test("wallet scorer ranks profitable wallets and flags snipers and devs", async () => {
  const { WalletScorer, copyCandidates, formatScores } = await import("../src/copy/score.js");
  const scorer = new WalletScorer({ minTokens: 3, feeBps: 125, initialVirtualTokens: 1_073_000_000, realTokensForSale: 793_100_000, botHoldSec: 10 });
  let t = T0;
  for (let i = 0; i < 5; i++) {
    const tok = new FakeToken(`m${i}`, i === 0 ? "smart" : "DEV");
    scorer.add(tok.create(), (t += 1000));
    scorer.add(tok.buy("smart", 1), (t += 1000));
    scorer.add(tok.buy("sniper", 0.5), (t += 1000));
    scorer.add(tok.sell("sniper"), (t += 1000));
    for (let k = 0; k < 10; k++) scorer.add(tok.buy(`crowd${k}`, 1), (t += 1000));
    scorer.add(tok.buy("late", 2), (t += 1000));
    scorer.add(tok.sell("smart"), (t += 60_000));
    for (let k = 0; k < 10; k++) scorer.add(tok.sell(`crowd${k}`), (t += 1000));
    scorer.add(tok.sell("late"), (t += 1000));
  }
  const rows = scorer.results();
  const by = (w: string) => rows.find((r) => r.wallet === w)!;
  assert.equal(rows[0]!.wallet, "smart");
  assert.equal(by("smart").tokens, 4, "the token it created is left out");
  assert.equal(by("smart").winRatePct, 100);
  assert.ok(by("smart").flags.some((f) => f.startsWith("dev of 1")));
  assert.ok(by("late").pnlSol < 0);
  assert.ok(by("sniper").flags.some((f) => f.startsWith("bot-like")));
  const picks = copyCandidates(rows).map((r) => r.wallet);
  assert.equal(picks[0], "smart");
  assert.ok(!picks.includes("sniper") && !picks.includes("late"));
  assert.match(formatScores(rows, 5), /smart/);
});
