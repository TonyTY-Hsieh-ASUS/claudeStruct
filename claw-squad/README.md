# claw-squad

**A 3-agent Claude orchestrator that plans, codes, and reviews — then learns from every loop. Each agent can run on any supported model backend.**

Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw) (gateway-based control plane + pluggable sandboxes) and [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) (clean agent loop + hooks). This project takes their best ideas and lands them in a tighter, more opinionated tool focused on one workflow: **requirement → shipped code**.

Written in **TypeScript** (orchestrator) + **Go** (sandbox binary). No Python.

## What it does

```
User requirement
   ↓
┌──────────────────────────────────────┐
│  Planner                              │
│   1. Asks clarifying questions        │
│   2. Produces a TODO list             │
└──────────────┬───────────────────────┘
               ↓
     ┌───── one TODO item ─────┐
     ↓                          │
┌──────────────────────┐        │  (request_changes)
│ Coder                │        │
│  · writes code        │        │
│  · git commit         │───────┤
└─────────┬─────────────┘        │
          ↓ diff                  │
┌──────────────────────┐        │
│ Reviewer              │        │
│  · reads diff only    │        │
│  · structured verdict │        │
└─────────┬─────────────┘        │
          │ approve               │
          ↓                       │
    Planner reviews TODO ─────────┘
    & memory, picks next task
```

## Model choice is per-agent

Each of the 3 agents can run on any backend. Mix & match freely — e.g. cloud Claude for Planner (best reasoning), local Ollama for Coder (cost-free bulk work), GPT-4 for Reviewer (second-opinion diversity).

| Provider | `name` value | Notes |
|---|---|---|
| Anthropic | `anthropic` | Native SDK. Keeps prompt caching (1h TTL) + adaptive thinking. |
| OpenAI | `openai` | GPT-5 / GPT-4 family. `effort` maps to `reasoning_effort` on reasoning models. |
| Google Gemini | `gemini` | Via Gemini's OpenAI-compat endpoint. Default baseURL preset. |
| MiniMax | `minimax` | Via their OpenAI-compat endpoint. |
| Ollama | `ollama` | Default `http://localhost:11434/v1`. |
| vLLM | `vllm` | Default `http://localhost:8000/v1`. |
| SGLang | `sglang` | Default `http://localhost:30000/v1`. |
| Any OpenAI-wire-format server | `openai-compat` | Pass your own `baseURL`. |

Everything except Anthropic goes through the `openai` npm SDK with a different `baseURL` — one code path, many backends.

### Configure via file OR CLI flags OR both

**Option 1: `.claw-squad/config.json`**

```json
{
  "agents": {
    "planner": {
      "name": "anthropic",
      "model": "claude-opus-4-7",
      "effort": "max"
    },
    "coder": {
      "name": "ollama",
      "model": "qwen2.5-coder:14b",
      "baseURL": "http://localhost:11434/v1"
    },
    "reviewer": {
      "name": "openai",
      "model": "gpt-5",
      "effort": "high"
    }
  }
}
```

**Option 2: CLI flags** (override config file per-run)

```bash
node dist/cli.js run "<requirement>" \
  --planner-provider anthropic --planner-model claude-opus-4-7 \
  --coder-provider ollama --coder-model qwen2.5-coder:14b \
  --reviewer-provider openai --reviewer-model gpt-5
```

Both can coexist — CLI wins, file wins over built-in defaults, and defaults are all-Anthropic.

## Why 3 agents, not 1

1. **Planner Q&A first, Coder second.** Clarifying questions happen before Coder tokens are spent. Cheapest role clears the ambiguity.
2. **Reviewer sees diffs, Coder sees files.** Different context shapes → different token counts. 500-line file with a 10-line change sends 10 lines to the Reviewer, not 500.
3. **Prompts cached per role (Anthropic only).** 1h TTL `cache_control: ephemeral` on each agent's system prompt. Repeat calls cost ~10% of prompt input. Other providers fall back to server-side auto-caching or nothing, depending on backend.

Plus the correctness win: the Reviewer catches what the Coder missed.

## Install

```bash
cd claw-squad
pnpm install
pnpm build

# Optional: build the Go sandbox (only needed if you pass --sandbox)
cd ../claw-sandbox
go build -o claw-sandbox .
export CLAW_SANDBOX_BIN=$(pwd)/claw-sandbox
```

## Env vars per provider

| Provider | Env var |
|---|---|
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| gemini | `GOOGLE_API_KEY` |
| minimax | `MINIMAX_API_KEY` |
| ollama / vllm / sglang | optional (local servers usually accept any string) |
| openai-compat | `OPENAI_COMPAT_API_KEY`, or `--<role>-api-key` |

Also `GITHUB_TOKEN` when `--github` is enabled.

## Usage

```bash
# Local dry run with all-Anthropic defaults
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js run "add retry logic to the API client with exponential backoff"

# Coder runs locally on Ollama, Planner & Reviewer stay on Claude
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js run "<requirement>" \
  --coder-provider ollama --coder-model qwen2.5-coder:14b

# All three on cloud OpenAI
export OPENAI_API_KEY=sk-...
node dist/cli.js run "<requirement>" \
  --planner-provider openai --planner-model gpt-5 --planner-effort max \
  --coder-provider openai --coder-model gpt-5-mini \
  --reviewer-provider openai --reviewer-model gpt-5 --reviewer-effort high

# Scaffold config.json
node dist/cli.js init

# Turn on GitHub + Go sandbox
node dist/cli.js run "<requirement>" --github --github-repo owner/repo --sandbox
```

## User requirements → implementation

| Requirement | Implementation |
|---|---|
| Security mechanism, default off | `--sandbox` flag → `claw-sandbox` Go binary (rlimits + path validation + env scrubbing). Always-on: hardcoded `.git/.env/.ssh/` deny-list in TS applier (not user-disableable). |
| Multi-agent review mechanism | `src/orchestrator.ts` — Planner Q&A then Coder ↔ Reviewer loop with bounded `maxReviewRounds`. Only approved diffs get merged. |
| Planner thinking + Q&A before dispatch | Planner uses adaptive thinking (Anthropic) or `reasoning_effort` (OpenAI/Gemini). Refuses to emit TODOs until its `planReady` phase. |
| Reviewer requests changes → Coder fixes → re-review | `runTaskLoop` in orchestrator. Reviewer's findings passed back into Coder's next user turn as explicit fix items. |
| Self-learning, default on | `src/memory/memory.ts` — appends lessons + patterns to `.claw-squad/memory/*.md` after every task. Planner reads the most recent 8 KB on each invocation. Disable with `--no-self-learning`. |
| Flexible model choice | Provider registry maps 8 backends to 2 client classes (native Anthropic + generic OpenAI-compat). Per-agent config via JSON or CLI. |

## Key design choices

- **Prompts live as Markdown files**, not template strings. Keeps the cached prefix byte-stable and auditable.
- **Coder never talks to git directly.** Produces JSON file edits; orchestrator writes + commits.
- **Reviewer sees only the staged diff**, deterministic, smaller payload.
- **Token accountability**: every LLM call's usage tallied; end-of-run summary shows input, output, cache reads, cache writes, estimated cost.
- **Human-in-the-loop by default** for destructive GitHub actions (push, merge). Pass `--no-confirm` to automate.
- **Single dependency for non-Anthropic providers** (`openai` npm package). No plugin framework, no LiteLLM adapter chain — just baseURL swap.

## What's wired vs. deferred

**Phase 1 (done):**
- Provider abstraction (8 backends via 2 client classes)
- Per-agent config: defaults + `config.json` + CLI flags with precedence
- Planner / Coder / Reviewer agents
- 3-agent orchestrator loop with bounded rounds
- Local file apply + git commit
- Path validation (always on) + Go sandbox (opt-in)
- Self-learning memory
- Interactive CLI with `prompts`
- **48** TS smoke tests + **7** Go tests

**Phase 2 (skeleton in place, wiring pending):**
- `src/github/octokit.ts` has `pushBranch` / `openPr` / `postReview` / `mergePr`.
- Next step: wire them into the `approve` branch of `runTaskLoop`.

## Testing

```bash
pnpm test         # 48 TS smoke tests (parsers, memory, path, providers, config)
cd ../claw-sandbox && go test ./...   # 7 Go tests
```

No API calls. API integration tests come in a follow-up.
