/**
 * TEST 8: Network and asset allowlists.
 *
 * Only explicitly approved networks and assets may be paid. A payment
 * requirement for another network or another asset must be REFUSED before
 * signing. These tests also prove that a seller (or the model) cannot make
 * the purse pay on an unapproved network/asset.
 */
import { describe, expect, it } from "vitest";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";
import { PaymentService, sellerFromEndpoint } from "../src/buyer/payment-service.js";
import { openLedgerDatabase } from "../src/ledger/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // public Base Sepolia USDC
const OTHER_ASSET = "0x1111111111111111111111111111111111111111"; // some other token contract

function makeService(overrides: { allowedNetworks?: string[]; allowedAsset?: string } = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "coin-purse-allow-")), "ledger.sqlite");
  const db = openLedgerDatabase({ dbPath });
  const ledger = new Ledger(db);
  const policy = new SpendingPolicy({
    maxCallAmountBaseUnits: 1_000_000n,
    totalRunBudgetBaseUnits: 5_000_000n,
    allowedNetworks: overrides.allowedNetworks ?? ["base-sepolia"],
    allowedAsset: overrides.allowedAsset ?? BASE_SEPOLIA_USDC,
    allowedAssetDecimals: 6,
  });
  const service = new PaymentService(policy, ledger, "run-allowlist");
  return { service, ledger, policy, cleanup: () => { ledger.close(); rmSync(dbPath, { force: true }); } };
}

describe("TEST 8: network allowlist", () => {
  it("refuses a payment requirement for an unsupported network before signing", async () => {
    const { service, ledger, cleanup } = makeService();
    const result = await service.decide(
      [
        {
          scheme: "exact",
          network: "polygon-amoy", // NOT on the allowlist
          maxAmountRequired: "10000",
          asset: BASE_SEPOLIA_USDC,
          payTo: "0x1234567890abcdef1234567890abcdef12345678",
        },
      ],
      "https://evil.example/reports/latest",
      1,
    );
    expect(result.decision).toBe("REFUSED");
    expect(result.requirements).toBeUndefined();
    // The refusal is persisted; nothing was signed.
    const record = ledger.getRecord(result.ledgerId);
    expect(record?.decision).toBe("REFUSED");
    expect(record?.paymentSigned).toBe(false);
    expect(record?.paymentSubmitted).toBe(false);
    cleanup();
  });

  it("refuses when a seller offers several networks, none of which are allowed", async () => {
    const { service, cleanup } = makeService();
    const result = await service.decide(
      [
        { scheme: "exact", network: "base", maxAmountRequired: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
        { scheme: "exact", network: "avalanche-fuji", maxAmountRequired: "10000", asset: OTHER_ASSET },
      ],
      "https://evil.example/reports/latest",
      1,
    );
    expect(result.decision).toBe("REFUSED");
    cleanup();
  });

  it("accepts the allowed network when everything else is in policy", async () => {
    const { service, cleanup } = makeService();
    const result = await service.decide(
      [
        { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: BASE_SEPOLIA_USDC },
      ],
      "https://honest.example/reports/latest",
      1,
    );
    expect(result.decision).toBe("ACCEPTED");
    expect(result.requirements?.network).toBe("base-sepolia");
    cleanup();
  });
});

describe("TEST 8: asset allowlist", () => {
  it("refuses an unapproved asset before signing, even on the allowed network", async () => {
    const { service, ledger, cleanup } = makeService();
    const result = await service.decide(
      [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "10000",
          asset: OTHER_ASSET, // NOT the allowed asset
          payTo: "0x1234567890abcdef1234567890abcdef12345678",
        },
      ],
      "https://evil.example/reports/latest",
      1,
    );
    expect(result.decision).toBe("REFUSED");
    expect(result.requirements).toBeUndefined();
    const record = ledger.getRecord(result.ledgerId);
    expect(record?.decision).toBe("REFUSED");
    expect(record?.paymentSigned).toBe(false);
    cleanup();
  });

  it("policy-level asset check is case-insensitive but strict about the address", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "coin-purse-asset-")), "ledger.sqlite");
    const policy = new SpendingPolicy({
      maxCallAmountBaseUnits: 1_000_000n,
      totalRunBudgetBaseUnits: 5_000_000n,
      allowedNetworks: ["base-sepolia"],
      allowedAsset: BASE_SEPOLIA_USDC,
      allowedAssetDecimals: 6,
    });
    const lower = policy.evaluate(
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: BASE_SEPOLIA_USDC.toLowerCase() },
      "seller", "/a",
      { totalSpendBeforeBaseUnits: 0n },
    );
    expect(lower.decision).toBe("ACCEPTED");
    const wrong = policy.evaluate(
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: OTHER_ASSET },
      "seller", "/a",
      { totalSpendBeforeBaseUnits: 0n },
    );
    expect(wrong.decision).toBe("REFUSED");
    expect(wrong.reason).toBe("asset is not on the allowlist");
    rmSync(dbPath, { force: true });
  });

  it("a seller cannot bypass the asset allowlist by omitting the asset field", async () => {
    const { service, cleanup } = makeService();
    const result = await service.decide(
      [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000" }],
      "https://evil.example/reports/latest",
      1,
    );
    expect(result.decision).toBe("REFUSED");
    cleanup();
  });
});

describe("seller label derivation", () => {
  it("derives the audit label from the endpoint host", () => {
    expect(sellerFromEndpoint("http://127.0.0.1:4022/reports/rogue")).toBe("127.0.0.1:4022");
    expect(sellerFromEndpoint("https://api.example.com/x")).toBe("api.example.com");
  });
});
