/**
 * Research agent tools.
 *
 * The paid HTTP capability is exposed to the LLM as the `paidFetch` tool.
 *
 * TOOL SECURITY (critical):
 *   - The tool schema exposes ONLY request-related arguments (`url`).
 *     additionalProperties is disallowed, so a model cannot smuggle in
 *     policy parameters.
 *   - Spending limits, budgets, allowlists, and the signing key are NEVER
 *     tool parameters. They live in trusted application configuration and
 *     are bound into the tool handler at construction time.
 *   - The tool handler routes every payment decision through the
 *     SpendingPolicy; the model is never trusted to decide whether a
 *     payment is safe.
 */
import type { X402Client } from "../buyer/x402-client.js";
import type { SpendingPolicy } from "../buyer/spending-policy.js";
import type { Ledger } from "../ledger/ledger.js";
import type { PaidFetchResult } from "../types/index.js";

/** Map of tool name to its concrete handler. */
export type ToolHandlers = Map<string, (args: Record<string, unknown>) => Promise<unknown>>;

/** JSON-schema-style tool definition handed to the LLM. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * The paidFetch tool definition.
 *
 * NOTE: `url` is the only parameter. There is no maxAmount, totalBudget,
 * allowedNetwork, allowedAsset, privateKey, or walletAddress parameter.
 * Policy values cannot be passed through tool arguments.
 */
export const PAID_FETCH_TOOL: ToolDefinition = {
  name: "paidFetch",
  description:
    "Fetch a research resource that may be protected by an x402 payment. " +
    "Pass only the URL to fetch. If the resource requires payment, the agent's " +
    "coin purse policy decides automatically whether the payment is allowed; " +
    "you cannot and must not attempt to influence the amount, network, asset, " +
    "or budget. Returns the resource body when payment is accepted, or the " +
    "policy refusal reason when it is not.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL of the research resource to fetch." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/** Read-only purse status tool. No policy mutation is possible. */
export const GET_PURSE_STATUS_TOOL: ToolDefinition = {
  name: "getPurseStatus",
  description:
    "Read the current state of the coin purse: cumulative spend for this run, " +
    "per-call ceiling, total run budget, and allowed network/asset. Read-only; " +
    "these values cannot be changed through this tool.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export const ALL_TOOLS: ToolDefinition[] = [PAID_FETCH_TOOL, GET_PURSE_STATUS_TOOL];

export interface ToolContext {
  x402Client: X402Client;
  policy: SpendingPolicy;
  ledger: Ledger;
  /** Current agent run id (used for ledger bookkeeping). */
  runId: string;
}

/**
 * Bind tool definitions to concrete handlers. The handlers close over the
 * trusted configuration; tool arguments can never reach the policy.
 */
export function createToolHandlers(ctx: ToolContext): ToolHandlers {
  const handlers: ToolHandlers = new Map();

  handlers.set(PAID_FETCH_TOOL.name, async (args: Record<string, unknown>) => {
    const url = args["url"];
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return { error: "paidFetch requires a valid http(s) url argument" };
    }
    // Extra/unknown tool arguments are deliberately ignored: a model passing
    // { maxAmount: "999999999999" } cannot create a new spending limit.
    const result: PaidFetchResult = await ctx.x402Client.paidFetch(url);
    return {
      url: result.url,
      ok: result.ok,
      decision: result.decision,
      reason: result.reason,
      status: result.status ?? null,
      ledgerId: result.ledgerId,
      paymentSigned: result.paymentSigned,
      paymentSubmitted: result.paymentSubmitted,
      transactionHash: result.transactionHash,
      bodyPreview: result.body ? result.body.slice(0, 2000) : null,
      // NOTE: the private key, signing inputs, and full payment payload are
      // deliberately NOT returned to the model.
    };
  });

  handlers.set(GET_PURSE_STATUS_TOOL.name, async () => {
    const spend = ctx.ledger.getTotalSpendBaseUnits(ctx.runId);
    return {
      totalSpendBaseUnits: spend.toString(),
      maxCallAmountBaseUnits: ctx.policy.config.maxCallAmountBaseUnits.toString(),
      totalRunBudgetBaseUnits: ctx.policy.config.totalRunBudgetBaseUnits.toString(),
      remainingBudgetBaseUnits: (ctx.policy.config.totalRunBudgetBaseUnits - spend).toString(),
      allowedNetworks: [...ctx.policy.config.allowedNetworks],
      allowedAsset: ctx.policy.config.allowedAsset,
    };
  });

  return handlers;
}

/** Execute a tool call by name (used by the research agent loop and tests). */
export async function executeTool(
  handlers: ToolHandlers,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) {
    return { error: `unknown tool: ${name}` };
  }
  return handler(args);
}
