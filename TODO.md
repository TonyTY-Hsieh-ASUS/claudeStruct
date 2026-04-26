# claudeStruct Roadmap TODO

Tracks the wave-by-wave roadmap. Updated on every PR push.

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
🚧 **Wave 4** (Q1) — public release readiness
⏳ **Wave 5** (Q2) — production hardening
⏳ **Wave 6** (Q3a) — team collaboration
⏳ **Wave 7** (Q3b) — ecosystem & GTM
⏳ **Wave 8** (Q4) — hosted SaaS launch

The 1-3 roadmap is closed. Wave 4-8 below tracks the path to a "complete and commercializable" product. Target shape: **OSS dev tool + hosted SaaS (open core)**, **teams of 5-50 devs**, **~12 months**.

---

## Wave 4 — Public release readiness (Q1)

Goal: anyone can `pip install claudestruct` / `npm install claw-squad` / `docker run` and get a working, trustworthy tool. Today everything ships unsigned, untested-by-CI, undocumented past `claw-squad/docs/`.

- [x] **W4.1 — GitHub Actions CI matrix**
  - `.github/workflows/ci.yml` — pytest (3.10/3.11/3.12/3.13), vitest + tsc (Node 20/22), go test + go vet (1.22)
  - Concurrency group cancels superseded runs; pip/pnpm caches keyed off lockfiles
  - ruff lint deferred (pyproject.toml has no ruff config yet; tracked under W5)
- [~] **W4.2 — License + governance files**
  - `LICENSE` (MIT, matches `pyproject.toml` declared license) at repo root
  - `CONTRIBUTING.md`, `SECURITY.md` (vuln disclosure)
  - `CHANGELOG.md` (keepachangelog 1.1 format) seeded with Waves 1-3 history
  - `CODE_OF_CONDUCT.md` deferred — see note below
- [ ] **W4.3 — Release automation**
  - `.github/workflows/release.yml` — on tag `v*.*.*`: PyPI publish (trusted publishing/OIDC, no API token), npm publish for `claw-squad`, GitHub Release with cross-compiled `claw-sandbox` binaries (linux-amd64/arm64, darwin-amd64/arm64) + Sigstore provenance
  - `release-please` or `cz-cli` for conventional-commit-driven version bumps
  - Defers until repo-level PyPI / npm / GHCR trusted-publishing config is in place (manual step on the org settings)
- [x] **W4.4 — Container distribution**
  - Multi-stage `Dockerfile` (python-slim base, Go builder for sandbox, Node builder for claw-squad) → `ghcr.io/tonyandclaw/claudestruct:latest`
  - `.github/workflows/docker.yml` builds on every PR (verifies the Dockerfile) and pushes to GHCR on push to main + on tag, with PR/branch/sha tags via `docker/metadata-action`
  - SBOM (syft) + vuln scan (trivy) deferred to a follow-up PR alongside W4.3
- [x] **W4.5 — Docs site**
  - mkdocs-material wraps `claw-squad/docs/*.md` + the root README/CHANGELOG/CONTRIBUTING/SECURITY/TODO via `mkdocs-include-markdown-plugin` (single source of truth, no duplicated content)
  - `.github/workflows/docs.yml` builds on every PR (`mkdocs build --strict`) and deploys to GitHub Pages on push to main via `actions/deploy-pages@v4`
  - GH Pages must be enabled at the repo level (manual step) for the deploy job to land; build job runs unconditionally
- [~] **W4.6 — README polish + demo**
  - CI / Docs / License / Container badges added to the README header
  - Asciinema recording of `cs dev` and `claw-squad run` in action — pending (needs an env with API key)
  - Per-platform install (Homebrew, scoop, snap) tracked under W7.7

---

## Wave 5 — Production hardening (Q2)

Goal: trust this in CI pipelines and long-running daemons. Wave 4 makes it installable; Wave 5 makes it operable.

- [ ] **W5.1 — OpenTelemetry tracing**
  - claudestruct: `src/claudestruct/tracing.py` — span per task, child spans for context-gather and Claude invocation; OTLP exporter via `OTEL_EXPORTER_OTLP_ENDPOINT`
  - claw-squad: `src/tracing.ts` — spans across Planner→Coder→Reviewer with correlation IDs flowing into `runs/log.ts` events
  - Reuse: existing `logging.py` event sink, `runs/log.ts` `RunLogHandle`
- [ ] **W5.2 — Error reporting (Sentry)**
  - Opt-in via `CLAUDESTRUCT_SENTRY_DSN` / `CLAW_SQUAD_SENTRY_DSN`
  - Redact `ANTHROPIC_API_KEY`, `SLACK_*_TOKEN`, `GITHUB_TOKEN` in event capture (before-send hook)
- [ ] **W5.3 — PII redaction + retention**
  - Pluggable redactor pipeline (regex set: emails, phones, AWS/GCP keys, JWT-shaped tokens) applied to log events at write time
  - `cs logs purge --older-than 30d` and `claw-squad runs purge` subcommands
  - Configurable retention policy in `.claudestruct/config.json` and `.claw-squad/config.json`
- [ ] **W5.4 — Secrets vault integration**
  - `SecretsProvider` abstraction in both codebases; built-in providers: `env` (default), `keyring` (OS keychain), `pass` (Unix), AWS Secrets Manager, HashiCorp Vault
  - Replace direct `os.environ["ANTHROPIC_API_KEY"]` reads with `secrets.get("anthropic.api_key")`
- [ ] **W5.5 — Hardened sandbox**
  - Linux seccomp profile (`claw-sandbox/seccomp.json`) blocking `ptrace`, `kexec_*`, `mount`, etc.
  - AppArmor profile sample
  - Network-namespace isolation when CAP_SYS_ADMIN available; auto-detect + warn otherwise
  - Documented Docker / firejail recipes
- [x] **W5.6 — Cumulative cost cap**
  - `src/claudestruct/budget.py` — `current_period_spend(root)` folds `<root>/.claudestruct/runs/*.jsonl` for the current UTC calendar month; `check_budget(root, cap)` returns `BudgetStatus(spent, cap, warn_threshold, exceeded, near_limit)` with `WARN_FRACTION = 0.8`
  - CLI: new `--monthly-cap-usd <float>` flag on `cs dev/review/plan/debug` (also reads `CLAUDESTRUCT_MONTHLY_CAP_USD`); hard-aborts (`exit 2`) before any LLM call when `spent ≥ cap`, soft-warns when `spent ≥ 0.8 × cap`. Skipped on `--dry-run`.
  - Tests: `tests/test_budget.py` (11 cases) — month bounds incl. December roll-over, period filtering, naive ISO timestamps, exact-threshold semantics, `cap=0` disables check, malformed run skipped
- [ ] **W5.7 — Test rigor**
  - End-to-end tests with mocked Anthropic SDK (no real API calls)
  - Mutation testing: `mutmut` (Python), `stryker` (TS); coverage gate at 80% in CI

---

## Wave 6 — Team collaboration (Q3a)

Goal: 5-50 devs share the tool with shared visibility, shared budgets, and team-level admin. Today the orchestrator and dashboard are single-user-on-this-machine.

- [ ] **W6.1 — Daemon mode**
  - `cs serve` and `claw-squad serve` long-running supervisor
  - Postgres backend (default for >1 user), SQLite single-file fallback for tiny teams
  - Stateless workers can scale horizontally; state lives in DB, not local JSONL
- [ ] **W6.2 — HTTP REST API**
  - Mirrors CLI: `POST /v1/runs`, `GET /v1/runs/:id`, `GET /v1/dashboard`, `GET /healthz`, `GET /metrics`
  - OpenAPI 3.1 spec auto-generated; SDK stubs for Python + TS
  - Auth: API keys (long-lived, rotatable) + session cookies (browser)
- [ ] **W6.3 — User / team / org model + RBAC**
  - Postgres schema: `orgs`, `teams`, `users`, `memberships`, `roles` (admin/member/viewer)
  - Migration tool (`alembic` for Python side, `drizzle` for TS side) with seeded fixtures
- [ ] **W6.4 — OAuth login**
  - GitHub + Google login for the daemon's web UI
  - Reuse existing `claw-squad/src/ui/web.ts` + `web-page.ts` page; swap token-in-URL for cookie session
- [ ] **W6.5 — Shared dashboard**
  - Multi-user view of recent runs, per-team budget rollups, cost-per-author leaderboard
  - Regression alerts: "run cost is >2σ over team baseline" → Slack/email
  - Extends `src/claudestruct/dashboard.py` with team-scoped queries
- [ ] **W6.6 — GitHub App**
  - Replaces personal-token usage; per-org installation; opens PRs as `claudeStruct[bot]`
  - Webhook-triggered runs (`pull_request`, `issue_comment` with `/cs review`)
- [x] **W6.7 — GitLab + Bitbucket integrations**
  - `src/claudestruct/integrations/gitlab-ci-cs-review.yml` — MR-triggered job, posts verdict via GitLab Notes API using `CI_JOB_TOKEN`. Honors `ANTHROPIC_API_KEY` + optional `CLAUDESTRUCT_MONTHLY_CAP_USD`.
  - `src/claudestruct/integrations/bitbucket-pipelines-cs-review.yml` — `pull-requests."**"` step, posts via Bitbucket 2.0 Comments API using `BITBUCKET_USER` + `BITBUCKET_APP_PASSWORD`.
  - `integrations/README.md` documents the install / env-var setup for both, plus a "common knobs" section covering `--max-bytes` + `CLAUDESTRUCT_MONTHLY_CAP_USD` across all three templates.

---

## Wave 7 — Ecosystem & GTM (Q3b)

Goal: distribution. Make the product discoverable, easy to install, and easy to extend.

- [ ] **W7.1 — VS Code extension**
  - Surfaces `cs review` on the diff in SCM gutter; `cs dev`/`cs debug` in command palette
  - Uses daemon REST API when available, falls back to local CLI
  - Published to VS Marketplace + Open VSX
- [ ] **W7.2 — JetBrains plugin**
  - Same surface for IntelliJ / PyCharm / WebStorm; tool window for run history
  - Published to JetBrains Marketplace
- [ ] **W7.3 — Skills marketplace**
  - Content-addressed registry (`skill@v1.2.0` hash-pinned references)
  - Cosign-signed skill packages; `claw-squad skills install <id>`
  - Site at `skills.claudestruct.dev`
- [ ] **W7.4 — Plugin SDK for new agents**
  - Published TS types + decorator API
  - Auto-discovery of `claudestruct-plugin-*` npm packages and `claudestruct-plugin-*` PyPI packages
  - Reuses existing `claw-squad/docs/agents.md` contract
- [ ] **W7.5 — Public playground**
  - `playground.claudestruct.dev` with read-only sample runs, no key required
  - Limited to a 10k-token-per-day shared bucket; rate-limited per IP
- [ ] **W7.6 — Marketing + docs site upgrade**
  - Landing page, pricing page, demo videos, case studies
  - Algolia DocSearch; analytics via Plausible (privacy-friendly)
- [ ] **W7.7 — Distribution channels**
  - Homebrew tap (`brew install tonyandclaw/tap/claudestruct`)
  - Scoop bucket (Windows), AUR (Arch), Snap (Ubuntu)
  - Auto-published on tag

---

## Wave 8 — Hosted SaaS launch (Q4)

Goal: a managed service teams pay for. Open-core split: Waves 4-7 OSS, Wave 8 hosted layer (closed-source or AGPL with separate hosted offering).

- [ ] **W8.1 — Multi-tenant infrastructure**
  - Postgres-per-region (US, EU); each tenant gets a logical schema
  - Redis for ephemeral state; deployed via Helm chart on EKS/GKE
  - Terraform module for self-host evaluators
- [ ] **W8.2 — Billing & subscription**
  - Stripe integration; usage-based pricing (per million tokens) + flat seat tier
  - In-app billing page; invoice PDFs via Stripe-hosted receipts
  - Free tier: 100k tokens/month for solo accounts
- [ ] **W8.3 — Tenant-scoped sandbox**
  - One Docker container per orchestrator-run; image is the published `ghcr.io/tonyandclaw/claudestruct` from W4.4
  - Resource quotas (CPU, memory) enforced per-tier
- [ ] **W8.4 — Append-only hash-chained audit log**
  - Every state-changing API call writes to an audit table
  - Chain-root hash exposed via API for tamper-evidence verification
  - Retention: 7 years for paid, 90 days for free
- [ ] **W8.5 — Data residency**
  - `claudestruct.cloud` resolves to nearest region; org settings can pin storage region
  - Provable via API-returned region tag in every response
- [ ] **W8.6 — Customer-managed encryption keys (CMEK)**
  - Optional BYOK via AWS KMS / GCP KMS; per-tenant DEK encrypted with customer KEK
- [ ] **W8.7 — Status page + SLO dashboard**
  - `status.claudestruct.dev` (statuspage.io or self-hosted Cachet)
  - SLOs: 99.9% monthly uptime, p95 API latency < 500ms, p95 run-start latency < 5s
  - Public incident timeline

---

## Optional Wave 9 — Enterprise top-up (deferred until Wave 8 lands enterprise contracts)

- SAML 2.0 SSO (Okta, Azure AD)
- SCIM 2.0 user provisioning
- Tenant-isolated VPC peering
- SOC2 Type II prep (gap analysis once Wave 5+8 controls are in place)
- HIPAA-eligible deployment
- Air-gapped self-hosted edition (Helm chart for fully-isolated installs)

Reopen criterion: a signed enterprise contract or three serious leads asking for any item above.

---

## Last Update

- 2026-04-26 — Wave 4 in flight on PR [#17](https://github.com/tonyandclaw/claudeStruct/pull/17):
  - W4.1 ✅ CI matrix landed
  - W4.2 ~ governance docs (LICENSE, CHANGELOG, CONTRIBUTING, SECURITY); CODE_OF_CONDUCT.md deferred (the standard Contributor Covenant 2.1 text trips Anthropic's output-content filter when generated inline; will be added manually from the upstream copy)
  - W4.4 ✅ Dockerfile + GHCR publish workflow
  - W4.5 ✅ mkdocs-material site + GH Pages deploy workflow
  - W4.6 ~ README badges in; asciinema recording pending
- 2026-04-25 — Waves 1-3 closed (PRs #11, #13, #14, #15, #16 merged). Wave 4-8 commercialization roadmap added.
