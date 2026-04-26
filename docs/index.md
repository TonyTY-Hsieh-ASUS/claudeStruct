# claudeStruct

**Token-efficient Claude companion for Claude Code workflows.**

Three tools, one philosophy: cache aggressively, send the minimum useful
context, and surface where the prompt is leaking.

## What's in the box

[**`cs` (claudestruct)**](cs.md) — Python CLI for one-shot Claude calls with
smart, git-aware context gathering. Four task types: `dev`, `review`, `plan`,
`debug`.

[**`claw-squad`**](claw-squad.md) — TypeScript orchestrator that runs three
agents (Planner → Coder → Reviewer) over eight model providers, with
rollback, multi-repo, and remote UIs (Slack, Web).

[**`claw-sandbox`**](https://github.com/tonyandclaw/claudeStruct/tree/main/claw-sandbox)
— Go binary that wraps subprocesses with rlimits, path validation, and env
scrubbing. Defense-in-depth, not a VM.

## Why prompt caching matters

Every byte you change in the system prompt invalidates the cache prefix and
turns a 9× cost reduction into a full-price call. Both tools mark their
system prompts with `cache_control: ephemeral` (1h TTL) and content-hash
their prompt versions so a silent invalidation surfaces in the run summary.

See [the cs guide](cs.md) for the rules.

## Project status

Waves 1–3 are closed (foundations, observability, advanced capabilities).
Wave 4–8 [roadmap](roadmap.md) covers public release readiness, production
hardening, team collaboration, ecosystem & GTM, and a hosted SaaS launch.

## Where to start

- New to the tools? [Install](install.md), then run `cs dev "your task"`.
- Operating it for a team? Skim the [integrations](integrations.md) and the
  W6 entries in the [roadmap](roadmap.md).
- Want to contribute? [Contributing guide](contributing.md).
- Found a vulnerability? [Security policy](security.md).
