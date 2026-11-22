import "dotenv/config";
import { join } from "node:path";
import { Bot } from "./bot.js";
import { loadConfig, type Config } from "./config.js";
import { LiveExecutor } from "./exec/live.js";
import { PaperExecutor } from "./exec/paper.js";
import type { Executor } from "./exec/types.js";
import { PumpPortalFeed } from "./feed/pumpportal.js";
import { Journal } from "./journal.js";
import { createLogger, type Logger } from "./logger.js";
import { fetchSocials } from "./metadata.js";
import { replay } from "./replay.js";

async function run(cfg: Config, log: Logger): Promise<void> {
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
  const feed = new PumpPortalFeed(url, log);
  const recorder = new Journal(cfg.RECORD_FILE);
  const journal = new Journal(join(cfg.DATA_DIR, `trades-${cfg.MODE}.jsonl`));

  const bot = new Bot({
    cfg,
    log,
    executor,
    journal,
    selfWallet,
    subscribe: (m) => feed.subscribeTrades(m),
    unsubscribe: (m) => feed.unsubscribeTrades(m),
    fetchSocials: async (mint, uri) => {
      const s = await fetchSocials(uri, cfg.METADATA_TIMEOUT_MS);
      if (cfg.RECORD_FILE) recorder.write({ t: Date.now(), meta: { mint, socials: s } });
      return s;
    },
  });

  feed.on("message", (m: unknown) => {
    const now = Date.now();
    if (cfg.RECORD_FILE) recorder.write({ t: now, m });
    bot.handle(m, now);
  });
  log.info(`trade journal: ${join(cfg.DATA_DIR, `trades-${cfg.MODE}.jsonl`)} | summary every ${cfg.SUMMARY_INTERVAL_SEC}s | Ctrl+C to stop`);
  const timer = setInterval(() => bot.tick(Date.now()), 1000);
  feed.start();

  const shutdown = async () => {
    log.info("shutting down...");
    clearInterval(timer);
    feed.stop();
    await bot.idle();
    const s = bot.summary();
    log.info("final summary", s);
    if (s.openPositions.length) log.warn(`${s.openPositions.length} position(s) still open — they are NOT sold on shutdown`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const [cmd = "run", file] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === "replay") {
    if (!file) throw new Error("usage: npm run replay -- <recording.jsonl>");
    const clock = { now: 0 };
    const bot = await replay(cfg, createLogger(cfg.LOG_LEVEL, () => clock.now), file, clock);
    console.log("\n=== Replay result ===");
    console.log(JSON.stringify(bot.summary(), null, 2));
    return;
  }
  if (cmd !== "run") throw new Error(`unknown command "${cmd}" (use run | replay)`);
  await run(cfg, createLogger(cfg.LOG_LEVEL));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
