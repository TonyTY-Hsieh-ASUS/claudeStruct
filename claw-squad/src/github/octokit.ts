/**
 * GitHub integration (Phase 2).
 *
 * Only activated when `config.githubEnabled === true`. Requires GITHUB_TOKEN
 * in the environment. Uses Octokit for PR creation, review posting, and
 * merge.
 *
 * Design decision: the Reviewer's findings are posted as individual review
 * comments anchored on the PR diff, not as a single bulky comment. This
 * mirrors what a human reviewer would do and makes it obvious which line
 * triggered which finding.
 *
 * NOTE: wiring this into orchestrator.ts is deferred to Phase 2 — the
 * skeleton is here so the signatures are stable.
 */

import { Octokit } from "@octokit/rest";
import type { ReviewVerdict } from "../types.js";

export interface GithubClient {
  pushBranch: (args: {
    repoRoot: string;
    branch: string;
  }) => Promise<void>;
  openPr: (args: {
    owner: string;
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }) => Promise<{ number: number; url: string }>;
  postReview: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    verdict: ReviewVerdict;
  }) => Promise<void>;
  mergePr: (args: {
    owner: string;
    repo: string;
    prNumber: number;
    commitTitle?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
  }) => Promise<void>;
}

export function makeGithubClient(): GithubClient {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set — required when --github is enabled.",
    );
  }
  const octokit = new Octokit({ auth: token });

  return {
    async pushBranch({ repoRoot, branch }) {
      // Deferred: shell out to `git push -u origin <branch>` via the applier.
      // Keeping logic there so the same sandboxing / error handling applies.
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["push", "-u", "origin", branch], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    },

    async openPr({ owner, repo, branch, base, title, body, draft }) {
      const res = await octokit.pulls.create({
        owner,
        repo,
        head: branch,
        base,
        title,
        body,
        draft,
      });
      return { number: res.data.number, url: res.data.html_url };
    },

    async postReview({ owner, repo, prNumber, verdict }) {
      // A single PR review with inline findings where possible.
      const event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" =
        verdict.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";

      const comments = verdict.findings
        .filter((f) => f.file && f.line)
        .map((f) => ({
          path: f.file as string,
          line: f.line as number,
          side: "RIGHT" as const,
          body: `**[${f.severity}]** ${f.issue}\n\n_Suggested fix:_ ${f.suggestion}`,
        }));

      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        event,
        body: verdict.summary,
        comments: comments.length > 0 ? comments : undefined,
      });

      // File-less findings (e.g. holistic scope issues) go as a PR comment.
      const global = verdict.findings.filter((f) => !f.file);
      if (global.length > 0) {
        const body = global
          .map((f) => `- **[${f.severity}]** ${f.issue}\n  _Fix:_ ${f.suggestion}`)
          .join("\n");
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
      }
    },

    async mergePr({ owner, repo, prNumber, commitTitle, mergeMethod }) {
      await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        commit_title: commitTitle,
        merge_method: mergeMethod ?? "squash",
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
