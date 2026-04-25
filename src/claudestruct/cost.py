"""Minimal Anthropic cost estimator for claudestruct.

Keeps the rate table local to this tool — claudestruct is Anthropic-only,
so we don't drag in claw-squad's multi-provider registry. Mirroring the
shape of `claw-squad/src/providers/registry.ts` keeps both tools' logs
comparable: same units (USD), same arithmetic, same fields.

Rates are public list prices; they shift occasionally. Update here when
that happens. The CLI presents these as estimates, not invoices —
authoritative numbers live on the Anthropic console.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rate:
    input: float          # $/1M input tokens (uncached)
    output: float         # $/1M output tokens
    cache_read: float     # $/1M tokens served from cache
    cache_write: float    # $/1M tokens written to cache (1h TTL)


# Per-model $/1M rates. The default model `claude-opus-4-7` is the only
# entry callers should rely on hitting; anything unknown falls back to
# the opus rate, which over-estimates for cheaper models — preferable
# to silent under-counting.
_RATES: dict[str, Rate] = {
    "claude-opus-4-7": Rate(input=5.0, output=25.0, cache_read=0.5, cache_write=10.0),
    "claude-sonnet-4-6": Rate(input=3.0, output=15.0, cache_read=0.3, cache_write=6.0),
    "claude-haiku-4-5": Rate(input=1.0, output=5.0, cache_read=0.1, cache_write=2.0),
}

_FALLBACK = _RATES["claude-opus-4-7"]


def estimate_cost_usd(
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_creation_tokens: int,
) -> float:
    rate = _RATES.get(model, _FALLBACK)
    return (
        input_tokens / 1_000_000 * rate.input
        + output_tokens / 1_000_000 * rate.output
        + cache_read_tokens / 1_000_000 * rate.cache_read
        + cache_creation_tokens / 1_000_000 * rate.cache_write
    )
