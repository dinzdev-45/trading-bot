/** Messages from the PumpPortal data WebSocket (amounts are UI units: SOL and whole tokens). */
export interface CreateEvent {
  txType: "create";
  signature: string;
  mint: string;
  traderPublicKey: string; // the dev / creator
  initialBuy?: number; // tokens bought by dev in the create tx
  solAmount?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
}

export interface TradeEvent {
  txType: "buy" | "sell";
  signature: string;
  mint: string;
  traderPublicKey: string;
  tokenAmount: number;
  solAmount: number;
  newTokenBalance?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  pool?: string;
}

export interface MigrationEvent {
  txType: "migrate";
  signature?: string;
  mint: string;
  pool?: string;
}

export type FeedEvent = CreateEvent | TradeEvent | MigrationEvent;

export interface Socials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function parseFeedMessage(raw: unknown): FeedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.mint !== "string") return null;
  const t = m.txType;
  if (t === "create") {
    if (typeof m.vTokensInBondingCurve !== "number" || typeof m.vSolInBondingCurve !== "number") return null;
    return m as unknown as CreateEvent;
  }
  if (t === "buy" || t === "sell") {
    if (typeof m.traderPublicKey !== "string" || typeof m.solAmount !== "number") return null;
    return m as unknown as TradeEvent;
  }
  if (t === "migrate" || t === "migration") return { ...(m as object), txType: "migrate" } as MigrationEvent;
  return null;
}
