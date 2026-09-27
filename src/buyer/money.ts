/**
 * Exact integer money helpers.
 *
 * Money is NEVER represented with floating point. All amounts are handled as
 * decimal strings or bigint base units. `number` inputs are rejected at the
 * type level and guarded at runtime.
 */

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

/** Plain decimal notation only. Rejects exponent notation, signs, whitespace. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Digit-only integer notation (base units already quoted by an x402 seller). */
const INTEGER_RE = /^\d+$/;

/**
 * Convert a decimal string amount (e.g. "0.001") into integer base units
 * (e.g. 1000n for a 6-decimal asset). Exact: no floating point involved.
 *
 * Used for decimal-string prices and display. NOTE: x402 payment
 * requirements quote amounts ALREADY in base units — those are parsed with
 * parseBaseUnits, not this function.
 *
 * @param amount   Decimal string, e.g. "1", "0.001"
 * @param decimals Asset decimals, e.g. 6 for USDC
 */
export function parseAmountToBaseUnits(amount: string, decimals: number): bigint {
  if (typeof amount !== "string") {
    throw new MoneyFormatError("amount must be a decimal string, not a number");
  }
  if (!DECIMAL_RE.test(amount)) {
    throw new MoneyFormatError(`amount "${amount}" is not a plain decimal string`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new MoneyFormatError(`decimals must be a non-negative integer`);
  }
  const [intPart, fracPart = ""] = amount.split(".");
  if (fracPart.length > decimals) {
    throw new MoneyFormatError(
      `amount "${amount}" has more precision (${fracPart.length} decimals) than the asset supports (${decimals})`,
    );
  }
  const paddedFraction = fracPart.padEnd(decimals, "0");
  return BigInt(`${intPart}${paddedFraction}`);
}

/**
 * Parse a quoted amount that is ALREADY expressed in base units (as x402
 * payment requirements always are, e.g. "10000" = 10,000 base units) into a
 * bigint. Exact: digit-only strings only, no floating point involved.
 *
 * Anything that is not a plain non-negative integer string (exponent
 * notation, fractions, signs, whitespace, garbage) is rejected.
 */
export function parseBaseUnits(value: string): bigint {
  if (typeof value !== "string") {
    throw new MoneyFormatError("base-unit amount must be an integer string, not a number");
  }
  if (!INTEGER_RE.test(value)) {
    throw new MoneyFormatError(`base-unit amount "${value}" is not a plain integer string`);
  }
  return BigInt(value);
}

/** Format integer base units back into a decimal string for display. */
export function formatBaseUnits(baseUnits: bigint, decimals: number): string {
  if (typeof baseUnits !== "bigint") {
    throw new MoneyFormatError("baseUnits must be a bigint");
  }
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const digits = abs.toString();
  if (decimals === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** Exact integer comparison helpers used by the spending policy. */
export function isWithinCeiling(quotedAmount: bigint, maxCallAmount: bigint): boolean {
  return quotedAmount <= maxCallAmount;
}

export function isWithinBudget(quotedAmount: bigint, totalSpendSoFar: bigint, totalBudget: bigint): boolean {
  return totalSpendSoFar + quotedAmount <= totalBudget;
}
