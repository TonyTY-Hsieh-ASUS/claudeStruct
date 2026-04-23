# claw-squad

**A 3-agent Claude orchestrator that plans, codes, and reviews — then learns from every loop.**

Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw) (gateway-based control plane + pluggable sandboxes) and [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) (clean agent loop + hooks). This project takes their best ideas and lands them in a tighter, more opinionated tool focused on one workflow: **requirement → shipped code**.

Written in **TypeScript** (orchestrator) + **Go** (sandbox binary). No Python in this tool — the existing `cs` CLI in the parent repo stays Python; `claw-squad` is a separate system with a different job.

## What it does

```
User requirement
   ↓
┌─────────────────────────────────┐
│  Planner (opus-4-7, effort=max)  │
│   1. Asks clarifying questions   │
│   2. Produces a TODO list        │
└──────────────┬──────────────────┘
               ↓
     ┌───── one TODO item ─────┐
     ↓                          │
┌──────────────────────┐        │  (request_changes)
│ Coder                │        │
│  (sonnet-4-6, high)   │        │
│  · writes code        │        │
│  · git commit          │───────┤
└─────────┬─────────────┘        │
          ↓ diff                  │
┌──────────────────────┐        │
│ Reviewer              │        │
│  (opus-4-7, xhigh)    │        │
│  · reads diff only    │        │
│  · structured verdict │        │
└─────────┬─────────────┘        │
          │ approve               │
          ↓                       │
    Planner reviews TODO ─────────┘
    & memory, picks next task
```

## Why 3 agents, not 1

Splitting the roles gives three cost wins:

1. **Planner Q&A first, Coder second.** Clarifying questions happen before any Coder tokens are spent. Requirements get hammered out by the cheapest role (Planner is thinking-heavy but output-light).
2. **Reviewer sees diffs, Coder sees files.** Different context shapes → different token counts. A 500-line file with a 10-line change sends 10 lines to the Reviewer, not 500. That's a 50× savings on Reviewer input tokens for typical edits.
3. **System prompts cached 1h per role.** Each agent has a frozen `.md` prompt loaded with `cache_control: ephemeral, ttl: 1h`. After the first call, repeat invocations pay ~10% of the prompt's input cost.

Plus the obvious correctness win: the Reviewer catches what the Coder missed, and the Planner catches what the Reviewer missed.

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

## Usage

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# Local dry run (no GitHub push, no sandbox). Safe default.
node dist/cli.js run "add retry logic to the API client with exponential backoff"

# Turn on GitHub push + PR + auto-merge (with human confirmation)
export GITHUB_TOKEN=ghp_...
node dist/cli.js run "<requirement>" --github --github-repo tonyandclaw/myrepo

# Turn on the Go sandbox wrapper for git/shell commands
node dist/cli.js run "<requirement>" --sandbox

# Scaffold .claw-squad/ in an existing repo
node dist/cli.js init
```

## User-facing requirements → where they live

| Your requirement | Implementation |
|---|---|
| Security mechanism, default off | `--sandbox` flag → `claw-sandbox` Go binary (rlimits + path validation + env scrubbing). Default: off. Also: hardcoded `.git/.env/.ssh` deny-list in TS applier is **always on** (not user-disableable). |
| Multi-agent review mechanism | `src/orchestrator.ts` — Planner Q&A then Coder ↔ Reviewer loop with bounded `maxReviewRounds`. Only approved diffs get merged. |
| Planner thinking + Q&A before dispatch | Planner uses `thinking: adaptive` + `effort: max`. Refuses to emit TODOs until its `planReady` phase. |
| Reviewer requests changes → Coder fixes → re-review | `runTaskLoop` in orchestrator. Reviewer's findings are passed back into Coder's next user turn as explicit fix items. |
| Approve PR and merge | Phase 2 — `src/github/octokit.ts` skeleton is in place; wiring into the approve branch is the next step. Right now approve just exits the task loop. |
| Loop back to Planner for TODO review | After each task, `runPlanner(..., mode: "loop")` is invoked with memory snippet + completed-task summary, and can revise the TODO list or emit `complete`. |
| Self-learning, default on | `src/memory/memory.ts` — appends lessons + patterns to `.claw-squad/memory/*.md` after every task. Planner reads the most recent 8 KB on each invocation. Disable with `--no-self-learning`. |

## Key design choices

- **Prompts live as Markdown files**, not template strings in TypeScript. This keeps the cached prefix byte-stable across runs and lets humans audit/edit prompts without a rebuild.
- **Coder never talks to git directly.** It produces a JSON list of file edits; the orchestrator writes them, runs `git add/commit`, and (if enabled) pushes. Keeps the security boundary clean and the agent trivially unit-testable.
- **Reviewer sees only the staged diff**, not any dirty files the user already had. Deterministic, smaller payload.
- **Token accountability**: every LLM call's usage is tallied; end-of-run summary shows input, output, cache reads, cache writes, and estimated cost.
- **Human-in-the-loop by default** for destructive GitHub actions (push, merge). Pass `--no-confirm` to automate.

## Models

| Role | Model | Effort | Why |
|---|---|---|---|
| Planner | `claude-opus-4-7` | `max` | Hardest reasoning — requirements + design live here |
| Coder | `claude-sonnet-4-6` | `high` | Fast, capable for implementation; most of the tokens flow here |
| Reviewer | `claude-opus-4-7` | `xhigh` | Skeptic work, benefits from strong reasoning but less than Planner |

Override by editing `src/types.ts` `DEFAULT_MODELS` or (future work) via a `--models` flag.

## What's wired vs. deferred

**Phase 1 (done):**
- Planner / Coder / Reviewer agents with cached prompts
- 3-agent orchestrator loop with bounded rounds
- Local file apply + git commit
- Path validation (always on) + Go sandbox (opt-in)
- Self-learning memory
- Interactive CLI with `prompts`
- Smoke tests (23 TS + 7 Go)

**Phase 2 (skeleton in place, wiring pending):**
- `src/github/octokit.ts` has `pushBranch` / `openPr` / `postReview` / `mergePr`.
- Next step is to call them from the `approve` branch of `runTaskLoop`.

## Testing

```bash
pnpm test         # 23 TS smoke tests (parsers, memory, path validation)
cd ../claw-sandbox && go test ./...   # 7 Go tests (path validation)
```

Neither hits the Claude API — API integration tests come in a follow-up.
