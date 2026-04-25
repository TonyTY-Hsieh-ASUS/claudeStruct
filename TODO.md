# claudeStruct Roadmap TODO

Tracks progress against the [improve-crispy-moore roadmap](~/.claude/plans/improve-crispy-moore.md). Updated on every PR push.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done

---

## Wave 1 — Quick Wins

- [x] **W1.1 — Cache hit rate alarm** (B4)
  - claudestruct: `src/claudestruct/cache_state.py` persists `(task, model, prompt_hash)` → write timestamp under `~/.claudestruct/cache_state.json`; CLI surfaces a `[warning]` line when the next call within TTL reads 0 cached tokens
  - claw-squad: `isSilentCacheInvalidator` in `claw-squad/src/totals.ts` already wired into `printSummary` (cli.ts:577)
  - Tests: `tests/test_cache_state.py` (7 cases)
- [x] **W1.2 — Ctrl+C / cancellation handling** (A2)
  - `claw-squad/src/abort-signal.ts` wraps the UI: 1st SIGINT → existing `onQuit` → `persistState` runs in orchestrator's `finally`; 2nd SIGINT → exit 130
  - Wired in `claw-squad/src/cli.ts` around `runOrchestrator`
  - Tests: `claw-squad/tests/abort-signal.test.ts` (5 cases)
- [x] **W1.3 — claw-squad `--dry-run`** (C1)
  - `claw-squad/src/dry-run.ts` heuristic estimator (per-todo Coder + Reviewer with avg token sizes × `min(maxReviewRounds, 1.3)`)
  - Orchestrator short-circuits after Phase 2 with `reason: "dry_run"`
  - CLI flag wired; `dry_run` exits 0
  - Tests: `claw-squad/tests/dry-run.test.ts` (9 cases)
- [x] **W1.4 — Prompt versioning** (C4)
  - Content-hash auto-versioning (sha256 prefix) — no human bumping required
  - claudestruct: `prompt_version()` + `TASK_PROMPT_VERSIONS` in `src/claudestruct/prompts.py`; CLI prints `prompt: dev v=abc12345`
  - claw-squad: `loadPromptVersion()` in `src/prompts.ts`; printed in `printSummary` for all 3 roles
  - Tests: `tests/test_prompts.py` (4 cases) + `claw-squad/tests/prompts.test.ts` (4 cases)
- [x] **W1.5 — Sandbox isolation transparency** (A4)
  - `claw-sandbox/isolation_report.go` emits one structured JSON line on every run: `[sandbox] {"event":"isolation","platform":"darwin","rlimitCpu":"unsupported",...}`
  - Platform-specific `isolationCapabilities()` in `rlimit_linux.go` / `rlimit_other.go`
  - `claw-squad/README.md` documents per-platform caveats (Linux: rlimits enforced, no-network unsupported; macOS/other: most controls unsupported, defense-in-depth only)
  - Tests: `claw-sandbox/isolation_report_test.go` (4 cases) — needs Go toolchain to run

### Wave 1 verification

| Suite | Result |
|---|---|
| `pytest tests/test_cache_state.py tests/test_prompts.py` | 11 passed |
| `npx vitest run` (claw-squad) | 220 passed (22 files) |
| `npx tsc --noEmit` | clean |
| `go test ./claw-sandbox/...` | not run locally (no Go); expected to pass on CI |

---

## Wave 2 — Foundations

- [x] **W2.1 — Structured logging** (B1) ⚓ basis for B2/B3/D1
  - claudestruct: `src/claudestruct/logging.py` event sink (run.start / agent.usage / cache.warning / run.end), `src/claudestruct/cost.py` Anthropic rate table; new `--log-json <path>` flag
  - claw-squad: `RunLogHandle.mirrorPath` extends `src/runs/log.ts`; `RunConfig.logJsonPath` threaded through orchestrator; new `--log-json <path>` CLI flag
  - Tests: `tests/test_logging.py` (8 cases) + `claw-squad/tests/runs.test.ts` (+2 cases for mirror)
- [x] **W2.2 — API retry + timeout** (A1)
  - claudestruct: `_env_float` / `_env_int` helpers; `anthropic.Anthropic(timeout=, max_retries=)` with `CLAUDESTRUCT_TIMEOUT` / `CLAUDESTRUCT_MAX_RETRIES` env-var overrides (defaults 300s / 3)
  - claw-squad: `src/providers/transport.ts` with `CLAW_SQUAD_TIMEOUT` / `CLAW_SQUAD_MAX_RETRIES`; both Anthropic and OpenAI-compat clients now pass `timeout`/`maxRetries` to their SDKs
  - Tests: `tests/test_client_env.py` (6 cases) + `claw-squad/tests/transport.test.ts` (5 cases)
- [x] **W2.3 — Unified config schema + validation** (C3)
  - `claw-squad/src/config-schema.ts` with zod schemas for the full `.claw-squad/config.json` shape (strict objects → unknown-field rejection; field-path errors like `agents.planner.effort`)
  - Hooked into `readConfigFile` so the file is gated before merge
  - Added zod ^3.25 to package.json
  - Tests: `claw-squad/tests/config-schema.test.ts` (9 cases)
- [x] **W2.4 — Slack / Web UI reconnect** (A3)
  - Slack Socket Mode: subscribe to SDK `disconnected` / `reconnecting` / `connected` events; expose `onConnectionState(fn)` on `SocketReplyStrategy`; `slack.ts` posts `:warning: lost socket — reconnecting…` and `:white_check_mark: reconnected` to the channel
  - Web UI: client-side reconnect now uses jittered exponential backoff capped at 30s with retry counter shown in the connection banner
  - Tests: `tests/slack-socket.test.ts` (+3 cases for connection state)
- [x] **W2.5 — Architecture / contributor docs** (C2)
  - `CLAUDE.md` at repo root: layout + how to run + key conventions
  - `claw-squad/docs/agents.md` — orchestrator state machine diagram, agent contract, UI seam, adding a new agent role
  - `claw-squad/docs/skills.md` — skill format, two activation paths (Planner-tagged vs `apply_to`), authoring tips
  - `claw-squad/docs/hooks.md` — lifecycle hooks surface, `HookAbort`, recipes
  - `claw-squad/docs/providers.md` — adding a new provider (OpenAI-compat path vs new client class)

### Wave 2 verification

| Suite | Result |
|---|---|
| `pytest tests/` (Python) | 25 passed (cache_state + prompts + logging + client_env) |
| `npx vitest run` (claw-squad) | 239 passed (24 files; +19 new tests) |
| `npx tsc --noEmit` | clean |

---

## Wave 3 — Advanced Capabilities

- [x] **W3.1 — claudestruct dashboard parity** (B3)
  - `src/claudestruct/dashboard.py` folds JSONL events into `RunSummary`; new `cs dashboard` subcommand renders a Rich table with `--task` / `--json` / `--limit` filters
  - Run logs now auto-write to `<root>/.claudestruct/runs/<ts>.jsonl` via the new `MultiSink` / `fanout_log` helpers in `logging.py` (preserves the `--log-json` mirror)
  - Tests: `tests/test_dashboard.py` (7 cases) — round-trips writer → reader, malformed-line skipping, `--task` / `--since` filters, JSON shape parity
- [x] **W3.2 — Per-task token budget tuning** (D4)
  - `BUDGETS_PER_TASK` in `src/claudestruct/context.py`: review 200k, dev 600k (=`DEFAULT_MAX_TOTAL_BYTES`), debug 400k, plan 800k
  - Each gatherer now defaults to its task-specific budget; CLI flag `--max-bytes` overrides
  - Tests: `tests/test_budgets.py` (5 cases) — pins per-task ordering and unknown-task fallback
- [x] **W3.3 — Cross-run agent memory v2** (D2)
  - Verified: `src/memory/memory.ts` already wired (Planner reads tail before each run, lessons accumulate after each task) — base behavior was working
  - Added `readRelevantMemorySnippet(repoRoot, query, budgetBytes?)`: keyword-overlap scoring (stopword-filtered, ≥3-char tokens) over per-lesson blocks; selects highest-scoring lessons within budget, falls back to chronological tail when query/lessons empty or all-zero scores
  - Orchestrator now passes `requirement` as the query at all three Planner call sites
  - Tests: `claw-squad/tests/memory.test.ts` (+5 cases for ranking, fallback, byte budget, stopword filtering)
- [x] **W3.4 — Metrics export (Prometheus text format)** (B2)
  - Chose Prometheus textfile collector over OTel SDK to keep the dep footprint at zero
  - `src/claudestruct/metrics.py` aggregates `<root>/.claudestruct/runs/*.jsonl` into Prometheus exposition: `claudestruct_runs_total`, `claudestruct_tokens_total{direction}`, `claudestruct_cost_usd_total`, `claudestruct_cache_warnings_total`, plus `claudestruct_last_run_*` gauges
  - New `cs metrics [--out <path>]` subcommand; suitable for node_exporter's textfile collector via cron
  - Tests: `tests/test_metrics.py` (6 cases) — counter sums, last-run gauges, label escaping, format-grammar regex
- [x] **W3.5 — Pre-commit / GitHub Actions integration** (D1)
  - `src/claudestruct/integrations/pre-commit-cs-review.sh` — staged-diff hook with diff-size cap, `CS_HOOK=0` bypass, critical-finding gating via `CS_HOOK_BLOCK`
  - `src/claudestruct/integrations/github-action-cs-review.yml` — drop-in workflow that runs `cs review` on PRs and posts verdict as a comment
  - `src/claudestruct/integrations/README.md` — install + env-var reference
- [~] **W3.6 — Incremental context shrinking** (D3) — DEFERRED
  - **Status**: explicitly deferred per the original plan ("先量化收益再決定是否做")
  - **Why**: Anthropic's 1h prompt cache already covers the common path. The marginal value of a hand-rolled file-hash cache only kicks in when (a) cache TTL has expired (>1h between calls) AND (b) files actually haven't changed. We don't yet have telemetry showing this case is hot.
  - **Reopen criteria**: when the dashboard (`cs dashboard --json`) or the metrics export (`cs metrics`) shows >1h-elapsed call patterns dominating spend, revisit with concrete numbers.
- [~] **W3.7 — Multi-repo conflict resolution** (D5) — DEFERRED
  - **Status**: explicitly deferred per the original plan ("建議在前 6 項做完、有真實 multi-repo 使用 case 之後再 design")
  - **Why**: cross-repo TODO routing already works (Planner tags `repoAlias`; orchestrator dispatches to the right `RepoCtx`). Conflict-resolution semantics — what to do when a TODO in repo A and a TODO in repo B both modify a shared API contract — depend on workflow conventions that vary per team. Designing without a real reproducer risks shipping the wrong abstraction.
  - **Reopen criteria**: a concrete failure mode observed in production multi-repo runs, with the desired resolution behavior named.

### Wave 3 verification (cumulative)

| Suite | Result |
|---|---|
| `pytest tests/` (Python) | 51 passed (+6 new for metrics) |
| `npx vitest run` (claw-squad) | 254 passed (+6 new for memory v2) |
| `npx tsc --noEmit` | clean |

---

## Roadmap status

✅ **Wave 1** (5/5) — quick wins
✅ **Wave 2** (5/5) — foundations
✅ **Wave 3** (5/7 done; 2 explicitly deferred with reopen criteria)

The roadmap is closed. Future work tracks against new asks rather than this file.

---

## Last Update

- 2026-04-25 — All actionable roadmap items shipped:
  - Wave 1 via [#11](https://github.com/tonyandclaw/claudeStruct/pull/11) (merged)
  - Wave 2 via [#13](https://github.com/tonyandclaw/claudeStruct/pull/13) (merged)
  - Wave 3 part 1 (W3.1, W3.2, W3.5) via [#14](https://github.com/tonyandclaw/claudeStruct/pull/14) (merged)
  - Wave 3 part 2 (W3.3, W3.4) via [#15](https://github.com/tonyandclaw/claudeStruct/pull/15) (merged)
  - Final cleanup (`cs dashboard --watch`, `.gitignore`, roadmap closeout) ready for PR push
