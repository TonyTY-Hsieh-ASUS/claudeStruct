# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning 2.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Append-only hash-chained audit log** (W8.4): `src/claudestruct/server/audit.py` records every state-changing API call (`key.create` / `key.revoke` / `run.submit` / `billing.checkout.create`) as a per-org `AuditEntry` row whose `entry_hash` chains over `prev_hash` + canonical-JSON payload + identity fields. New `GET /v1/audit/head` (viewer+), `GET /v1/audit` (admin, paginated), `GET /v1/audit/verify` (admin) endpoints. `prune_audit()` enforces tier-driven retention (free=90d, paid=7y).
- **Billing & subscription skeleton** (W8.2): `src/claudestruct/server/billing.py` adds a `Subscription` model (`free`/`team`/`business` tier) with audit-retention map. New `/v1/billing/subscription` (viewer+), `/v1/billing/checkout` (admin), `/v1/billing/usage` (viewer+), `/v1/billing/webhook` (unauthenticated, signature-verified) endpoints. Stripe SDK is lazy-imported; the OSS path returns a deterministic stub Checkout URL and a 503 from the webhook with a clear "install stripe" message.
- **Hosted-deployment artifacts** (W8.1): `deploy/helm/claudestruct/` Helm chart (Deployment + Service + optional Ingress + Secret + helpers, strict pod securityContext) and `deploy/terraform/main.tf` (VPC + RDS Postgres 16 + security groups + Secrets Manager-managed master password). `deploy/README.md` documents install + roadmap mapping.
- **`claw-squad runs list / purge`** (W5.3 follow-up): TS-side retention pruning for `<root>/.claw-squad/runs/*.jsonl`. Same mtime-based semantics as `cs logs purge` so both tools' run-log retention stays in lockstep; `--dry-run` previews candidates without unlinking. New module `claw-squad/src/runs/purge.ts`.
- **claw-squad plugin SDK** (W7.4): `claw-squad/src/plugins.ts` exposes a `ClawSquadPlugin` contract plus auto-discovery of `node_modules/claudestruct-plugin-*` packages. Plugins contribute new subagents and skills (not core roles); apiVersion mismatches are skipped with a warning rather than crashing the host. Dedup is deterministic (first-wins).
- **claw-squad skills marketplace** (W7.3): `claw-squad/src/skills-registry.ts` plus `claw-squad skills list / install <idOrUrl> / uninstall <id>` subcommands. Manifest format (`id` + `version` + `url` + `sha256` + optional fields) with content-addressed integrity check on install. Default registry URL is `https://skills.claudestruct.dev/index.json`; `--registry` / `CLAW_SKILLS_REGISTRY` override; `file://` URLs supported for air-gapped use. Sidecar `<id>.md.manifest.json` keeps provenance inspectable.
- **Distribution channel templates** (W7.7): `packaging/homebrew/claudestruct.rb`, `packaging/scoop/claudestruct.json`, `packaging/aur/PKGBUILD`, `packaging/snap/snapcraft.yaml`, plus `packaging/README.md` with the manual publish flow until W4.3 release automation lands. `docs/install.md` lists every channel.

### Earlier additions
- **PII / secret redaction in run logs** (W5.3): new `src/claudestruct/redact.py` with default ruleset covering Anthropic / GitHub / Slack / Stripe tokens, AWS access keys, emails, and JWTs. Opt-in via `--redact` flag (or `CLAUDESTRUCT_REDACT` env) on `cs dev/review/plan/debug`. Custom rules via `Redactor.add_rule()`.
- **`cs logs purge --older-than-days N [--dry-run]`** (W5.3): mtime-based retention pruning for `<root>/.claudestruct/runs/*.jsonl`.
- **Pluggable secrets backend** (W5.4): `claudestruct.secrets` with `SecretsProvider` Protocol and built-in `env` / `keyring` / `pass` / `file` providers. Configure the chain via `CLAUDESTRUCT_SECRETS_PROVIDER=env,keyring,pass,file:/run/secrets`. Legacy `ANTHROPIC_API_KEY` env keeps working.
- **Ruff lint + coverage gate** (W5.7): `pyproject.toml` ships ruff config (F/E/W/I/B/UP/SIM) and a `coverage` floor of 70% (current run: 80%). CI runs `ruff check` then `coverage run -m pytest`.

### Added (earlier)
- **`cs serve` daemon-mode draft** (W6.2 + W6.3, behind `pip install 'claudestruct[server]'`): FastAPI HTTP API with `/healthz`, `/readyz`, `/v1/dashboard`, `/v1/budget`, `/v1/runs` (POST + GET), `/v1/keys` (list/create/revoke). OpenAPI 3.1 at `/openapi.json`. Multi-tenant SQLAlchemy schema (`orgs`, `users`, `memberships`, `api_keys`) with three roles (`admin`/`member`/`viewer`) enforced by a `require_role` dependency. Bearer-token auth uses `ck_<key_id>_<secret>` with SHA-256-hashed secrets. CLI bootstrap: `cs serve init-db / add-org / add-user / add-key / run`.
- **GitLab + Bitbucket CI templates** (W6.7): `src/claudestruct/integrations/gitlab-ci-cs-review.yml` and `bitbucket-pipelines-cs-review.yml` — drop-in pipelines that run `cs review` on every MR/PR and post the verdict as a comment via the platform-native API. Mirrors the existing GitHub Action shape.
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
