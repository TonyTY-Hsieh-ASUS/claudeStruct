/**
 * Shared types for the 3-agent loop.
 *
 * Design: every agent reads+writes a single shared Squad state, so we can
 * snapshot it to disk between iterations (for resume, audit, debugging).
 */

export type AgentRole = "planner" | "coder" | "reviewer";

/**
 * Buckets used for per-role token/cost attribution. Subagents are all
 * folded under a single "subagent" bucket regardless of their named
 * identity — per-name breakdown can be derived from per-run logs if
 * we need it later.
 */
export type RoleBucket = AgentRole | "subagent";

export const ROLE_BUCKETS: readonly RoleBucket[] = [
  "planner",
  "coder",
  "reviewer",
  "subagent",
];

export interface TodoItem {
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Expanded description — scope, files likely touched, acceptance criteria. */
  description: string;
  status: "pending" | "in_progress" | "done" | "abandoned";
  /** Set by the Reviewer when the PR for this task merges. */
  mergedPrNumber?: number;
  /** Iterations spent by Coder+Reviewer on this task (for budget visibility). */
  iterations: number;
  /**
   * Skill names the Planner tagged for this task. Orchestrator also
   * auto-activates skills whose `apply_to` globs match the Coder's
   * touched files, so this list isn't exhaustive.
   */
  skills?: string[];
  /**
   * Multi-repo runs only. The repo alias from `RunConfig.repos`. When
   * unset the orchestrator falls back to the first repo in the list.
   * Single-repo runs never populate this.
   */
  repoAlias?: string;
  /**
   * Set by the orchestrator when a task was aborted mid-flight and its
   * branch got reverted. Feeds into the lesson writer so future Planner
   * runs can learn from the failure.
   */
  rolledBack?: boolean;
  /**
   * Reason the task was rolled back. Short free-form string — gets
   * surfaced in lessons.md and the CLI summary.
   */
  rollbackReason?: string;
}

/**
 * One target repository. Multi-repo runs list several of these under
 * `RunConfig.repos`; single-repo runs synthesize a default spec from
 * the legacy `repoRoot` + `githubRepo` fields.
 */
export interface RepoSpec {
  /** Short identifier the Planner uses to tag TODOs. */
  alias: string;
  /** Absolute path to the repo root on disk. */
  root: string;
  /** `owner/repo`. Optional — only needed if githubEnabled. */
  githubRepo?: string;
}

export interface ClarificationTurn {
  question: string;
  answer?: string;
}

export interface ReviewVerdict {
  decision: "approve" | "request_changes";
  summary: string;
  /** Concrete issues the Coder should fix, each actionable in one edit. */
  findings: ReviewFinding[];
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file?: string;
  line?: number;
  issue: string;
  suggestion: string;
}

export interface CoderOutput {
  /** File paths (relative to repo root) Coder created or modified. */
  changedFiles: string[];
  /** Commit message Coder chose. */
  commitMessage: string;
  /** If `push` was enabled, the PR number opened. Undefined in local/dry mode. */
  prNumber?: number;
  /** Branch the Coder committed to. */
  branch: string;
  /** The patch (git diff) the Coder produced, for Reviewer to examine. */
  diff: string;
}

export interface SquadState {
  requirement: string;
  clarifications: ClarificationTurn[];
  /** True once Planner is confident enough to hand off to Coder. */
  planReady: boolean;
  todos: TodoItem[];
  /** Current task being worked on by Coder/Reviewer. */
  activeTaskId?: string;
  /** All review rounds on the current task, newest last. */
  reviewHistory: ReviewVerdict[];
  /** Loop iteration counter — guards against runaway spending. */
  loopCount: number;
}

export interface RunConfig {
  /** Defaults to cwd. */
  repoRoot: string;
  /** Absolute hard cap on Planner↔user clarifications. */
  maxClarifications: number;
  /** Absolute hard cap on Coder↔Reviewer round trips per task. */
  maxReviewRounds: number;
  /** Absolute hard cap on Planner outer loops (one per task completed). */
  maxLoops: number;
  /** Require user confirmation before Coder pushes and Reviewer merges. */
  requireHumanApproval: boolean;
  /** Enable Go sandbox wrapper on Coder subprocesses. Default: false. */
  sandboxEnabled: boolean;
  /** Write memory files (lessons.md, patterns.md). Default: true. */
  selfLearning: boolean;
  /** Actually interact with GitHub (push, PR, review, merge). Default: false (dry). */
  githubEnabled: boolean;
  /** GitHub repo, e.g. "tonyandclaw/claudeStruct". Required if githubEnabled. */
  githubRepo?: string;
  /**
   * Multi-repo runs. When set, the Planner is told about these aliases
   * and TODOs can be tagged with `repoAlias`. When unset, a single
   * default spec is synthesized from `repoRoot` + `githubRepo` so
   * legacy configs keep working unchanged.
   */
  repos?: RepoSpec[];
  /**
   * Revert the task's branch (and close its PR, if any) when the
   * Coder↔Reviewer loop blows through `maxReviewRounds` without
   * landing an approved change. Default true.
   */
  rollbackOnMaxRounds?: boolean;
  /**
   * Revert the task's branch on a hard failure (preCommit HookAbort,
   * corrupt sandbox state, etc.). Default true.
   */
  rollbackOnHardFail?: boolean;
  /**
   * Hard cap on estimated USD spent on LLM calls before the run aborts.
   * Undefined = no cap. Checked after every LLM invocation. The estimate
   * is the same number the CLI prints at the end; see registry.ts.
   */
  maxCostUsd?: number;
  /** Hard cap on total tokens (input + output + cache). Undefined = no cap. */
  maxTokens?: number;
  /**
   * Shell command to run after each Coder commit. If it exits non-zero,
   * the failure output is fed into the Coder's next round as Reviewer
   * feedback. Undefined = skip the test step entirely.
   */
  testCommand?: string;
  /** Wall clock for the test command. Default 5 min. */
  testTimeoutMs?: number;
  /**
   * After Reviewer approves, block on GitHub CI before merging. Only
   * takes effect when githubEnabled=true. Default false.
   */
  waitForCi?: boolean;
  /** Wall clock for waiting on CI. Default 15 min. */
  ciTimeoutMs?: number;
  /**
   * Stop after the Planner produces its TODO list and emit a cost
   * estimate for what the rest of the run would spend. The orchestrator
   * returns reason="dry_run" before any Coder / Reviewer call. Default
   * false. claudestruct's `--dry-run` is the analog.
   */
  dryRun?: boolean;
  /**
   * When set, every run-log event also lands at this path (in addition
   * to the canonical `.claw-squad/runs/<ts>.jsonl`). Wired by the
   * `--log-json` CLI flag for callers that want to pipe events into
   * their own observability pipeline without scanning the runs dir.
   */
  logJsonPath?: string;
  /**
   * Use the local embedding index (built via `claw-squad index build`)
   * to pick top-K semantically-relevant files for round 1 of each
   * Coder task, in addition to the existing keyword-rank gatherer.
   * The biggest payoff is on local 32B models where the 32K context
   * window can't fit a glob walk; cloud Sonnet's 200K window absorbs
   * the noise either way. Default false.
   */
  smartContext?: boolean;
}

// Per-agent provider config now lives in ./config.ts as AgentConfig.
// Use loadAgentConfig() to resolve CLI + file + defaults into the
// concrete config passed to createProvider().
