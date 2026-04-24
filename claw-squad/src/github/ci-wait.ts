/**
 * Wait for GitHub CI to settle on a PR before we merge.
 *
 * Why this is its own step (not part of Reviewer):
 *   - Reviewer's "approve" is a logic judgment on the diff; CI is
 *     ground truth about whether the change compiles/tests pass in the
 *     real build environment. They're complementary.
 *   - Merge-on-green is a standard team policy. This lets claw-squad
 *     respect it automatically.
 *
 * Behavior:
 *   - Poll the combined status + check_runs for the PR's head SHA.
 *   - Return `passed` when every required check reports `success`.
 *   - Return `failed` on the first check reporting `failure` or
 *     `timed_out` (we don't wait for the rest — the merge would
 *     be blocked anyway).
 *   - Return `pending_timeout` if the wall-clock cap trips first.
 *   - Surface the raw check summaries so the orchestrator can feed
 *     failures into the Coder's next round as fix instructions.
 */

import type { Octokit } from "@octokit/rest";

export type CiOutcome = "passed" | "failed" | "pending_timeout";

export interface CheckSummary {
  name: string;
  conclusion: string | null;
  status: string;
  detailsUrl?: string;
  summary?: string;
}

export interface CiWaitResult {
  outcome: CiOutcome;
  checks: CheckSummary[];
  elapsedMs: number;
  headSha: string;
}

export interface CiWaitOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Max wall clock to wait. Default 15 min — tune to your CI runtime. */
  timeoutMs?: number;
  /** Poll interval; starts fast and backs off. */
  initialPollMs?: number;
  maxPollMs?: number;
  onProgress?: (checks: CheckSummary[]) => void;
}

const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const DEFAULT_POLL = 5_000;
const DEFAULT_MAX_POLL = 30_000;

/**
 * Wait for CI. Non-blocking with backoff; intended to be awaited from
 * the orchestrator between "Reviewer approved" and "merge PR".
 */
export async function waitForCi(
  opts: CiWaitOptions,
): Promise<CiWaitResult> {
  const start = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let poll = opts.initialPollMs ?? DEFAULT_POLL;
  const maxPoll = opts.maxPollMs ?? DEFAULT_MAX_POLL;

  // Fetch PR once to get the head SHA. The SHA pins our polls — if new
  // commits land during waiting, we'll detect via a SHA shift and
  // restart the clock (caller re-enters waitForCi after another push).
  const pr = await opts.octokit.pulls.get({
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
  });
  const headSha = pr.data.head.sha;

  while (true) {
    const checks = await fetchChecks(opts, headSha);
    opts.onProgress?.(checks);

    const verdict = evaluateChecks(checks);
    if (verdict === "passed" || verdict === "failed") {
      return { outcome: verdict, checks, elapsedMs: Date.now() - start, headSha };
    }

    if (Date.now() - start >= timeout) {
      return {
        outcome: "pending_timeout",
        checks,
        elapsedMs: Date.now() - start,
        headSha,
      };
    }

    await sleep(poll);
    // Exponential-ish backoff — CI latency varies wildly.
    poll = Math.min(poll * 1.5, maxPoll);
  }
}

async function fetchChecks(
  opts: CiWaitOptions,
  headSha: string,
): Promise<CheckSummary[]> {
  // check_runs (modern GitHub Actions / Checks API)
  const checkRuns = await opts.octokit.checks.listForRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: headSha,
    per_page: 100,
  });
  const fromChecks: CheckSummary[] = checkRuns.data.check_runs.map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    detailsUrl: c.details_url ?? undefined,
    summary: c.output?.summary ?? undefined,
  }));

  // Legacy commit statuses (Travis-era integrations still post here).
  const statuses = await opts.octokit.repos.listCommitStatusesForRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: headSha,
    per_page: 100,
  });
  const fromStatuses: CheckSummary[] = statuses.data.map((s) => ({
    name: s.context,
    status: s.state === "pending" ? "in_progress" : "completed",
    conclusion:
      s.state === "success"
        ? "success"
        : s.state === "failure" || s.state === "error"
          ? "failure"
          : null,
    detailsUrl: s.target_url ?? undefined,
    summary: s.description ?? undefined,
  }));

  // If the same "name" appears in both, the modern check_runs entry
  // wins — that's where the richer info lives.
  const byName = new Map<string, CheckSummary>();
  for (const c of fromStatuses) byName.set(c.name, c);
  for (const c of fromChecks) byName.set(c.name, c);
  return Array.from(byName.values());
}

export function evaluateChecks(
  checks: CheckSummary[],
): CiOutcome | "pending" {
  if (checks.length === 0) {
    // No checks at all is a pending state (CI may not have started yet).
    // After the timeout we'll report pending_timeout, not passed.
    return "pending";
  }
  let anyPending = false;
  for (const c of checks) {
    if (c.status !== "completed") {
      anyPending = true;
      continue;
    }
    const conc = c.conclusion;
    if (conc === "failure" || conc === "timed_out" || conc === "cancelled") {
      return "failed";
    }
    if (conc === "action_required") return "failed";
    if (
      conc !== "success" &&
      conc !== "neutral" &&
      conc !== "skipped"
    ) {
      // Unknown conclusion → be conservative, treat as pending rather
      // than silently passing.
      anyPending = true;
    }
  }
  return anyPending ? "pending" : "passed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Compact one-liner for log output. */
export function summarizeChecks(checks: CheckSummary[]): string {
  const counts = {
    success: 0,
    failure: 0,
    pending: 0,
    other: 0,
  };
  for (const c of checks) {
    if (c.status !== "completed") counts.pending++;
    else if (c.conclusion === "success") counts.success++;
    else if (
      c.conclusion === "failure" ||
      c.conclusion === "timed_out" ||
      c.conclusion === "cancelled"
    )
      counts.failure++;
    else counts.other++;
  }
  return `✓${counts.success} ✗${counts.failure} ⋯${counts.pending}${counts.other ? ` ?${counts.other}` : ""}`;
}
