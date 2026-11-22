import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export interface WatchedWallet {
  address: string;
  label: string;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Parse a whale list. Entries are separated by commas or new lines; each is either
 * `ADDRESS` or `label:ADDRESS` (or `ADDRESS label` in a file). `#` starts a comment.
 */
export function parseWalletList(raw: string): WatchedWallet[] {
  const out = new Map<string, WatchedWallet>();
  for (let line of raw.split(/[\n,]/)) {
    line = line.replace(/#.*$/, "").trim();
    if (!line) continue;
    let address: string;
    let label = "";
    if (line.includes(":")) {
      const i = line.lastIndexOf(":");
      label = line.slice(0, i).trim();
      address = line.slice(i + 1).trim();
    } else {
      const [a, ...rest] = line.split(/\s+/);
      address = a!;
      label = rest.join(" ");
    }
    if (!BASE58_ADDRESS.test(address)) throw new Error(`Invalid wallet address in copy list: "${address}"`);
    out.set(address, { address, label: label || `${address.slice(0, 4)}…${address.slice(-4)}` });
  }
  return [...out.values()];
}

/** Parse "2:0.5,4:0.25" into [{ multiple: 2, fraction: 0.5 }, ...]. */
export function parseTakeProfitLevels(raw: string): { multiple: number; fraction: number }[] {
  if (!raw.trim()) return [];
  const levels = raw.split(",").map((part) => {
    const [m, f] = part.split(":").map((s) => Number(s.trim()));
    if (!Number.isFinite(m) || !Number.isFinite(f) || m! <= 1 || f! <= 0 || f! > 1) {
      throw new Error(`Invalid TAKE_PROFIT_LEVELS entry "${part}" (expected multiple:fraction, e.g. 2:0.5)`);
    }
    return { multiple: m!, fraction: f! };
  });
  levels.sort((a, b) => a.multiple - b.multiple);
  const total = levels.reduce((s, l) => s + l.fraction, 0);
  if (total > 1 + 1e-9) throw new Error("TAKE_PROFIT_LEVELS fractions must add up to at most 1");
  return levels;
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "y", "on"].includes(v.toLowerCase())));
const num = z.coerce.number().finite();

const schema = z.object({
  MODE: z.enum(["paper", "live"]).default("paper"),
  LIVE_TRADING_CONFIRM: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATA_DIR: z.string().default("data"),
  RECORD_FILE: z.string().default(""),

  // Feed
  PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),
  PUMPPORTAL_API_KEY: z.string().default(""),
  MAX_TRACKED_TOKENS: num.int().positive().default(400),
  METADATA_TIMEOUT_MS: num.int().positive().default(4000),

  // Curve constants (pump.fun defaults, UI units)
  CURVE_INITIAL_VIRTUAL_TOKENS: num.positive().default(1_073_000_000),
  CURVE_REAL_TOKENS_FOR_SALE: num.positive().default(793_100_000),
  PUMP_FEE_BPS: num.min(0).default(125),

  // Entry filter
  MIN_CURVE_PROGRESS: num.min(0).max(1).default(0.3),
  MAX_CURVE_PROGRESS: num.min(0).max(1).default(0.7),
  MOMENTUM_WINDOW_SEC: num.positive().default(300),
  MIN_UNIQUE_BUYERS: num.int().min(0).default(15),
  MIN_BUY_SELL_RATIO: num.min(0).default(2),
  MIN_BUY_VOLUME_SOL: num.min(0).default(5),
  MIN_TOKEN_AGE_SEC: num.min(0).default(30),
  MAX_TOKEN_AGE_SEC: num.positive().default(1800),

  // Safety
  MAX_DEV_HOLD_PCT: num.min(0).max(100).default(10),
  BLOCK_IF_DEV_SOLD: bool.default(true),
  MAX_TOP10_HOLD_PCT: num.min(0).max(100).default(30),
  BUNDLE_WINDOW_SEC: num.min(0).default(3),
  MAX_EARLY_BUYERS_HOLD_PCT: num.min(0).max(100).default(15),
  REQUIRE_SOCIALS: bool.default(true),

  // Sizing & execution
  BUY_AMOUNT_SOL: num.positive().default(0.1),
  SLIPPAGE_PCT: num.min(0).max(100).default(15),
  PAPER_EXTRA_SLIPPAGE_PCT: num.min(0).max(100).default(3),
  PRIORITY_FEE_SOL: num.min(0).default(0.0005),
  JITO_TIP_SOL: num.min(0).default(0.001),
  USE_JITO: bool.default(true),
  JITO_BLOCK_ENGINE_URL: z.string().default("https://mainnet.block-engine.jito.wtf"),
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  WALLET_PRIVATE_KEY: z.string().default(""),

  // Exits
  TAKE_PROFIT_LEVELS: z.string().default("2:0.5"),
  TRAILING_STOP_PCT: num.min(0).max(100).default(25),
  TRAILING_ACTIVATE_MULTIPLE: num.min(1).default(1.5),
  STOP_LOSS_PCT: num.min(0).max(100).default(30),
  MOMENTUM_DEATH_SEC: num.positive().default(180),
  MAX_HOLD_SEC: num.positive().default(1800),
  GRADUATION_SELL_PROGRESS: num.min(0).max(1).default(0.95),
  GRADUATION_SELL_FRACTION: num.min(0).max(1).default(1),

  // Risk
  MAX_OPEN_POSITIONS: num.int().positive().default(3),
  MAX_DAILY_LOSS_SOL: num.positive().default(1),
  STARTING_BALANCE_SOL: num.positive().default(5),
  SUMMARY_INTERVAL_SEC: num.positive().default(60),

  // Strategies
  MOMENTUM_ENABLED: bool.default(true),

  // Copy trading (follow whale wallets)
  COPY_WALLETS: z.string().default(""),
  COPY_WALLETS_FILE: z.string().default(""),
  COPY_BUY_AMOUNT_SOL: num.positive().default(0.05),
  COPY_MIN_WHALE_BUY_SOL: num.min(0).default(0.5),
  COPY_MAX_CURVE_PROGRESS: num.min(0).max(1).default(0.8),
  COPY_MAX_PRICE_MOVE_PCT: num.min(0).default(25),
  COPY_SIGNAL_TTL_SEC: num.positive().default(15),
  COPY_MAX_TOP10_HOLD_PCT: num.min(0).max(100).default(50),
  COPY_REQUIRE_SOCIALS: bool.default(false),
  COPY_SKIP_IF_WHALE_IS_DEV: bool.default(true),
  COPY_ADOPT_UNSEEN_TOKENS: bool.default(true),
  PUMPFUN_API_URL: z.string().default("https://frontend-api-v3.pump.fun"),
  COPY_EXIT_ON_WHALE_SELL: bool.default(true),
  COPY_WHALE_SELL_EXIT_PCT: num.min(0).max(100).default(50),
  COPY_MAX_OPEN_POSITIONS: num.int().min(0).default(2),

  // Dashboard (web UI)
  DASHBOARD_ENABLED: bool.default(true),
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: num.int().min(0).max(65535).default(3000),
});

export type RawConfig = z.infer<typeof schema>;
export type Config = RawConfig & {
  takeProfitLevels: { multiple: number; fraction: number }[];
  /** Whale wallets to copy (from COPY_WALLETS and COPY_WALLETS_FILE). Empty = copy trading off. */
  copyWallets: WatchedWallet[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as "unset" so defaults apply.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") cleaned[k] = v;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.MIN_CURVE_PROGRESS >= cfg.MAX_CURVE_PROGRESS) {
    throw new Error("MIN_CURVE_PROGRESS must be lower than MAX_CURVE_PROGRESS");
  }
  if (cfg.MODE === "live") {
    if (cfg.LIVE_TRADING_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
      throw new Error('MODE=live requires LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY in .env');
    }
    if (!cfg.WALLET_PRIVATE_KEY) throw new Error("MODE=live requires WALLET_PRIVATE_KEY in .env");
  }
  let walletText = cfg.COPY_WALLETS;
  if (cfg.COPY_WALLETS_FILE) {
    if (!existsSync(cfg.COPY_WALLETS_FILE)) throw new Error(`COPY_WALLETS_FILE not found: ${cfg.COPY_WALLETS_FILE}`);
    walletText += "\n" + readFileSync(cfg.COPY_WALLETS_FILE, "utf8");
  }
  const copyWallets = parseWalletList(walletText);
  return { ...cfg, takeProfitLevels: parseTakeProfitLevels(cfg.TAKE_PROFIT_LEVELS), copyWallets };
}
