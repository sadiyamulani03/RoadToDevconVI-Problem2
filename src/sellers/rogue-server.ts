/**
 * Rogue x402 seller (local HTTP service).
 *
 * A separate seller that demands an UNACCEPTABLE payment amount: by default
 * $10.00 = 10,000,000 base units of USDC, which exceeds the configured
 * per-call ceiling (MAX_CALL_AMOUNT_BASE_UNITS, default 1,000,000 = 1 USDC).
 *
 * The buyer must:
 *   receive the requirement
 *     -> detect the excessive amount
 *     -> record a refusal in the ledger
 *     -> NOT sign
 *     -> NOT submit any payment
 *
 * The rogue seller's facilitator-side stats make this verifiable by actual
 * execution: no payment is ever verified or settled for this seller.
 */
import "dotenv/config";
import { getAddress, keccak256, toBytes } from "viem";
import { createSellerApp, startSellerServer, type SellerOptions } from "./seller-kit.js";
import { fileURLToPath } from "node:url";

/** Same deterministic derivation as the honest seller; distinct label. Not a secret. */
export function demoPayToAddress(label: string): `0x${string}` {
  const hash = keccak256(toBytes(label));
  return getAddress(`0x${hash.slice(26)}`);
}

export const ROGUE_DEFAULTS: SellerOptions = {
  kind: "rogue",
  /** $10.00 => 10,000,000 base units. FAR above the per-call ceiling. */
  price: "$10.00",
  network: "base-sepolia",
  description: "Rogue x402 seller: overpriced research report",
  resourcePath: "/reports/rogue",
  payTo: demoPayToAddress("coin-purse-rogue-seller"),
  port: Number.parseInt(process.env.ROGUE_PORT ?? "4022", 10),
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://127.0.0.1:4020",
};

export function createRogueSellerApp(overrides: Partial<SellerOptions> = {}) {
  return createSellerApp({ ...ROGUE_DEFAULTS, ...overrides });
}

export async function startRogueSeller(overrides: Partial<SellerOptions> = {}) {
  return startSellerServer({ ...ROGUE_DEFAULTS, ...overrides });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, statsUrl } = await startRogueSeller();
  console.log(`[rogue-seller] listening on ${statsUrl}`);
  console.log(`[rogue-seller] price: ${ROGUE_DEFAULTS.price} (${ROGUE_DEFAULTS.network}) - exceeds per-call ceiling`);
  console.log(`[rogue-seller] payTo: ${ROGUE_DEFAULTS.payTo} (deterministic demo address, not funded)`);
  console.log(`[rogue-seller] facilitator: ${ROGUE_DEFAULTS.facilitatorUrl}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
