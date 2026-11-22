import type { TokenState } from "../tracker.js";

export interface Fill {
  /** For buys: total SOL spent incl. fees/tips. For sells: net SOL received after fees/tips. */
  sol: number;
  tokens: number;
  signature?: string;
}

export interface Executor {
  readonly name: string;
  buy(st: TokenState, solAmount: number): Promise<Fill>;
  /** `all` = close the whole position (lets live mode sell "100%" and avoid dust). */
  sell(st: TokenState, tokens: number, all: boolean): Promise<Fill>;
}
