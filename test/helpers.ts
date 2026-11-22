import { loadConfig, type Config } from "../src/config.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: "", SUMMARY_INTERVAL_SEC: "999999", ...overrides });
}

/** Simulates one pump.fun token's on-chain curve and emits PumpPortal-shaped messages. */
export class FakeToken {
  vSol = 30;
  vTokens = 1_073_000_000;
  readonly k = this.vSol * this.vTokens;
  readonly balances = new Map<string, number>();
  private sig = 0;

  constructor(
    readonly mint: string,
    readonly dev = "DEV",
  ) {}

  create(devBuySol = 0.5, uri = "https://meta/" + this.mint) {
    const tokens = this.applyBuy(devBuySol);
    this.balances.set(this.dev, tokens);
    return {
      txType: "create",
      signature: `s${this.sig++}`,
      mint: this.mint,
      traderPublicKey: this.dev,
      initialBuy: tokens,
      solAmount: devBuySol,
      vSolInBondingCurve: this.vSol,
      vTokensInBondingCurve: this.vTokens,
      name: "Test " + this.mint,
      symbol: this.mint.toUpperCase(),
      uri,
      pool: "pump",
    };
  }

  buy(wallet: string, sol: number) {
    const tokens = this.applyBuy(sol);
    const bal = (this.balances.get(wallet) ?? 0) + tokens;
    this.balances.set(wallet, bal);
    return this.msg("buy", wallet, sol, tokens, bal);
  }

  sell(wallet: string, fraction = 1) {
    const held = this.balances.get(wallet) ?? 0;
    const tokens = held * fraction;
    const newTokens = this.vTokens + tokens;
    const newSol = this.k / newTokens;
    const sol = this.vSol - newSol;
    this.vSol = newSol;
    this.vTokens = newTokens;
    this.balances.set(wallet, held - tokens);
    return this.msg("sell", wallet, sol, tokens, held - tokens);
  }

  get price() {
    return this.vSol / this.vTokens;
  }

  private applyBuy(sol: number): number {
    const newSol = this.vSol + sol;
    const newTokens = this.k / newSol;
    const out = this.vTokens - newTokens;
    this.vSol = newSol;
    this.vTokens = newTokens;
    return out;
  }

  private msg(txType: string, wallet: string, sol: number, tokens: number, bal: number) {
    return {
      txType,
      signature: `s${this.sig++}`,
      mint: this.mint,
      traderPublicKey: wallet,
      solAmount: sol,
      tokenAmount: tokens,
      newTokenBalance: bal,
      vSolInBondingCurve: this.vSol,
      vTokensInBondingCurve: this.vTokens,
      pool: "pump",
    };
  }
}
