import { existsSync, readFileSync } from "node:fs";
import type { Bot, BotSummary } from "../bot.js";
import type { Config } from "../config.js";
import type { Journal } from "../journal.js";
import type { LogEntry } from "../logger.js";

export interface EquityPoint {
  t: number;
  /** Balance + current value of open positions (paper), in SOL. */
  equity: number;
  balance: number;
  realized: number;
}

export interface FeedHealth {
  connected: boolean;
  eventsPerMin: number;
  newTokensPerMin: number;
  lastEventAgoSec: number | null;
  totalEvents: number;
  totalNewTokens: number;
}

export interface DashboardState {
  now: number;
  startedAt: number;
  summary: BotSummary;
  feed: FeedHealth;
  settings: Record<string, string | number | boolean>;
}

export interface FeedStatus {
  connected: boolean;
}

type Listener = (event: string, data: unknown) => void;

const MAX_LOGS = 300;
const MAX_TRADES = 1000;
const EQUITY_EVERY_MS = 5_000;
const MAX_EQUITY = (24 * 3600 * 1000) / EQUITY_EVERY_MS; // 24h of points
const TRADE_TYPES = new Set(["buy", "sell", "close", "buy_failed"]);

/**
 * In-memory state for the dashboard: equity curve, trade feed, recent log lines and feed health.
 * Only ever exposes a safe subset of the config (no keys, no RPC URL).
 */
export class DashboardHub {
  readonly startedAt = Date.now();
  readonly logs: LogEntry[] = [];
  readonly trades: Record<string, unknown>[] = [];
  readonly equity: EquityPoint[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly feedSamples: { t: number; events: number; tokens: number }[] = [];
  private bot?: Bot;
  private feed?: FeedStatus;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly demo = false,
  ) {}

  /** Logger sink: keep recent lines and stream them. */
  readonly onLog = (e: LogEntry): void => {
    this.logs.push(e);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.emit("log", e);
  };

  attach(bot: Bot, journal: Journal, feed: FeedStatus): void {
    this.bot = bot;
    this.feed = feed;
    this.loadHistory(journal.path);
    journal.onWrite((entry) => {
      const e = entry as Record<string, unknown>;
      if (!TRADE_TYPES.has(String(e.type))) return;
      this.trades.push(e);
      if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
      this.emit("trade", e);
    });
    this.sample(Date.now());
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - (this.equity.at(-1)?.t ?? 0) >= EQUITY_EVERY_MS) this.emit("equity", this.sample(now));
      if (this.listeners.size) this.emit("state", this.state(now));
    }, 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(now = Date.now()): DashboardState {
    if (!this.bot) throw new Error("dashboard not attached to a bot");
    return {
      now,
      startedAt: this.startedAt,
      summary: this.bot.summary(),
      feed: this.feedHealth(now),
      settings: this.settings(),
    };
  }

  snapshot(now = Date.now()) {
    return { state: this.state(now), equity: this.equity, trades: this.trades, logs: this.logs };
  }

  private sample(now: number): EquityPoint {
    const bot = this.bot!;
    const s = bot.summary();
    const open = s.openPositions.reduce((a, p) => a + p.valueSol, 0);
    const point = { t: now, equity: s.balanceSol + open, balance: s.balanceSol, realized: s.realizedPnlSol };
    this.equity.push(point);
    if (this.equity.length > MAX_EQUITY) this.equity.splice(0, this.equity.length - MAX_EQUITY);
    this.feedSamples.push({ t: now, events: bot.totalEvents, tokens: bot.totalNewTokens });
    while (this.feedSamples.length > 2 && now - this.feedSamples[1]!.t >= 60_000) this.feedSamples.shift();
    return point;
  }

  private feedHealth(now: number): FeedHealth {
    const bot = this.bot!;
    const first = this.feedSamples[0];
    const spanMin = first ? Math.max((now - first.t) / 60_000, 1 / 60) : 1;
    return {
      connected: this.feed?.connected ?? false,
      eventsPerMin: first ? Math.round((bot.totalEvents - first.events) / spanMin) : 0,
      newTokensPerMin: first ? Math.round((bot.totalNewTokens - first.tokens) / spanMin) : 0,
      lastEventAgoSec: bot.lastEventAt ? Math.max(0, Math.round((now - bot.lastEventAt) / 1000)) : null,
      totalEvents: bot.totalEvents,
      totalNewTokens: bot.totalNewTokens,
    };
  }

  private settings(): Record<string, string | number | boolean> {
    const c = this.cfg;
    return {
      mode: this.bot?.summary().mode ?? c.MODE,
      demo: this.demo,
      startingBalanceSol: c.STARTING_BALANCE_SOL,
      buyAmountSol: c.BUY_AMOUNT_SOL,
      maxOpenPositions: c.MAX_OPEN_POSITIONS,
      maxDailyLossSol: c.MAX_DAILY_LOSS_SOL,
      curveWindow: `${Math.round(c.MIN_CURVE_PROGRESS * 100)}–${Math.round(c.MAX_CURVE_PROGRESS * 100)}%`,
      takeProfit: c.TAKE_PROFIT_LEVELS,
      stopLossPct: c.STOP_LOSS_PCT,
      trailingStopPct: c.TRAILING_STOP_PCT,
      useJito: c.USE_JITO,
      momentumEnabled: c.MOMENTUM_ENABLED,
      copyWallets: c.copyWallets.length,
      copyBuyAmountSol: c.COPY_BUY_AMOUNT_SOL,
      copyMaxOpen: c.COPY_MAX_OPEN_POSITIONS,
      copyExitOnWhaleSell: c.COPY_EXIT_ON_WHALE_SELL,
    };
  }

  /** Previous runs' trades from the journal file, so history survives restarts. */
  private loadHistory(path: string): void {
    if (!path || !existsSync(path)) return;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines.slice(-MAX_TRADES * 2)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (TRADE_TYPES.has(e.type)) this.trades.push(e);
      } catch {
        /* skip bad line */
      }
    }
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
  }

  private emit(event: string, data: unknown): void {
    for (const fn of this.listeners) fn(event, data);
  }
}
