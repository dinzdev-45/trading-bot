/**
 * pump.fun bonding curve math (constant product on virtual reserves).
 * All amounts are UI units (SOL, whole tokens).
 */
export interface CurveParams {
  initialVirtualTokens: number; // 1,073,000,000
  realTokensForSale: number; // 793,100,000
  feeBps: number; // protocol + creator fee on each trade
}

export interface Reserves {
  vSol: number;
  vTokens: number;
}

/** Fraction 0..1 of the curve that has been bought. 1 = ready to graduate. */
export function curveProgress(vTokens: number, p: CurveParams): number {
  const sold = p.initialVirtualTokens - vTokens;
  return Math.min(1, Math.max(0, sold / p.realTokensForSale));
}

/** Spot price in SOL per token. */
export function spotPrice(r: Reserves): number {
  return r.vTokens > 0 ? r.vSol / r.vTokens : 0;
}

/** Tokens received for spending `sol` (fee taken from input). */
export function quoteBuy(r: Reserves, sol: number, feeBps: number): { tokens: number; after: Reserves } {
  const solIn = sol * (1 - feeBps / 10_000);
  const k = r.vSol * r.vTokens;
  const newSol = r.vSol + solIn;
  const newTokens = k / newSol;
  return { tokens: r.vTokens - newTokens, after: { vSol: newSol, vTokens: newTokens } };
}

/** SOL received for selling `tokens` (fee taken from output). */
export function quoteSell(r: Reserves, tokens: number, feeBps: number): { sol: number; after: Reserves } {
  const k = r.vSol * r.vTokens;
  const newTokens = r.vTokens + tokens;
  const newSol = k / newTokens;
  const gross = r.vSol - newSol;
  return { sol: gross * (1 - feeBps / 10_000), after: { vSol: newSol, vTokens: newTokens } };
}
