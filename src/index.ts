import "dotenv/config";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Bot } from "./bot.js";
import { loadConfig, type Config } from "./config.js";
import { LiveExecutor } from "./exec/live.js";
import { PaperExecutor } from "./exec/paper.js";
import type { Executor } from "./exec/types.js";
import { PumpPortalFeed } from "./feed/pumpportal.js";
import { Journal } from "./journal.js";
import { createLogger, type Logger } from "./logger.js";
import { fetchSocials } from "./metadata.js";
import type { Socials } from "./types.js";

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

/** Replay a file recorded with RECORD_FILE through the strategy (always paper). */
export async function replay(cfg: Config, log: Logger, file: string, clock: { now: number } = { now: 0 }): Promise<Bot> {
  // Metadata lines are loaded up-front so socials are known when the create event replays.
  const socials = new Map<string, Socials | null>();
  const events: { t: number; m: unknown }[] = [];
  const rl = createInterface({ input: createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.meta) socials.set(entry.meta.mint, entry.meta.socials);
      else if (typeof entry.t === "number") events.push(entry);
    } catch {
      /* skip bad line */
    }
  }

  const bot = new Bot({
    cfg: { ...cfg, MODE: "paper" },
    log,
    executor: new PaperExecutor(cfg),
    journal: new Journal(join(cfg.DATA_DIR, "trades-replay.jsonl")),
    subscribe: () => {},
    unsubscribe: () => {},
    fetchSocials: async (mint) => socials.get(mint) ?? null,
  });

  let lastTick = events[0]?.t ?? 0;
  for (const { t, m } of events) {
    while (t - lastTick >= 1000) {
      lastTick += 1000;
      clock.now = lastTick;
      bot.tick(lastTick);
      await bot.idle();
    }
    clock.now = t;
    bot.handle(m, t);
    await bot.idle();
  }
  // Let time-based exits fire after the recording ends.
  for (let i = 0; i < cfg.MAX_HOLD_SEC + 1 && bot.positions.size; i++) {
    lastTick += 1000;
    clock.now = lastTick;
    bot.tick(lastTick);
    await bot.idle();
  }
  return bot;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
