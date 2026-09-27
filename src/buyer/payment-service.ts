/**
 * Payment service: the orchestration layer between the x402 client, the
 * spending policy, and the persistent ledger.
 *
 * Responsibilities (in strict order):
 *   1. Select the candidate payment requirement that matches the trusted
 *      network + asset allowlist (never an arbitrary one offered by a seller).
 *   2. Evaluate it against the SpendingPolicy using the PERSISTED cumulative
 *      spend read from the SQLite ledger.
 *   3. Persist the decision (ACCEPTED or REFUSED) BEFORE any signing.
 *   4. Only if ACCEPTED: allow the x402 client to sign, then update the
 *      record with signing/submission state.
 *
 * The private key never passes through this module.
 */
import { findMatchingPaymentRequirements } from "x402/shared";
import type { AdvertisedPaymentRequirement, PolicyDecision } from "../types/index.js";
import { SpendingPolicy } from "./spending-policy.js";
import type { Ledger } from "../ledger/ledger.js";

export interface DecideResult {
  decision: PolicyDecision["decision"];
  reason: string;
  /** Ledger record id of the persisted decision. */
  ledgerId: number;
  /** The requirement the policy accepted (present only when ACCEPTED). */
  requirements?: AdvertisedPaymentRequirement;
}

export class PaymentService {
  private readonly policy: SpendingPolicy;
  private readonly ledger: Ledger;
  private readonly runId: string;

  constructor(policy: SpendingPolicy, ledger: Ledger, runId: string) {
    this.policy = policy;
    this.ledger = ledger;
    this.runId = runId;
  }

  /**
   * Decide whether to pay an advertised set of payment requirements.
   *
   * The candidate requirement is chosen by matching the trusted network and
   * asset allowlists — a seller cannot make the purse pay on a network or
   * asset the operator did not approve, and cannot swap in a different
   * requirement after the check.
   *
   * The decision is persisted to the ledger BEFORE any signing happens.
   */
  async decide(accepts: Array<Record<string, unknown>>, endpoint: string, x402Version: number): Promise<DecideResult> {
    const requirements = this.selectCandidate(accepts);

    let policyDecision: PolicyDecision;
    if (!requirements) {
      // No requirement matches the trusted network + asset allowlist.
      const seenNetworks = uniqueStrings(accepts.map((a) => a["network"]).filter(isString));
      const seenAssets = uniqueStrings(accepts.map((a) => a["asset"]).filter(isString));
      policyDecision = {
        decision: "REFUSED",
        reason: "no payment requirement matches the trusted network and asset allowlist",
        seller: sellerFromEndpoint(endpoint),
        endpoint,
        amountBaseUnits: null,
        maxCallAmountBaseUnits: this.policy.config.maxCallAmountBaseUnits,
        totalRunBudgetBaseUnits: this.policy.config.totalRunBudgetBaseUnits,
        totalSpendBeforeBaseUnits: this.getSpendSoFarBaseUnits(),
        asset: seenAssets.length === 1 ? seenAssets[0] : null,
        network: seenNetworks.length === 1 ? seenNetworks[0] : null,
        paymentRequired: true,
      };
    } else {
      policyDecision = this.policy.evaluate(
        requirements as AdvertisedPaymentRequirement,
        sellerFromEndpoint(endpoint),
        endpoint,
        { totalSpendBeforeBaseUnits: this.getSpendSoFarBaseUnits() },
      );
    }

    // Persist the decision BEFORE any signing. The record starts with
    // payment_signed=0 / payment_submitted=0.
    const ledgerId = this.ledger.recordDecision({
      seller: policyDecision.seller,
      endpoint: policyDecision.endpoint,
      decision: policyDecision.decision,
      reason: policyDecision.reason,
      amountBaseUnits: policyDecision.amountBaseUnits,
      asset: policyDecision.asset,
      network: policyDecision.network,
      paymentRequired: policyDecision.paymentRequired,
      runId: this.runId,
    });

    if (policyDecision.decision === "REFUSED") {
      return { decision: "REFUSED", reason: policyDecision.reason, ledgerId };
    }

    return { decision: "ACCEPTED", reason: policyDecision.reason, ledgerId, requirements };
  }

  /**
   * Select the payment requirement matching the trusted allowlists.
   *
   * Returns the first requirement that matches BOTH the allowed network AND
   * the allowed asset. If none match, returns undefined (refusal).
   */
  private selectCandidate(accepts: Array<Record<string, unknown>>): AdvertisedPaymentRequirement | undefined {
    const { allowedNetworks, allowedAsset } = this.policy.config;
    for (const network of allowedNetworks) {
      // Prefer a requirement that also matches the allowed asset.
      const matching = accepts.find(
        (a) => a["network"] === network && typeof a["asset"] === "string" &&
          (a["asset"] as string).toLowerCase() === allowedAsset.toLowerCase(),
      );
      if (matching) return matching as AdvertisedPaymentRequirement;
    }
    // Fall back to the SDK matcher restricted to allowed networks; the asset
    // allowlist is still enforced by the policy afterwards.
    const perNetwork = accepts.find((a) =>
      allowedNetworks.includes(typeof a["network"] === "string" ? (a["network"] as string) : ""),
    );
    if (!perNetwork) return undefined;
    const sdkMatch = findMatchingPaymentRequirements(
      accepts as unknown as Parameters<typeof findMatchingPaymentRequirements>[0],
      { scheme: "exact", network: perNetwork["network"] } as unknown as Parameters<typeof findMatchingPaymentRequirements>[1],
    );
    return (sdkMatch ?? perNetwork) as unknown as AdvertisedPaymentRequirement;
  }

  /** Cumulative spend for this run, read from the PERSISTED ledger. */
  getSpendSoFarBaseUnits(): bigint {
    return this.ledger.getTotalSpendBaseUnits(this.runId);
  }

  markSigned(ledgerId: number): Promise<void> {
    this.ledger.markPayment(ledgerId, { paymentSigned: true, paymentSubmitted: false, transactionHash: null });
    return Promise.resolve();
  }

  markSubmitted(ledgerId: number, transactionHash: string | null): Promise<void> {
    this.ledger.markPayment(ledgerId, { paymentSigned: true, paymentSubmitted: true, transactionHash });
    return Promise.resolve();
  }

  markNotSubmitted(ledgerId: number): Promise<void> {
    // Signed but no settlement header; keep signed=true, submitted=false.
    this.ledger.markPayment(ledgerId, { paymentSigned: true, paymentSubmitted: false, transactionHash: null });
    return Promise.resolve();
  }

  markSigningFailure(ledgerId: number, reason: string): Promise<void> {
    this.ledger.markRefusalExtra(ledgerId, `signing failed: ${reason}`);
    return Promise.resolve();
  }

  markSubmissionFailure(ledgerId: number, reason: string): Promise<void> {
    this.ledger.markRefusalExtra(ledgerId, `submission failed: ${reason}`);
    return Promise.resolve();
  }
}

/** Derive an audit label for the seller from the endpoint URL host. */
export function sellerFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
