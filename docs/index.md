# claudeStruct

[![CI](https://github.com/tonyandclaw/claudeStruct/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyandclaw/claudeStruct/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/tonyandclaw/claudeStruct/blob/main/LICENSE)
[![Python 3.10–3.13](https://img.shields.io/badge/python-3.10–3.13-3776AB?logo=python&logoColor=white)](install.md)
[![Container](https://img.shields.io/badge/ghcr.io-claudestruct-2496ED?logo=docker)](https://github.com/tonyandclaw/claudeStruct/pkgs/container/claudestruct)

**Token-efficient Claude Code companion — local-first, prompt-cache-aware,
provider-agnostic.**

Three CLI tools and a daemon-mode HTTP API, designed around one
philosophy: **cache aggressively, send the minimum useful context, and
make every cache miss visible.** Open-source MIT; the same code drives
the (optional) hosted SaaS.

---

## Pick your path

=== "Solo developer (5 min)"

    ```bash
    pip install claudestruct
    export ANTHROPIC_API_KEY=sk-ant-...
    cs review                     # diff against main, structured findings
    cs dev "add retry to client.py"
    ```

    See [the cs guide](cs.md) for the full task surface.

=== "Team (1 day)"

    Run the daemon, wire in a GitHub App webhook, dashboards, and
    cost-regression alerts:

    ```bash
    pip install 'claudestruct[server]'
    cs serve init-db
    cs serve run --port 8787
    ```

    Multi-tenant orgs / users / API keys, audit log, billing skeleton —
    see [server.md](server.md) and [home-server.md](home-server.md).

=== "GX10 / local-only (1 day)"

    Zero per-token cost on an Asus GX10 (or any always-on Linux box):

    ```bash
    pip install 'claudestruct[openai,smart-context,voice]'
    ollama pull qwen2.5-coder:32b nomic-embed-text
    export CLAUDESTRUCT_PROVIDER=openai
    export CLAUDESTRUCT_BASE_URL=http://localhost:11434/v1
    cs index build && cs review --smart-context "..."
    ```

    See [smart-context.md](smart-context.md) and the [hybrid routing
    recipe](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/docs/hybrid-routing.md).

---

## What ships in the box

| Tool                        | Language    | What it does                                                                                              |
|-----------------------------|-------------|-----------------------------------------------------------------------------------------------------------|
| **`cs` (claudestruct)**     | Python CLI  | One-shot Claude calls with smart, git-aware context. Four tasks: `dev` / `review` / `plan` / `debug`.     |
| **`claw-squad`**            | TypeScript  | Planner → Coder → Reviewer multi-agent orchestrator. 8 model providers, rollback, multi-repo, Slack/Web. |
| **`claw-sandbox`**          | Go binary   | rlimits + path validation + env scrub + (Linux+root) real `CLONE_NEWNET` isolation.                       |
| **`cs serve`**              | FastAPI     | Multi-tenant HTTP API: orgs / users / API keys / audit log / billing / SLO endpoint / GitHub App.         |
| **`cs mcp` / `claw-squad mcp`** | MCP stdio | Expose every task as a tool to Claude Code or any MCP client.                                             |

Plus on the same install:

- **`cs index` + `--smart-context`** — local embedding index for top-K
  file selection on large monorepos. ([docs](smart-context.md))
- **`cs voice`** — local Whisper STT for hands-busy queries. ([docs](voice.md))
- **`cs dataset export`** — mine your own run logs for LoRA fine-tuning. ([docs](dataset-export.md))
- **`cs dashboard / metrics`** — Rich + Prometheus views.

---

## Provider matrix

Pick cloud Anthropic, cloud OpenAI, or any OpenAI-compatible local
server:

| Provider                 | `cs` (CLI) | `claw-squad` | Notes                                              |
|--------------------------|:----------:|:------------:|----------------------------------------------------|
| Anthropic (Sonnet, Opus, Haiku) | ✅ default | ✅           | Server-side prompt cache + ephemeral 1 h TTL.       |
| OpenAI (gpt-4o, gpt-4.1) | ✅         | ✅           | Set `CLAUDESTRUCT_PROVIDER=openai` + `_BASE_URL`.   |
| Ollama / vLLM / SGLang   | ✅         | ✅           | OpenAI-compat wire format; zero per-token cost.     |
| llama.cpp `server`       | ✅         | ✅           | Same wire format.                                   |
| Bedrock                  | —          | ✅           | claw-squad routes through the AWS SDK.              |
| Vertex AI                | —          | ✅           | Same.                                               |
| Gemini / MiniMax         | —          | ✅           | Direct provider integrations.                       |

The
[`hybrid`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/configs/hybrid.json)
preset runs Planner on cloud Sonnet (asymmetric IQ demand + low call
volume + prompt-cache savings) and Coder + Reviewer on local Ollama
(high call volume, lower IQ ceiling) — about **25 % of all-cloud
spend** on a typical multi-TODO run. See the [routing
guide](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/docs/hybrid-routing.md)
for the cost math.

---

## Why prompt caching matters

Anthropic charges roughly **10× less for cache reads than fresh
input**. Every byte that changes in the system prompt invalidates
the entire prefix and turns a 9× cost reduction into a full-price
call.

Both tools mark their system prompts with `cache_control: ephemeral`
(1 h TTL) and **content-hash their prompt versions** so a silent
invalidation surfaces in the run summary. The W6.5 cost-regression
alerter watches the rolling cache hit-rate and warns when a release
breaks the contract.

See [the cs guide](cs.md) for the rules and
[smart-context.md](smart-context.md) for what we send *after* the
cached prefix.

---

## Try it

- 🛝 **[Playground](playground.md)** — pre-recorded `cs review` output
  on a real PR. Read the verdict shape without burning an API call.
- 📦 [Install](install.md) — pip / Docker / Homebrew / scoop / AUR / snap.
- 📖 [Full CLI reference](cs.md).

---

## Project status

[![Roadmap](https://img.shields.io/badge/roadmap-W1–W10-7E57C2)](roadmap.md)

Waves 1–10 are largely closed (foundations → observability → advanced
capabilities → public release readiness → production hardening → team
collaboration → ecosystem & GTM → hosted SaaS skeleton → GX10 / local
inference → smart-context + voice + dataset export). The
[roadmap](roadmap.md) tracks the residual partials — mostly external
blockers (Stripe live keys, IDE marketplace publishing, hosted
playground hosting).

700+ tests across Python / TypeScript / Go. CI runs Python 3.10–3.13,
Node 20/22, Go 1.22 on every PR.

---

## Where to start

| If you're … | Start here |
|---|---|
| New to the tools | [Install](install.md) → [`cs` guide](cs.md) → run `cs dev "your task"` |
| Operating it for a team | [Server](server.md) → [Home-server deploy](home-server.md) → [Audit log](audit.md) |
| Running it on GX10 / local | [Smart-context](smart-context.md) → [Voice REPL](voice.md) → [Hybrid routing](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/docs/hybrid-routing.md) |
| Contributing | [Contributing guide](contributing.md) |
| Reporting a vulnerability | [Security policy](security.md) |
