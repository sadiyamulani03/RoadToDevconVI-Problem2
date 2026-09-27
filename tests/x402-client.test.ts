/**
 * TEST 1: The paid fetch uses the ACTUAL x402 client/payment mechanism.
 * TEST 2: The paid HTTP capability is exposed to the agent as a tool.
 *
 * These tests prove the real x402 protocol flow:
 *   1. fetch -> 402 Payment Required with an x402 payment requirement
 *   2. the buyer signs via the x402 SDK (createPaymentHeader -> real
 *      EIP-712 TransferWithAuthorization signature)
 *   3. retry with the X-PAYMENT header (x402 protocol retry)
 *   4. the seller's facilitator verifies the signature and the protected
 *      resource is served; the settlement receipt is returned
 *
 * The payment header is decoded with x402's own decodePayment and the
 * EIP-712 signature is re-verified with viem to prove it is a genuine
 * x402 payment payload, not a fake Authorization header.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { getAddress, verifyTypedData } from "viem";
import { createSigner, evm } from "x402/types";
import { exact as exactScheme } from "x402/schemes";
import { loadConfig } from "../src/config/config.js";
import { openLedgerDatabase } from "../src/ledger/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";
import { PaymentService } from "../src/buyer/payment-service.js";
import { X402Client } from "../src/buyer/x402-client.js";
import { createToolHandlers, executeTool } from "../src/agent/tools.js";
import { startTestStack, TEST_ASSET, type TestStack } from "./test-utils.js";

describe("TEST 1: paid fetch uses the actual x402 payment mechanism", () => {
  let stack: TestStack;
  let ledger: Ledger;
  let dbPath: string;
  let config: ReturnType<typeof loadConfig>;
  let client: X402Client;
  let privateKey: ReturnType<typeof generatePrivateKey>;

  beforeAll(async () => {
    stack = await startTestStack();
    config = loadConfig({
      MAX_CALL_AMOUNT_BASE_UNITS: "1000000",
      TOTAL_RUN_BUDGET_BASE_UNITS: "5000000",
      ALLOWED_NETWORK: "base-sepolia",
      ALLOWED_ASSET: TEST_ASSET,
    } as NodeJS.ProcessEnv);
    dbPath = join(mkdtempSync(join(tmpdir(), "coin-purse-x402-")), "ledger.sqlite");
    ledger = new Ledger(openLedgerDatabase({ dbPath }));
    privateKey = generatePrivateKey();
    const policy = new SpendingPolicy({
      maxCallAmountBaseUnits: config.maxCallAmountBaseUnits,
      totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits,
      allowedNetworks: config.allowedNetworks,
      allowedAsset: config.allowedAsset,
      allowedAssetDecimals: config.allowedAssetDecimals,
    });
    const paymentService = new PaymentService(policy, ledger, `run-${randomUUID()}`);
    client = new X402Client({
      paymentService,
      signerFactory: () => createSigner("base-sepolia", privateKey),
      x402Version: config.x402Version,
    });
  });

  afterAll(async () => {
    await stack.close();
    ledger.close();
    rmSync(dbPath, { force: true });
  });

  it("a protected resource returns an x402 payment requirement (402 + accepts)", async () => {
    const response = await fetch(stack.honestUrl);
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      x402Version?: number;
      accepts?: Array<{ scheme: string; network: string; maxAmountRequired: string; asset: string }>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.accepts?.length).toBeGreaterThan(0);
    const req = body.accepts?.[0];
    expect(req?.scheme).toBe("exact");
    expect(req?.network).toBe("base-sepolia");
    expect(req?.maxAmountRequired).toBe("10000"); // $0.01 = 10,000 base units
    expect(req?.asset?.toLowerCase()).toBe(TEST_ASSET.toLowerCase());
  });

  it("the buyer pays through the x402 flow and receives the protected resource", async () => {
    const result = await client.paidFetch(stack.honestUrl);
    expect(result.decision).toBe("ACCEPTED");
    expect(result.paymentSigned).toBe(true);
    expect(result.paymentSubmitted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain("x402 Market Research Report");
    // Settlement receipt from the X-PAYMENT-RESPONSE header (local facilitator receipt).
    expect(result.transactionHash).toBeTruthy();
    expect(result.transactionHash?.startsWith("local-")).toBe(true);
  });

  it("the X-PAYMENT header is a genuine x402 payment payload with a verifiable EIP-712 signature", async () => {
    // Capture the X-PAYMENT header the client sends on the retry, by
    // performing the protocol steps manually with the same SDK functions.
    const { createPaymentHeader } = await import("x402/client");
    const first = await fetch(stack.honestUrl);
    expect(first.status).toBe(402);
    const body = (await first.json()) as { x402Version?: number; accepts?: Array<Record<string, unknown>> };
    const accepts = body.accepts ?? [];

    const signer = await createSigner("base-sepolia", privateKey);
    const { selectPaymentRequirements } = await import("x402/client");
    const requirements = selectPaymentRequirements(
      accepts as never,
      "base-sepolia",
      "exact",
    );
    const header = await createPaymentHeader(signer, body.x402Version ?? 1, requirements as never);

    // The header is base64 JSON, decodable by x402's own decodePayment.
    const decoded = exactScheme.evm.decodePayment(header);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("base-sepolia");
    const auth = (decoded.payload as { signature: string; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } });
    expect(auth.authorization.value).toBe("10000"); // exactly the required amount
    expect(getAddress(auth.authorization.to)).toBe(getAddress(requirements.payTo as string));

    // Re-verify the EIP-712 signature with viem against the exact domain
    // the x402 SDK signs with.
    const valid = await verifyTypedData({
      address: auth.authorization.from as `0x${string}`,
      domain: {
        name: (requirements as { extra?: { name?: string } }).extra?.name ?? "USDC",
        version: (requirements as { extra?: { version?: string } }).extra?.version ?? "2",
        chainId: 84532,
        verifyingContract: getAddress(requirements.asset as string),
      },
      types: evm.authorizationTypes,
      primaryType: evm.authorizationPrimaryType,
      message: {
        from: getAddress(auth.authorization.from),
        to: getAddress(auth.authorization.to),
        value: auth.authorization.value,
        validAfter: auth.authorization.validAfter,
        validBefore: auth.authorization.validBefore,
        nonce: auth.authorization.nonce,
      },
      signature: auth.signature as `0x${string}`,
    });
    expect(valid).toBe(true);

    // The server accepts this genuine payment and serves the resource.
    const retry = await fetch(stack.honestUrl, { headers: { "X-PAYMENT": header } });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { report?: { title?: string } };
    expect(retryBody.report?.title).toBe("x402 Market Research Report");
    // Settlement receipt header present (x402 standard).
    expect(retry.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("the facilitator rejects a tampered payment payload", async () => {
    // Tamper with the signed value: the local facilitator's verification
    // (and any real facilitator) must reject it.
    const { createPaymentHeader } = await import("x402/client");
    const first = await fetch(stack.honestUrl);
    const body = (await first.json()) as { x402Version?: number; accepts?: Array<Record<string, unknown>> };
    const signer = await createSigner("base-sepolia", privateKey);
    const { selectPaymentRequirements } = await import("x402/client");
    const requirements = selectPaymentRequirements(body.accepts as never, "base-sepolia", "exact") as Record<string, unknown>;
    const header = await createPaymentHeader(signer, body.x402Version ?? 1, requirements as never);
    const decoded = exactScheme.evm.decodePayment(header) as Record<string, unknown>;
    const payload = decoded.payload as Record<string, unknown>;
    const authorization = payload.authorization as Record<string, unknown>;
    // Change the signed amount: signature no longer matches the payload.
    authorization["value"] = "1";
    const tamperedHeader = Buffer.from(JSON.stringify({ ...decoded, payload: { ...payload, authorization } })).toString("base64");
    const retry = await fetch(stack.honestUrl, { headers: { "X-PAYMENT": tamperedHeader } });
    expect(retry.status).toBe(402);
    const retryBody = (await retry.json()) as { error?: string };
    expect(retryBody.error).toBeTruthy();
  });
});

describe("TEST 2 (integration): paid fetch reachable through the agent tool", () => {
  it("the agent tool executes the full x402 flow end-to-end", async () => {
    const stack2 = await startTestStack();
    try {
      const config2 = loadConfig({
        MAX_CALL_AMOUNT_BASE_UNITS: "1000000",
        TOTAL_RUN_BUDGET_BASE_UNITS: "5000000",
        ALLOWED_NETWORK: "base-sepolia",
        ALLOWED_ASSET: TEST_ASSET,
      } as NodeJS.ProcessEnv);
      const pk = generatePrivateKey();
      const db2Path = join(mkdtempSync(join(tmpdir(), "coin-purse-agent-")), "ledger.sqlite");
      const db2 = openLedgerDatabase({ dbPath: db2Path });
      const ledger2 = new Ledger(db2);
      const agentRunId = `run-${randomUUID()}`;
      const policy2 = new SpendingPolicy({
        maxCallAmountBaseUnits: config2.maxCallAmountBaseUnits,
        totalRunBudgetBaseUnits: config2.totalRunBudgetBaseUnits,
        allowedNetworks: config2.allowedNetworks,
        allowedAsset: config2.allowedAsset,
        allowedAssetDecimals: config2.allowedAssetDecimals,
      });
      const service2 = new PaymentService(policy2, ledger2, agentRunId);
      const client2 = new X402Client({
        paymentService: service2,
        signerFactory: () => createSigner("base-sepolia", pk),
        x402Version: config2.x402Version,
      });
      const handlers = createToolHandlers({ x402Client: client2, policy: policy2, ledger: ledger2, runId: agentRunId });

      const result = (await executeTool(handlers, "paidFetch", { url: stack2.honestUrl })) as {
        decision: string; ok: boolean; paymentSigned: boolean; paymentSubmitted: boolean; bodyPreview: string | null;
      };
      expect(result.decision).toBe("ACCEPTED");
      expect(result.ok).toBe(true);
      expect(result.paymentSigned).toBe(true);
      expect(result.paymentSubmitted).toBe(true);
      expect(result.bodyPreview).toContain("x402 Market Research Report");

      // The ledger recorded the accepted payment.
      const records = ledger2.getRecordsForRun(agentRunId);
      expect(records.length).toBe(1);
      expect(records[0]?.decision).toBe("ACCEPTED");
      expect(records[0]?.amountBaseUnits).toBe("10000");
      expect(records[0]?.paymentSigned).toBe(true);
      ledger2.close();
      rmSync(db2Path, { force: true });
    } finally {
      await stack2.close();
    }
  });
});
