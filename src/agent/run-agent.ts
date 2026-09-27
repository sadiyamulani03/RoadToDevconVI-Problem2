/**
 * Research agent CLI.
 *
 * Usage:
 *   npm run agent -- --url http://localhost:4021/reports/latest [--task "..."]
 *
 * The agent's paid HTTP capability is the secure paidFetch tool. Spending
 * policy values come from trusted configuration (environment), never from
 * tool arguments or model output.
 *
 * PRIVATE_KEY handling: loaded from the environment only. It is never
 * logged, persisted, exposed to the model, or written anywhere. If
 * PRIVATE_KEY is not set, a throwaway unfunded wallet is generated for
 * LOCAL DEMONSTRATION ONLY (clearly labeled as such); live runs must set
 * PRIVATE_KEY.
 */
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSigner } from "x402/types";
import type { Hex } from "viem";
import { loadConfigForLocalDemo, redactConfigForLog } from "../config/config.js";
import { openLedgerDatabase } from "../ledger/database.js";
import { Ledger } from "../ledger/ledger.js";
import { SpendingPolicy } from "../buyer/spending-policy.js";
import { PaymentService } from "../buyer/payment-service.js";
import { X402Client } from "../buyer/x402-client.js";
import { ALL_TOOLS, createToolHandlers } from "./tools.js";
import { ResearchAgent } from "./research-agent.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args[key] = value;
      if (value !== "true") i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfigForLocalDemo();
  const runId = args["run-id"] ?? `run-${randomUUID()}`;

  console.log("[agent] coin purse configuration (redacted):");
  for (const [k, v] of Object.entries(redactConfigForLog(config))) {
    console.log(`[agent]   ${k} = ${v}`);
  }

  // Private key: environment only. Never logged, never passed to the model.
  let privateKey: Hex;
  if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.trim() !== "") {
    privateKey = process.env.PRIVATE_KEY.trim() as Hex;
    console.log("[agent] PRIVATE_KEY loaded from environment (value not shown)");
  } else {
    privateKey = generatePrivateKey();
    console.log(
      "[agent] WARNING: PRIVATE_KEY not set. Generated a throwaway UNFUNDED wallet for LOCAL DEMONSTRATION ONLY.",
    );
  }
  const account = privateKeyToAccount(privateKey);
  console.log(`[agent] buyer wallet address: ${account.address}`);

  const db = openLedgerDatabase({ dbPath: config.ledgerDbPath });
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
    // The signer is created here, OUTSIDE tool arguments. The private key
    // never passes through tool arguments or the model.
    signerFactory: () => createSigner(network, privateKey),
    x402Version: config.x402Version,
  });

  const handlers = createToolHandlers({
    x402Client,
    policy,
    ledger,
    runId,
  });

  const task = args["task"] ?? (args["url"] ? `Research ${args["url"]}` : `Research ${args["url"] ?? "http://localhost:4021/reports/latest"}`);

  const agent = new ResearchAgent({
    task,
    tools: ALL_TOOLS,
    handlers,
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
  });

  const result = await agent.run();
  console.log(`[agent] run id: ${result.runId} (mode: ${result.mode})`);
  console.log("[agent] final message:");
  console.log(result.finalMessage);
  console.log("[agent] ledger for this run:");
  for (const record of ledger.getRecordsForRun(result.runId)) {
    console.log(
      `[agent]   #${record.id} ${record.decision} ${record.seller} ${record.endpoint} amount=${record.amountBaseUnits} signed=${record.paymentSigned} submitted=${record.paymentSubmitted}`,
    );
  }
  const spend = ledger.getTotalSpendBaseUnits(result.runId);
  console.log(`[agent] total spend for run: ${spend} base units of budget ${config.totalRunBudgetBaseUnits}`);
  ledger.close();
}

main().catch((error) => {
  console.error(`[agent] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
