/**
 * Shared types for the x402 Coin Purse agent.
 *
 * Monetary values are represented as exact integers (bigint) in base units.
 * 1 USDC with 6 decimals === 1_000_000n base units.
 */

export type PolicyDecisionType = "ACCEPTED" | "REFUSED";

export type RefusalReason =
  | "network is not on the allowlist"
  | "asset is not on the allowlist"
  | "quoted amount exceeds per-call ceiling"
  | "quoted amount would exceed total run budget"
  | "quoted amount is not a valid integer amount"
  | "no acceptable payment requirement";

export interface PolicyDecision {
  decision: PolicyDecisionType;
  reason: string;
  seller: string;
  endpoint: string;
  /** Exact integer amount quoted by the seller, in base units. Null when unparseable. */
  amountBaseUnits: bigint | null;
  maxCallAmountBaseUnits: bigint;
  totalRunBudgetBaseUnits: bigint;
  /** Persisted total spend before this decision, in base units. */
  totalSpendBeforeBaseUnits: bigint;
  asset: string | null;
  network: string | null;
  paymentRequired: boolean;
}

export interface LedgerEntryInput {
  seller: string;
  endpoint: string;
  decision: PolicyDecisionType;
  reason: string;
  /** Exact integer amount in base units (decimal string in storage). Null when unparseable. */
  amountBaseUnits: bigint | null;
  asset: string | null;
  network: string | null;
  paymentRequired: boolean;
  runId: string;
}

export interface LedgerRecord {
  id: number;
  timestamp: string;
  seller: string;
  endpoint: string;
  decision: PolicyDecisionType;
  reason: string;
  /** Exact decimal string of the bigint base-unit amount. */
  amountBaseUnits: string | null;
  asset: string | null;
  network: string | null;
  paymentRequired: boolean;
  paymentSigned: boolean;
  paymentSubmitted: boolean;
  transactionHash: string | null;
  runId: string;
}

export interface PaidFetchResult {
  url: string;
  ok: boolean;
  decision: PolicyDecisionType;
  reason: string;
  status?: number;
  body?: string;
  /** Ledger record id for the persisted decision. */
  ledgerId: number | null;
  paymentSigned: boolean;
  paymentSubmitted: boolean;
  transactionHash: string | null;
}

/** A payment requirement as advertised by an x402 seller. */
export interface AdvertisedPaymentRequirement {
  scheme: string;
  network: string;
  asset?: string;
  /** Decimal string amount required by the seller. */
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}
