/**
 * Provider registry + default-baseURL resolution.
 *
 * Users write natural config like `{provider: "ollama", model: "qwen2.5-coder:14b"}`.
 * We fill in the baseURL the server defaults to, and pick the right
 * implementation class. They can override baseURL if they run the server
 * on a non-default host/port.
 */

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { Provider, ProviderConfig, ProviderName } from "./types.js";

/**
 * Default baseURL per provider. `undefined` means "use the SDK default"
 * (relevant for OpenAI, which knows its own host).
 */
const DEFAULT_BASE_URLS: Partial<Record<ProviderName, string>> = {
  ollama: "http://localhost:11434/v1",
  vllm: "http://localhost:8000/v1",
  sglang: "http://localhost:30000/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  // MiniMax's OpenAI-compat surface. If the user hits a different
  // region/host they can override baseURL.
  minimax: "https://api.minimaxi.chat/v1",
};

/**
 * Fill in provider-default baseURL when caller didn't specify one.
 * Never mutates the input.
 */
export function resolveConfig(cfg: ProviderConfig): ProviderConfig {
  if (cfg.baseURL) return cfg;
  const fallback = DEFAULT_BASE_URLS[cfg.name];
  if (!fallback) return cfg;
  return { ...cfg, baseURL: fallback };
}

/**
 * Build the correct Provider implementation for this config. Call this
 * once per agent per run; caching the result is fine since ProviderConfig
 * is immutable from the caller's side.
 */
export function createProvider(cfg: ProviderConfig): Provider {
  const resolved = resolveConfig(cfg);
  switch (resolved.name) {
    case "anthropic":
      return new AnthropicProvider(resolved);
    case "openai":
    case "gemini":
    case "minimax":
    case "ollama":
    case "vllm":
    case "sglang":
    case "openai-compat":
      return new OpenAICompatProvider(resolved);
    default: {
      // Exhaustiveness check — catches a new ProviderName added to the
      // union that isn't handled here.
      const _exhaustive: never = resolved.name;
      throw new Error(`unknown provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * Rough cost estimate. Anthropic pricing as a reference line; other
 * providers vary wildly, and we don't pretend to have a perfect model.
 * For local backends (ollama/vllm/sglang) we report $0. For hosted
 * ones, we use a single per-provider fallback rate that's within an
 * order of magnitude of reality, with an explicit note that it's an
 * estimate. Users who need exact accounting should check their provider
 * dashboard.
 */
/**
 * Per-provider $/1M token rates. Same table estimateCost consults —
 * exported so helpers can reuse it without duplicating numbers.
 *
 * Note: `cacheRead`/`cacheWrite` are undefined for every non-Anthropic
 * provider today. That's deliberate: OpenAI's auto-caching is a free
 * server-side optimization we don't bill for separately, Gemini/MiniMax
 * don't expose caching metrics through their OpenAI-compat shims, and
 * the local backends are $0 flat.
 */
export const PROVIDER_RATES: Record<
  ProviderName,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
> = {
  anthropic: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 10.0 },
  openai: { input: 2.5, output: 10.0 },
  gemini: { input: 1.25, output: 5.0 },
  minimax: { input: 1.0, output: 4.0 },
  ollama: { input: 0, output: 0 },
  vllm: { input: 0, output: 0 },
  sglang: { input: 0, output: 0 },
  "openai-compat": { input: 0, output: 0 },
};

/**
 * Dollars saved vs. a hypothetical no-cache baseline. When cache read
 * tokens land at ~10% of input rate, the delta (input - cacheRead) per
 * token read is the concrete savings. Zero for providers that don't
 * charge cache rates separately (OpenAI, Gemini, local) — they either
 * don't cache or don't bill for it.
 */
export function cacheSavings(args: {
  provider: ProviderName;
  cacheReadTokens: number;
}): number {
  const r = PROVIDER_RATES[args.provider];
  if (r.cacheRead === undefined) return 0;
  return (args.cacheReadTokens / 1_000_000) * (r.input - r.cacheRead);
}

export function estimateCost(args: {
  provider: ProviderName;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  // Rates live in PROVIDER_RATES above; see cacheSavings() for the other
  // reader.
  const r = PROVIDER_RATES[args.provider];
  const input = (args.inputTokens / 1_000_000) * r.input;
  const output = (args.outputTokens / 1_000_000) * r.output;
  const cr = (args.cacheReadTokens / 1_000_000) * (r.cacheRead ?? 0);
  const cw = (args.cacheCreationTokens / 1_000_000) * (r.cacheWrite ?? 0);
  return input + output + cr + cw;
}
