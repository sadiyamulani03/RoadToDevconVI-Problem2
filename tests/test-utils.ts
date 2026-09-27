/**
 * Shared test utilities.
 *
 * Every private key used in tests is GENERATED AT RUNTIME via viem's
 * generatePrivateKey(). No credentials are committed to the repository.
 *
 * Sellers + facilitator run on ephemeral ports against a local facilitator,
 * so no test ever touches an external network or a real chain.
 */
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { createSigner } from "x402/types";
import type { Signer } from "x402/types";
import { startLocalFacilitator, type FacilitatorServer } from "../src/sellers/local-facilitator.js";
import { startHonestSeller, HONEST_DEFAULTS } from "../src/sellers/honest-server.js";
import { startRogueSeller, ROGUE_DEFAULTS } from "../src/sellers/rogue-server.js";
import type { SellerServer } from "../src/sellers/seller-kit.js";

export interface TestStack {
  facilitator: FacilitatorServer;
  honest: SellerServer;
  rogue: SellerServer;
  signerFactory: () => Promise<Signer>;
  honestUrl: string;
  rogueUrl: string;
  close(): Promise<void>;
}

export const TEST_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (public, from the x402 SDK)

export async function startTestStack(overrides: {
  honestPrice?: string;
  roguePrice?: string;
} = {}): Promise<TestStack> {
  const facilitator = await startLocalFacilitator({ networks: ["base-sepolia"] });
  const honest = await startHonestSeller({
    facilitatorUrl: facilitator.url,
    port: 0,
    ...(overrides.honestPrice ? { price: overrides.honestPrice } : {}),
  });
  const rogue = await startRogueSeller({
    facilitatorUrl: facilitator.url,
    port: 0,
    ...(overrides.roguePrice ? { price: overrides.roguePrice } : {}),
  });
  const privateKey: Hex = generatePrivateKey();
  return {
    facilitator,
    honest,
    rogue,
    signerFactory: () => createSigner("base-sepolia", privateKey),
    honestUrl: `${honest.url}${honest.options.resourcePath}`,
    rogueUrl: `${rogue.url}${rogue.options.resourcePath}`,
    close: async () => {
      await honest.close();
      await rogue.close();
      await facilitator.close();
    },
  };
}

export { HONEST_DEFAULTS, ROGUE_DEFAULTS };
