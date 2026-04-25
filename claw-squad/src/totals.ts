/**
 * Per-role token/cost accounting.
 *
 * Before PR-1 (squad-observability) the orchestrator accumulated a flat
 * record of input/output/cache/cost across all agents. That was fine for
 * a single "total spend" line but obscured:
 *   - which agent is burning the budget
 *   - whether prompt caching is actually landing
 *   - how Planner vs Coder vs Reviewer weights shift run to run
 *
 * This module owns the shape and the update primitives. The orchestrator
 * calls `addUsage(totals, role, usage)` once per LLM call; consumers
 * (CLI summary, TUI header, cost dashboard) read the structured totals.
 */

import { ROLE_BUCKETS, type RoleBucket } from "./types.js";
import { estimateCost, cacheSavings } from "./providers/registry.js";
import type { InvokeResult } from "./providers/types.js";

export interface RoleTotals {
  /** Billable input tokens (uncached, never cache-read/write). */
  inputTokens: number;
  outputTokens: number;
  /** Served from cache — we pay ~10% of input rate. */
  cacheReadTokens: number;
  /** Written to cache — we pay 1.25x or 2x input rate. */
  cacheCreationTokens: number;
  /** Estimated USD — sum of per-call estimateCost(). */
  costUsd: number;
  /** Estimated savings vs. a no-cache baseline. Non-zero for Anthropic. */
  cacheSavedUsd: number;
  /** Count of LLM invocations that hit this bucket. */
  calls: number;
  /**
   * How many of those calls were against Anthropic. Used by the CLI to
   * warn about a silent-cache-invalidator when Anthropic calls exist
   * but cacheReadTokens stays at zero.
   */
  anthropicCalls: number;
}

export interface RunTotals {
  perRole: Record<RoleBucket, RoleTotals>;
  /**
   * Per-named-subagent totals. Subagent calls also accumulate under
   * `perRole.subagent` (the catch-all bucket from PR-1) and under
   * `overall`, so this is purely additional detail — readers that
   * don't care can keep using `perRole.subagent`.
   *
   * Keys are the subagent's `name` from AgentConfig.subagents[*].
   * Empty for runs that don't use subagents.
   */
  bySubagent: Record<string, RoleTotals>;
  overall: RoleTotals;
}

export function emptyRoleTotals(): RoleTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    cacheSavedUsd: 0,
    calls: 0,
    anthropicCalls: 0,
  };
}

export function emptyRunTotals(): RunTotals {
  const perRole = {} as Record<RoleBucket, RoleTotals>;
  for (const b of ROLE_BUCKETS) perRole[b] = emptyRoleTotals();
  return { perRole, bySubagent: {}, overall: emptyRoleTotals() };
}

/**
 * In-place accumulator. Mutates `totals`.
 *
 * @param subagentName when role is "subagent" and this is provided,
 *   the call also lands in `bySubagent[name]` so the dashboard / TUI
 *   can attribute spend to the specific subagent. Pass undefined for
 *   role calls (planner/coder/reviewer) or for unnamed subagent
 *   invocations.
 */
export function addUsage(
  totals: RunTotals,
  role: RoleBucket,
  u: InvokeResult,
  subagentName?: string,
): void {
  const cost = estimateCost(u);
  const saved = cacheSavings(u);
  const buckets: RoleTotals[] = [totals.perRole[role], totals.overall];
  if (role === "subagent" && subagentName && subagentName.length > 0) {
    if (!totals.bySubagent[subagentName]) {
      totals.bySubagent[subagentName] = emptyRoleTotals();
    }
    buckets.push(totals.bySubagent[subagentName]);
  }
  for (const b of buckets) {
    b.inputTokens += u.inputTokens;
    b.outputTokens += u.outputTokens;
    b.cacheReadTokens += u.cacheReadTokens;
    b.cacheCreationTokens += u.cacheCreationTokens;
    b.costUsd += cost;
    b.cacheSavedUsd += saved;
    b.calls += 1;
    if (u.provider === "anthropic") b.anthropicCalls += 1;
  }
}

/**
 * Detect the silent-cache-invalidator anti-pattern: we made multiple
 * Anthropic calls but got zero cache reads. Either the prefix has a
 * nondeterministic token (timestamp, UUID) or the model/tool set shifted.
 */
export function isSilentCacheInvalidator(
  totals: RoleTotals,
  minAnthropicCalls = 3,
): boolean {
  return (
    totals.anthropicCalls >= minAnthropicCalls && totals.cacheReadTokens === 0
  );
}
