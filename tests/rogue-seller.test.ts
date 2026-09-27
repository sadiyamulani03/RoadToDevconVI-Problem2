/**
 * TEST 3: The rogue seller exists, demands an excessive payment, and is
 *         REFUSED before any signing or submission.
 *
 * Integration test over real HTTP: the rogue seller is a separate local
 * server that demands 10,000,000 base units (10 USDC) — far above the
 * per-call ceiling (1,000,000 = 1 USDC). The buyer goes through the actual
 * x402 client, the policy refuses, and the verification proves:
 *
 *   - rogue payment signed   = false
 *   - rogue payment submitted = false
 *   - rogue transaction hash  = null
 *   - the rogue seller's protected resource was NEVER served
 *   - the refusal is persisted in the SQLite ledger with a reason
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { createSigner } from "x402/types";
import { loadConfig } from "../src/config/config.js";
import { openLedgerDatabase } from "../src/ledger/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";
import { PaymentService } from "../src/buyer/payment-service.js";
import { X402Client } from "../src/buyer/x402-client.js";
import { startTestStack, TEST_ASSET, type TestStack } from "./test-utils.js";

describe("TEST 3: rogue seller is refused before signing", () => {
  let stack: TestStack;
  let ledger: Ledger;
  let dbPath: string;
  let runId: string;
  let client: X402Client;

  beforeAll(async () => {
    stack = await startTestStack();
    const env: NodeJS.ProcessEnv = {
      MAX_CALL_AMOUNT_BASE_UNITS: "1000000", // 1 USDC per call
      TOTAL_RUN_BUDGET_BASE_UNITS: "5000000", // 5 USDC total
      ALLOWED_NETWORK: "base-sepolia",
      ALLOWED_ASSET: TEST_ASSET,
    };
    const config = loadConfig(env);
    dbPath = join(mkdtempSync(join(tmpdir(), "coin-purse-rogue-")), "ledger.sqlite");
    const db = openLedgerDatabase({ dbPath });
    ledger = new Ledger(db);
    const policy = new SpendingPolicy({
      maxCallAmountBaseUnits: config.maxCallAmountBaseUnits,
      totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits,
      allowedNetworks: config.allowedNetworks,
      allowedAsset: config.allowedAsset,
      allowedAssetDecimals: config.allowedAssetDecimals,
    });
    runId = `run-${randomUUID()}`;
    const paymentService = new PaymentService(policy, ledger, runId);
    const privateKey = generatePrivateKey();
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

  it("the rogue seller is a separate seller demanding an excessive amount", async () => {
    // The rogue seller is a distinct HTTP service with its own port and payTo.
    expect(stack.rogue.url).not.toBe(stack.honest.url);
    expect(stack.rogue.options.price).toBe("$10.00"); // 10,000,000 base units
    expect(stack.honest.options.price).toBe("$0.01"); // 10,000 base units

    // It does expose a real x402 payment requirement over HTTP (402 + accepts).
    const response = await fetch(stack.rogueUrl);
    expect(response.status).toBe(402);
    const body = (await response.json()) as { x402Version?: number; accepts?: Array<Record<string, unknown>> };
    expect(body.accepts?.length).toBeGreaterThan(0);
    expect(body.accepts?.[0]?.maxAmountRequired).toBe("10000000"); // exceeds the ceiling
  });

  it("the buyer refuses the rogue payment BEFORE signing; nothing is paid", async () => {
    const result = await client.paidFetch(stack.rogueUrl);

    expect(result.decision).toBe("REFUSED");
    expect(result.reason).toBe("quoted amount exceeds per-call ceiling");

    // SECURITY-CRITICAL assertions:
    expect(result.paymentSigned).toBe(false); // never signed
    expect(result.paymentSubmitted).toBe(false); // never submitted
    expect(result.transactionHash).toBeNull(); // no transaction
    expect(result.ok).toBe(false); // no protected resource received

    // The persisted ledger entry reflects the refusal.
    const record = result.ledgerId !== null ? ledger.getRecord(result.ledgerId) : null;
    expect(record).not.toBeNull();
    expect(record?.decision).toBe("REFUSED");
    expect(record?.reason).toBe("quoted amount exceeds per-call ceiling");
    expect(record?.paymentSigned).toBe(false);
    expect(record?.paymentSubmitted).toBe(false);
    expect(record?.transactionHash).toBeNull();
    expect(record?.amountBaseUnits).toBe("10000000");
  });

  it("the rogue seller's facilitator never verified or settled a payment; resource never served", async () => {
    // Server-side observation from the rogue seller itself.
    const stats = (await (await fetch(stack.rogue.statsUrl)).json()) as { kind: string; resourceServed: number };
    expect(stats.kind).toBe("rogue");
    expect(stats.resourceServed).toBe(0); // the protected resource was NEVER served

    // The local facilitator's counters: the honest seller's accepted payment
    // has not been made in this suite (this stack is rogue-only), so there
    // must be zero settlements.
    expect(stack.facilitator.stats.settlementsOk).toBe(0);
    expect(stack.facilitator.stats.settlementsFailed).toBe(0);
  });

  it("an honest seller on the SAME stack IS accepted (contrast case)", async () => {
    // Proves the refusal is not a blanket block: the honest seller's price is
    // within policy and IS accepted, signed, and settled.
    const result = await client.paidFetch(stack.honestUrl);
    expect(result.decision).toBe("ACCEPTED");
    expect(result.paymentSigned).toBe(true);
    expect(result.paymentSubmitted).toBe(true);
    expect(result.transactionHash).toBeTruthy();
    expect(result.transactionHash?.startsWith("local-")).toBe(true); // local facilitator receipt, NOT a blockchain tx
    expect(result.body).toContain("x402 Market Research Report");

    const honestStats = (await (await fetch(stack.honest.statsUrl)).json()) as { resourceServed: number };
    expect(honestStats.resourceServed).toBe(1);
    expect(stack.facilitator.stats.settlementsOk).toBe(1);
  });
});
