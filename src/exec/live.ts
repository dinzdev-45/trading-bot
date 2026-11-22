import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TokenState } from "../tracker.js";
import type { Executor, Fill } from "./types.js";

const TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

// Public Jito tip accounts (https://docs.jito.wtf).
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  return Keypair.fromSecretKey(bs58.decode(s));
}

/**
 * Real trades. Transactions are built by PumpPortal's local-transaction API,
 * signed locally (the private key never leaves this machine), and sent as a
 * Jito bundle with a tip (falls back to plain RPC if the bundle is rejected).
 */
export class LiveExecutor implements Executor {
  readonly name = "live";
  private readonly conn: Connection;
  readonly wallet: Keypair;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.conn = new Connection(cfg.RPC_URL, "confirmed");
    this.wallet = loadKeypair(cfg.WALLET_PRIVATE_KEY);
  }

  get publicKey(): string {
    return this.wallet.publicKey.toBase58();
  }

  async buy(st: TokenState, solAmount: number): Promise<Fill> {
    return this.trade(st, "buy", solAmount, true);
  }

  async sell(st: TokenState, tokens: number, all: boolean): Promise<Fill> {
    return this.trade(st, "sell", all ? "100%" : tokens, false);
  }

  private async trade(st: TokenState, action: "buy" | "sell", amount: number | string, inSol: boolean): Promise<Fill> {
    const res = await fetch(TRADE_LOCAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: this.publicKey,
        action,
        mint: st.mint,
        amount,
        denominatedInSol: inSol ? "true" : "false",
        slippage: this.cfg.SLIPPAGE_PCT,
        priorityFee: this.cfg.PRIORITY_FEE_SOL,
        pool: st.migrated ? "auto" : "pump",
      }),
    });
    if (!res.ok) throw new Error(`trade-local ${action} failed: HTTP ${res.status} ${await res.text()}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([this.wallet]);
    const signature = bs58.encode(tx.signatures[0]!);

    let tipPaid = 0;
    let sentViaJito = false;
    if (this.cfg.USE_JITO && this.cfg.JITO_TIP_SOL > 0) {
      try {
        await this.sendBundle(tx);
        tipPaid = this.cfg.JITO_TIP_SOL;
        sentViaJito = true;
      } catch (e) {
        this.log.warn(`Jito bundle failed, falling back to RPC: ${(e as Error).message}`);
      }
    }
    if (!sentViaJito) {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    }

    await this.waitForConfirmation(signature);
    const fill = await this.readFill(signature, st.mint);
    // Jito tip is a separate transaction, so add it to the cost of this trade.
    if (action === "buy") return { sol: fill.solDelta * -1 + tipPaid, tokens: fill.tokenDelta, signature };
    return { sol: fill.solDelta - tipPaid, tokens: -fill.tokenDelta, signature };
  }

  private async sendBundle(tx: VersionedTransaction): Promise<void> {
    const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!);
    const tipTx = new Transaction({
      feePayer: this.wallet.publicKey,
      recentBlockhash: tx.message.recentBlockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: Math.round(this.cfg.JITO_TIP_SOL * LAMPORTS_PER_SOL),
      }),
    );
    tipTx.sign(this.wallet);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [
        [Buffer.from(tx.serialize()).toString("base64"), tipTx.serialize().toString("base64")],
        { encoding: "base64" },
      ],
    };
    const res = await fetch(`${this.cfg.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok || json.error) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }

  private async waitForConfirmation(signature: string, timeoutMs = 45_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await this.conn.getSignatureStatuses([signature]);
      const s = value[0];
      if (s?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`transaction ${signature} not confirmed within ${timeoutMs / 1000}s`);
  }

  /** Exact SOL and token deltas for our wallet from the confirmed transaction. */
  private async readFill(signature: string, mint: string): Promise<{ solDelta: number; tokenDelta: number }> {
    for (let i = 0; i < 10; i++) {
      const tx = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        const owner = this.publicKey;
        const solDelta = (tx.meta.postBalances[0]! - tx.meta.preBalances[0]!) / LAMPORTS_PER_SOL;
        const bal = (list: typeof tx.meta.preTokenBalances) =>
          (list ?? []).find((b) => b.mint === mint && b.owner === owner)?.uiTokenAmount.uiAmount ?? 0;
        return { solDelta, tokenDelta: bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances) };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`could not load transaction ${signature}`);
  }
}
