# Hybrid cloud / local routing (W10.10)

## When to use which role on which backend

The 3-agent loop is asymmetric in cost and IQ demand. A single design rule cuts the bill ~5× without a noticeable quality drop:

> **Send the smart, low-volume role to the cloud. Run the high-volume roles locally.**

Per-call IQ vs per-task call-volume across the three roles:

| Role | Calls per task | IQ ceiling needed | Best fit |
|---|---|---|---|
| **Planner** | 1–4 (Q&A + TODO list + per-loop replan) | High — must reason about the whole repo + decompose | **Cloud Sonnet / Opus** |
| **Coder** | `maxReviewRounds` per todo, often 1–2 | Medium — concrete edits with the diff already framed | **Local 32B coder model** |
| **Reviewer** | `maxReviewRounds` per todo, often 1–2 | Medium — see only the diff, not the world | **Local 7–14B fast model** |

Cloud Anthropic prompt cache covers the Planner cheaply (the system prompt is the same across the run). The Coder + Reviewer are where the per-task token bill compounds — they're also the roles where a 32B local model is "good enough" because the inputs are small (a single TODO, a single diff).

## Recipe

```bash
claw-squad run --preset hybrid "<requirement>"
```

The `hybrid` preset under `claw-squad/configs/hybrid.json` ships the layout above:

- Planner → `anthropic` / `claude-opus-4-7` / effort=max
- Coder → `ollama` / `qwen2.5-coder:32b` (localhost:11434)
- Reviewer → `ollama` / `qwen2.5:7b`

Layered like every other preset: project `config.json` and per-role CLI flags still win on top. Want a different local Coder? `--coder-model qwen2.5-coder:14b`. Want cloud Reviewer too for one run? `--reviewer-provider anthropic --reviewer-model claude-opus-4-7`.

## Cost math

Worked example for a 5-TODO run with 2 review rounds each:

| Mode | Planner calls | Coder calls | Reviewer calls | Approx Anthropic cost @ Apr 2026 list rates |
|---|---|---|---|---|
| All-cloud (`--preset` unset; default Anthropic) | 6 | 10 | 10 | $1.20 |
| Hybrid (`--preset hybrid`) | 6 | 0 | 0 | $0.30 |
| All-local (`--preset gx10`) | 0 | 0 | 0 | $0.00 (electricity only) |

The hybrid path lands at ~25% of all-cloud cost while keeping the role that benefits most from a frontier model on a frontier model. All-local is free per call but plan quality drops noticeably on harder tasks — the QwQ-32B planner is good, not Sonnet-good.

## What about cache?

Anthropic 1h prompt cache only fires on the cloud-served path. Hybrid keeps cache savings on the Planner (`cache_control: ephemeral` is preserved), so the second through Nth Planner call within an hour costs ~10% of the first. Local Coder/Reviewer have no comparable cache today; W10.4 (local prompt-result cache, content-hashed) is the planned counterpart.

## Failure modes

- **Local server cold start**: Ollama loads weights on first call. The Coder's first round of the day adds 5–30 s before tokens stream. Workaround: pre-warm with `ollama run qwen2.5-coder:32b ""` at boot.
- **Ollama OOM on a small box**: 32B models need ~24 GB RAM headroom. On hardware below that, swap the Coder for `--preset local-laptop` instead.
- **Cloud / local network split**: if the cloud Planner fires but the local Coder is unreachable, the orchestrator surfaces a `provider error` and the run snapshots to `state.json` — re-running with `--resume` picks up where it stopped.

## Migration from all-cloud

```bash
# Before (all roles on Anthropic)
claw-squad run "add retries to the API client"

# After (Planner on cloud, Coder + Reviewer local)
claw-squad run --preset hybrid "add retries to the API client"
```

No code change required — both forms accept the same `requirement`. The `hybrid` preset assumes Ollama at `localhost:11434/v1`; override `--coder-base-url` / `--reviewer-base-url` for vLLM / SGLang / a remote LAN server.
