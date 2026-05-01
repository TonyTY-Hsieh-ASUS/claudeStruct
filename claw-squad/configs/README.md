# claw-squad presets

Starting-point configurations shipped with the binary. Loaded via:

```bash
claw-squad run --preset <name> "<requirement>"
```

Layered **below** user config + CLI flags, so a preset is a starting
point, not a lock-in. Override any single role with the standard
`--<role>-provider` / `--<role>-model` flags.

## `local-gx10.json` — Asus GX10 (128 GB unified memory)

Optimised for the GX10 hardware target: enough memory to host
multiple large local models concurrently with Ollama serving as the
runtime.

| Role | Model | Why |
|---|---|---|
| Planner | `qwq:32b` | Strong chain-of-thought; handles requirements Q&A |
| Coder | `qwen2.5-coder:32b` | Purpose-built for code edits; the bulk of the per-task tokens |
| Reviewer | `qwen2.5:7b` | Diff is small; speed wins over IQ here |
| Subagent (`research-helper`) | `llama3.2:3b` | Latency-sensitive helper for the Planner |

All four pulled from `localhost:11434/v1` (Ollama default). Switch the
`baseURL` for vLLM / SGLang / llama-server.

Pull the models first:

```bash
ollama pull qwq:32b qwen2.5-coder:32b qwen2.5:7b llama3.2:3b
```

## `local-laptop.json` — Apple Silicon / mid-range x86 (32 GB)

Smaller models than the GX10 preset so all three roles fit in 32 GB
without swapping. Trade-off: Coder is 14B not 32B, so review rounds
may climb on complex tasks. Counterbalance with `--max-review-rounds 4`
in your run flags.

No subagents — the laptop budget can't comfortably host an extra
concurrent process while the Planner / Coder / Reviewer cycle.

## `hybrid.json` — cloud Planner + local Coder/Reviewer (W10.10)

The recipe that lands ~25 % of the all-cloud cost while keeping the
role that benefits most from a frontier model (Planner, asymmetric
IQ demand, low call volume) on cloud Anthropic. The high-volume
roles (Coder + Reviewer) run on local Ollama 32B / 7B.

Full rationale + cost math in [`docs/hybrid-routing.md`](../docs/hybrid-routing.md).

## Adding a preset

1. Drop a new JSON file here matching the same schema (`agents.{planner,coder,reviewer}` + optional `subagents`).
2. Add the name → filename entry to `PRESET_FILES` in `claw-squad/src/config.ts`.
3. Update the `--preset` flag's help string.

The schema is strict — unknown root keys are rejected — so don't put
inline doc strings (`_doc`, `_comment`) in the JSON. Document the
preset here in this README instead.
