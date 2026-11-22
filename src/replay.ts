import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Bot } from "./bot.js";
import type { Config } from "./config.js";
import { PaperExecutor } from "./exec/paper.js";
import { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import type { CoinInfo, Socials } from "./types.js";

/** Replay a file recorded with RECORD_FILE through the strategy (always paper). */
export async function replay(cfg: Config, log: Logger, file: string, clock: { now: number } = { now: 0 }): Promise<Bot> {
  // Metadata lines are loaded up-front so socials are known when the create event replays.
  const socials = new Map<string, Socials | null>();
  const infos = new Map<string, CoinInfo | null>();
  const events: { t: number; m: unknown }[] = [];
  const rl = createInterface({ input: createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.meta && "info" in entry.meta) infos.set(entry.meta.mint, entry.meta.info);
      else if (entry.meta) socials.set(entry.meta.mint, entry.meta.socials);
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
    fetchCoinInfo: async (mint) => infos.get(mint) ?? null,
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
