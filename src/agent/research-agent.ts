/**
 * Research agent: an LLM-driven tool-calling agent whose paid HTTP capability
 * is the secure `paidFetch` tool.
 *
 * SECURITY MODEL (critical):
 *   - The LLM prompt is NOT a security boundary.
 *   - The model only chooses which URL to research via paidFetch.
 *   - Every payment decision is made by the SpendingPolicy in executable
 *     code, with the persisted ledger as the source of cumulative spend.
 *   - The model never sees the private key, the signing inputs, or the full
 *     payment payload; the tool returns only outcomes and refusal reasons.
 *
 * LLM transport: any OpenAI-compatible chat-completions endpoint
 * (LLM_BASE_URL, default https://api.openai.com/v1) with LLM_API_KEY and
 * LLM_MODEL. When no API key is configured, the agent falls back to a
 * deterministic local planner that issues the same paidFetch tool call —
 * this keeps the demonstration runnable offline. The fallback is documented
 * and is NOT a security boundary either: both paths go through the exact
 * same policy-enforcing tool handler.
 */
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolHandlers } from "./tools.js";
import { executeTool } from "./tools.js";

export interface ResearchAgentOptions {
  /** System-level mission description for the model. Never contains secrets. */
  task: string;
  /** Tool definitions (paidFetch, getPurseStatus). */
  tools: ToolDefinition[];
  /** Concrete tool handlers bound to trusted configuration. */
  handlers: ToolHandlers;
  /** OpenAI-compatible base URL. */
  llmBaseUrl?: string;
  /** LLM API key. Loaded from the environment; never logged or persisted. */
  llmApiKey?: string;
  /** Model name. */
  llmModel?: string;
  /** Max tool-calling iterations. */
  maxIterations?: number;
  /** When true, skip the LLM and use the deterministic local planner. */
  offline?: boolean;
}

export interface AgentStep {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ResearchAgentResult {
  runId: string;
  steps: AgentStep[];
  finalMessage: string;
  mode: "llm" | "offline-planner";
}

/** The system prompt for the model. NOTE: it contains no secrets and no keys. */
export function buildSystemPrompt(toolNames: string[]): string {
  return [
    "You are a research agent with a secure coin purse.",
    "You can fetch web resources with the paidFetch tool. Some resources are",
    "protected by x402 micropayments. When a resource requires payment, the",
    "coin purse policy evaluates the payment automatically and pays only",
    "within its hard per-call ceiling, total run budget, and network/asset",
    "allowlists.",
    "",
    "IMPORTANT RULES:",
    "- You can only choose which URL to fetch via paidFetch.",
    "- You cannot change spending limits, budgets, allowed networks, allowed",
    "  assets, or any signing policy. Do not attempt to pass amounts, budgets,",
    "  or policy overrides in tool arguments; they will be ignored.",
    "- If a payment is refused, report the refusal to the user. Never try to",
    "  bypass or work around the refusal.",
    "- You can check the purse state with the getPurseStatus tool.",
    "",
    `Available tools: ${toolNames.join(", ")}.`,
  ].join("\n");
}

export class ResearchAgent {
  private readonly options: ResearchAgentOptions;

  constructor(options: ResearchAgentOptions) {
    this.options = options;
  }

  /** Run the agent to completion (tool-calling loop, or offline planner). */
  async run(): Promise<ResearchAgentResult> {
    const runId = `run-${randomUUID()}`;
    const offline = this.options.offline || !this.options.llmApiKey;
    if (offline) {
      return this.runOfflinePlanner(runId);
    }
    return this.runLlmLoop(runId);
  }

  /**
   * Deterministic offline planner: issues the same paidFetch tool call the
   * LLM would issue, then reports the outcome. Used when no LLM API key is
   * configured so the demonstration remains runnable without credentials.
   */
  private async runOfflinePlanner(runId: string): Promise<ResearchAgentResult> {
    const steps: AgentStep[] = [];
    const url = extractUrl(this.options.task);
    if (!url) {
      return {
        runId,
        steps,
        finalMessage:
          "No http(s) URL found in the task. Provide a URL to research, e.g. --url http://localhost:4021/reports/latest",
        mode: "offline-planner",
      };
    }
    const result = await executeTool(this.options.handlers, "paidFetch", { url });
    steps.push({ iteration: 1, tool: "paidFetch", args: { url }, result });
    const summary = summarizePaidFetch(result);
    return { runId, steps, finalMessage: summary, mode: "offline-planner" };
  }

  /** OpenAI-compatible tool-calling loop. */
  private async runLlmLoop(runId: string): Promise<ResearchAgentResult> {
    const baseUrl = (this.options.llmBaseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const model = this.options.llmModel ?? "gpt-4o-mini";
    const maxIterations = this.options.maxIterations ?? 6;
    const steps: AgentStep[] = [];
    const toolNames = this.options.tools.map((t) => t.name);

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: buildSystemPrompt(toolNames) },
      { role: "user", content: this.options.task },
    ];

    let finalMessage = "";
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.llmApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: this.options.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM API error ${response.status}: ${text.slice(0, 500)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> } }>;
      };
      const choice = data.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls ?? [];

      if (toolCalls.length === 0) {
        finalMessage = choice?.content ?? "(no response from model)";
        break;
      }

      messages.push({
        role: "assistant",
        content: choice?.content ?? null,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const fn = call["function"] as { name?: string; arguments?: string } | undefined;
        const name = fn?.name ?? "";
        let args: Record<string, unknown> = {};
        try {
          args = fn?.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        const result = await executeTool(this.options.handlers, name, args);
        steps.push({ iteration, tool: name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: typeof call["id"] === "string" ? call["id"] : `call-${steps.length}`,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    }

    if (!finalMessage) {
      finalMessage = summarizeSteps(steps);
    }
    return { runId, steps, finalMessage, mode: "llm" };
  }
}

function extractUrl(task: string): string | null {
  const match = task.match(/https?:\/\/[^\s"']+/i);
  return match ? match[0] : null;
}

function summarizePaidFetch(result: unknown): string {
  const r = result as { ok?: boolean; decision?: string; reason?: string; url?: string; paymentSigned?: boolean; paymentSubmitted?: boolean; transactionHash?: string | null; bodyPreview?: string | null };
  if (r.decision === "REFUSED") {
    return `Payment REFUSED for ${r.url}: ${r.reason}. No payment was signed or submitted.`;
  }
  if (r.ok) {
    const tx = r.transactionHash ? ` Settlement transaction/receipt: ${r.transactionHash}.` : "";
    return `Research complete for ${r.url}. Payment accepted${r.paymentSigned ? ", signed" : ""}${r.paymentSubmitted ? " and submitted" : ""}.${tx}`;
  }
  return `Fetch did not succeed for ${r.url}: ${r.reason}`;
}

function summarizeSteps(steps: AgentStep[]): string {
  if (steps.length === 0) return "(no tool calls executed)";
  return steps
    .map((s) => `- [${s.iteration}] ${s.tool}: ${JSON.stringify(s.args)} -> ${JSON.stringify(s.result).slice(0, 300)}`)
    .join("\n");
}
