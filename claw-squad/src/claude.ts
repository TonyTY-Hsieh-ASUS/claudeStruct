/**
 * Compatibility shim — the codebase originally called `invoke()` directly
 * from this file. Now everything flows through the provider abstraction
 * so agents can talk to Anthropic / OpenAI / Ollama / vLLM / SGLang /
 * Gemini / MiniMax with the same API.
 *
 * New code should import from `./providers/` directly. This file stays
 * so existing agent imports don't break.
 */

export { estimateCost } from "./providers/registry.js";
export type {
  InvokeArgs,
  InvokeResult,
  Provider,
  ProviderConfig,
  ProviderName,
} from "./providers/types.js";
