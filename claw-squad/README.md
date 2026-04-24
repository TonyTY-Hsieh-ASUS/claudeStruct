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

## New in v0.3 (squad-extensions)

- **Test runner** between Coder and Reviewer: `--test-cmd "npm test"` runs the tests after every Coder commit. If they fail, output is fed into Coder's next round as a `critical` finding — *Reviewer is skipped*, saving an LLM call per bad commit. `--auto-test` sniffs the repo for `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pom.xml` / `build.gradle` / `Makefile` and picks one.
- **CI wait** between Reviewer approve and merge: `--wait-for-ci` polls GitHub's `check_runs` + legacy commit-status for the PR's head SHA. On failure, the failing check names + URLs feed into Coder as another round. Timeouts configurable via `--ci-timeout` (default 15 min).
- **Skills**: drop `.claw-squad/skills/*.md` files with YAML frontmatter (`name`, `description`, optional `apply_to` globs). Planner sees a compact catalog and tags TODOs with `skills: [...]`; orchestrator also auto-activates any skill whose `apply_to` matches the Coder's file context. Full skill body goes into Coder's user turn, not into the (cached) system prompt — so cache hits aren't burnt on skills the task doesn't need.
- **Subagents**: declare ephemeral research/verification helpers in `subagents: [...]` in `config.json`. Each has its own provider config — use cheap/fast models (`claude-haiku-4-5`, `gpt-4o-mini`, local Ollama) for subordinate work. Planner delegates by emitting `## Delegate <name>\n<prompt>`; answers fold into Planner's next turn.
- **TUI** (`--tui`): Ink-based terminal UI with a live status header (tokens, cost, active agent), a TODO panel (✓/◐/✗/·), and a scrolling activity pane. Handles confirm/clarification prompts in-TUI via `useInput`. Falls back to plain CLI when stdout isn't a TTY.

See `examples/config.with-subagents.json` and `examples/skills/typescript-conventions.md` for concrete templates.

## What's wired

- **Provider abstraction**: 8 backends (Anthropic, OpenAI, Gemini, MiniMax, Ollama, vLLM, SGLang, openai-compat) via 2 client classes
- **Per-agent config**: defaults + `config.json` + CLI flags, with precedence
- **3-agent loop**: Planner / Coder / Reviewer, bounded by `maxReviewRounds`
- **GitHub integration** (`--github`): push branch, find-or-create draft PR, post Reviewer verdict as inline PR review, mark-ready + squash-merge on approve. PR description includes the TODO and original requirement.
- **Coder round-1 file context**: `src/context-gather.ts` uses keyword + path matching against `git ls-files` so round 1 starts with relevant files preloaded, not a blank slate
- **Local file apply + git commit** with always-on path deny-list (`.git/`, `.env`, `.ssh/`)
- **Go sandbox** (`--sandbox`, opt-in): rlimits + path validation + env scrubbing
- **Self-learning memory** (`--no-self-learning` to disable): lessons.md + patterns.md per repo, Planner reads recent 8 KB
- **Budget caps**: `--max-cost <usd>` and `--max-tokens-total <n>` abort the run as soon as the cumulative cost/tokens cross the threshold
- **Lifecycle hooks** (`--hooks <path>`): `preAgent` / `postAgent` / `preCommit` / `postCommit` / `onBudgetExceeded`. Throw `HookAbort` to cancel a step. See `examples/hooks.sample.mjs`.
- **State snapshots + resume** (`--resume`): orchestrator persists `.claw-squad/state.json` after every outer loop and in `finally`. Use `--resume` to pick up a long run after a budget trip / network blip / manual interrupt.
- Interactive CLI with `prompts` + `commander`
- **67 TS tests** (parsers, memory, path validation, providers, config, snapshot, hooks, context-gather) + **7 Go tests**

## Testing

```bash
pnpm test         # 48 TS smoke tests (parsers, memory, path, providers, config)
cd ../claw-sandbox && go test ./...   # 7 Go tests
```

No API calls. API integration tests come in a follow-up.
