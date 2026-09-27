/**
 * TEST 7: Persistent cumulative spend in SQLite.
 *
 * The authoritative cumulative spend is computed FROM the SQLite ledger,
 * never from an in-memory counter. Every payment decision is persisted with
 * a reason. These tests prove that persisted records affect future spending
 * decisions and that spending calculations survive a "restart" (reopen).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../src/ledger/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SpendingPolicy } from "../src/buyer/spending-policy.js";

function makeLedger(): { ledger: Ledger; dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), "coin-purse-")), "ledger.sqlite");
  const db = openLedgerDatabase({ dbPath });
  return { ledger: new Ledger(db), dbPath };
}

describe("TEST 7: cumulative spend persisted in SQLite", () => {
  it("persists every decision with reason and integer base units", () => {
    const { ledger } = makeLedger();
    const id1 = ledger.recordDecision({
      seller: "seller-a",
      endpoint: "https://seller-a/reports/latest",
      decision: "ACCEPTED",
      reason: "within per-call ceiling and total run budget",
      amountBaseUnits: 10_000n,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      network: "base-sepolia",
      paymentRequired: true,
      runId: "run-test",
    });
    const id2 = ledger.recordDecision({
      seller: "seller-b",
      endpoint: "https://seller-b/reports/rogue",
      decision: "REFUSED",
      reason: "quoted amount exceeds per-call ceiling",
      amountBaseUnits: 10_000_000n,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      network: "base-sepolia",
      paymentRequired: true,
      runId: "run-test",
    });

    const r1 = ledger.getRecord(id1);
    const r2 = ledger.getRecord(id2);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.decision).toBe("ACCEPTED");
    expect(r1?.amountBaseUnits).toBe("10000");
    expect(r1?.paymentSigned).toBe(false);
    expect(r2?.decision).toBe("REFUSED");
    expect(r2?.amountBaseUnits).toBe("10000000");
    expect(r2?.reason).toBe("quoted amount exceeds per-call ceiling");
    expect(r1?.timestamp).toBeTruthy();
    expect(r1?.runId).toBe("run-test");
    ledger.close();
  });

  it("cumulative spend is summed from persisted records", () => {
    const { ledger } = makeLedger();
    ledger.recordDecision({
      seller: "a", endpoint: "/a", decision: "ACCEPTED", reason: "ok",
      amountBaseUnits: 10_000n, asset: null, network: "base-sepolia",
      paymentRequired: true, runId: "r",
    });
    ledger.recordDecision({
      seller: "a", endpoint: "/a2", decision: "ACCEPTED", reason: "ok",
      amountBaseUnits: 20_000n, asset: null, network: "base-sepolia",
      paymentRequired: true, runId: "r",
    });
    // REFUSED rows must not contribute to spend.
    ledger.recordDecision({
      seller: "b", endpoint: "/b", decision: "REFUSED", reason: "too much",
      amountBaseUnits: 10_000_000n, asset: null, network: "base-sepolia",
      paymentRequired: true, runId: "r",
    });
    expect(ledger.getTotalSpendBaseUnits("r")).toBe(30_000n);
    ledger.close();
  });

  it("survives an application restart: reopened ledger yields the same spend", () => {
    const { ledger, dbPath } = makeLedger();
    ledger.recordDecision({
      seller: "a", endpoint: "/a", decision: "ACCEPTED", reason: "ok",
      amountBaseUnits: 10_000n, asset: null, network: "base-sepolia",
      paymentRequired: true, runId: "r",
    });
    const spendBefore = ledger.getTotalSpendBaseUnits("r");
    ledger.close();

    // "Restart": reopen the same SQLite file in a new Ledger instance.
    const db2 = openLedgerDatabase({ dbPath });
    const ledger2 = new Ledger(db2);
    const spendAfter = ledger2.getTotalSpendBaseUnits("r");
    expect(spendBefore).toBe(10_000n);
    expect(spendAfter).toBe(10_000n);
    ledger2.close();
    rmSync(dbPath, { force: true });
  });

  it("persisted records affect FUTURE spending decisions (policy + ledger integration)", () => {
    const { ledger, dbPath } = makeLedger();
    const policy = new SpendingPolicy({
      maxCallAmountBaseUnits: 1_000_000n,
      totalRunBudgetBaseUnits: 25_000n,
      allowedNetworks: ["base-sepolia"],
      allowedAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      allowedAssetDecimals: 6,
    });

    // First payment: accepted and persisted (10,000).
    const d1 = policy.evaluate(
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      "seller", "/a",
      { totalSpendBeforeBaseUnits: ledger.getTotalSpendBaseUnits("r") },
    );
    expect(d1.decision).toBe("ACCEPTED");
    ledger.recordDecision({
      seller: d1.seller, endpoint: d1.endpoint, decision: d1.decision, reason: d1.reason,
      amountBaseUnits: d1.amountBaseUnits, asset: d1.asset, network: d1.network,
      paymentRequired: d1.paymentRequired, runId: "r",
    });

    // Second decision reads the PERSISTED spend from the ledger (10,000).
    const persistedSpend = ledger.getTotalSpendBaseUnits("r");
    expect(persistedSpend).toBe(10_000n);
    // 10,000 (persisted) + 10,000 (new) = 20,000 <= 25,000 -> allowed.
    const d2 = policy.evaluate(
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      "seller", "/b",
      { totalSpendBeforeBaseUnits: persistedSpend },
    );
    expect(d2.decision).toBe("ACCEPTED");
    ledger.recordDecision({
      seller: d2.seller, endpoint: d2.endpoint, decision: d2.decision, reason: d2.reason,
      amountBaseUnits: d2.amountBaseUnits, asset: d2.asset, network: d2.network,
      paymentRequired: d2.paymentRequired, runId: "r",
    });

    // Third decision: persisted spend now 20,000; 20,000 + 10,000 > 25,000 -> REFUSED.
    const persistedSpend3 = ledger.getTotalSpendBaseUnits("r");
    expect(persistedSpend3).toBe(20_000n);
    const d3 = policy.evaluate(
      { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      "seller", "/c",
      { totalSpendBeforeBaseUnits: persistedSpend3 },
    );
    expect(d3.decision).toBe("REFUSED");
    expect(d3.reason).toBe("quoted amount would exceed total run budget");
    ledger.close();
    rmSync(dbPath, { force: true });
  });

  it("markPayment updates signing/submission state persistently", () => {
    const { ledger, dbPath } = makeLedger();
    const id = ledger.recordDecision({
      seller: "a", endpoint: "/a", decision: "ACCEPTED", reason: "ok",
      amountBaseUnits: 10_000n, asset: null, network: "base-sepolia",
      paymentRequired: true, runId: "r",
    });
    ledger.markPayment(id, { paymentSigned: true, paymentSubmitted: true, transactionHash: "0xabc123" });
    const after = ledger.getRecord(id);
    expect(after?.paymentSigned).toBe(true);
    expect(after?.paymentSubmitted).toBe(true);
    expect(after?.transactionHash).toBe("0xabc123");

    // Still true after a restart.
    ledger.close();
    const db2 = openLedgerDatabase({ dbPath });
    const ledger2 = new Ledger(db2);
    const reopened = ledger2.getRecord(id);
    expect(reopened?.paymentSigned).toBe(true);
    expect(reopened?.paymentSubmitted).toBe(true);
    ledger2.close();
    rmSync(dbPath, { force: true });
  });
});
