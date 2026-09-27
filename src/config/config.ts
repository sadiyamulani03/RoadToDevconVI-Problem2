/**
 * Application configuration.
 *
 * All spending-policy values come from trusted configuration (environment),
 * never from tool arguments or model output.
 *
 * No secrets are hardcoded here. PRIVATE_KEY / LLM_API_KEY are read from the
 * environment at runtime and are never logged, persisted, or exposed to the
 * model.
 */
import "dotenv/config";
import { MoneyFormatError } from "../buyer/money.js";

export interface AppConfig {
  /** Hard per-call ceiling in base units (bigint). */
  maxCallAmountBaseUnits: bigint;
  /** Total run budget in base units (bigint). */
  totalRunBudgetBaseUnits: bigint;
  /** Networks the purse may ever pay on, e.g. ["base-sepolia"]. */
  allowedNetworks: readonly string[];
  /** The single allowed payment asset contract address. */
  allowedAsset: string;
  /** Decimals of the allowed asset (used for exact base-unit parsing). */
  allowedAssetDecimals: number;
  /** x402 protocol version. */
  x402Version: number;
  /** Facilitator URL used for payment verification/settlement. */
  facilitatorUrl: string;
  /** EVM RPC URL used for signing-side chain access. */
  rpcUrl: string;
  /** Path to the SQLite ledger database. */
  ledgerDbPath: string;
  /** Ports for the local sellers. */
  honestPort: number;
  roguePort: number;
  /** EVM chain id for the allowed network (Base Sepolia = 84532). */
  chainId: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse an env value into an exact bigint. Rejects non-integer notation. */
export function parseBigIntEnv(value: string | undefined, name: string): bigint {
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`${name} must be a non-negative integer (base units), got "${trimmed}"`);
  }
  return BigInt(trimmed);
}

function parseIntEnv(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Load configuration from environment variables.
 *
 * Credentials (PRIVATE_KEY, LLM_API_KEY) are intentionally NOT part of the
 * returned config object: the policy layer never needs them, and the
 * research agent must never see them.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxCallAmountBaseUnits = parseBigIntEnv(env.MAX_CALL_AMOUNT_BASE_UNITS, "MAX_CALL_AMOUNT_BASE_UNITS");
  const totalRunBudgetBaseUnits = parseBigIntEnv(env.TOTAL_RUN_BUDGET_BASE_UNITS, "TOTAL_RUN_BUDGET_BASE_UNITS");

  const allowedNetworkRaw = env.ALLOWED_NETWORKS ?? env.ALLOWED_NETWORK;
  if (!allowedNetworkRaw || allowedNetworkRaw.trim() === "") {
    throw new ConfigError("Missing required environment variable: ALLOWED_NETWORK (or ALLOWED_NETWORKS)");
  }
  const allowedNetworks = allowedNetworkRaw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (allowedNetworks.length === 0) {
    throw new ConfigError("ALLOWED_NETWORK must contain at least one network");
  }

  const allowedAsset = requireEnv(env.ALLOWED_ASSET, "ALLOWED_ASSET");
  if (!/^0x[0-9a-fA-F]{40}$/.test(allowedAsset)) {
    throw new ConfigError(`ALLOWED_ASSET must be a 20-byte hex contract address, got "${allowedAsset}"`);
  }

  const allowedAssetDecimals = parseIntEnv(env.ALLOWED_ASSET_DECIMALS, "ALLOWED_ASSET_DECIMALS", 6);
  const x402Version = parseIntEnv(env.X402_VERSION, "X402_VERSION", 1);
  const facilitatorUrl = env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
  const rpcUrl = env.RPC_URL?.trim() || "https://sepolia.base.org";
  const ledgerDbPath = env.LEDGER_DB_PATH?.trim() || "./data/ledger.sqlite";
  const honestPort = parseIntEnv(env.HONEST_PORT, "HONEST_PORT", 4021);
  const roguePort = parseIntEnv(env.ROGUE_PORT, "ROGUE_PORT", 4022);

  const chainId = parseIntEnv(env.CHAIN_ID, "CHAIN_ID", BASE_SEPOLIA_CHAIN_ID);
  if (chainId === BASE_SEPOLIA_CHAIN_ID && !allowedNetworks.includes("base-sepolia")) {
    throw new ConfigError('Base Sepolia (chain id 84532) selected but "base-sepolia" is not in ALLOWED_NETWORK');
  }

  return {
    maxCallAmountBaseUnits,
    totalRunBudgetBaseUnits,
    allowedNetworks,
    allowedAsset,
    allowedAssetDecimals,
    x402Version,
    facilitatorUrl,
    rpcUrl,
    ledgerDbPath,
    honestPort,
    roguePort,
    chainId,
  };
}

/** Redact config for safe logging/display: monetary limits and allowlists only. */
export function redactConfigForLog(config: AppConfig): Record<string, string> {
  return {
    maxCallAmountBaseUnits: config.maxCallAmountBaseUnits.toString(),
    totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits.toString(),
    allowedNetworks: config.allowedNetworks.join(","),
    allowedAsset: config.allowedAsset,
    allowedAssetDecimals: String(config.allowedAssetDecimals),
    chainId: String(config.chainId),
  };
}

/**
 * Local-demo defaults for the spending policy (non-secret, documented in
 * .env.example and README). Used ONLY by the demo/agent entry points when
 * the corresponding environment variables are not set, so the local
 * demonstration runs without any configuration. Live deployments must set
 * the environment variables explicitly via loadConfig().
 */
export const LOCAL_DEMO_DEFAULTS = {
  MAX_CALL_AMOUNT_BASE_UNITS: "1000000", // 1 USDC per call
  TOTAL_RUN_BUDGET_BASE_UNITS: "5000000", // 5 USDC per run
  ALLOWED_NETWORK: "base-sepolia",
  /** Base Sepolia USDC — the default asset built into the x402 SDK. Public, not a secret. */
  ALLOWED_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

/** loadConfig with local-demo defaults filled in for missing policy variables. */
export function loadConfigForLocalDemo(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfig({
    ...env,
    MAX_CALL_AMOUNT_BASE_UNITS: env.MAX_CALL_AMOUNT_BASE_UNITS ?? LOCAL_DEMO_DEFAULTS.MAX_CALL_AMOUNT_BASE_UNITS,
    TOTAL_RUN_BUDGET_BASE_UNITS: env.TOTAL_RUN_BUDGET_BASE_UNITS ?? LOCAL_DEMO_DEFAULTS.TOTAL_RUN_BUDGET_BASE_UNITS,
    ALLOWED_NETWORK: env.ALLOWED_NETWORK ?? env.ALLOWED_NETWORKS ?? LOCAL_DEMO_DEFAULTS.ALLOWED_NETWORK,
    ALLOWED_ASSET: env.ALLOWED_ASSET ?? LOCAL_DEMO_DEFAULTS.ALLOWED_ASSET,
  });
}

export { MoneyFormatError };
