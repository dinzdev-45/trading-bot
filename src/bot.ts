import type { Config } from "./config.js";
import { curveProgress, quoteSell, spotPrice, type CurveParams } from "./curve.js";
import type { Executor } from "./exec/types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { evaluateEntry } from "./strategy/entry.js";
import { evaluateExit, type ExitDecision, type Position } from "./strategy/exit.js";
import { TokenTracker, type TokenState } from "./tracker.js";
import { parseFeedMessage, type Socials } from "./types.js";

export interface BotDeps {
  cfg: Config;
  log: Logger;
  executor: Executor;
  journal: Journal;
  subscribe: (mints: string[]) => void;
  unsubscribe: (mints: string[]) => void;
  fetchSocials: (mint: string, uri: string) => Promise<Socials | null>;
  /** Our own wallet (live mode), so our trades don't count as momentum. */
  selfWallet?: string;
}

export interface BotSummary {
  mode: string;
  balanceSol: number;
  realizedPnlSol: number;
  dailyPnlSol: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  openPositions: {
    mint: string;
    symbol: string;
    pnlPct: number;
    valueSol: number;
    solSpent: number;
    solReceived: number;
    openedAt: number;
    curveProgressPct: number;
    tpHit: number;
  }[];
  trackedTokens: number;
}

const DUST_TOKENS = 1;

export class Bot {
  readonly tracker: TokenTracker;
  readonly positions = new Map<string, Position>();
  private readonly socials = new Map<string, Socials | null>();
  /** Mints we already traded or permanently rejected. */
  private readonly done = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly lastRejectLog = new Map<string, number>();
  private readonly curve: CurveParams;

  balance: number;
  realizedPnl = 0;
  dailyPnl = 0;
  private dayKey = "";
  wins = 0;
  losses = 0;
  /** Lifetime feed counters (for the dashboard's feed-health panel). */
  totalEvents = 0;
  totalNewTokens = 0;
  lastEventAt = 0;
  private lastSummaryAt = 0;
  private eventsSinceSummary = 0;
  private newTokensSinceSummary = 0;

  constructor(private readonly d: BotDeps) {
    const { cfg } = d;
    this.balance = cfg.STARTING_BALANCE_SOL;
    this.curve = {
      initialVirtualTokens: cfg.CURVE_INITIAL_VIRTUAL_TOKENS,
      realTokensForSale: cfg.CURVE_REAL_TOKENS_FOR_SALE,
      feeBps: cfg.PUMP_FEE_BPS,
    };
    this.tracker = new TokenTracker({
      bundleWindowSec: cfg.BUNDLE_WINDOW_SEC,
      keepTradesSec: Math.max(cfg.MOMENTUM_WINDOW_SEC, 60),
      selfWallet: d.selfWallet,
    });
  }

  /** Resolves once all in-flight trades have settled (used by replay and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  handle(raw: unknown, now: number): void {
    const ev = parseFeedMessage(raw);
    if (!ev) return;
    this.eventsSinceSummary++;
    this.totalEvents++;
    this.lastEventAt = now;
    this.rollDay(now);

    if (ev.txType === "create") {
      if (this.tracker.tokens.has(ev.mint)) return;
      this.newTokensSinceSummary++;
      this.totalNewTokens++;
      const st = this.tracker.onCreate(ev, now);
      this.d.subscribe([ev.mint]);
      this.evictIfNeeded();
      this.track(
        this.d.fetchSocials(ev.mint, st.uri).then((s) => {
          this.socials.set(ev.mint, s);
        }),
      );
      return;
    }

    if (ev.txType === "migrate") {
      const st = this.tracker.markMigrated(ev.mint);
      const pos = this.positions.get(ev.mint);
      if (st && pos) this.maybeExit(pos, st, now);
      else if (st) this.forget(ev.mint);
      return;
    }

    const st = this.tracker.onTrade(ev, now);
    if (!st) return;
    const pos = this.positions.get(ev.mint);
    if (pos) this.maybeExit(pos, st, now);
    else this.maybeEnter(st, now);
  }

  /** Call about once per second: time-based exits, pruning, periodic summary. */
  tick(now: number): void {
    this.rollDay(now);
    for (const pos of this.positions.values()) {
      const st = this.tracker.tokens.get(pos.mint);
      if (st) this.maybeExit(pos, st, now);
    }
    const maxAgeMs = this.d.cfg.MAX_TOKEN_AGE_SEC * 1000;
    for (const st of this.tracker.tokens.values()) {
      if (this.positions.has(st.mint)) continue;
      if (st.migrated || now - st.createdAt > maxAgeMs) this.forget(st.mint);
    }
    if (now - this.lastSummaryAt >= this.d.cfg.SUMMARY_INTERVAL_SEC * 1000) {
      const first = this.lastSummaryAt === 0;
      this.lastSummaryAt = now;
      const s = this.summary();
      if (!first && this.eventsSinceSummary === 0) {
        this.d.log.warn("no data received from the feed since the last summary; check your internet connection / PumpPortal");
      }
      this.d.log.info(
        `summary: feed ${this.eventsSinceSummary} events, ${this.newTokensSinceSummary} new tokens | balance ${s.balanceSol.toFixed(4)} SOL | realized ${fmtSol(s.realizedPnlSol)} | today ${fmtSol(s.dailyPnlSol)} | ` +
          `trades ${s.closedTrades} (win ${s.winRatePct.toFixed(0)}%) | open ${s.openPositions.length} | tracking ${s.trackedTokens}`,
      );
      this.eventsSinceSummary = 0;
      this.newTokensSinceSummary = 0;
    }
  }

  summary(): BotSummary {
    const open = [...this.positions.values()]
      .filter((p) => p.status === "open")
      .map((p) => {
        const st = this.tracker.tokens.get(p.mint);
        const value = st ? quoteSell({ vSol: st.vSol, vTokens: st.vTokens }, p.tokensHeld, this.curve.feeBps).sol : 0;
        const pnl = p.solReceived + value - p.solSpent;
        return {
          mint: p.mint,
          symbol: p.symbol,
          pnlPct: (pnl / p.solSpent) * 100,
          valueSol: value,
          solSpent: p.solSpent,
          solReceived: p.solReceived,
          openedAt: p.openedAt,
          curveProgressPct: st ? curveProgress(st.vTokens, this.curve) * 100 : 0,
          tpHit: p.nextTpIndex,
        };
      });
    const closed = this.wins + this.losses;
    return {
      mode: this.d.executor.name,
      balanceSol: this.balance,
      realizedPnlSol: this.realizedPnl,
      dailyPnlSol: this.dailyPnl,
      closedTrades: closed,
      wins: this.wins,
      losses: this.losses,
      winRatePct: closed ? (this.wins / closed) * 100 : 0,
      openPositions: open,
      trackedTokens: this.tracker.tokens.size,
    };
  }

  // ---------------------------------------------------------------- entries

  private maybeEnter(st: TokenState, now: number): void {
    const { cfg, log } = this.d;
    if (this.done.has(st.mint)) return;

    const progress = curveProgress(st.vTokens, this.curve);
    const stats = this.tracker.stats(st, now, cfg.MOMENTUM_WINDOW_SEC);
    const decision = evaluateEntry(st, stats, progress, this.socials.get(st.mint), cfg);
    if (!decision.ok) {
      if (decision.permanent) {
        log.debug(`skip ${st.symbol || st.mint}: ${decision.reasons.join(", ")}`);
        this.done.add(st.mint);
        this.forget(st.mint);
      } else if (progress >= cfg.MIN_CURVE_PROGRESS && now - (this.lastRejectLog.get(st.mint) ?? 0) > 30_000) {
        // Near-miss inside the curve window: useful when tuning thresholds.
        this.lastRejectLog.set(st.mint, now);
        log.debug(`wait ${st.symbol || st.mint} @${(progress * 100).toFixed(0)}%: ${decision.reasons.join(", ")}`);
      }
      return;
    }

    // Risk gates
    const openCount = [...this.positions.values()].filter((p) => p.status !== "closed").length;
    if (openCount >= cfg.MAX_OPEN_POSITIONS) return;
    if (this.dailyPnl <= -cfg.MAX_DAILY_LOSS_SOL) return;
    const cost = cfg.BUY_AMOUNT_SOL + cfg.PRIORITY_FEE_SOL + (cfg.USE_JITO ? cfg.JITO_TIP_SOL : 0);
    if (this.d.executor.name === "paper" && this.balance < cost) return;

    this.done.add(st.mint);
    const pos: Position = {
      mint: st.mint,
      symbol: st.symbol,
      status: "opening",
      openedAt: now,
      entryPrice: 0,
      tokensInitial: 0,
      tokensHeld: 0,
      solSpent: 0,
      solReceived: 0,
      peakPrice: 0,
      nextTpIndex: 0,
      preGradSold: false,
      busy: true,
      exitReasons: [],
    };
    this.positions.set(st.mint, pos);
    const signal = {
      progressPct: +(progress * 100).toFixed(1),
      uniqueBuyers: stats.uniqueBuyers,
      buyVolSol: +stats.buyVolumeSol.toFixed(2),
      sellVolSol: +stats.sellVolumeSol.toFixed(2),
      devPct: +stats.devHoldPct.toFixed(1),
      top10Pct: +stats.top10HoldPct.toFixed(1),
      earlyPct: +stats.earlyBuyersHoldPct.toFixed(1),
      ageSec: Math.round(stats.ageSec),
    };
    log.info(`BUY signal ${st.symbol} ${st.mint}`, signal);

    this.track(
      this.d.executor
        .buy(st, cfg.BUY_AMOUNT_SOL)
        .then((fill) => {
          if (fill.tokens <= 0) throw new Error("buy returned 0 tokens");
          pos.status = "open";
          pos.busy = false;
          pos.solSpent = fill.sol;
          pos.tokensInitial = fill.tokens;
          pos.tokensHeld = fill.tokens;
          pos.entryPrice = fill.sol / fill.tokens;
          pos.peakPrice = Math.max(pos.entryPrice, spotPrice(st));
          if (this.d.executor.name === "paper") this.balance -= fill.sol;
          this.d.journal.write({ t: now, type: "buy", mint: st.mint, symbol: st.symbol, sol: fill.sol, tokens: fill.tokens, signature: fill.signature, signal });
          log.info(`BOUGHT ${st.symbol}: ${fill.sol.toFixed(4)} SOL -> ${fill.tokens.toFixed(0)} tokens`, { signature: fill.signature });
        })
        .catch((e: Error) => {
          this.positions.delete(st.mint);
          log.error(`buy ${st.symbol} failed: ${e.message}`);
          this.d.journal.write({ t: now, type: "buy_failed", mint: st.mint, error: e.message });
        }),
    );
  }

  // ------------------------------------------------------------------ exits

  private maybeExit(pos: Position, st: TokenState, now: number): void {
    if (pos.status !== "open") return;
    const price = spotPrice(st);
    if (price > pos.peakPrice) pos.peakPrice = price;
    const progress = curveProgress(st.vTokens, this.curve);
    const stats = this.tracker.stats(st, now, this.d.cfg.MOMENTUM_WINDOW_SEC);
    const decision = evaluateExit(pos, price, progress, st.migrated, stats, now, this.d.cfg);
    if (decision) this.sell(pos, st, decision, now);
  }

  private sell(pos: Position, st: TokenState, dec: ExitDecision, now: number): void {
    const { log } = this.d;
    pos.busy = true;
    log.info(`SELL ${pos.symbol}: ${dec.reason}`, { tokens: Math.round(dec.tokens) });
    this.track(
      this.d.executor
        .sell(st, dec.tokens, dec.closesPosition)
        .then((fill) => {
          pos.tokensHeld = Math.max(0, pos.tokensHeld - fill.tokens);
          pos.solReceived += fill.sol;
          pos.exitReasons.push(dec.reason);
          if (dec.kind === "take-profit") pos.nextTpIndex++;
          if (dec.kind === "pre-graduation") pos.preGradSold = true;
          if (this.d.executor.name === "paper") this.balance += fill.sol;
          this.d.journal.write({ t: now, type: "sell", mint: pos.mint, symbol: pos.symbol, reason: dec.reason, sol: fill.sol, tokens: fill.tokens, signature: fill.signature });
          log.info(`SOLD ${pos.symbol}: ${fill.tokens.toFixed(0)} tokens -> ${fill.sol.toFixed(4)} SOL`, { signature: fill.signature });
          if (dec.closesPosition || pos.tokensHeld <= DUST_TOKENS) this.close(pos, now);
        })
        .catch((e: Error) => {
          log.error(`sell ${pos.symbol} failed (will retry): ${e.message}`);
        })
        .finally(() => {
          pos.busy = false;
        }),
    );
  }

  private close(pos: Position, now: number): void {
    pos.status = "closed";
    pos.closedAt = now;
    const pnl = pos.solReceived - pos.solSpent;
    this.realizedPnl += pnl;
    this.dailyPnl += pnl;
    if (pnl > 0) this.wins++;
    else this.losses++;
    const pct = (pnl / pos.solSpent) * 100;
    this.d.journal.write({
      t: now,
      type: "close",
      mint: pos.mint,
      symbol: pos.symbol,
      solSpent: pos.solSpent,
      solReceived: pos.solReceived,
      pnlSol: pnl,
      pnlPct: pct,
      holdSec: Math.round((now - pos.openedAt) / 1000),
      reasons: pos.exitReasons,
    });
    this.d.log.info(`CLOSED ${pos.symbol}: ${fmtSol(pnl)} (${pct.toFixed(1)}%) after ${Math.round((now - pos.openedAt) / 1000)}s`);
    this.positions.delete(pos.mint);
    this.forget(pos.mint);
    if (this.dailyPnl <= -this.d.cfg.MAX_DAILY_LOSS_SOL) {
      this.d.log.warn(`daily loss limit reached (${fmtSol(this.dailyPnl)}), no new entries until UTC midnight`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private forget(mint: string): void {
    if (this.positions.has(mint)) return;
    if (this.tracker.tokens.has(mint)) {
      this.tracker.remove(mint);
      this.d.unsubscribe([mint]);
    }
    this.socials.delete(mint);
    this.lastRejectLog.delete(mint);
  }

  private evictIfNeeded(): void {
    const max = this.d.cfg.MAX_TRACKED_TOKENS;
    if (this.tracker.tokens.size <= max) return;
    for (const mint of this.tracker.tokens.keys()) {
      if (this.tracker.tokens.size <= max) break;
      if (!this.positions.has(mint)) this.forget(mint);
    }
  }

  private rollDay(now: number): void {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      if (this.dayKey) this.d.log.info(`new UTC day ${key}, daily PnL reset`);
      this.dayKey = key;
      this.dailyPnl = 0;
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}

function fmtSol(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`;
}
