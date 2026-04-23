/**
 * OpenAI-compatible provider.
 *
 * Handles every backend that speaks the OpenAI chat-completions wire
 * format. That includes:
 *   - OpenAI itself (gpt-*)
 *   - Ollama (http://localhost:11434/v1)
 *   - vLLM (http://localhost:8000/v1)
 *   - SGLang (http://localhost:30000/v1)
 *   - Gemini via OpenAI-compat endpoint
 *     (https://generativelanguage.googleapis.com/v1beta/openai/)
 *   - MiniMax's OpenAI-compat endpoint
 *   - DeepSeek, Together, Groq, Fireworks, and anything else you plug in
 *     with `name: "openai-compat"` + baseURL.
 *
 * We use a single `openai` SDK instance per ProviderConfig. Local servers
 * usually accept any non-empty apiKey (we use `not-needed` as a sentinel).
 *
 * Limitations vs the Anthropic provider:
 *   - No prompt caching (OpenAI has server-side auto-caching, free to
 *     use but not as aggressive as Anthropic's 1h explicit TTL).
 *   - `effort` is mapped to `reasoning_effort` when the model supports
 *     it (GPT-5 reasoning / o1 / o3 / Gemini 2.5 / etc.), ignored
 *     otherwise. We never silently error on unsupported fields — the
 *     server either accepts or rejects them.
 */

import OpenAI from "openai";
import type {
  InvokeArgs,
  InvokeResult,
  Provider,
  ProviderConfig,
  ProviderName,
} from "./types.js";

/**
 * Map our normalized effort to OpenAI's reasoning_effort vocabulary.
 * OpenAI accepts "minimal" | "low" | "medium" | "high". We over-map
 * our two extra levels: xhigh/max collapse to "high".
 */
function mapEffort(
  effort?: ProviderConfig["effort"],
): "minimal" | "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high"; // high | xhigh | max
}

/**
 * Which "reasoning" knob to send. Some providers accept
 * `reasoning_effort` at top level (OpenAI, Gemini compat); others expect
 * it nested in `reasoning: { effort }`. We include both and let the
 * server ignore what it doesn't understand. Strict servers may reject
 * unknown fields — users on those backends should pass `effort: null` or
 * omit it.
 */
function buildExtraFields(
  cfg: ProviderConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(cfg.extra ?? {}) };
  const r = mapEffort(cfg.effort);
  if (r && !("reasoning_effort" in out)) {
    out.reasoning_effort = r;
  }
  return out;
}

export class OpenAICompatProvider implements Provider {
  readonly name: ProviderName;
  private readonly client: OpenAI;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    const apiKey = cfg.apiKey ?? resolveApiKeyFromEnv(cfg.name) ?? "not-needed";
    this.client = new OpenAI({
      apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    // OpenAI chat format: system message at the front, then history,
    // then the new user turn. We also set max_tokens via max_completion_tokens
    // which is the current field (max_tokens is deprecated for reasoning
    // models).
    const messages = [
      { role: "system" as const, content: args.systemPrompt },
      ...(args.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: args.userMessage },
    ];

    const extra = buildExtraFields(this.cfg);
    const collected: string[] = [];

    // Streaming with usage. `stream_options: {include_usage: true}` asks
    // the server to emit a final usage chunk; most OpenAI-compat
    // implementations honor it, but a few (old Ollama builds) may not.
    const stream = await this.client.chat.completions.create({
      model: this.cfg.model,
      messages,
      max_completion_tokens: args.maxTokens ?? 16_000,
      stream: true,
      stream_options: { include_usage: true },
      ...extra,
    } as Parameters<typeof this.client.chat.completions.create>[0]);

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;
    let modelReturned = this.cfg.model;

    for await (const chunk of stream as AsyncIterable<{
      choices: Array<{
        delta?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    }>) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        collected.push(choice.delta.content);
        args.onText?.(choice.delta.content);
      }
      if (choice?.finish_reason) {
        stopReason = choice.finish_reason;
      }
      if (chunk.model) modelReturned = chunk.model;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }

    return {
      text: collected.join(""),
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason,
      model: modelReturned,
      provider: this.name,
      role: args.role,
    };
  }
}

function resolveApiKeyFromEnv(name: ProviderName): string | undefined {
  const keys: Partial<Record<ProviderName, string>> = {
    openai: "OPENAI_API_KEY",
    gemini: "GOOGLE_API_KEY",
    minimax: "MINIMAX_API_KEY",
    ollama: "OLLAMA_API_KEY",
    vllm: "VLLM_API_KEY",
    sglang: "SGLANG_API_KEY",
    "openai-compat": "OPENAI_COMPAT_API_KEY",
  };
  const envVar = keys[name];
  return envVar ? process.env[envVar] : undefined;
}
