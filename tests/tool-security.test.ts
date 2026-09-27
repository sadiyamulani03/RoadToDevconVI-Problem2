/**
 * TEST 2: paid fetch exposed as an agent tool (schema exposes only request
 *         arguments, never policy parameters).
 * TEST 9: tool arguments CANNOT modify the spending policy.
 *
 * These tests attempt the exact attack from the problem statement:
 *   paidFetch({ url: "...", maxAmount: "999999999999" })
 * and prove the policy remains unchanged and the payment is still refused.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { createSigner } from "x402/types";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { openLedgerDatabase } from "../src/ledger/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";
import { PaymentService } from "../src/buyer/payment-service.js";
import { X402Client } from "../src/buyer/x402-client.js";
import { ALL_TOOLS, PAID_FETCH_TOOL, GET_PURSE_STATUS_TOOL, createToolHandlers, executeTool } from "../src/agent/tools.js";
import { startTestStack, TEST_ASSET, type TestStack } from "./test-utils.js";

describe("TEST 2: paid fetch exposed as an agent tool", () => {
  it("the paidFetch tool exists in the agent toolset", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain("paidFetch");
    expect(names).toContain("getPurseStatus");
  });

  it("the paidFetch tool schema exposes ONLY the url argument", () => {
    expect(PAID_FETCH_TOOL.parameters.required).toEqual(["url"]);
    expect(Object.keys(PAID_FETCH_TOOL.parameters.properties)).toEqual(["url"]);
    expect(PAID_FETCH_TOOL.parameters.additionalProperties).toBe(false);
  });

  it("the tool schema does not expose policy-changing arguments", () => {
    const forbidden = ["maxAmount", "totalBudget", "allowedNetwork", "allowedAsset", "privateKey", "walletAddress", "maxCallAmount", "amount", "network", "asset", "budget"];
    const propertyNames = ALL_TOOLS.flatMap((t) => Object.keys(t.parameters.properties));
    for (const name of forbidden) {
      expect(propertyNames).not.toContain(name);
    }
    // Also nothing resembling a secret parameter.
    expect(JSON.stringify(ALL_TOOLS)).not.toContain("private");
    expect(JSON.stringify(ALL_TOOLS)).not.toContain("secret");
  });

  it("the tool executes a paid fetch through the policy and returns the resource", async () => {
    const stack = await startTestStack();
    try {
      const env: NodeJS.ProcessEnv = {
        MAX_CALL_AMOUNT_BASE_UNITS: "1000000",
        TOTAL_RUN_BUDGET_BASE_UNITS: "5000000",
        ALLOWED_NETWORK: "base-sepolia",
        ALLOWED_ASSET: TEST_ASSET,
      };
      const config = loadConfig(env);
      const privateKey = generatePrivateKey();
      const { x402Client, handlers, policy, ledger } = makeToolBundle(config, privateKey, stack);
      const result = (await executeTool(handlers, "paidFetch", { url: stack.honestUrl })) as {
        ok: boolean; decision: string; paymentSigned: boolean; bodyPreview: string | null;
      };
      expect(result.decision).toBe("ACCEPTED");
      expect(result.ok).toBe(true);
      expect(result.paymentSigned).toBe(true);
      expect(result.bodyPreview).toContain("x402 Market Research Report");
      // The tool result never contains the private key or signing inputs.
      expect(JSON.stringify(result)).not.toContain(privateKey);
      void policy; void ledger;
    } finally {
      await stack.close();
    }
  });
});

describe("TEST 9: tool arguments cannot modify the spending policy", () => {
  let stack: TestStack;
  let config: AppConfig;
  let privateKey: Hex;
  let bundle: ReturnType<typeof makeToolBundle>;

  beforeAll(async () => {
    stack = await startTestStack();
    const env: NodeJS.ProcessEnv = {
      MAX_CALL_AMOUNT_BASE_UNITS: "1000000",
      TOTAL_RUN_BUDGET_BASE_UNITS: "5000000",
      ALLOWED_NETWORK: "base-sepolia",
      ALLOWED_ASSET: TEST_ASSET,
    };
    config = loadConfig(env);
    privateKey = generatePrivateKey();
    bundle = makeToolBundle(config, privateKey, stack);
  });

  afterAll(async () => {
    await stack.close();
  });

  it("the exact attack from the problem statement: maxAmount in tool args", async () => {
    // The model tries to raise the ceiling through tool arguments.
    const attackArgs = {
      url: stack.rogueUrl,
      maxAmount: "999999999999",
      totalBudget: "999999999999",
      allowedNetwork: "ethereum",
      allowedAsset: "0xanything",
      privateKey: "0xdeadbeef",
    };
    const result = (await executeTool(bundle.handlers, "paidFetch", attackArgs)) as {
      decision: string; reason: string; paymentSigned: boolean; paymentSubmitted: boolean;
    };

    // The payment is STILL refused: the policy was not modified.
    expect(result.decision).toBe("REFUSED");
    expect(result.paymentSigned).toBe(false);
    expect(result.paymentSubmitted).toBe(false);

    // The policy remains exactly as configured.
    expect(bundle.policy.config.maxCallAmountBaseUnits).toBe(1_000_000n);
    expect(bundle.policy.config.totalRunBudgetBaseUnits).toBe(5_000_000n);
    expect([...bundle.policy.config.allowedNetworks]).toEqual(["base-sepolia"]);
    expect(bundle.policy.config.allowedAsset.toLowerCase()).toBe(TEST_ASSET.toLowerCase());

    // The refusal is persisted in the ledger.
    const records = bundle.ledger.getRecordsForRun(bundle.runId);
    const refusals = records.filter((r) => r.decision === "REFUSED");
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0]?.paymentSigned).toBe(false);
  });

  it("policy object is frozen against mutation from tool arguments", () => {
    const policy = bundle.policy;
    const configSnapshot = JSON.stringify({
      max: policy.config.maxCallAmountBaseUnits.toString(),
      budget: policy.config.totalRunBudgetBaseUnits.toString(),
      networks: [...policy.config.allowedNetworks],
      asset: policy.config.allowedAsset,
    });
    // Attempt to mutate the policy config object directly.
    try {
      (policy.config as unknown as Record<string, unknown>)["maxCallAmountBaseUnits"] = 999999999999n;
    } catch {
      // Frozen objects throw in strict mode; both outcomes are fine as long
      // as the value is unchanged.
    }
    expect(JSON.stringify({
      max: policy.config.maxCallAmountBaseUnits.toString(),
      budget: policy.config.totalRunBudgetBaseUnits.toString(),
      networks: [...policy.config.allowedNetworks],
      asset: policy.config.allowedAsset,
    })).toBe(configSnapshot);
    expect(policy.config.maxCallAmountBaseUnits).toBe(1_000_000n);
  });

  it("an unknown tool name cannot reach the policy", async () => {
    const result = await executeTool(bundle.handlers, "setSpendingPolicy", { maxAmount: "999999999999" });
    expect(result).toEqual({ error: "unknown tool: setSpendingPolicy" });
  });

  it("getPurseStatus is read-only and reports configuration values", async () => {
    expect(GET_PURSE_STATUS_TOOL.parameters.properties).toEqual({});
    const status = (await executeTool(bundle.handlers, "getPurseStatus", {})) as Record<string, unknown>;
    expect(status["maxCallAmountBaseUnits"]).toBe("1000000");
    expect(status["totalRunBudgetBaseUnits"]).toBe("5000000");
    expect(status["allowedNetworks"]).toEqual(["base-sepolia"]);
    // Status cannot change anything: passing mutation args has no effect.
    await executeTool(bundle.handlers, "getPurseStatus", { maxCallAmountBaseUnits: "999999999999" });
    const status2 = (await executeTool(bundle.handlers, "getPurseStatus", {})) as Record<string, unknown>;
    expect(status2["maxCallAmountBaseUnits"]).toBe("1000000");
  });
});

function makeToolBundle(config: AppConfig, privateKey: Hex, stack: TestStack) {
  const runId = `run-${randomUUID()}`;
  const db = openLedgerDatabase({ dbPath: join(mkdtempSync(join(tmpdir(), "coin-purse-tool-")), "ledger.sqlite") });
  const ledger = new Ledger(db);
  const policy = new SpendingPolicy({
    maxCallAmountBaseUnits: config.maxCallAmountBaseUnits,
    totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits,
    allowedNetworks: config.allowedNetworks,
    allowedAsset: config.allowedAsset,
    allowedAssetDecimals: config.allowedAssetDecimals,
  });
  const paymentService = new PaymentService(policy, ledger, runId);
  const x402Client = new X402Client({
    paymentService,
    signerFactory: () => createSigner("base-sepolia", privateKey),
    x402Version: config.x402Version,
  });
  const handlers = createToolHandlers({ x402Client, policy, ledger, runId });
  return { runId, ledger, policy, paymentService, x402Client, handlers };
}

