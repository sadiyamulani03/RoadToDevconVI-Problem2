/**
 * The Coin Purse spending policy.
 *
 * This is the security boundary of the buyer. It runs in executable code and
 * is the ONLY place payment decisions are made. The LLM prompt is NOT a
 * security boundary and the model is never trusted to decide whether a
 * payment is safe.
 *
 * Checks, in order, all BEFORE any signing:
 *   1. Network allowlist
 *   2. Asset allowlist
 *   3. Exact integer parse of the quoted amount into base units
 *   4. Per-call ceiling:   quoted <= maxCallAmountBaseUnits
 *   5. Total run budget:   persistedSpend + quoted <= totalRunBudgetBaseUnits
 *
 * All monetary comparisons use bigint. Policy values come from trusted
 * application configuration, never from tool arguments.
 */
import { parseBaseUnits, isWithinCeiling, isWithinBudget } from "./money.js";
import type { AdvertisedPaymentRequirement, PolicyDecision, RefusalReason } from "../types/index.js";

export interface SpendingPolicyConfig {
  /** Hard per-call ceiling in base units (bigint). */
  maxCallAmountBaseUnits: bigint;
  /** Total run budget in base units (bigint). */
  totalRunBudgetBaseUnits: bigint;
  /** Networks the purse may ever pay on. */
  allowedNetworks: readonly string[];
  /** The single allowed payment asset contract address. */
  allowedAsset: string;
  /** Decimals of the allowed asset (for exact base-unit parsing). */
  allowedAssetDecimals: number;
}

export interface PolicyEvaluationContext {
  /** Persisted total spend before this decision, in base units. */
  totalSpendBeforeBaseUnits: bigint;
}

export interface RequirementParseResult {
  ok: boolean;
  reason?: RefusalReason | string;
  amountBaseUnits?: bigint;
}

export class SpendingPolicy {
  readonly config: SpendingPolicyConfig;

  constructor(config: SpendingPolicyConfig) {
    // Deep-freeze the policy configuration: neither tool arguments, model
    // output, nor seller input can mutate the trusted policy values.
    this.config = Object.freeze({
      ...config,
      allowedNetworks: Object.freeze([...config.allowedNetworks]),
    }) as SpendingPolicyConfig;
  }

  /**
   * Fully evaluate an advertised payment requirement against this policy.
   * Returns ACCEPTED only when every check passes. NEVER signs or pays —
   * this method is pure decision logic.
   */
  evaluate(
    requirement: AdvertisedPaymentRequirement,
    seller: string,
    endpoint: string,
    ctx: PolicyEvaluationContext,
  ): PolicyDecision {
    const base = {
      seller,
      endpoint,
      maxCallAmountBaseUnits: this.config.maxCallAmountBaseUnits,
      totalRunBudgetBaseUnits: this.config.totalRunBudgetBaseUnits,
      totalSpendBeforeBaseUnits: ctx.totalSpendBeforeBaseUnits,
      asset: typeof requirement.asset === "string" ? requirement.asset : null,
      network: typeof requirement.network === "string" ? requirement.network : null,
      paymentRequired: true,
    };

    // 1. Network allowlist
    if (!requirement.network || typeof requirement.network !== "string" ||
        !this.config.allowedNetworks.includes(requirement.network)) {
      return {
        ...base,
        decision: "REFUSED",
        reason: "network is not on the allowlist",
        amountBaseUnits: null,
      };
    }

    // 2. Asset allowlist
    if (!requirement.asset || typeof requirement.asset !== "string" ||
        requirement.asset.toLowerCase() !== this.config.allowedAsset.toLowerCase()) {
      return {
        ...base,
        decision: "REFUSED",
        reason: "asset is not on the allowlist",
        amountBaseUnits: null,
      };
    }

    // 3. Exact integer parse of the quoted amount into base units.
    //    x402 payment requirements quote amounts ALREADY in base units
    //    (e.g. "10000" = 10,000 base units); they are parsed directly as
    //    exact integers, never with floating point.
    let amountBaseUnits: bigint;
    try {
      if (typeof requirement.maxAmountRequired !== "string") {
        throw new Error("missing amount");
      }
      amountBaseUnits = parseBaseUnits(requirement.maxAmountRequired);
    } catch {
      return {
        ...base,
        decision: "REFUSED",
        reason: "quoted amount is not a valid integer amount",
        amountBaseUnits: null,
      };
    }

    // 4. Per-call ceiling (bigint comparison, before signing)
    if (!isWithinCeiling(amountBaseUnits, this.config.maxCallAmountBaseUnits)) {
      return {
        ...base,
        decision: "REFUSED",
        reason: "quoted amount exceeds per-call ceiling",
        amountBaseUnits,
      };
    }

    // 5. Total run budget against persisted spend (bigint comparison, before signing)
    if (!isWithinBudget(amountBaseUnits, ctx.totalSpendBeforeBaseUnits, this.config.totalRunBudgetBaseUnits)) {
      return {
        ...base,
        decision: "REFUSED",
        reason: "quoted amount would exceed total run budget",
        amountBaseUnits,
      };
    }

    return {
      ...base,
      decision: "ACCEPTED",
      reason: "within per-call ceiling and total run budget",
      amountBaseUnits,
    };
  }
}
