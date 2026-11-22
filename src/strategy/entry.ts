import type { Config } from "../config.js";
import type { TokenState, TokenStats } from "../tracker.js";
import type { Socials } from "../types.js";

export interface EntryDecision {
  ok: boolean;
  /** Reasons the token was rejected (empty when ok). */
  reasons: string[];
  /** True when a rejection can never clear (no point re-checking this token). */
  permanent: boolean;
}

/**
 * socials: undefined = metadata still loading, null = metadata unavailable.
 */
export function evaluateEntry(
  st: TokenState,
  stats: TokenStats,
  progress: number,
  socials: Socials | null | undefined,
  cfg: Config,
): EntryDecision {
  const reasons: string[] = [];
  let permanent = false;

  if (st.migrated) return { ok: false, reasons: ["migrated"], permanent: true };

  // Curve window
  if (progress < cfg.MIN_CURVE_PROGRESS) reasons.push(`progress ${(progress * 100).toFixed(1)}% < min`);
  if (progress > cfg.MAX_CURVE_PROGRESS) reasons.push(`progress ${(progress * 100).toFixed(1)}% > max`);

  // Age
  if (stats.ageSec < cfg.MIN_TOKEN_AGE_SEC) reasons.push(`age ${stats.ageSec.toFixed(0)}s < min`);
  if (stats.ageSec > cfg.MAX_TOKEN_AGE_SEC) {
    reasons.push(`age ${stats.ageSec.toFixed(0)}s > max`);
    permanent = true;
  }

  // Momentum
  if (stats.uniqueBuyers < cfg.MIN_UNIQUE_BUYERS) reasons.push(`unique buyers ${stats.uniqueBuyers} < ${cfg.MIN_UNIQUE_BUYERS}`);
  if (stats.buySellRatio < cfg.MIN_BUY_SELL_RATIO) reasons.push(`buy/sell ratio ${stats.buySellRatio.toFixed(2)} < ${cfg.MIN_BUY_SELL_RATIO}`);
  if (stats.buyVolumeSol < cfg.MIN_BUY_VOLUME_SOL) reasons.push(`buy volume ${stats.buyVolumeSol.toFixed(2)} SOL < ${cfg.MIN_BUY_VOLUME_SOL}`);

  // Safety
  if (cfg.BLOCK_IF_DEV_SOLD && st.devSold) {
    reasons.push("dev sold");
    permanent = true;
  }
  if (stats.devHoldPct > cfg.MAX_DEV_HOLD_PCT) reasons.push(`dev holds ${stats.devHoldPct.toFixed(1)}% > ${cfg.MAX_DEV_HOLD_PCT}%`);
  if (stats.top10HoldPct > cfg.MAX_TOP10_HOLD_PCT) reasons.push(`top10 hold ${stats.top10HoldPct.toFixed(1)}% > ${cfg.MAX_TOP10_HOLD_PCT}%`);
  if (stats.earlyBuyersHoldPct > cfg.MAX_EARLY_BUYERS_HOLD_PCT) {
    reasons.push(`early/bundle wallets hold ${stats.earlyBuyersHoldPct.toFixed(1)}% > ${cfg.MAX_EARLY_BUYERS_HOLD_PCT}%`);
  }

  if (cfg.REQUIRE_SOCIALS) {
    if (socials === undefined) reasons.push("metadata pending");
    else if (!socials || !(socials.twitter || socials.telegram || socials.website)) {
      reasons.push("no socials");
      permanent = true;
    }
  }

  return { ok: reasons.length === 0, reasons, permanent };
}
