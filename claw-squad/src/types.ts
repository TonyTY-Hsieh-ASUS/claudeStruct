/**
 * Shared types for the 3-agent loop.
 *
 * Design: every agent reads+writes a single shared Squad state, so we can
 * snapshot it to disk between iterations (for resume, audit, debugging).
 */

export type AgentRole = "planner" | "coder" | "reviewer";

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
}

/**
 * Per-role model and effort. Tuned for the 3-agent division of labor:
 * - Planner does the heavy reasoning (requirements + design).
 * - Coder is the workhorse — fast, focused.
 * - Reviewer is a skeptic — needs good reasoning, not as much as Planner.
 */
export interface AgentModelConfig {
  planner: { model: string; effort: "high" | "xhigh" | "max" };
  coder: { model: string; effort: "medium" | "high" | "xhigh" };
  reviewer: { model: string; effort: "high" | "xhigh" };
}

export const DEFAULT_MODELS: AgentModelConfig = {
  // Planner: hardest job, needs adaptive thinking + max effort
  planner: { model: "claude-opus-4-7", effort: "max" },
  // Coder: high throughput. Sonnet is fast and capable for implementation work.
  coder: { model: "claude-sonnet-4-6", effort: "high" },
  // Reviewer: skeptic, needs strong reasoning on diffs
  reviewer: { model: "claude-opus-4-7", effort: "xhigh" },
};
