/**
 * Anthropic provider — native SDK.
 *
 * Why this is separate from the OpenAI-compat path: prompt caching and
 * adaptive thinking are Anthropic-specific features, and both are real
 * money. Caching alone can cut input cost by 10x on repeat calls;
 * adaptive thinking picks the right reasoning depth per turn.
 *
 * Per the skill guide, we never mix Anthropic calls with OpenAI SDK.
 * When the user wires `provider: "anthropic"` for an agent, we come
 * here. When they wire any other provider, we go through openai-compat.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { InvokeArgs, InvokeResult, Provider, ProviderConfig } from "./types.js";

const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "anthropic provider: ANTHROPIC_API_KEY is not set and no apiKey in config",
      );
    }
    this.client = new Anthropic({
      apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    const messages = [
      ...(args.history ?? []),
      { role: "user" as const, content: args.userMessage },
    ];

    const collected: string[] = [];
    const effort = this.cfg.effort ?? "high";

    const stream = this.client.messages.stream({
      model: this.cfg.model,
      max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [
        {
          type: "text",
          text: args.systemPrompt,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort },
      messages,
      ...(this.cfg.extra ?? {}),
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
      provider: this.name,
      role: args.role,
    };
  }
}
