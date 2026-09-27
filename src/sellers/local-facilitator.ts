/**
 * Local x402 facilitator.
 *
 * Implements the standard x402 facilitator HTTP contract (POST /verify,
 * POST /settle, GET /supported) so the local demonstration is fully
 * self-contained: no external facilitator, no chain, no credentials.
 *
 * /verify performs GENUINE cryptographic verification of the payment
 * authorization using viem's verifyTypedData against the exact EIP-712
 * domain the x402 SDK signs with (EIP-3009 TransferWithAuthorization,
 * domain { name, version, chainId, verifyingContract } from the payment
 * requirements' `extra`).
 *
 * /settle re-verifies and returns a success receipt. IMPORTANT: the
 * `transaction` value returned here is a LOCAL facilitator receipt
 * ("local-<hash>"), NOT a blockchain transaction hash. No on-chain
 * settlement is broadcast because no chain is available in the local
 * demonstration. For live Base Sepolia runs, configure FACILITATOR_URL to a
 * real facilitator (e.g. https://x402.org/facilitator) which performs true
 * on-chain settlement.
 *
 * This is infrastructure for the SELLER side only. The buyer's purse never
 * trusts this component for its own spending decisions.
 */
import express, { type Request, Response } from "express";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, stringToHex, verifyTypedData } from "viem";
import { evm } from "x402/types";

export interface LocalFacilitatorOptions {
  /** Networks this facilitator supports, e.g. ["base-sepolia"]. */
  networks: readonly string[];
  /** Default EIP-712 domain name if the payment requirements do not provide one. */
  defaultDomainName?: string;
  /** Default EIP-712 domain version if the payment requirements do not provide one. */
  defaultDomainVersion?: string;
}

export interface FacilitatorServer {
  app: ReturnType<typeof express>;
  port: number;
  url: string;
  close(): Promise<void>;
  /** Counters used by verification tests/demos (server-side observations). */
  stats: { verifyCalls: number; settleCalls: number; settlementsOk: number; settlementsFailed: number };
}

export function createLocalFacilitator(options: LocalFacilitatorOptions): FacilitatorServer {
  const app = express();
  app.use(express.json());

  const stats = { verifyCalls: 0, settleCalls: 0, settlementsOk: 0, settlementsFailed: 0 };

  async function verifyPayment(
    paymentPayload: any,
    paymentRequirements: any,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    stats.verifyCalls++;

    // Scheme must be "exact".
    if (paymentPayload?.scheme !== "exact") {
      return { isValid: false, invalidReason: "unsupported_scheme" };
    }
    // Network must be one this facilitator supports.
    if (!options.networks.includes(paymentPayload?.network)) {
      return { isValid: false, invalidReason: "invalid_network" };
    }
    if (paymentRequirements?.network !== paymentPayload?.network) {
      return { isValid: false, invalidReason: "invalid_payment_requirements" };
    }

    const authorization = paymentPayload?.payload?.authorization;
    const signature = paymentPayload?.payload?.signature;
    if (!authorization || typeof signature !== "string") {
      return { isValid: false, invalidReason: "invalid_payload" };
    }

    let payTo: `0x${string}`;
    let asset: `0x${string}`;
    let from: `0x${string}`;
    let to: `0x${string}`;
    try {
      payTo = getAddress(paymentRequirements.payTo);
      asset = getAddress(paymentRequirements.asset);
      from = getAddress(authorization.from);
      to = getAddress(authorization.to);
    } catch {
      return { isValid: false, invalidReason: "invalid_payload" };
    }

    // The signed transfer must go to the seller the requirements name.
    if (to !== payTo) {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_recipient_mismatch" };
    }

    // The signed amount must equal the required amount, compared as exact
    // integers (bigint), never floating point.
    let value: bigint;
    let maxAmountRequired: bigint;
    try {
      if (!/^\d+$/.test(String(authorization.value))) throw new Error("not an integer");
      if (!/^\d+$/.test(String(paymentRequirements.maxAmountRequired))) throw new Error("not an integer");
      value = BigInt(String(authorization.value));
      maxAmountRequired = BigInt(String(paymentRequirements.maxAmountRequired));
    } catch {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value" };
    }
    if (value !== maxAmountRequired) {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value" };
    }

    // Validity window check.
    let validAfter: bigint;
    let validBefore: bigint;
    try {
      validAfter = BigInt(String(authorization.validAfter));
      validBefore = BigInt(String(authorization.validBefore));
    } catch {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_after" };
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < validAfter) {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_after" };
    }
    if (now > validBefore) {
      return { isValid: false, invalidReason: "payment_expired" };
    }

    // Nonce must be 32 bytes.
    const nonce = String(authorization.nonce);
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      return { isValid: false, invalidReason: "invalid_payload" };
    }

    // Genuine EIP-712 signature verification, exactly as the x402 SDK signs:
    // domain from requirements.extra (name/version), chainId, verifyingContract = asset.
    const domainName = typeof paymentRequirements.extra?.name === "string"
      ? paymentRequirements.extra.name
      : (options.defaultDomainName ?? "USD Coin");
    const domainVersion = typeof paymentRequirements.extra?.version === "string"
      ? paymentRequirements.extra.version
      : (options.defaultDomainVersion ?? "2");
    const chainId = networkToChainId(paymentRequirements.network);
    if (chainId === null) {
      return { isValid: false, invalidReason: "invalid_network" };
    }

    let signatureValid = false;
    try {
      signatureValid = await verifyTypedData({
        address: from,
        domain: { name: domainName, version: domainVersion, chainId, verifyingContract: asset },
        types: evm.authorizationTypes,
        primaryType: evm.authorizationPrimaryType,
        message: {
          from,
          to,
          value: String(authorization.value),
          validAfter: String(authorization.validAfter),
          validBefore: String(authorization.validBefore),
          nonce,
        },
        signature: signature as `0x${string}`,
      });
    } catch {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    }
    if (!signatureValid) {
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    }

    // NOTE: no on-chain balance/settlement check — no chain is available in
    // the local demonstration. See the module docstring.
    return { isValid: true, payer: from };
  }

  app.post("/verify", async (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const result = await verifyPayment(paymentPayload, paymentRequirements);
    res.status(200).json(result);
  });

  app.post("/settle", async (req: Request, res: Response) => {
    stats.settleCalls++;
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const result = await verifyPayment(paymentPayload, paymentRequirements);
    if (!result.isValid) {
      stats.settlementsFailed++;
      res.status(200).json({ success: false, errorReason: result.invalidReason, payer: result.payer, transaction: "", network: paymentPayload?.network ?? "" });
      return;
    }
    stats.settlementsOk++;
    // Local receipt id: deterministic, clearly NOT a blockchain tx hash.
    const receipt = `local-${keccak256(stringToHex(`${paymentRequirements.payTo}:${paymentRequirements.maxAmountRequired}:${result.payer ?? ""}`))}`;
    res.status(200).json({ success: true, transaction: receipt, network: paymentPayload.network, payer: result.payer });
  });

  app.get("/supported", (_req: Request, res: Response) => {
    res.status(200).json({
      kinds: options.networks.map((network) => ({
        x402Version: 1,
        scheme: "exact",
        network,
        extra: {},
      })),
    });
  });

  return {
    app,
    port: 0,
    url: "",
    stats,
    close: () => Promise.resolve(),
  };
}

/** Map an x402 network name to its EVM chain id (facilitator-side allowlist). */
function networkToChainId(network: string): number | null {
  const table: Record<string, number> = {
    "base-sepolia": 84532,
    base: 8453,
  };
  return table[network] ?? null;
}

/**
 * Start the facilitator on an ephemeral port. Returns the bound URL.
 */
export async function startLocalFacilitator(options: LocalFacilitatorOptions): Promise<FacilitatorServer> {
  const facilitator = createLocalFacilitator(options);
  const server = await listen(facilitator.app);
  const port = (server.address() as { port: number }).port;
  return {
    app: facilitator.app,
    port,
    url: `http://127.0.0.1:${port}`,
    stats: facilitator.stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function listen(app: ReturnType<typeof express>): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.FACILITATOR_PORT ?? "4020", 10);
  const facilitator = createLocalFacilitator({ networks: process.env.ALLOWED_NETWORKS?.split(",").map((n) => n.trim()).filter(Boolean) ?? ["base-sepolia"] });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = facilitator.app.listen(port, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });
  const bound = (server.address() as { port: number }).port;
  console.log(`[local-facilitator] listening on http://127.0.0.1:${bound}`);
  console.log(`[local-facilitator] networks: base-sepolia (local receipt settlement, no chain)`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
