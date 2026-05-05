# Service-Level Objectives (W8.7)

claudeStruct's hosted control plane publishes its SLOs at `GET /v1/slo`.
The endpoint is **unauthenticated** so an external status page can
scrape it without managing a service token. Output is aggregate (no run
IDs, no payloads, no per-tenant data) so leaving it open trades nothing
sensitive for operator convenience.

## Targets

| Metric                 | Target            | Source                                   |
|------------------------|-------------------|------------------------------------------|
| Run success rate       | **99.9%** monthly | `done / (done + failed)` over `runs`     |
| p95 run-start latency  | **< 5s**          | `started_at - created_at` of claimed runs |
| p95 run duration       | **< 10min**       | `duration_ms` of `done` runs (advisory)  |

Targets live as constants in `src/claudestruct/server/slo.py` so they
move under code review, not silently through a config table.

## Response shape

```json
{
  "generated_at": "2026-04-28T00:00:00Z",
  "targets": {
    "success_rate": 0.999,
    "p95_run_start_ms": 5000,
    "p95_duration_ms": 600000
  },
  "windows": [
    {
      "window": "24h",
      "total_runs": 142,
      "succeeded": 141,
      "failed": 1,
      "success_rate": 0.993,
      "error_rate": 0.007,
      "p50_run_start_ms": 230,
      "p95_run_start_ms": 1850,
      "p99_run_start_ms": 4200,
      "p50_duration_ms": 18500,
      "p95_duration_ms": 92000,
      "p99_duration_ms": 175000
    },
    { "window": "7d", "...": "..." },
    { "window": "30d", "...": "..." }
  ]
}
```

`null` percentiles signal an empty window — render "n/a", don't plot
zeros.

## What's measured (and what's not)

- **`success_rate`** — fraction of *terminal* runs (`done` + `failed`)
  whose status is `done`. Queued and running rows are excluded so they
  can't skew the number while the worker is mid-flight.
- **`p95_run_start_ms`** — queue wait + claim time, i.e. the latency a
  user *feels* between submitting a run and the worker starting it.
  Negative deltas (clock skew) clamp to 0 instead of poisoning the
  percentile.
- **`p95_duration_ms`** — execution time of successful runs only.
  Failed runs are excluded so a single crash can't drag the percentile.

What this **doesn't** measure:

- HTTP request latency for the API itself (no request-middleware
  instrumentation yet — would be a separate metric).
- Pure `/healthz` uptime — that needs an external prober. The success
  rate proxy is "did the worker complete the runs we claimed?", which
  is the closest authentic signal we can derive from current data.

## Status page wiring

A status page (statuspage.io, Cachet, custom) can scrape `/v1/slo` on a
1-minute interval and render trafic-light state per window. Suggested
mapping:

- Green if `success_rate ≥ targets.success_rate` and
  `p95_run_start_ms ≤ targets.p95_run_start_ms`
- Yellow if either metric breaches its target by < 2x
- Red otherwise

For composite uptime, fold the 24h window — it's the actionable signal.
The 7d/30d windows are for trend lines and post-mortems.

## Reopening

Out-of-scope for the current cut, tracked separately:

- Per-tenant SLO endpoint (auth-gated) so a customer can verify the
  fleet number applies to *their* runs.
- API request-latency metric (needs FastAPI middleware capturing
  per-route timings).
- Public incident timeline + status page hosting at
  `status.claudestruct.dev`.
