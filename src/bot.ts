import type { Config } from "./config.js";
import { curveProgress, quoteSell, spotPrice, type CurveParams } from "./curve.js";
import type { Executor } from "./exec/types.js";
import type { Journal } from "./journal.js";
import type { Logger } from "./logger.js";
import { evaluateEntry } from "./strategy/entry.js";
import { evaluateCopyEntry, type CopySignal } from "./strategy/copy.js";
import { evaluateExit, type ExitDecision, type Position, type PositionSource } from "./strategy/exit.js";
import { TokenTracker, type TokenState } from "./tracker.js";
import { parseFeedMessage, type CoinInfo, type Socials, type TradeEvent } from "./types.js";
import type { WatchedWallet } from "./config.js";

export interface BotDeps {
  cfg: Config;
  log: Logger;
  executor: Executor;
  journal: Journal;
  subscribe: (mints: string[]) => void;
  unsubscribe: (mints: string[]) => void;
  fetchSocials: (mint: string, uri: string) => Promise<Socials | null>;
  /** Copy trading: details of a token we never saw created. Optional; without it such tokens have no metadata. */
  fetchCoinInfo?: (mint: string) => Promise<CoinInfo | null>;
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
    source: PositionSource;
    whale?: string;
    whaleLabel?: string;
  }[];
  trackedTokens: number;
  strategies: { momentum: boolean; copy: boolean };
  /** Watched whale wallets and what they did this session. */
  whales: WhaleActivity[];
}

export interface WhaleActivity {
  address: string;
  label: string;
  buys: number;
  sells: number;
  copied: number;
  skipped: number;
  lastAt: number;
  /** Short description of the latest thing the bot did with this whale's trade. */
  lastNote: string;
}

const DUST_TOKENS = 1;
const MAX_SEEN_TRADES = 20_000;

export class Bot {
  readonly tracker: TokenTracker;
  readonly positions = new Map<string, Position>();
  private readonly socials = new Map<string, Socials | null>();
  /** Mints we already traded or permanently rejected. */
  private readonly done = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly lastRejectLog = new Map<string, number>();
  private readonly curve: CurveParams;
  /** Copy trading: watched wallets, pending signals, and mints already copied. */
  private readonly whales = new Map<string, WatchedWallet>();
  private readonly whaleSet = new Set<string>();
  readonly whaleActivity = new Map<string, WhaleActivity>();
  private readonly pendingCopies = new Map<string, CopySignal>();
  private readonly copied = new Set<string>();
  private readonly coinInfoPending = new Set<string>();
  /** Trade keys already handled: the same trade can arrive via token and account subscriptions. */
  private readonly seenTrades = new Set<string>();

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
  /** Latest time seen in handle()/tick() (the bot never reads the wall clock itself). */
  private clock = 0;
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
    for (const w of cfg.copyWallets) {
      if (w.address === d.selfWallet) continue;
      this.whales.set(w.address, w);
      this.whaleSet.add(w.address);
      this.whaleActivity.set(w.address, { address: w.address, label: w.label, buys: 0, sells: 0, copied: 0, skipped: 0, lastAt: 0, lastNote: "" });
    }
  }

  get copyEnabled(): boolean {
    return this.whales.size > 0;
  }

  /** Resolves once all in-flight trades have settled (used by replay and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  handle(raw: unknown, now: number): void {
    const ev = parseFeedMessage(raw);
    if (!ev) return;
    this.clock = Math.max(this.clock, now);
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

    if (ev.signature) {
      const key = `${ev.signature}:${ev.traderPublicKey}:${ev.mint}:${ev.txType}`;
      if (this.seenTrades.has(key)) return;
      this.seenTrades.add(key);
      if (this.seenTrades.size > MAX_SEEN_TRADES) {
        const first = this.seenTrades.values().next().value;
        if (first !== undefined) this.seenTrades.delete(first);
      }
    }

    const whale = this.whales.get(ev.traderPublicKey);
    const prevBalance = this.tracker.tokens.get(ev.mint)?.balances.get(ev.traderPublicKey) ?? 0;
    let st = this.tracker.onTrade(ev, now);
    if (!st && whale && ev.txType === "buy") st = this.adopt(ev, now);
    if (!st) {
      if (whale) this.noteWhale(whale, ev, now, `${ev.txType === "buy" ? "bought" : "sold"} ${shortMint(ev.mint)} (token not tracked)`, true);
      return;
    }
    if (whale) this.onWhaleTrade(whale, ev, st, prevBalance, now);

    const pos = this.positions.get(ev.mint);
    if (pos) this.maybeExit(pos, st, now);
    else {
      const sig = this.pendingCopies.get(ev.mint);
      if (sig) this.tryCopy(sig, now);
      if (!this.positions.has(ev.mint)) this.maybeEnter(st, now);
    }
  }

  /** Call about once per second: time-based exits, pruning, periodic summary. */
  tick(now: number): void {
    this.clock = Math.max(this.clock, now);
    this.rollDay(now);
    for (const pos of this.positions.values()) {
      const st = this.tracker.tokens.get(pos.mint);
      if (st) this.maybeExit(pos, st, now);
    }
    for (const sig of [...this.pendingCopies.values()]) this.tryCopy(sig, now);
    const maxAgeMs = this.d.cfg.MAX_TOKEN_AGE_SEC * 1000;
    for (const st of this.tracker.tokens.values()) {
      if (this.positions.has(st.mint) || this.pendingCopies.has(st.mint)) continue;
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
          source: p.source,
          whale: p.whale,
          whaleLabel: p.whaleLabel,
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
      strategies: { momentum: this.d.cfg.MOMENTUM_ENABLED, copy: this.copyEnabled },
      whales: [...this.whaleActivity.values()].map((w) => ({ ...w })),
    };
  }

  // ---------------------------------------------------------------- entries

  private maybeEnter(st: TokenState, now: number): void {
    const { cfg, log } = this.d;
    if (!cfg.MOMENTUM_ENABLED || st.adopted) return;
    if (this.done.has(st.mint)) return;

    const progress = curveProgress(st.vTokens, this.curve);
    const stats = this.tracker.stats(st, now, cfg.MOMENTUM_WINDOW_SEC);
    const decision = evaluateEntry(st, stats, progress, this.socials.get(st.mint), cfg);
    if (!decision.ok) {
      if (decision.permanent) {
        log.debug(`skip ${st.symbol || st.mint}: ${decision.reasons.join(", ")}`);
        this.done.add(st.mint);
        // With copy trading on, keep watching it: a whale may still buy, and holder data matters then.
        if (!this.copyEnabled) this.forget(st.mint);
      } else if (progress >= cfg.MIN_CURVE_PROGRESS && now - (this.lastRejectLog.get(st.mint) ?? 0) > 30_000) {
        // Near-miss inside the curve window: useful when tuning thresholds.
        this.lastRejectLog.set(st.mint, now);
        log.debug(`wait ${st.symbol || st.mint} @${(progress * 100).toFixed(0)}%: ${decision.reasons.join(", ")}`);
      }
      return;
    }

    if (this.riskBlock("momentum", cfg.BUY_AMOUNT_SOL)) return;
    this.done.add(st.mint);
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
    this.open(st, cfg.BUY_AMOUNT_SOL, now, { source: "momentum" }, signal);
  }

  /** Returns why a new position can't be opened right now, or null if it can. */
  private riskBlock(source: PositionSource, amount: number): string | null {
    const { cfg } = this.d;
    const live = [...this.positions.values()].filter((p) => p.status !== "closed");
    if (live.length >= cfg.MAX_OPEN_POSITIONS) return `max ${cfg.MAX_OPEN_POSITIONS} open positions`;
    if (source === "copy" && cfg.COPY_MAX_OPEN_POSITIONS > 0 && live.filter((p) => p.source === "copy").length >= cfg.COPY_MAX_OPEN_POSITIONS) {
      return `max ${cfg.COPY_MAX_OPEN_POSITIONS} copy positions`;
    }
    if (this.dailyPnl <= -cfg.MAX_DAILY_LOSS_SOL) return "daily loss limit reached";
    const cost = amount + cfg.PRIORITY_FEE_SOL + (cfg.USE_JITO ? cfg.JITO_TIP_SOL : 0);
    if (this.d.executor.name === "paper" && this.balance < cost) return "balance too low";
    return null;
  }

  private open(
    st: TokenState,
    amount: number,
    now: number,
    meta: { source: PositionSource; whale?: string; whaleLabel?: string },
    signal: object,
  ): void {
    const { log } = this.d;
    const pos: Position = {
      mint: st.mint,
      symbol: st.symbol,
      ...meta,
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
    const tag = this.tagOf(pos);

    this.track(
      this.d.executor
        .buy(st, amount)
        .then((fill) => {
          if (fill.tokens <= 0) throw new Error("buy returned 0 tokens");
          pos.status = "open";
          pos.busy = false;
          pos.symbol = st.symbol || pos.symbol;
          pos.solSpent = fill.sol;
          pos.tokensInitial = fill.tokens;
          pos.tokensHeld = fill.tokens;
          pos.entryPrice = fill.sol / fill.tokens;
          pos.peakPrice = Math.max(pos.entryPrice, spotPrice(st));
          if (this.d.executor.name === "paper") this.balance -= fill.sol;
          this.d.journal.write({ t: now, type: "buy", mint: st.mint, symbol: pos.symbol, sol: fill.sol, tokens: fill.tokens, signature: fill.signature, signal, ...tag });
          log.info(`BOUGHT ${this.name(pos)}${pos.source === "copy" ? ` (copy ${pos.whaleLabel})` : ""}: ${fill.sol.toFixed(4)} SOL -> ${fill.tokens.toFixed(0)} tokens`, { signature: fill.signature });
          // The whale may already have sold while our buy was in flight.
          this.maybeExit(pos, st, now);
        })
        .catch((e: Error) => {
          this.positions.delete(st.mint);
          log.error(`buy ${this.name(pos)} failed: ${e.message}`);
          this.d.journal.write({ t: now, type: "buy_failed", mint: st.mint, symbol: pos.symbol, error: e.message, ...tag });
        }),
    );
  }

  // ------------------------------------------------------------ copy trading

  /** Start tracking a token a whale bought that the bot never saw created. */
  private adopt(ev: TradeEvent, now: number): TokenState | undefined {
    const { cfg } = this.d;
    if (!cfg.COPY_ADOPT_UNSEEN_TOKENS) return undefined;
    if (ev.pool && ev.pool !== "pump") return undefined; // only bonding-curve trades
    const st = this.tracker.adopt(ev, now);
    if (!st) return undefined;
    this.d.subscribe([ev.mint]);
    this.evictIfNeeded();
    const fetchInfo = this.d.fetchCoinInfo;
    if (!fetchInfo) {
      this.socials.set(ev.mint, null);
      return st;
    }
    this.coinInfoPending.add(ev.mint);
    this.track(
      fetchInfo(ev.mint)
        .then(async (info) => {
          if (!info) return void this.socials.set(ev.mint, null);
          st.name = info.name ?? st.name;
          st.symbol = info.symbol ?? st.symbol;
          st.uri = info.uri ?? st.uri;
          if (info.creator) st.dev = info.creator;
          const pos = this.positions.get(ev.mint);
          if (pos && !pos.symbol) pos.symbol = st.symbol;
          const s = info.socials !== undefined ? info.socials : st.uri ? await this.d.fetchSocials(ev.mint, st.uri) : null;
          this.socials.set(ev.mint, s);
        })
        .catch(() => void this.socials.set(ev.mint, null))
        .finally(() => {
          this.coinInfoPending.delete(ev.mint);
          // Don't wait for the next tick: speed matters when copying.
          const sig = this.pendingCopies.get(ev.mint);
          if (sig) this.tryCopy(sig, Math.max(this.clock, sig.at));
        }),
    );
    return st;
  }

  private onWhaleTrade(whale: WatchedWallet, ev: TradeEvent, st: TokenState, prevBalance: number, now: number): void {
    const { cfg, log } = this.d;
    const act = this.whaleActivity.get(whale.address)!;
    const sym = st.symbol || shortMint(st.mint);
    if (ev.txType === "buy") {
      act.buys++;
      const pos = this.positions.get(st.mint);
      if (pos || this.copied.has(st.mint)) return this.noteWhale(whale, ev, now, `bought ${sym} (already in it)`);
      if (this.pendingCopies.has(st.mint)) return this.noteWhale(whale, ev, now, `bought ${sym} (signal pending)`);
      log.info(`WHALE ${whale.label} bought ${sym}: ${ev.solAmount.toFixed(2)} SOL`, { mint: st.mint });
      this.noteWhale(whale, ev, now, `bought ${sym} ${ev.solAmount.toFixed(2)} SOL`);
      this.tryCopy({ mint: st.mint, whale, at: now, whaleSol: ev.solAmount, whalePrice: spotPrice(st) }, now);
      return;
    }

    act.sells++;
    const before = typeof ev.newTokenBalance === "number" ? ev.newTokenBalance + ev.tokenAmount : prevBalance;
    const fraction = before > 0 ? Math.min(1, ev.tokenAmount / before) : 1;
    const pct = Math.round(fraction * 100);
    const pending = this.pendingCopies.get(st.mint);
    if (pending?.whale.address === whale.address) {
      this.pendingCopies.delete(st.mint);
      log.info(`COPY cancelled ${sym}: ${whale.label} sold before we bought`);
    }
    const pos = this.positions.get(st.mint);
    if (!pos || pos.source !== "copy" || pos.whale !== whale.address || !cfg.COPY_EXIT_ON_WHALE_SELL) {
      return this.noteWhale(whale, ev, now, `sold ${pct}% of ${sym}`);
    }
    const full = fraction * 100 >= cfg.COPY_WHALE_SELL_EXIT_PCT;
    const prev = pos.pendingWhaleSell?.fraction ?? 0;
    const f = full ? 1 : Math.min(1, prev + fraction * (1 - prev));
    pos.pendingWhaleSell = { fraction: f, reason: `whale ${whale.label} sold ${pct}%` };
    log.info(`WHALE ${whale.label} sold ${pct}% of ${sym}, ${full ? "exiting" : `selling ${Math.round(f * 100)}%`}`);
    this.noteWhale(whale, ev, now, `sold ${pct}% of ${sym}, we follow`);
  }

  private tryCopy(sig: CopySignal, now: number): void {
    const { cfg, log } = this.d;
    const st = this.tracker.tokens.get(sig.mint);
    const act = this.whaleActivity.get(sig.whale.address)!;
    const drop = (why: string) => {
      this.pendingCopies.delete(sig.mint);
      act.skipped++;
      act.lastNote = `skipped ${st?.symbol || shortMint(sig.mint)}: ${why}`;
      log.info(`COPY skip ${st?.symbol || shortMint(sig.mint)} from ${sig.whale.label}: ${why}`);
    };
    if (!st) return drop("token no longer tracked");
    if (this.positions.has(sig.mint) || this.copied.has(sig.mint)) return void this.pendingCopies.delete(sig.mint);

    const progress = curveProgress(st.vTokens, this.curve);
    const stats = this.tracker.stats(st, now, cfg.MOMENTUM_WINDOW_SEC, this.whaleSet);
    const decision = evaluateCopyEntry(st, stats, progress, spotPrice(st), sig, this.socials.get(sig.mint), cfg);
    const waitingInfo = st.adopted && this.coinInfoPending.has(sig.mint);
    if (decision.wait || (decision.ok && waitingInfo)) {
      if (now - sig.at > cfg.COPY_SIGNAL_TTL_SEC * 1000) return drop(`metadata not available within ${cfg.COPY_SIGNAL_TTL_SEC}s`);
      this.pendingCopies.set(sig.mint, sig);
      return;
    }
    if (!decision.ok) return drop(decision.reasons.join(", "));
    const risk = this.riskBlock("copy", cfg.COPY_BUY_AMOUNT_SOL);
    if (risk) return drop(risk);

    this.pendingCopies.delete(sig.mint);
    this.copied.add(sig.mint);
    this.done.add(sig.mint);
    act.copied++;
    act.lastNote = `copied ${st.symbol || shortMint(st.mint)}`;
    const signal = {
      whale: sig.whale.label,
      whaleSol: +sig.whaleSol.toFixed(2),
      progressPct: +(progress * 100).toFixed(1),
      delaySec: +((now - sig.at) / 1000).toFixed(1),
      devPct: +stats.devHoldPct.toFixed(1),
      top10Pct: +stats.top10HoldPct.toFixed(1),
      unseenLaunch: st.adopted,
    };
    log.info(`COPY signal ${st.symbol || st.mint} from ${sig.whale.label}`, signal);
    this.open(st, cfg.COPY_BUY_AMOUNT_SOL, now, { source: "copy", whale: sig.whale.address, whaleLabel: sig.whale.label }, signal);
  }

  private noteWhale(whale: WatchedWallet, ev: TradeEvent, now: number, note: string, count = false): void {
    const act = this.whaleActivity.get(whale.address);
    if (!act) return;
    act.lastAt = now;
    act.lastNote = note;
    if (count) act[ev.txType === "buy" ? "buys" : "sells"]++;
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
    if (dec.kind === "whale-sell") pos.pendingWhaleSell = undefined;
    log.info(`SELL ${this.name(pos)}: ${dec.reason}`, { tokens: Math.round(dec.tokens) });
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
          this.d.journal.write({ t: now, type: "sell", mint: pos.mint, symbol: pos.symbol, reason: dec.reason, sol: fill.sol, tokens: fill.tokens, signature: fill.signature, ...this.tagOf(pos) });
          log.info(`SOLD ${this.name(pos)}: ${fill.tokens.toFixed(0)} tokens -> ${fill.sol.toFixed(4)} SOL`, { signature: fill.signature });
          if (dec.closesPosition || pos.tokensHeld <= DUST_TOKENS) this.close(pos, now);
        })
        .catch((e: Error) => {
          // A failed whale-follow sell is retried on the next tick like any other exit.
          if (dec.kind === "whale-sell" && !pos.pendingWhaleSell) pos.pendingWhaleSell = { fraction: dec.tokens / Math.max(pos.tokensHeld, 1e-9), reason: dec.reason };
          log.error(`sell ${this.name(pos)} failed (will retry): ${e.message}`);
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
      ...this.tagOf(pos),
    });
    this.d.log.info(`CLOSED ${this.name(pos)}: ${fmtSol(pnl)} (${pct.toFixed(1)}%) after ${Math.round((now - pos.openedAt) / 1000)}s`);
    this.positions.delete(pos.mint);
    this.forget(pos.mint);
    if (this.dailyPnl <= -this.d.cfg.MAX_DAILY_LOSS_SOL) {
      this.d.log.warn(`daily loss limit reached (${fmtSol(this.dailyPnl)}), no new entries until UTC midnight`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private tagOf(pos: Position): { source: PositionSource; whale?: string; whaleLabel?: string } {
    return pos.source === "copy" ? { source: "copy", whale: pos.whale, whaleLabel: pos.whaleLabel } : { source: "momentum" };
  }

  private name(pos: Position): string {
    return pos.symbol || this.tracker.tokens.get(pos.mint)?.symbol || shortMint(pos.mint);
  }

  private forget(mint: string): void {
    if (this.positions.has(mint) || this.pendingCopies.has(mint)) return;
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
      if (!this.positions.has(mint) && !this.pendingCopies.has(mint)) this.forget(mint);
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

function shortMint(m: string): string {
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

function fmtSol(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`;
}
