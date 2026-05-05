/**
 * Reviewer-side smart-context helpers (W10.5b follow-up).
 *
 * Two concerns the orchestrator needs when building the Reviewer's
 * sibling-file slot:
 *
 *  1. Parse the diff for the paths it touches, so we can EXCLUDE
 *     those from the smart-context candidate list — the Reviewer
 *     already sees them in the diff and a duplicated paste burns
 *     tokens for no signal.
 *
 *  2. Read sibling files from disk with a tight budget so the
 *     Reviewer's prompt doesn't balloon. Reviewer caps are tighter
 *     than Coder's because the Reviewer's job is mostly "look at the
 *     diff" — sibling context is a bonus, not the main feed.
 *
 * Hoisted into its own module so the orchestrator integration test
 * can exercise the path parsing without booting the full run.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Reviewer sibling-context budgets. Tighter than the Coder's
// (`context-gather.ts#DEFAULT_MAX_BYTES = 80_000`) because the
// Reviewer's bread-and-butter is the diff itself; siblings are
// supplementary.
const REVIEWER_MAX_FILES = 4;
const REVIEWER_MAX_TOTAL_BYTES = 32_000;
const REVIEWER_MAX_FILE_BYTES = 12_000;

/**
 * Extract repo-relative paths from a unified diff. Handles git's
 * `diff --git a/<path> b/<path>` headers (both pre- and post-image)
 * plus the older `+++ b/<path>` / `--- a/<path>` form. Used by the
 * orchestrator to dedupe smart-context hits against files the
 * Reviewer already sees through the diff itself.
 */
export function extractDiffPaths(diff: string): Set<string> {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    // git diff --git a/foo/bar b/foo/bar
    const gitHeader = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (gitHeader && gitHeader[1] && gitHeader[2]) {
      out.add(gitHeader[1]);
      out.add(gitHeader[2]);
      continue;
    }
    // --- a/foo/bar  (pre-image)
    if (line.startsWith("--- a/")) {
      out.add(line.slice(6).trim());
      continue;
    }
    // +++ b/foo/bar  (post-image)
    if (line.startsWith("+++ b/")) {
      out.add(line.slice(6).trim());
      continue;
    }
  }
  // /dev/null shows up for create/delete; drop it so it can't sneak
  // into the exclude set as a path.
  out.delete("/dev/null");
  return out;
}

/**
 * Read the candidate sibling files into the Reviewer's prompt slot.
 * Applies the per-file / per-total / max-files cap; skips unreadable
 * files silently (a stale index pointing at a deleted file shouldn't
 * abort the Reviewer).
 */
export function readReviewerSiblings(
  repoRoot: string,
  relPaths: string[],
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const rel of relPaths) {
    if (out.length >= REVIEWER_MAX_FILES) break;
    if (totalBytes >= REVIEWER_MAX_TOTAL_BYTES) break;
    let content: string;
    try {
      const abs = join(repoRoot, rel);
      const st = statSync(abs);
      if (!st.isFile()) continue;
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (content.length > REVIEWER_MAX_FILE_BYTES) {
      // Prefer skipping over truncating: a half-file makes the
      // Reviewer hallucinate the rest. The remaining hits in
      // relPaths still get a chance.
      continue;
    }
    if (totalBytes + content.length > REVIEWER_MAX_TOTAL_BYTES) {
      continue;
    }
    out.push({ path: rel, content });
    totalBytes += content.length;
  }
  return out;
}
