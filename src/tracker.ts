import type { CreateEvent, TradeEvent } from "./types.js";

export const TOTAL_SUPPLY = 1_000_000_000;

export interface TradeRecord {
  t: number;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
}

export interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  dev: string;
  createdAt: number;
  vSol: number;
  vTokens: number;
  lastUpdate: number;
  balances: Map<string, number>;
  recentTrades: TradeRecord[];
  earlyBuyers: Set<string>;
  devSold: boolean;
  lastBuyAt: number;
  tradeCount: number;
  migrated: boolean;
}

export interface TokenStats {
  ageSec: number;
  uniqueBuyers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buySellRatio: number;
  devHoldPct: number;
  top10HoldPct: number;
  earlyBuyersHoldPct: number;
  secSinceLastBuy: number;
}

export class TokenTracker {
  readonly tokens = new Map<string, TokenState>();

  constructor(
    private readonly opts: { bundleWindowSec: number; keepTradesSec: number; selfWallet?: string },
  ) {}

  onCreate(ev: CreateEvent, now: number): TokenState {
    const st: TokenState = {
      mint: ev.mint,
      name: ev.name ?? "",
      symbol: ev.symbol ?? "",
      uri: ev.uri ?? "",
      dev: ev.traderPublicKey,
      createdAt: now,
      vSol: ev.vSolInBondingCurve,
      vTokens: ev.vTokensInBondingCurve,
      lastUpdate: now,
      balances: new Map(),
      recentTrades: [],
      earlyBuyers: new Set(),
      devSold: false,
      lastBuyAt: now,
      tradeCount: 0,
      migrated: false,
    };
    if (ev.initialBuy && ev.initialBuy > 0) {
      st.balances.set(ev.traderPublicKey, ev.initialBuy);
      st.earlyBuyers.add(ev.traderPublicKey);
    }
    this.tokens.set(ev.mint, st);
    return st;
  }

  onTrade(ev: TradeEvent, now: number): TokenState | undefined {
    const st = this.tokens.get(ev.mint);
    if (!st) return undefined;
    st.tradeCount++;
    st.lastUpdate = now;
    if (typeof ev.vSolInBondingCurve === "number" && typeof ev.vTokensInBondingCurve === "number") {
      st.vSol = ev.vSolInBondingCurve;
      st.vTokens = ev.vTokensInBondingCurve;
    }

    const prev = st.balances.get(ev.traderPublicKey) ?? 0;
    const next =
      typeof ev.newTokenBalance === "number"
        ? ev.newTokenBalance
        : Math.max(0, prev + (ev.txType === "buy" ? ev.tokenAmount : -ev.tokenAmount));
    if (next > 0) st.balances.set(ev.traderPublicKey, next);
    else st.balances.delete(ev.traderPublicKey);

    if (ev.traderPublicKey === st.dev && ev.txType === "sell") st.devSold = true;

    const isSelf = this.opts.selfWallet && ev.traderPublicKey === this.opts.selfWallet;
    if (!isSelf) {
      st.recentTrades.push({ t: now, wallet: ev.traderPublicKey, side: ev.txType, sol: ev.solAmount });
      if (ev.txType === "buy") {
        st.lastBuyAt = now;
        if (now - st.createdAt <= this.opts.bundleWindowSec * 1000) st.earlyBuyers.add(ev.traderPublicKey);
      }
    }
    const cutoff = now - this.opts.keepTradesSec * 1000;
    while (st.recentTrades.length && st.recentTrades[0]!.t < cutoff) st.recentTrades.shift();
    return st;
  }

  markMigrated(mint: string): TokenState | undefined {
    const st = this.tokens.get(mint);
    if (st) st.migrated = true;
    return st;
  }

  remove(mint: string): void {
    this.tokens.delete(mint);
  }

  stats(st: TokenState, now: number, windowSec: number): TokenStats {
    const cutoff = now - windowSec * 1000;
    const buyers = new Set<string>();
    let buyVol = 0;
    let sellVol = 0;
    for (const tr of st.recentTrades) {
      if (tr.t < cutoff) continue;
      if (tr.side === "buy") {
        buyers.add(tr.wallet);
        buyVol += tr.sol;
      } else sellVol += tr.sol;
    }
    const pct = (tokens: number) => (tokens / TOTAL_SUPPLY) * 100;
    const holders = [...st.balances.entries()]
      .filter(([w]) => w !== this.opts.selfWallet)
      .map(([, b]) => b)
      .sort((a, b) => b - a);
    const top10 = holders.slice(0, 10).reduce((s, b) => s + b, 0);
    let early = 0;
    for (const w of st.earlyBuyers) early += st.balances.get(w) ?? 0;
    return {
      ageSec: (now - st.createdAt) / 1000,
      uniqueBuyers: buyers.size,
      buyVolumeSol: buyVol,
      sellVolumeSol: sellVol,
      buySellRatio: sellVol > 0 ? buyVol / sellVol : buyVol > 0 ? Infinity : 0,
      devHoldPct: pct(st.balances.get(st.dev) ?? 0),
      top10HoldPct: pct(top10),
      earlyBuyersHoldPct: pct(early),
      secSinceLastBuy: (now - st.lastBuyAt) / 1000,
    };
  }
}
