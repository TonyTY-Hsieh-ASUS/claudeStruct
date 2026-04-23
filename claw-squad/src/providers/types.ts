/**
 * Provider abstraction.
 *
 * Rationale for this shape:
 *
 * - Anthropic is special: we want prompt caching (1h TTL) and adaptive
 *   thinking, both of which the native @anthropic-ai/sdk exposes with
 *   correct types. Shoving it through an OpenAI-compat shim would cost
 *   real money (losing 10x caching discount is not hypothetical).
 *
 * - Everything else (OpenAI itself, Ollama, vLLM, SGLang, Gemini's
 *   OpenAI-compat endpoint, MiniMax's OpenAI-compat endpoint, DeepSeek,
 *   Together, Groq, ...) speaks the same wire format. We use the
 *   `openai` SDK with `baseURL` override for all of them. One provider,
 *   many backends.
 *
 * The `invoke` signature is identical across providers. Callers pass a
 * ProviderConfig; the registry decides which class handles it. Agents
 * (Planner/Coder/Reviewer) are provider-agnostic — they compose a system
 * prompt + user message and hand it to whatever provider the user wired.
 */

import type { AgentRole } from "../types.js";

/**
 * Canonical names. We accept these in configs; the registry maps them
 * to the right underlying implementation + default baseURL.
 *
 * `openai-compat` is the escape hatch for any other server that speaks
 * the OpenAI wire format — just provide baseURL + model.
 */
export type ProviderName =
  | "anthropic"
  | "openai"
  | "gemini"
  | "minimax"
  | "ollama"
  | "vllm"
  | "sglang"
  | "openai-compat";

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  /** Override the default base URL for this provider. */
  baseURL?: string;
  /**
   * API key. If omitted, we read from a provider-appropriate env var
   * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, MINIMAX_API_KEY,
   * or OLLAMA_API_KEY / VLLM_API_KEY / SGLANG_API_KEY which are usually
   * dummy strings for local servers).
   */
  apiKey?: string;
  /**
   * Normalized effort. Mapped per-provider:
   *   anthropic: output_config.effort directly
   *   openai: reasoning_effort (for reasoning models only; ignored elsewhere)
   *   gemini: reasoning_effort via OpenAI-compat shim
   *   ollama/vllm/sglang/minimax: ignored — not all servers support it
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Provider-specific escape hatch. Merged into the underlying request
   * body verbatim. Use sparingly — it won't be validated.
   */
  extra?: Record<string, unknown>;
}

export interface ProviderHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InvokeArgs {
  role: AgentRole;
  systemPrompt: string;
  userMessage: string;
  history?: ProviderHistoryTurn[];
  maxTokens?: number;
  onText?: (chunk: string) => void;
}

export interface InvokeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-only; 0 elsewhere. */
  cacheReadTokens: number;
  /** Anthropic-only; 0 elsewhere. */
  cacheCreationTokens: number;
  stopReason: string | null;
  model: string;
  provider: ProviderName;
  role: AgentRole;
}

export interface Provider {
  readonly name: ProviderName;
  invoke(args: InvokeArgs): Promise<InvokeResult>;
}
