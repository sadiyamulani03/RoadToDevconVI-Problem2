/**
 * Honest x402 seller (local HTTP service).
 *
 * Uses the actual x402-express paymentMiddleware to protect a research
 * endpoint. Requests an ALLOWED price ($0.01 = 10,000 base units of USDC on
 * base-sepolia by default) so a correctly-configured buyer purse accepts it.
 *
 * Flow: request without payment -> 402 with the x402 payment requirement ->
 * buyer signs via x402 -> retry with X-PAYMENT -> local facilitator verifies
 * the EIP-712 signature -> resource is served -> settlement receipt is
 * returned in the X-PAYMENT-RESPONSE header.
 *
 * Deterministic and self-contained: the pay-to address is a deterministic
 * demo address (not funded, not a secret). No private keys are involved on
 * the seller side.
 */
import "dotenv/config";
import express from "express";
import { getAddress, keccak256, toBytes } from "viem";
import { paymentMiddleware } from "x402-express";
import { createSellerApp, startSellerServer, type SellerOptions } from "./seller-kit.js";
import { fileURLToPath } from "node:url";

/** Deterministic, transparent demo pay-to address (20 bytes of keccak256(label)). NOT a secret, never funded. */
export function demoPayToAddress(label: string): `0x${string}` {
  const hash = keccak256(toBytes(label));
  return getAddress(`0x${hash.slice(26)}`);
}

export const HONEST_DEFAULTS: SellerOptions = {
  kind: "honest",
  /** $0.01 => 10,000 base units of the 6-decimal USDC asset. Within policy. */
  price: "$0.01",
  network: "base-sepolia",
  description: "Honest x402 seller: market research report",
  resourcePath: "/reports/latest",
  payTo: demoPayToAddress("coin-purse-honest-seller"),
  port: Number.parseInt(process.env.HONEST_PORT ?? "4021", 10),
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://127.0.0.1:4020",
};

export function createHonestSellerApp(overrides: Partial<SellerOptions> = {}) {
  return createSellerApp({ ...HONEST_DEFAULTS, ...overrides });
}

export async function startHonestSeller(overrides: Partial<SellerOptions> = {}) {
  return startSellerServer({ ...HONEST_DEFAULTS, ...overrides });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, statsUrl } = await startHonestSeller();
  console.log(`[honest-seller] listening on ${statsUrl}`);
  console.log(`[honest-seller] price: ${HONEST_DEFAULTS.price} (${HONEST_DEFAULTS.network})`);
  console.log(`[honest-seller] payTo: ${HONEST_DEFAULTS.payTo} (deterministic demo address, not funded)`);
  console.log(`[honest-seller] facilitator: ${HONEST_DEFAULTS.facilitatorUrl}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
