# Adding a new provider

The 8 currently-supported providers (Anthropic, OpenAI, Gemini, MiniMax, Ollama, vLLM, SGLang, openai-compat) all funnel through 2 client classes:

- `AnthropicProvider` (`src/providers/anthropic.ts`) — uses the native `@anthropic-ai/sdk`. Required to keep prompt caching with explicit `cache_control` and adaptive thinking.
- `OpenAICompatProvider` (`src/providers/openai-compat.ts`) — uses the `openai` SDK with a swapped `baseURL`. Covers everything else.

If your new provider speaks the OpenAI chat-completions wire format, you almost certainly don't need a new class — just a new entry in the registry.

## Recipe: new OpenAI-compat provider

1. **Add the name to the union.** Edit `src/providers/types.ts` → `ProviderName`. Add `"deepseek"` (or whatever).
2. **Add it to the zod schema.** `src/config-schema.ts` → `PROVIDERS`. Tests covering invalid-provider error paths will pick this up automatically.
3. **Add cost rates.** `src/providers/registry.ts` → `PROVIDER_RATES`. Use the provider's published $/1M token figures. Cache fields stay undefined unless they bill caching separately.
4. **Optional: add an env-var fallback.** If your provider has a conventional env var (`DEEPSEEK_API_KEY`), wire it in `resolveApiKeyFromEnv` (`src/providers/openai-compat.ts`). Otherwise users pass it via `--<role>-api-key`.
5. **Optional: default baseURL.** If the provider has a fixed baseURL, set it in the registry's factory branch. Otherwise users pass `--<role>-base-url`.

Test:

```bash
node dist/cli.js run "..." \
  --planner-provider deepseek --planner-model deepseek-coder \
  --planner-api-key "$DEEPSEEK_API_KEY"
```

## Recipe: provider that needs a new client class

Rare. Examples: a provider with a non-OpenAI wire format, or one that needs prompt caching with a different SDK shape.

1. **Implement `Provider` interface** (`src/providers/types.ts`):
   ```ts
   interface Provider {
     readonly name: ProviderName;
     invoke(args: InvokeArgs): Promise<InvokeResult>;
   }
   ```
   - `args.systemPrompt` is the *raw* string. If your SDK wants caching, wrap it yourself (see how `AnthropicProvider` does `cache_control: ephemeral`).
   - `args.userMessage` is the volatile content; do NOT cache it.
   - Return token counts for input / output / cache read / cache write. Zero is fine for cache fields when the SDK doesn't expose them — `estimateCost` and `cacheSavings` handle the missing-rate case.
2. **Wire via `transportPolicy()`.** Both existing classes call this on construction to read `CLAW_SQUAD_TIMEOUT` / `CLAW_SQUAD_MAX_RETRIES`. Do the same — users expect uniform retry behavior across providers.
3. **Add to the registry factory** (`src/providers/registry.ts` → `createProvider`). Branch on `cfg.name`.
4. **Tests.** Mock the SDK (don't hit the network). `tests/providers.test.ts` is the convention.

## Conventions

- **Streaming is always on for the Anthropic path.** OpenAI-compat doesn't stream by default but the underlying SDK supports it; if you add streaming, surface chunks via the `onText` callback so the UI sees them live.
- **Effort mapping.** Our 5-level effort (`low | medium | high | xhigh | max`) compresses into whatever the provider offers. OpenAI: 4 levels (`mapEffort` collapses xhigh/max → `high`). Anthropic: 5 levels mapped 1:1. Document your mapping in the new class.
- **Don't validate provider rates client-side.** Rates change; we keep `PROVIDER_RATES` updatable as a simple table. Authoritative billing lives on the provider's dashboard.
