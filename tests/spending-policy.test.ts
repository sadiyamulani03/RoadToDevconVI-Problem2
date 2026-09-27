/**
 * TEST 5: Per-call spending limit checked BEFORE signing.
 * TEST 6: Total run budget checked BEFORE signing.
 *
 * These tests exercise the SpendingPolicy directly. The policy is pure
 * decision logic: it NEVER signs or pays. Every check here happens in code,
 * with bigint comparisons.
 */
import { describe, expect, it } from "vitest";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";
import type { AdvertisedPaymentRequirement } from "../src/types/index.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (public)

function makePolicy(maxCall: bigint, totalBudget: bigint): SpendingPolicy {
  return new SpendingPolicy({
    maxCallAmountBaseUnits: maxCall,
    totalRunBudgetBaseUnits: totalBudget,
    allowedNetworks: ["base-sepolia"],
    allowedAsset: ASSET,
    allowedAssetDecimals: 6,
  });
}

function requirement(amountBaseUnits: string): AdvertisedPaymentRequirement {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: amountBaseUnits,
    resource: "https://seller.example/reports/latest",
    payTo: "0x1234567890abcdef1234567890abcdef12345678",
    asset: ASSET,
  };
}

const ZERO_SPEND = { totalSpendBeforeBaseUnits: 0n };

describe("TEST 5: per-call ceiling checked before signing", () => {
  it("accepts an amount below the limit", () => {
    const policy = makePolicy(1_000_000n, 5_000_000n); // 1 USDC per call
    const decision = policy.evaluate(requirement("999999"), "seller", "endpoint", ZERO_SPEND);
    expect(decision.decision).toBe("ACCEPTED");
    expect(decision.amountBaseUnits).toBe(999999n);
  });

  it("accepts an amount exactly equal to the limit", () => {
    const policy = makePolicy(1_000_000n, 5_000_000n);
    const decision = policy.evaluate(requirement("1000000"), "seller", "endpoint", ZERO_SPEND);
    expect(decision.decision).toBe("ACCEPTED");
    expect(decision.amountBaseUnits).toBe(1_000_000n);
  });

  it("refuses an amount above the limit and does NOT authorize signing", () => {
    const policy = makePolicy(1_000_000n, 5_000_000n);
    const decision = policy.evaluate(requirement("1000001"), "seller", "endpoint", ZERO_SPEND);
    expect(decision.decision).toBe("REFUSED");
    expect(decision.reason).toBe("quoted amount exceeds per-call ceiling");
    // The policy is pure decision logic: no signing capability exists here.
    expect("sign" in policy).toBe(false);
  });

  it("refuses a massively excessive amount (drain attempt)", () => {
    const policy = makePolicy(1_000_000n, 5_000_000n);
    const decision = policy.evaluate(requirement("999999999999"), "seller", "endpoint", ZERO_SPEND);
    expect(decision.decision).toBe("REFUSED");
    expect(decision.reason).toBe("quoted amount exceeds per-call ceiling");
    expect(decision.amountBaseUnits).toBe(999999999999n);
  });
});

describe("TEST 6: total run budget checked before signing", () => {
  it("allows a payment when spend + amount equals the budget exactly (60 + 40 = 100)", () => {
    const policy = makePolicy(1_000_000n, 100n);
    const decision = policy.evaluate(requirement("40"), "seller", "endpoint", {
      totalSpendBeforeBaseUnits: 60n,
    });
    expect(decision.decision).toBe("ACCEPTED");
    expect(decision.amountBaseUnits).toBe(40n);
  });

  it("refuses a payment when spend + amount exceeds the budget (60 + 41 > 100)", () => {
    const policy = makePolicy(1_000_000n, 100n);
    const decision = policy.evaluate(requirement("41"), "seller", "endpoint", {
      totalSpendBeforeBaseUnits: 60n,
    });
    expect(decision.decision).toBe("REFUSED");
    expect(decision.reason).toBe("quoted amount would exceed total run budget");
  });

  it("refuses when the budget is already exhausted", () => {
    const policy = makePolicy(1_000_000n, 100n);
    const decision = policy.evaluate(requirement("1"), "seller", "endpoint", {
      totalSpendBeforeBaseUnits: 100n,
    });
    expect(decision.decision).toBe("REFUSED");
    expect(decision.reason).toBe("quoted amount would exceed total run budget");
  });

  it("budget check uses the PERSISTED spend value passed in the context", () => {
    const policy = makePolicy(1_000_000n, 500n);
    // The context value comes from the ledger in real usage; here it
    // demonstrates that the policy trusts only the persisted figure.
    const decision = policy.evaluate(requirement("400"), "seller", "endpoint", {
      totalSpendBeforeBaseUnits: 100n,
    });
    expect(decision.decision).toBe("ACCEPTED");
    expect(decision.totalSpendBeforeBaseUnits).toBe(100n);
  });
});
