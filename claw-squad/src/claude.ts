/**
 * Thin Anthropic SDK wrapper enforcing our efficiency discipline.
 *
 * Invariants:
 *   1. System prompts are ALWAYS passed as a list with `cache_control:
 *      {type: "ephemeral", ttl: "1h"}` on the last block. Per-role prompts
 *      are constants so the cache prefix is byte-stable across calls.
 *   2. Streaming is always on — avoids HTTP timeouts on large max_tokens
 *      and lets the orchestrator surface progress live.
 *   3. Adaptive thinking on all roles (opus-4-7 + sonnet-4-6 both support it).
 *   4. `effort` is tuned per role (see DEFAULT_MODELS).
 *   5. temperature / top_p / top_k are NEVER set — removed on opus-4-7 and
 *      a silent-invalidator for cache on any model.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentRole } from "./types.js";

const DEFAULT_MAX_TOKENS = 16_000;

export interface InvokeArgs {
  role: AgentRole;
  systemPrompt: string;
  userMessage: string;
  /** Optional conversation history — Planner uses this for Q&A loops. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Live stream callback. */
  onText?: (chunk: string) => void;
}

export interface InvokeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
  model: string;
  role: AgentRole;
}

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it or put it in your shell rc.",
    );
  }
  _client = new Anthropic();
  return _client;
}

/**
 * Invoke an agent role. Streams response, returns usage stats.
 *
 * Note: history + userMessage combine into the messages array. history goes
 * FIRST so the cache prefix (system prompt + stable history turns) can grow
 * and get re-read across Q&A turns. Don't inject timestamps or UUIDs into
 * the system prompt — it will silently invalidate the cache.
 */
export async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(args.history ?? []),
    { role: "user", content: args.userMessage },
  ];

  const collected: string[] = [];
  const stream = client().messages.stream({
    model: args.model,
    max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: args.systemPrompt,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: args.effort },
    messages,
  });

  stream.on("text", (delta) => {
    collected.push(delta);
    args.onText?.(delta);
  });

  const final = await stream.finalMessage();
  const usage = final.usage;

  return {
    text: collected.join(""),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    stopReason: final.stop_reason ?? null,
    model: final.model,
    role: args.role,
  };
}

/** Rough cost estimate for status reporting. Not a billing source of truth. */
export function estimateCost(result: InvokeResult): number {
  // Opus 4.7 pricing; sonnet is cheaper so this over-estimates for sonnet.
  // Cache reads are ~10% of input, cache creation is ~125% of input (5m TTL)
  // or ~200% (1h TTL). We assume 1h TTL here.
  const inputCost = (result.inputTokens / 1_000_000) * 5.0;
  const cacheRead = (result.cacheReadTokens / 1_000_000) * 0.5;
  const cacheWrite = (result.cacheCreationTokens / 1_000_000) * 10.0;
  const outputCost = (result.outputTokens / 1_000_000) * 25.0;
  return inputCost + cacheRead + cacheWrite + outputCost;
}
