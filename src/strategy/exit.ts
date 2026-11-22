import type { Config } from "../config.js";
import type { TokenStats } from "../tracker.js";

export type PositionSource = "momentum" | "copy";

export interface Position {
  mint: string;
  symbol: string;
  /** Which strategy opened it. */
  source: PositionSource;
  /** Copy trades: the whale we followed. */
  whale?: string;
  whaleLabel?: string;
  /** Copy trades: the whale sold this fraction of their bag; mirror it on the next chance. */
  pendingWhaleSell?: { fraction: number; reason: string };
  status: "opening" | "open" | "closed";
  openedAt: number;
  closedAt?: number;
  /** Effective entry price, SOL per token, including fees and network costs. */
  entryPrice: number;
  tokensInitial: number;
  tokensHeld: number;
  solSpent: number;
  solReceived: number;
  peakPrice: number;
  /** Index of the next take-profit level to fire. */
  nextTpIndex: number;
  preGradSold: boolean;
  /** True while a sell is in flight. */
  busy: boolean;
  exitReasons: string[];
}

export interface ExitDecision {
  kind: "full" | "take-profit" | "pre-graduation" | "whale-sell";
  tokens: number;
  reason: string;
  closesPosition: boolean;
}

export function evaluateExit(
  pos: Position,
  price: number,
  progress: number,
  migrated: boolean,
  stats: TokenStats,
  now: number,
  cfg: Config,
): ExitDecision | null {
  if (pos.status !== "open" || pos.busy || pos.tokensHeld <= 0) return null;
  const all = (reason: string): ExitDecision => ({ kind: "full", tokens: pos.tokensHeld, reason, closesPosition: true });
  const multiple = pos.entryPrice > 0 ? price / pos.entryPrice : 0;

  if (migrated) return all("graduated (migrated)");

  // Copy trades follow the whale out before anything else.
  const ws = pos.pendingWhaleSell;
  if (ws) {
    const tokens = Math.min(pos.tokensHeld, pos.tokensHeld * ws.fraction);
    return { kind: "whale-sell", tokens, reason: ws.reason, closesPosition: tokens >= pos.tokensHeld };
  }

  if (!pos.preGradSold && cfg.GRADUATION_SELL_FRACTION > 0 && progress >= cfg.GRADUATION_SELL_PROGRESS) {
    const tokens = Math.min(pos.tokensHeld, pos.tokensHeld * cfg.GRADUATION_SELL_FRACTION);
    return { kind: "pre-graduation", tokens, reason: `pre-graduation sell at ${(progress * 100).toFixed(1)}% curve`, closesPosition: tokens >= pos.tokensHeld };
  }

  if (multiple <= 1 - cfg.STOP_LOSS_PCT / 100) return all(`stop-loss ${((multiple - 1) * 100).toFixed(1)}%`);

  const tp = cfg.takeProfitLevels[pos.nextTpIndex];
  if (tp && multiple >= tp.multiple) {
    const tokens = Math.min(pos.tokensHeld, pos.tokensInitial * tp.fraction);
    return { kind: "take-profit", tokens, reason: `take-profit ${tp.multiple}x`, closesPosition: tokens >= pos.tokensHeld };
  }

  const trailingActive = pos.nextTpIndex > 0 || pos.peakPrice >= pos.entryPrice * cfg.TRAILING_ACTIVATE_MULTIPLE;
  if (trailingActive && cfg.TRAILING_STOP_PCT > 0 && price <= pos.peakPrice * (1 - cfg.TRAILING_STOP_PCT / 100)) {
    return all(`trailing stop (${((price / pos.peakPrice - 1) * 100).toFixed(1)}% from peak)`);
  }

  if (stats.secSinceLastBuy >= cfg.MOMENTUM_DEATH_SEC) return all(`momentum died (no buys for ${stats.secSinceLastBuy.toFixed(0)}s)`);

  if ((now - pos.openedAt) / 1000 >= cfg.MAX_HOLD_SEC) return all("max hold time");

  return null;
}
