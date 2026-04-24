/**
 * GitHub integration.
 *
 * Gets activated when `config.githubEnabled === true`. Requires
 * GITHUB_TOKEN in the environment.
 *
 * Flow per task:
 *   1. After first Coder commit on `claw-squad/T1`:
 *        push branch (sandbox-aware)
 *        find-or-create draft PR, remember pr_number
 *   2. After each Reviewer verdict:
 *        push any new commits
 *        post the verdict as a GitHub PR review
 *          - approve -> APPROVE event
 *          - request_changes -> REQUEST_CHANGES event with inline comments
 *          - inline comments require side+line, so findings without file+line
 *            degrade to a single issue-comment body
 *   3. On final approve:
 *        mark the PR ready-for-review if it was draft
 *        merge (squash by default)
 *        return merged PR number for state tracking
 */

import { Octokit } from "@octokit/rest";
import { pushBranch as gitPushBranch, type GitOptions } from "../git.js";
import {
  summarizeChecks,
  waitForCi,
  type CheckSummary,
  type CiWaitResult,
} from "./ci-wait.js";
import type { ReviewVerdict } from "../types.js";

export interface GithubClient {
  /**
   * Push the current commits on `branch` to origin. Respects --sandbox.
   * Idempotent. Returns true on a push that moved the remote.
   */
  pushBranch: (args: { git: GitOptions; branch: string }) => Promise<boolean>;

  /**
   * Find the open PR whose head is this branch, or create it as draft.
   * Returns the PR number. Safe to call before or after push — it just
   * asks GitHub what PRs exist on the head.
   */
  ensurePr: (args: {
    owner: string;
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<{ number: number; html_url: string; draft: boolean }>;

  /**
   * Post a PR review reflecting a Reviewer verdict. Inline comments are
   * attempted for findings that have both file and line; others go into
   * the summary body. The `decision` maps to GitHub review event.
   */
  postReview: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    verdict: ReviewVerdict;
  }) => Promise<void>;

  /**
   * Mark a draft PR as ready-for-review (if it's currently draft), then
   * squash-merge. Returns the merge commit SHA.
   */
  markReadyAndMerge: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    commitTitle?: string;
  }) => Promise<{ merged: boolean; sha?: string }>;

  /**
   * Block until CI for the PR's head SHA settles. See ci-wait.ts for
   * the polling semantics. Used by the orchestrator between "Reviewer
   * approved" and "merge PR" when --wait-for-ci is set.
   */
  waitForCi: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    timeoutMs?: number;
    onProgress?: (checks: CheckSummary[]) => void;
  }) => Promise<CiWaitResult>;

  /**
   * Close a PR without merging, leaving a comment explaining why.
   * Used by the orchestrator's rollback path when a task is abandoned
   * (max review rounds exceeded, hook abort) so reviewers see a clear
   * reason rather than a ghost PR just vanishing.
   */
  closePr: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    reason: string;
  }) => Promise<void>;
}

export { summarizeChecks, type CheckSummary, type CiWaitResult };

export function makeGithubClient(): GithubClient {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set — required when --github is enabled.",
    );
  }
  const octokit = new Octokit({ auth: token });

  return {
    async pushBranch({ git, branch }) {
      const { pushed } = gitPushBranch(git, branch);
      return pushed;
    },

    async ensurePr({ owner, repo, branch, base, title, body }) {
      // Check for an existing open PR on this head.
      const existing = await octokit.pulls.list({
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "open",
      });
      const first = existing.data[0];
      if (first) {
        return {
          number: first.number,
          html_url: first.html_url,
          draft: first.draft ?? false,
        };
      }
      const created = await octokit.pulls.create({
        owner,
        repo,
        head: branch,
        base,
        title,
        body,
        draft: true,
      });
      return {
        number: created.data.number,
        html_url: created.data.html_url,
        draft: created.data.draft ?? true,
      };
    },

    async postReview({ owner, repo, prNumber, verdict }) {
      const event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" =
        verdict.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";

      const inlineable = verdict.findings
        .filter((f) => typeof f.file === "string" && typeof f.line === "number")
        .map((f) => ({
          path: f.file as string,
          line: f.line as number,
          side: "RIGHT" as const,
          body: `**[${f.severity}]** ${f.issue}\n\n_Fix:_ ${f.suggestion}`,
        }));

      const fileless = verdict.findings.filter(
        (f) => typeof f.file !== "string" || typeof f.line !== "number",
      );

      const bodyParts = [verdict.summary];
      if (fileless.length > 0) {
        bodyParts.push("");
        bodyParts.push("### Additional findings");
        for (const f of fileless) {
          bodyParts.push(`- **[${f.severity}]** ${f.issue}`);
          bodyParts.push(`  _Fix:_ ${f.suggestion}`);
        }
      }

      try {
        await octokit.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          event,
          body: bodyParts.join("\n"),
          comments: inlineable.length > 0 ? inlineable : undefined,
        });
      } catch (err) {
        // Inline-comment line numbers can 422 if the line isn't in the
        // diff (e.g., Reviewer pointed at a pre-existing line). Fall
        // back to a review without inline comments so the verdict at
        // least lands.
        if ((err as { status?: number }).status === 422 && inlineable.length > 0) {
          const flattened = [
            ...bodyParts,
            "",
            "### Findings (inline comments couldn't be placed)",
            ...verdict.findings.map(
              (f) =>
                `- **[${f.severity}]** ${f.file ?? "?"}:${f.line ?? "?"} — ${f.issue}\n  _Fix:_ ${f.suggestion}`,
            ),
          ].join("\n");
          await octokit.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            event,
            body: flattened,
          });
        } else {
          throw err;
        }
      }
    },

    async waitForCi({ owner, repo, prNumber, timeoutMs, onProgress }) {
      return waitForCi({
        octokit,
        owner,
        repo,
        prNumber,
        timeoutMs,
        onProgress,
      });
    },

    async markReadyAndMerge({ owner, repo, prNumber, commitTitle }) {
      // Flip draft -> ready if needed. Some orgs disallow auto-merge on
      // draft PRs, so this step is load-bearing.
      const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      if (pr.data.draft) {
        await octokit.graphql(
          `mutation($id: ID!) {
            markPullRequestReadyForReview(input: { pullRequestId: $id }) {
              pullRequest { isDraft }
            }
          }`,
          { id: pr.data.node_id },
        );
      }
      const merged = await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        commit_title: commitTitle,
        merge_method: "squash",
      });
      return { merged: merged.data.merged, sha: merged.data.sha };
    },

    async closePr({ owner, repo, prNumber, reason }) {
      // Post an explanatory comment first so the close event sits
      // under a human-readable rationale in the timeline.
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `claw-squad: abandoning this task. ${reason}`,
      });
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        state: "closed",
      });
    },
  };
}

export function parseOwnerRepo(spec: string): { owner: string; repo: string } {
  const [owner, repo] = spec.split("/");
  if (!owner || !repo) {
    throw new Error(`invalid --github-repo "${spec}" (expected owner/repo)`);
  }
  return { owner, repo };
}
