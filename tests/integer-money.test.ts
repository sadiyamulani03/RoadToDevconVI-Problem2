/**
 * TEST 10: Integer/base-unit money comparisons.
 *
 * Money is NEVER represented with floating-point arithmetic in this
 * codebase. All payment amounts are handled as bigint base units:
 *   1 USDC (6 decimals) === 1_000_000n
 *
 * These tests prove exact integer comparisons and the absence of float
 * artifacts: parseFloat()/Number() are never used for payment amounts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseAmountToBaseUnits, parseBaseUnits, formatBaseUnits, isWithinCeiling, isWithinBudget, MoneyFormatError } from "../src/buyer/money.js";

describe("TEST 10: integer base-unit money handling", () => {
  it("1 USDC === 1,000,000 base units for a 6-decimal asset", () => {
    expect(parseAmountToBaseUnits("1", 6)).toBe(1_000_000n);
  });

  it("parses fractional amounts exactly (no float artifacts)", () => {
    expect(parseAmountToBaseUnits("0.01", 6)).toBe(10_000n);
    expect(parseAmountToBaseUnits("0.001", 6)).toBe(1_000n);
    expect(parseAmountToBaseUnits("0.000001", 6)).toBe(1n);
    expect(parseAmountToBaseUnits("10.00", 6)).toBe(10_000_000n);
    expect(parseAmountToBaseUnits("0.1", 6)).toBe(100_000n);
  });

  it("parses quoted base-unit amounts exactly (x402 requirements quote base units)", () => {
    expect(parseBaseUnits("10000")).toBe(10_000n); // $0.01 of USDC
    expect(parseBaseUnits("1000000")).toBe(1_000_000n); // 1 USDC
    expect(parseBaseUnits("10000000")).toBe(10_000_000n); // 10 USDC
    expect(parseBaseUnits("0")).toBe(0n);
    expect(() => parseBaseUnits("1e6")).toThrow(MoneyFormatError);
    expect(() => parseBaseUnits("10.5")).toThrow(MoneyFormatError);
    expect(() => parseBaseUnits("-5")).toThrow(MoneyFormatError);
    expect(() => parseBaseUnits(10000 as unknown as string)).toThrow(MoneyFormatError);
  });

  it("rejects number inputs (money must be a string or bigint)", () => {
    expect(() => parseAmountToBaseUnits(0.01 as unknown as string, 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits(1 as unknown as string, 6)).toThrow(MoneyFormatError);
  });

  it("rejects exponent notation, signs, whitespace, and garbage", () => {
    expect(() => parseAmountToBaseUnits("1e6", 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits("-1", 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits(" 1 ", 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits("abc", 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits("", 6)).toThrow(MoneyFormatError);
    expect(() => parseAmountToBaseUnits("1.", 6)).toThrow(MoneyFormatError);
  });

  it("rejects amounts with more precision than the asset supports", () => {
    expect(() => parseAmountToBaseUnits("0.0000001", 6)).toThrow(MoneyFormatError);
  });

  it("handles huge values exactly (beyond Number.MAX_SAFE_INTEGER)", () => {
    const huge = "123456789012345678901234567890"; // 30 digits, far beyond 2^53
    expect(parseAmountToBaseUnits(huge, 6)).toBe(123456789012345678901234567890000000n);
  });

  it("compares amounts against limits with exact bigint semantics", () => {
    // Boundary values that float arithmetic would get wrong.
    expect(isWithinCeiling(9_000_000_000_000_000_001n, 9_000_000_000_000_000_000n)).toBe(false);
    expect(isWithinCeiling(9_000_000_000_000_000_000n, 9_000_000_000_000_000_000n)).toBe(true);
    expect(isWithinBudget(4_000_000_000_000_000_000n, 5_000_000_000_000_000_000n, 9_000_000_000_000_000_000n)).toBe(true);
    expect(isWithinBudget(4_000_000_000_000_000_001n, 5_000_000_000_000_000_000n, 9_000_000_000_000_000_000n)).toBe(false);
  });

  it("0.1 + 0.2 style float traps are impossible: exact bigint arithmetic", () => {
    // In floats, 0.1 + 0.2 !== 0.3. In base units this is exact:
    const a = parseAmountToBaseUnits("0.1", 6); // 100000n
    const b = parseAmountToBaseUnits("0.2", 6); // 200000n
    expect(a + b).toBe(parseAmountToBaseUnits("0.3", 6)); // 300000n exactly
  });

  it("formats base units back to decimal strings exactly", () => {
    expect(formatBaseUnits(1_000_000n, 6)).toBe("1.000000");
    expect(formatBaseUnits(10_000n, 6)).toBe("0.010000");
    expect(formatBaseUnits(1n, 6)).toBe("0.000001");
    expect(formatBaseUnits(10_000_000n, 6)).toBe("10.000000");
    expect(formatBaseUnits(0n, 6)).toBe("0.000000");
  });

  it("source code never uses parseFloat or Number() for payment amounts", () => {
    const buyerSources = [
      readFileSync(new URL("../src/buyer/money.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/buyer/spending-policy.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/buyer/payment-service.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/buyer/x402-client.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/ledger/ledger.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/config/config.ts", import.meta.url), "utf-8"),
      readFileSync(new URL("../src/types/index.ts", import.meta.url), "utf-8"),
    ].join("\n");
    expect(buyerSources).not.toMatch(/parseFloat\s*\(/);
    expect(buyerSources).not.toMatch(/\bNumber\s*\(\s*amount/);
    expect(buyerSources).not.toMatch(/\bNumber\s*\(\s*quoted/i);
    // Money fields are typed as bigint, not number.
    expect(buyerSources).toMatch(/maxCallAmountBaseUnits:\s*bigint/);
    expect(buyerSources).toMatch(/totalRunBudgetBaseUnits:\s*bigint/);
    expect(buyerSources).toMatch(/amountBaseUnits:\s*bigint\s*\|\s*null/);
  });
});
