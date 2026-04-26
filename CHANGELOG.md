# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning 2.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Cumulative monthly cost cap** (W5.6): new `--monthly-cap-usd` flag (also `CLAUDESTRUCT_MONTHLY_CAP_USD`) on `cs dev/review/plan/debug`. Aggregates spend across `<root>/.claudestruct/runs/*.jsonl` for the current UTC calendar month; hard-aborts before any LLM call when spent ≥ cap, warns at 80%.
- Top-level `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- GitHub Actions CI matrix (`.github/workflows/ci.yml`) covering Python 3.10–3.13, Node 20/22, and Go 1.22.
- Multi-stage `Dockerfile` producing a single image with all three binaries (`cs`, `claw-squad`, `claw-sandbox`).
- Wave 4–8 commercialization roadmap in `TODO.md`.

## [0.3.0] — 2026-04-25 — Wave 3 finalize

### Added
- `cs dashboard` (and `--watch`) — folds JSONL run logs into a Rich-rendered overview with `--task` / `--json` / `--limit` filters.
- `cs metrics` — Prometheus textfile-collector exposition (counters + last-run gauges).
- `src/claudestruct/integrations/` — pre-commit hook + GitHub Action template + README for `cs review`.
- claw-squad: relevance-ranked cross-run memory (`readRelevantMemorySnippet`) with byte budget and stopword filtering.
- Per-task token budgets (`BUDGETS_PER_TASK`): review 200k, debug 400k, dev 600k, plan 800k.

### Changed
- Run logs auto-write to `<root>/.claudestruct/runs/<ts>.jsonl` via `MultiSink` / `fanout_log`, preserving the explicit `--log-json` mirror.

## [0.2.0] — 2026-04-24 — Wave 2 foundations

### Added
- Structured logging (`run.start` / `agent.usage` / `cache.warning` / `run.end`) via `--log-json` in both tools.
- API retry/timeout knobs delegated to SDKs (`CLAUDESTRUCT_TIMEOUT`, `CLAUDESTRUCT_MAX_RETRIES`, `CLAW_SQUAD_TIMEOUT`, `CLAW_SQUAD_MAX_RETRIES`).
- claw-squad config validation via zod (`src/config-schema.ts`); strict objects with field-path errors.
- Slack reconnect surfacing + Web UI client jittered exponential reconnect backoff.
- Architecture docs under `claw-squad/docs/`: agents, skills, hooks, providers.

## [0.1.0] — 2026-04-22 — Wave 1 quick wins

### Added
- Cache-hit-rate alarm: persistent `cache_state.json` plus claw-squad's silent-cache-invalidator detection.
- SIGINT handling that persists state through the orchestrator's `finally` block.
- claw-squad `--dry-run` heuristic estimator.
- Content-hash prompt versioning printed in usage output for traceability.
- `claw-sandbox` per-platform `[sandbox] {"event":"isolation",...}` capability report.

[Unreleased]: https://github.com/tonyandclaw/claudeStruct/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tonyandclaw/claudeStruct/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tonyandclaw/claudeStruct/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tonyandclaw/claudeStruct/releases/tag/v0.1.0
