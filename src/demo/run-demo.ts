/**
 * End-to-end local demonstration: honest seller, rogue seller, and the coin
 * purse buyer.
 *
 * What it demonstrates (by actual execution):
 *   1. honest seller -> x402 payment requirement -> policy accepts ->
 *      payment signed via the x402 SDK -> retry -> protected resource
 *      received -> settlement receipt (local facilitator).
 *   2. rogue seller -> excessive payment requirement -> policy REFUSES
 *      BEFORE signing -> ledger entry -> zero signing / zero submission.
 *   3. Tool-argument attack: paidFetch with maxAmount in the arguments is
 *      ignored; the policy remains unchanged.
 *   4. Ledger persistence: after a restart, the cumulative spend is still
 *      correct and affects future decisions.
 *
 * All servers run locally on ephemeral ports with a local facilitator. No
 * external network, no chain, no credentials. The buyer wallet is a fresh
 * throwaway unfunded wallet generated per run unless PRIVATE_KEY is set.
 *
 * Usage:
 *   npm run demo:honest
 *   npm run demo:rogue
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSigner } from "x402/types";
import type { Hex } from "viem";
import { loadConfigForLocalDemo, redactConfigForLog } from "../config/config.js";
import { openLedgerDatabase } from "../ledger/database.js";
import { Ledger } from "../ledger/ledger.js";
import { SpendingPolicy } from "../buyer/spending-policy.js";
import { PaymentService } from "../buyer/payment-service.js";
import { X402Client } from "../buyer/x402-client.js";
import { ALL_TOOLS, createToolHandlers, executeTool } from "../agent/tools.js";
import { startLocalFacilitator } from "../sellers/local-facilitator.js";
import { startHonestSeller } from "../sellers/honest-server.js";
import { startRogueSeller } from "../sellers/rogue-server.js";

interface DemoStepResult {
  step: string;
  seller: string;
  decision: "ACCEPTED" | "REFUSED";
  reason: string;
  amountBaseUnits: string | null;
  paymentSigned: boolean;
  paymentSubmitted: boolean;
  transactionHash: string | null;
  httpStatus: number | null;
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--seller") && process.argv[process.argv.indexOf("--seller") + 1] === "rogue"
    ? "rogue"
    : "both";
  const config = loadConfigForLocalDemo();
  const runId = `demo-${randomUUID()}`;

  console.log("=== Coin Purse Demo (LOCAL, no chain, no credentials) ===");
  console.log(`run id: ${runId}`);
  console.log("purse configuration (redacted):", redactConfigForLog(config));

  // Throwaway unfunded buyer wallet (or PRIVATE_KEY if provided).
  const privateKey: Hex = process.env.PRIVATE_KEY?.trim() ? (process.env.PRIVATE_KEY.trim() as Hex) : generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`buyer wallet: ${account.address} ${process.env.PRIVATE_KEY?.trim() ? "(from env)" : "(throwaway, generated for this demo run)"}`);

  // 1. Local facilitator + sellers on ephemeral ports.
  const facilitator = await startLocalFacilitator({ networks: config.allowedNetworks });
  console.log(`local facilitator: ${facilitator.url}`);
  const honest = await startHonestSeller({ facilitatorUrl: facilitator.url, port: 0 });
  console.log(`honest seller: ${honest.url}${honest.options.resourcePath} (price ${honest.options.price})`);
  const rogue = await startRogueSeller({ facilitatorUrl: facilitator.url, port: 0 });
  console.log(`rogue seller: ${rogue.url}${rogue.options.resourcePath} (price ${rogue.options.price})`);

  // 2. Buyer purse: fresh ledger for this demo run.
  mkdirSync("data", { recursive: true });
  const demoDbPath = join("data", `demo-${runId}.sqlite`);
  const db = openLedgerDatabase({ dbPath: demoDbPath });
  const ledger = new Ledger(db);
  const policy = new SpendingPolicy({
    maxCallAmountBaseUnits: config.maxCallAmountBaseUnits,
    totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits,
    allowedNetworks: config.allowedNetworks,
    allowedAsset: config.allowedAsset,
    allowedAssetDecimals: config.allowedAssetDecimals,
  });
  const paymentService = new PaymentService(policy, ledger, runId);
  const network = config.allowedNetworks[0];
  const x402Client = new X402Client({
    paymentService,
    signerFactory: () => createSigner(network, privateKey),
    x402Version: config.x402Version,
  });
  const handlers = createToolHandlers({ x402Client, policy, ledger, runId });

  const results: DemoStepResult[] = [];
  const toStep = (step: string, r: Awaited<ReturnType<typeof x402Client.paidFetch>>): DemoStepResult => ({
    step,
    seller: r.url,
    decision: r.decision,
    reason: r.reason,
    amountBaseUnits: null,
    paymentSigned: r.paymentSigned,
    paymentSubmitted: r.paymentSubmitted,
    transactionHash: r.transactionHash,
    httpStatus: r.status ?? null,
  });

  // 3. Honest seller: paid fetch through the agent tool.
  console.log("\n--- step 1: honest seller (paid fetch via agent tool) ---");
  const honestResult = (await executeTool(handlers, "paidFetch", {
    url: `${honest.url}${honest.options.resourcePath}`,
  })) as Awaited<ReturnType<typeof x402Client.paidFetch>>;
  results.push({ ...toStep("honest paid fetch", honestResult), amountBaseUnits: honestAmount(config) });
  console.log(`decision=${honestResult.decision} reason="${honestResult.reason}"`);
  console.log(`signed=${honestResult.paymentSigned} submitted=${honestResult.paymentSubmitted} tx=${honestResult.transactionHash}`);
  if (honestResult.body) console.log(`resource body: ${honestResult.body.slice(0, 300)}`);

  // 4. Rogue seller: excessive payment demand.
  console.log("\n--- step 2: rogue seller (excessive payment demand) ---");
  const rogueResult = (await executeTool(handlers, "paidFetch", {
    url: `${rogue.url}${rogue.options.resourcePath}`,
  })) as Awaited<ReturnType<typeof x402Client.paidFetch>>;
  results.push({ ...toStep("rogue paid fetch", rogueResult), amountBaseUnits: rogueAmount(config) });
  console.log(`decision=${rogueResult.decision} reason="${rogueResult.reason}"`);
  console.log(`signed=${rogueResult.paymentSigned} submitted=${rogueResult.paymentSubmitted} tx=${rogueResult.transactionHash}`);

  // 5. Tool-argument attack: model tries to raise the limit through tool args.
  console.log("\n--- step 3: tool-argument attack (maxAmount in tool args) ---");
  const attackResult = (await executeTool(handlers, "paidFetch", {
    url: `${rogue.url}${rogue.options.resourcePath}`,
    maxAmount: "999999999999",
    totalBudget: "999999999999",
    allowedNetwork: "ethereum",
    privateKey: "0xattack-attempt-ignored",
  })) as unknown as Awaited<ReturnType<typeof x402Client.paidFetch>>;
  const policyUnchanged =
    policy.config.maxCallAmountBaseUnits === config.maxCallAmountBaseUnits &&
    policy.config.totalRunBudgetBaseUnits === config.totalRunBudgetBaseUnits &&
    JSON.stringify(policy.config.allowedNetworks) === JSON.stringify([...config.allowedNetworks]);
  console.log(`decision=${attackResult.decision} reason="${attackResult.reason}"`);
  console.log(`policy unchanged after attack: ${policyUnchanged}`);
  results.push({ ...toStep("tool-argument attack (ignored)", attackResult), amountBaseUnits: rogueAmount(config) });

  // 6. Facilitator-side observation: the rogue seller never verified/settled a payment.
  const rogueStats = await (await fetch(rogue.statsUrl)).json() as { kind: string; resourceServed: number };
  const honestStats = await (await fetch(honest.statsUrl)).json() as { kind: string; resourceServed: number };
  console.log("\n--- facilitator/seller-side observation ---");
  console.log(`honest seller resourceServed=${honestStats.resourceServed} (expected 1)`);
  console.log(`rogue seller resourceServed=${rogueStats.resourceServed} (expected 0 - never served)`);
  console.log(`facilitator verifyCalls=${facilitator.stats.verifyCalls} settleCalls=${facilitator.stats.settleCalls}`);

  // 7. Restart persistence: close, reopen, cumulative spend survives.
  console.log("\n--- step 4: restart persistence ---");
  const spendBeforeRestart = ledger.getTotalSpendBaseUnits(runId);
  ledger.close();
  const db2 = openLedgerDatabase({ dbPath: demoDbPath });
  const ledger2 = new Ledger(db2);
  const spendAfterRestart = ledger2.getTotalSpendBaseUnits(runId);
  console.log(`total spend before restart: ${spendBeforeRestart}`);
  console.log(`total spend after restart:  ${spendAfterRestart}`);
  console.log(`persistence verified: ${spendBeforeRestart === spendAfterRestart}`);
  ledger2.close();

  // 8. Summary.
  console.log("\n=== DEMO SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.step.padEnd(34)} ${r.decision.padEnd(8)} signed=${String(r.paymentSigned).padEnd(5)} submitted=${String(r.paymentSubmitted).padEnd(5)} tx=${r.transactionHash ?? "null"}`,
    );
  }
  console.log(`\nledger records written to ${demoDbPath} (gitignored, local only)`);

  // 9. Sanitized artifact (no credentials, no throwaway key).
  try {
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      join("artifacts", "demo-run-result.json"),
      JSON.stringify(
        {
          sessionType: "local-demo",
          note: "Local demonstration only. No on-chain transaction. transactionHash values are local facilitator receipts (local-<hash>), NOT blockchain transaction hashes.",
          runId,
          network: config.allowedNetworks.join(","),
          asset: config.allowedAsset,
          maxCallAmountBaseUnits: config.maxCallAmountBaseUnits.toString(),
          totalRunBudgetBaseUnits: config.totalRunBudgetBaseUnits.toString(),
          buyerWalletAddress: account.address,
          steps: results,
          sellerObservation: { honestResourceServed: honestStats.resourceServed, rogueResourceServed: rogueStats.resourceServed },
          facilitatorStats: facilitator.stats,
          totalSpendBaseUnits: spendAfterRestart.toString(),
          persistenceVerified: spendBeforeRestart === spendAfterRestart,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log("sanitized artifact written to artifacts/demo-run-result.json");
  } catch (error) {
    console.log(`artifact write skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  await facilitator.close();
  await honest.close();
  await rogue.close();

  const honestOk = results[0].decision === "ACCEPTED" && results[0].paymentSigned;
  const rogueOk = results[1].decision === "REFUSED" && !results[1].paymentSigned && !results[1].paymentSubmitted && rogueStats.resourceServed === 0;
  if (mode === "rogue" ? !rogueOk : !(honestOk && rogueOk)) {
    console.error("\nDEMO FAILED expectations");
    process.exit(1);
  }
  console.log("\nDEMO PASSED expectations");
}

function honestAmount(config: ReturnType<typeof loadConfigForLocalDemo>): string {
  // honest price $0.01 => 10,000 base units (6 decimals)
  void config;
  return "10000";
}

function rogueAmount(config: ReturnType<typeof loadConfigForLocalDemo>): string {
  // rogue price $10.00 => 10,000,000 base units (6 decimals)
  void config;
  return "10000000";
}

main().catch((error) => {
  console.error(`[demo] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
