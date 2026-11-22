import "dotenv/config";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Bot } from "./bot.js";
import { loadConfig, type Config } from "./config.js";
import { LiveExecutor } from "./exec/live.js";
import { PaperExecutor } from "./exec/paper.js";
import type { Executor } from "./exec/types.js";
import { PumpPortalFeed } from "./feed/pumpportal.js";
import { Journal } from "./journal.js";
import { DashboardHub } from "./dashboard/hub.js";
import { startDashboard } from "./dashboard/server.js";
import { DemoFeed, demoWhales } from "./demo.js";
import { createLogger, type Logger } from "./logger.js";
import { fetchCoinInfo, fetchSocials } from "./metadata.js";
import { replay } from "./replay.js";
import { copyCandidates, defaultScoreOptions, formatScores, scoreFiles } from "./copy/score.js";

interface Feed extends EventEmitter {
  connected: boolean;
  start(): void;
  stop(): void;
  subscribeTrades(mints: string[]): void;
  subscribeAccounts(wallets: string[]): void;
  unsubscribeTrades(mints: string[]): void;
}

async function run(cfg: Config, log: Logger, hub: DashboardHub | undefined, demo = false): Promise<void> {
  let executor: Executor;
  let selfWallet: string | undefined;
  if (cfg.MODE === "live") {
    const live = new LiveExecutor(cfg, log);
    executor = live;
    selfWallet = live.publicKey;
    log.warn(`LIVE MODE: trading real SOL from wallet ${selfWallet}`);
  } else {
    executor = new PaperExecutor(cfg);
    log.info(`paper mode: simulated balance ${cfg.STARTING_BALANCE_SOL} SOL, buy size ${cfg.BUY_AMOUNT_SOL} SOL`);
  }

  const url = cfg.PUMPPORTAL_API_KEY ? `${cfg.PUMPPORTAL_WS_URL}?api-key=${cfg.PUMPPORTAL_API_KEY}` : cfg.PUMPPORTAL_WS_URL;
  const feed: Feed = demo ? new DemoFeed(cfg.copyWallets) : new PumpPortalFeed(url, log);
  if (demo) log.warn("DEMO MODE: synthetic random feed, nothing here is real market data");
  const recorder = new Journal(demo ? "" : cfg.RECORD_FILE);
  const journalPath = join(cfg.DATA_DIR, `trades-${demo ? "demo" : cfg.MODE}.jsonl`);
  const journal = new Journal(journalPath);

  const bot = new Bot({
    cfg,
    log,
    executor,
    journal,
    selfWallet,
    subscribe: (m) => feed.subscribeTrades(m),
    unsubscribe: (m) => feed.unsubscribeTrades(m),
    fetchSocials: async (mint, uri) => {
      if (demo) return Math.random() < 0.85 ? { twitter: "https://x.com/demo" } : null;
      const s = await fetchSocials(uri, cfg.METADATA_TIMEOUT_MS);
      if (cfg.RECORD_FILE) recorder.write({ t: Date.now(), meta: { mint, socials: s } });
      return s;
    },
    fetchCoinInfo: async (mint) => {
      if (demo) return { symbol: "DEMO", socials: { twitter: "https://x.com/demo" } };
      const info = await fetchCoinInfo(mint, cfg.PUMPFUN_API_URL, cfg.METADATA_TIMEOUT_MS);
      if (cfg.RECORD_FILE) recorder.write({ t: Date.now(), meta: { mint, info } });
      return info;
    },
  });

  if (!cfg.MOMENTUM_ENABLED && !bot.copyEnabled) {
    throw new Error("Nothing to do: MOMENTUM_ENABLED=false and COPY_WALLETS is empty");
  }
  if (bot.copyEnabled) {
    feed.subscribeAccounts(cfg.copyWallets.map((w) => w.address));
    log.info(
      `copy trading ON: following ${cfg.copyWallets.length} wallet(s), ${cfg.COPY_BUY_AMOUNT_SOL} SOL per copy` +
        (cfg.MOMENTUM_ENABLED ? "" : " (momentum strategy OFF)"),
      { wallets: cfg.copyWallets.map((w) => w.label) },
    );
  }

  feed.on("message", (m: unknown) => {
    const now = Date.now();
    if (cfg.RECORD_FILE) recorder.write({ t: now, m });
    bot.handle(m, now);
  });
  let dashboardClose: (() => Promise<void>) | undefined;
  if (hub) {
    hub.attach(bot, journal, feed);
    try {
      const srv = await startDashboard(hub, cfg.DASHBOARD_HOST, cfg.DASHBOARD_PORT);
      dashboardClose = srv.close;
      log.info(`dashboard: ${srv.url}  (open this in your browser)`);
    } catch (e) {
      log.warn(`dashboard could not start: ${(e as Error).message}`);
    }
  }
  log.info(`trade journal: ${journalPath} | summary every ${cfg.SUMMARY_INTERVAL_SEC}s | Ctrl+C to stop`);
  const timer = setInterval(() => bot.tick(Date.now()), 1000);
  feed.start();

  const shutdown = async () => {
    log.info("shutting down...");
    clearInterval(timer);
    feed.stop();
    hub?.stop();
    await dashboardClose?.();
    await bot.idle();
    const s = bot.summary();
    log.info("final summary", s);
    if (s.openPositions.length) log.warn(`${s.openPositions.length} position(s) still open — they are NOT sold on shutdown`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function whales(args: string[], cfg: Config): Promise<void> {
  const opt = (name: string, def: number) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    const v = a ? Number(a.split("=")[1]) : def;
    if (!Number.isFinite(v)) throw new Error(`--${name} must be a number`);
    return v;
  };
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) throw new Error("usage: npm run whales -- <recording.jsonl> [more.jsonl ...] [--min-tokens=5] [--top=20] [--min-win=40]");
  const rows = await scoreFiles(files, {
    ...defaultScoreOptions,
    minTokens: opt("min-tokens", defaultScoreOptions.minTokens),
    feeBps: cfg.PUMP_FEE_BPS,
    initialVirtualTokens: cfg.CURVE_INITIAL_VIRTUAL_TOKENS,
    realTokensForSale: cfg.CURVE_REAL_TOKENS_FOR_SALE,
  });
  const top = opt("top", 20);
  console.log(`\n${rows.length} wallet(s) with at least ${opt("min-tokens", 5)} tokens traded in ${files.length} recording(s). Top ${Math.min(top, rows.length)} by PnL:\n`);
  if (rows.length) console.log(formatScores(rows, top));
  const picks = copyCandidates(rows, opt("min-win", 40)).slice(0, 10);
  console.log(
    picks.length
      ? `\nCandidates (profitable, win rate >= ${opt("min-win", 40)}%, not bot-like). Paste into .env, then paper-trade them first:\n\nCOPY_WALLETS=${picks.map((p, i) => `w${i + 1}:${p.wallet}`).join(",")}\n`
      : "\nNo wallet passes the copy filters yet. Record longer (several hours) and try again.\n",
  );
  console.log("Note: past profit in a short recording is a weak signal. Unrealized PnL is valued at the last price seen.");
}

async function main(): Promise<void> {
  const [cmd = "run", file] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === "whales") return whales(process.argv.slice(3), cfg);
  if (cmd === "replay") {
    if (!file) throw new Error("usage: npm run replay -- <recording.jsonl>");
    const clock = { now: 0 };
    const bot = await replay(cfg, createLogger(cfg.LOG_LEVEL, () => clock.now), file, clock);
    console.log("\n=== Replay result ===");
    console.log(JSON.stringify(bot.summary(), null, 2));
    return;
  }
  if (cmd !== "run" && cmd !== "demo") throw new Error(`unknown command "${cmd}" (use run | demo | replay | whales)`);
  const demo = cmd === "demo";
  const runCfg = demo
    ? { ...cfg, MODE: "paper" as const, copyWallets: cfg.copyWallets.length ? cfg.copyWallets : demoWhales() }
    : cfg;
  const hub = cfg.DASHBOARD_ENABLED ? new DashboardHub(runCfg, demo) : undefined;
  await run(runCfg, createLogger(cfg.LOG_LEVEL, Date.now, hub?.onLog), hub, demo);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
