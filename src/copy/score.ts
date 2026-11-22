import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { quoteSell } from "../curve.js";
import { parseFeedMessage } from "../types.js";

/**
 * Find wallets worth copying from feed recordings (RECORD_FILE).
 * For every wallet and token it adds up SOL spent and received, values what is still held at the
 * last price seen, and summarises per wallet. Only trades the recording saw count, so a wallet's
 * buys before the recording started (and trades on tokens the bot was not watching) are missing.
 */
export interface WalletScore {
  wallet: string;
  tokens: number;
  wins: number;
  winRatePct: number;
  solIn: number;
  pnlSol: number;
  roiPct: number;
  /** Median seconds from first buy to first sell, over tokens it sold. */
  medianHoldSec: number | null;
  avgBuySol: number;
  /** Average curve progress (%) at its first buy. Low = early entries. */
  avgEntryProgressPct: number;
  /** Tokens it created itself (excluded from the numbers above). */
  devTokens: number;
  flags: string[];
}

export interface ScoreOptions {
  minTokens: number;
  feeBps: number;
  initialVirtualTokens: number;
  realTokensForSale: number;
  /** Median hold below this looks like a sniper/MEV bot: too fast to copy. */
  botHoldSec: number;
}

export const defaultScoreOptions: ScoreOptions = {
  minTokens: 5,
  feeBps: 125,
  initialVirtualTokens: 1_073_000_000,
  realTokensForSale: 793_100_000,
  botHoldSec: 10,
};

interface Book {
  solIn: number;
  solOut: number;
  balance: number;
  firstBuyAt: number;
  firstSellAt: number;
  entryProgress: number;
}

export class WalletScorer {
  private readonly dev = new Map<string, string>();
  private readonly reserves = new Map<string, { vSol: number; vTokens: number }>();
  private readonly books = new Map<string, Map<string, Book>>(); // wallet -> mint -> book
  private readonly seen = new Set<string>();

  constructor(private readonly o: ScoreOptions = defaultScoreOptions) {}

  add(raw: unknown, t: number): void {
    const ev = parseFeedMessage(raw);
    if (!ev || ev.txType === "migrate") return;
    if (ev.txType === "create") {
      this.dev.set(ev.mint, ev.traderPublicKey);
      this.reserves.set(ev.mint, { vSol: ev.vSolInBondingCurve, vTokens: ev.vTokensInBondingCurve });
      return;
    }
    if (ev.signature) {
      const key = `${ev.signature}:${ev.traderPublicKey}:${ev.mint}:${ev.txType}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const before = this.reserves.get(ev.mint);
    if (typeof ev.vSolInBondingCurve === "number" && typeof ev.vTokensInBondingCurve === "number") {
      this.reserves.set(ev.mint, { vSol: ev.vSolInBondingCurve, vTokens: ev.vTokensInBondingCurve });
    }
    let mints = this.books.get(ev.traderPublicKey);
    if (!mints) this.books.set(ev.traderPublicKey, (mints = new Map()));
    let b = mints.get(ev.mint);
    if (!b) {
      if (ev.txType === "sell") return; // bought before we were watching: can't score it
      const r = before ?? this.reserves.get(ev.mint);
      const progress = r ? Math.min(1, Math.max(0, (this.o.initialVirtualTokens - r.vTokens) / this.o.realTokensForSale)) : 0;
      mints.set(ev.mint, (b = { solIn: 0, solOut: 0, balance: 0, firstBuyAt: t, firstSellAt: 0, entryProgress: progress }));
    }
    if (ev.txType === "buy") {
      b.solIn += ev.solAmount;
      b.balance = typeof ev.newTokenBalance === "number" ? ev.newTokenBalance : b.balance + ev.tokenAmount;
    } else {
      b.solOut += ev.solAmount;
      b.balance = typeof ev.newTokenBalance === "number" ? ev.newTokenBalance : Math.max(0, b.balance - ev.tokenAmount);
      if (!b.firstSellAt) b.firstSellAt = t;
    }
  }

  results(): WalletScore[] {
    const out: WalletScore[] = [];
    for (const [wallet, mints] of this.books) {
      let tokens = 0, wins = 0, solIn = 0, pnl = 0, progress = 0, devTokens = 0;
      const holds: number[] = [];
      for (const [mint, b] of mints) {
        if (this.dev.get(mint) === wallet) {
          devTokens++;
          continue;
        }
        if (b.solIn <= 0) continue;
        const r = this.reserves.get(mint);
        const held = b.balance > 1 && r ? quoteSell(r, b.balance, this.o.feeBps).sol : 0;
        const p = b.solOut + held - b.solIn;
        tokens++;
        if (p > 0) wins++;
        solIn += b.solIn;
        pnl += p;
        progress += b.entryProgress;
        if (b.firstSellAt) holds.push((b.firstSellAt - b.firstBuyAt) / 1000);
      }
      if (tokens < this.o.minTokens) continue;
      holds.sort((a, b) => a - b);
      const median = holds.length ? holds[Math.floor(holds.length / 2)]! : null;
      const flags: string[] = [];
      if (median !== null && median < this.o.botHoldSec) flags.push("bot-like (sells within seconds)");
      if (devTokens > 0) flags.push(`dev of ${devTokens} token(s)`);
      out.push({
        wallet,
        tokens,
        wins,
        winRatePct: (wins / tokens) * 100,
        solIn,
        pnlSol: pnl,
        roiPct: solIn > 0 ? (pnl / solIn) * 100 : 0,
        medianHoldSec: median,
        avgBuySol: solIn / tokens,
        avgEntryProgressPct: (progress / tokens) * 100,
        devTokens,
        flags,
      });
    }
    return out.sort((a, b) => b.pnlSol - a.pnlSol);
  }
}

/** Wallets that look copyable: profitable, win often enough, not too fast to follow. */
export function copyCandidates(rows: WalletScore[], minWinRatePct = 40): WalletScore[] {
  return rows.filter((r) => r.pnlSol > 0 && r.winRatePct >= minWinRatePct && !r.flags.some((f) => f.startsWith("bot-like")));
}

export async function scoreFiles(files: string[], o: ScoreOptions = defaultScoreOptions): Promise<WalletScore[]> {
  const scorer = new WalletScorer(o);
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.t === "number" && e.m) scorer.add(e.m, e.t);
      } catch {
        /* skip bad line */
      }
    }
  }
  return scorer.results();
}

export function formatScores(rows: WalletScore[], top: number): string {
  const head = ["#", "wallet", "tokens", "win%", "PnL SOL", "ROI%", "avg buy", "entry curve%", "median hold", "notes"];
  const body = rows.slice(0, top).map((r, i) => [
    String(i + 1),
    r.wallet,
    String(r.tokens),
    r.winRatePct.toFixed(0),
    (r.pnlSol >= 0 ? "+" : "") + r.pnlSol.toFixed(2),
    r.roiPct.toFixed(0),
    r.avgBuySol.toFixed(2),
    r.avgEntryProgressPct.toFixed(0),
    r.medianHoldSec === null ? "-" : `${Math.round(r.medianHoldSec)}s`,
    r.flags.join("; "),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((row) => row[c]!.length)));
  const fmt = (row: string[]) => row.map((v, c) => (c >= 2 && c <= 8 ? v.padStart(widths[c]!) : v.padEnd(widths[c]!))).join("  ").trimEnd();
  return [fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}
