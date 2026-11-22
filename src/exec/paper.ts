import type { Config } from "../config.js";
import { quoteBuy, quoteSell } from "../curve.js";
import type { TokenState } from "../tracker.js";
import type { Executor, Fill } from "./types.js";

/**
 * Simulated fills against the current bonding curve state.
 * Adds PAPER_EXTRA_SLIPPAGE_PCT to model latency (other buyers landing before us)
 * plus priority fee and Jito tip per transaction.
 */
export class PaperExecutor implements Executor {
  readonly name = "paper";
  constructor(private readonly cfg: Config) {}

  private networkCost(): number {
    return this.cfg.PRIORITY_FEE_SOL + (this.cfg.USE_JITO ? this.cfg.JITO_TIP_SOL : 0);
  }

  async buy(st: TokenState, solAmount: number): Promise<Fill> {
    const { tokens } = quoteBuy({ vSol: st.vSol, vTokens: st.vTokens }, solAmount, this.cfg.PUMP_FEE_BPS);
    const slip = 1 - this.cfg.PAPER_EXTRA_SLIPPAGE_PCT / 100;
    return { sol: solAmount + this.networkCost(), tokens: tokens * slip };
  }

  async sell(st: TokenState, tokens: number): Promise<Fill> {
    const { sol } = quoteSell({ vSol: st.vSol, vTokens: st.vTokens }, tokens, this.cfg.PUMP_FEE_BPS);
    const slip = 1 - this.cfg.PAPER_EXTRA_SLIPPAGE_PCT / 100;
    return { sol: Math.max(0, sol * slip - this.networkCost()), tokens };
  }
}
