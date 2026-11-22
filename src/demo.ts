import { EventEmitter } from "node:events";

/**
 * Synthetic PumpPortal-shaped feed for `npm run demo`: tokens are created, pumped, dumped and rugged
 * in real time so the bot and the dashboard can be tried without a network connection.
 * The data is random and says nothing about real market behaviour.
 */
type Kind = "dud" | "rug" | "runner";
type Phase = "pump" | "dump" | "dead";

interface DemoToken {
  mint: string;
  kind: Kind;
  phase: Phase;
  vSol: number;
  vTokens: number;
  k: number;
  balances: Map<string, number>;
  createdAt: number;
  peakProgress: number;
  budget: number; // dud: buys left
  dev: string;
}

const INITIAL_V_TOKENS = 1_073_000_000;
const REAL_FOR_SALE = 793_100_000;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WORDS = ["PEPE", "DOGE", "MOON", "CHAD", "WIF", "BONK", "FROG", "CAT", "GIGA", "TURBO", "BASED", "MEOW", "SIGMA", "ZOOM", "RUGME", "HODL", "LAMBO", "APE", "WAGMI", "GOAT"];

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
function id(len: number, suffix = ""): string {
  let s = "";
  for (let i = 0; i < len; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s + suffix;
}
function symbol(): string {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)]!;
  return Math.random() < 0.5 ? w : w + Math.floor(rand(1, 99));
}

export class DemoFeed extends EventEmitter {
  connected = false;
  private readonly tokens = new Map<string, DemoToken>();
  private readonly subscribed = new Set<string>();
  private timer?: NodeJS.Timeout;
  private lastSpawn = 0;
  private sig = 0;

  start(): void {
    this.connected = true;
    this.timer = setInterval(() => this.step(Date.now()), 250);
  }

  stop(): void {
    this.connected = false;
    clearInterval(this.timer);
  }

  subscribeTrades(mints: string[]): void {
    mints.forEach((m) => this.subscribed.add(m));
  }

  unsubscribeTrades(mints: string[]): void {
    mints.forEach((m) => this.subscribed.delete(m));
  }

  private step(now: number): void {
    if (now - this.lastSpawn > rand(2_000, 4_000)) {
      this.lastSpawn = now;
      this.spawn(now);
    }
    for (const tok of this.tokens.values()) this.advance(tok, now);
  }

  private spawn(now: number): void {
    const r = Math.random();
    const kind: Kind = r < 0.3 ? "runner" : r < 0.45 ? "rug" : "dud";
    const tok: DemoToken = {
      mint: id(40, "pump"),
      kind,
      phase: "pump",
      vSol: 30,
      vTokens: INITIAL_V_TOKENS,
      k: 30 * INITIAL_V_TOKENS,
      balances: new Map(),
      createdAt: now,
      // Some runners fade right after the entry zone, others run toward graduation.
      peakProgress: Math.random() < 0.45 ? rand(0.36, 0.5) : rand(0.55, 0.97),
      budget: Math.floor(rand(3, 12)),
      dev: id(44),
    };
    this.tokens.set(tok.mint, tok);
    const sym = symbol();
    const devTokens = this.applyBuy(tok, rand(0.1, 0.4));
    tok.balances.set(tok.dev, devTokens);
    this.emit("message", {
      txType: "create",
      signature: this.signature(),
      mint: tok.mint,
      traderPublicKey: tok.dev,
      initialBuy: devTokens,
      solAmount: 0.3,
      vSolInBondingCurve: tok.vSol,
      vTokensInBondingCurve: tok.vTokens,
      name: `${sym} demo`,
      symbol: sym,
      uri: `demo://${tok.mint}`,
      pool: "pump",
    });
    if (kind === "rug") {
      // Bundle: several wallets buy big in the same second, then the dev dumps.
      for (let i = 0; i < 6; i++) this.buy(tok, id(44), rand(1, 2));
    }
  }

  private advance(tok: DemoToken, now: number): void {
    const age = now - tok.createdAt;
    if (tok.phase === "dead") {
      if (age > 20 * 60_000) this.tokens.delete(tok.mint);
      return;
    }
    if (tok.kind === "dud") {
      if (age > 3_500 && Math.random() < 0.12) this.buy(tok, id(44), rand(0.05, 0.4));
      if (Math.random() < 0.03) this.sellSome(tok, 1);
      if (tok.budget-- <= 0 || age > 60_000) tok.phase = "dead";
      return;
    }
    if (tok.kind === "rug") {
      if (age > 8_000) {
        this.sell(tok, tok.dev, 1);
        tok.phase = "dead";
      } else if (Math.random() < 0.3) this.buy(tok, id(44), rand(0.1, 0.5));
      return;
    }
    // runner
    if (tok.phase === "pump") {
      if (age < 3_500) return; // stay out of the "bundle" window
      if (Math.random() < 0.55) this.buy(tok, id(44), rand(0.15, 0.6));
      if (Math.random() < 0.07) this.sellSome(tok, 0.5);
      if (this.progress(tok) >= tok.peakProgress) tok.phase = "dump";
    } else {
      if (Math.random() < 0.45) this.sellSome(tok, rand(0.5, 1));
      if (Math.random() < 0.05) this.buy(tok, id(44), rand(0.05, 0.2));
      if (this.progress(tok) < tok.peakProgress * 0.45 || tok.balances.size <= 2) tok.phase = "dead";
    }
    if (this.progress(tok) >= 0.999) {
      this.emit("message", { txType: "migrate", mint: tok.mint, signature: this.signature() });
      tok.phase = "dead";
    }
  }

  private progress(tok: DemoToken): number {
    return Math.min(1, (INITIAL_V_TOKENS - tok.vTokens) / REAL_FOR_SALE);
  }

  private applyBuy(tok: DemoToken, sol: number): number {
    const newSol = tok.vSol + sol;
    const newTokens = tok.k / newSol;
    const out = tok.vTokens - newTokens;
    tok.vSol = newSol;
    tok.vTokens = newTokens;
    return out;
  }

  private buy(tok: DemoToken, wallet: string, sol: number): void {
    const remaining = INITIAL_V_TOKENS - REAL_FOR_SALE;
    if (tok.vTokens - remaining < 1) return;
    const tokens = this.applyBuy(tok, sol);
    const bal = (tok.balances.get(wallet) ?? 0) + tokens;
    tok.balances.set(wallet, bal);
    this.trade(tok, "buy", wallet, sol, tokens, bal);
  }

  private sellSome(tok: DemoToken, fraction: number): void {
    const holders = [...tok.balances.keys()].filter((w) => w !== tok.dev);
    if (!holders.length) return;
    this.sell(tok, holders[Math.floor(Math.random() * holders.length)]!, fraction);
  }

  private sell(tok: DemoToken, wallet: string, fraction: number): void {
    const held = tok.balances.get(wallet) ?? 0;
    const tokens = held * fraction;
    if (tokens <= 0) return;
    const newTokens = tok.vTokens + tokens;
    const newSol = tok.k / newTokens;
    const sol = tok.vSol - newSol;
    tok.vSol = newSol;
    tok.vTokens = newTokens;
    const left = held - tokens;
    if (left < 1) tok.balances.delete(wallet);
    else tok.balances.set(wallet, left);
    this.trade(tok, "sell", wallet, sol, tokens, left);
  }

  private trade(tok: DemoToken, txType: "buy" | "sell", wallet: string, sol: number, tokens: number, bal: number): void {
    if (!this.subscribed.has(tok.mint)) return; // like PumpPortal: only subscribed tokens
    this.emit("message", {
      txType,
      signature: this.signature(),
      mint: tok.mint,
      traderPublicKey: wallet,
      solAmount: sol,
      tokenAmount: tokens,
      newTokenBalance: bal,
      vSolInBondingCurve: tok.vSol,
      vTokensInBondingCurve: tok.vTokens,
      pool: "pump",
    });
  }

  private signature(): string {
    return `demo${this.sig++}`;
  }
}
