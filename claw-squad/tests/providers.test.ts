/**
 * Provider registry unit tests.
 *
 * We don't hit real LLMs here — those tests belong in an integration
 * suite gated on API keys. These tests lock in the registry's behavior:
 *   - the right Provider class is instantiated per name
 *   - default baseURLs are filled in when the config omits them
 *   - user-supplied baseURLs win
 *   - estimateCost handles each provider sensibly
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProvider, estimateCost, resolveConfig } from "../src/providers/registry.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";

describe("resolveConfig", () => {
  it("fills in Ollama default baseURL when missing", () => {
    const cfg = resolveConfig({ name: "ollama", model: "qwen2.5" });
    expect(cfg.baseURL).toBe("http://localhost:11434/v1");
  });

  it("fills in vLLM default", () => {
    const cfg = resolveConfig({ name: "vllm", model: "meta-llama/Llama-3" });
    expect(cfg.baseURL).toBe("http://localhost:8000/v1");
  });

  it("fills in SGLang default", () => {
    const cfg = resolveConfig({ name: "sglang", model: "Qwen/Qwen2" });
    expect(cfg.baseURL).toBe("http://localhost:30000/v1");
  });

  it("fills in Gemini OpenAI-compat default", () => {
    const cfg = resolveConfig({ name: "gemini", model: "gemini-2.5-pro" });
    expect(cfg.baseURL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    );
  });

  it("preserves user-supplied baseURL", () => {
    const cfg = resolveConfig({
      name: "ollama",
      model: "x",
      baseURL: "http://remote:11434/v1",
    });
    expect(cfg.baseURL).toBe("http://remote:11434/v1");
  });

  it("leaves OpenAI baseURL unset (SDK knows default)", () => {
    const cfg = resolveConfig({ name: "openai", model: "gpt-4o" });
    expect(cfg.baseURL).toBeUndefined();
  });
});

describe("createProvider", () => {
  // These tests only check that the right class is instantiated — no
  // network traffic. We set a dummy env var so Anthropic constructor
  // doesn't throw, and restore it cleanly after.
  let originalKey: string | undefined;
  beforeAll(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("creates AnthropicProvider for anthropic", () => {
    const p = createProvider({ name: "anthropic", model: "claude-opus-4-7" });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe("anthropic");
  });

  for (const name of [
    "openai",
    "gemini",
    "minimax",
    "ollama",
    "vllm",
    "sglang",
    "openai-compat",
  ] as const) {
    it(`creates OpenAICompatProvider for ${name}`, () => {
      const p = createProvider({ name, model: "x" });
      expect(p).toBeInstanceOf(OpenAICompatProvider);
      expect(p.name).toBe(name);
    });
  }
});

describe("estimateCost", () => {
  it("returns 0 for local providers", () => {
    const cost = estimateCost({
      provider: "ollama",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it("applies Anthropic cache discount", () => {
    // 1M input + 1M cache-read should be well under 1M input + 1M input.
    const cached = estimateCost({
      provider: "anthropic",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    });
    const uncached = estimateCost({
      provider: "anthropic",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cached).toBeLessThan(uncached / 5);
  });

  it("OpenAI cost is nonzero for output tokens", () => {
    const cost = estimateCost({
      provider: "openai",
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });
});
