import type { Config, WatchedWallet } from "../config.js";
import type { TokenState, TokenStats } from "../tracker.js";
import type { Socials } from "../types.js";

/** A watched whale bought a token; we may follow. */
export interface CopySignal {
  mint: string;
  whale: WatchedWallet;
  /** When the whale's buy arrived. */
  at: number;
  whaleSol: number;
  /** Spot price right after the whale's buy (SOL per token). */
  whalePrice: number;
}

export interface CopyDecision {
  ok: boolean;
  reasons: string[];
  /** Only waiting on metadata: keep the signal and check again. */
  wait: boolean;
}

/**
 * Entry check for copy trades. The whale's buy is the signal, so the momentum filters
 * (unique buyers, volume, curve window start, token age) do not apply. The rug-safety checks do,
 * with the watched whales left out of the concentration numbers.
 * socials: undefined = metadata still loading, null = unavailable.
 */
export function evaluateCopyEntry(
  st: TokenState,
  stats: TokenStats,
  progress: number,
  price: number,
  sig: CopySignal,
  socials: Socials | null | undefined,
  cfg: Config,
): CopyDecision {
  const reasons: string[] = [];
  let pending = false;

  if (st.migrated) reasons.push("already graduated");
  if (progress > cfg.COPY_MAX_CURVE_PROGRESS) reasons.push(`curve ${(progress * 100).toFixed(0)}% > max ${(cfg.COPY_MAX_CURVE_PROGRESS * 100).toFixed(0)}%`);
  if (sig.whaleSol < cfg.COPY_MIN_WHALE_BUY_SOL) reasons.push(`whale buy ${sig.whaleSol.toFixed(2)} SOL < ${cfg.COPY_MIN_WHALE_BUY_SOL}`);
  if (sig.whalePrice > 0) {
    const move = (price / sig.whalePrice - 1) * 100;
    if (move > cfg.COPY_MAX_PRICE_MOVE_PCT) reasons.push(`price already +${move.toFixed(0)}% since the whale bought`);
  }

  if (cfg.COPY_SKIP_IF_WHALE_IS_DEV && st.dev && st.dev === sig.whale.address) reasons.push("whale is the token's dev");
  if (cfg.BLOCK_IF_DEV_SOLD && st.devSold) reasons.push("dev sold");
  if (st.dev && stats.devHoldPct > cfg.MAX_DEV_HOLD_PCT) reasons.push(`dev holds ${stats.devHoldPct.toFixed(1)}% > ${cfg.MAX_DEV_HOLD_PCT}%`);
  if (stats.top10HoldPct > cfg.COPY_MAX_TOP10_HOLD_PCT) reasons.push(`top10 (excl. whales) ${stats.top10HoldPct.toFixed(1)}% > ${cfg.COPY_MAX_TOP10_HOLD_PCT}%`);
  if (stats.earlyBuyersHoldPct > cfg.MAX_EARLY_BUYERS_HOLD_PCT) {
    reasons.push(`early/bundle wallets hold ${stats.earlyBuyersHoldPct.toFixed(1)}% > ${cfg.MAX_EARLY_BUYERS_HOLD_PCT}%`);
  }

  if (cfg.COPY_REQUIRE_SOCIALS) {
    if (socials === undefined) pending = true;
    else if (!socials || !(socials.twitter || socials.telegram || socials.website)) reasons.push("no socials");
  }

  if (reasons.length) return { ok: false, reasons, wait: false };
  if (pending) return { ok: false, reasons: ["metadata pending"], wait: true };
  return { ok: true, reasons: [], wait: false };
}
