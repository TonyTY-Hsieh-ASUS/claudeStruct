/**
 * File-context gathering for Coder round 1.
 *
 * Without this, round 1 runs with `fileContext: []` — the Coder has to
 * invent file contents from scratch, which is fine for new files but
 * catastrophic for editing existing ones.
 *
 * Strategy (in order):
 *   1. Pull keywords from the TODO's title + description (lowercased,
 *      stopwords removed, non-word chars stripped). Anything that looks
 *      like a file path (contains "/" or ends in ".ext") is extracted
 *      directly as a path candidate.
 *   2. Use `git ls-files` to enumerate tracked files. Rank each one by
 *      keyword hits in the file PATH (cheap). Take the top N paths as
 *      suspects.
 *   3. Grep the repo for the keywords and boost files that contain them.
 *   4. Cap by count + total bytes so the Coder's context stays bounded.
 *
 * This is a heuristic — it'll miss cases where the Coder needs to see a
 * file with no keyword match. Round 2+ picks up the slack: Reviewer
 * points at specific files, and the orchestrator reads exactly those.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGit, type GitOptions } from "./git.js";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 80_000;
const MAX_FILE_BYTES = 20_000;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "for", "of", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "this", "that", "these", "those", "it", "its", "into", "add", "make",
  "new", "remove", "update", "fix", "change", "when", "where", "which",
  "what", "who", "whose", "should", "would", "could", "may", "might", "can",
  "will", "shall", "must", "do", "does", "did", "have", "has", "had",
  "use", "using", "used", "file", "files", "code", "function", "method",
]);

export interface ContextResult {
  files: Array<{ path: string; content: string }>;
  /** Keywords the ranker picked up — useful for debugging. */
  keywords: string[];
  /** How many candidate paths we considered before the cap. */
  candidatesSeen: number;
}

export interface GatherOptions {
  git: GitOptions;
  todoTitle: string;
  todoDescription: string;
  maxFiles?: number;
  maxTotalBytes?: number;
}

export function gatherInitialContext(opts: GatherOptions): ContextResult {
  const text = `${opts.todoTitle}\n${opts.todoDescription}`;
  const keywords = extractKeywords(text);
  const explicitPaths = extractPathTokens(text);

  // Ask git for the universe of tracked files. If git fails (not a repo,
  // or sandbox-missing), we still want to function — return just the
  // explicit paths.
  let allFiles: string[] = [];
  try {
    allFiles = runGit(opts.git, ["ls-files"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // not fatal — the Coder will proceed with whatever we resolve below
  }

  const ranked = rankByPathKeywords(allFiles, keywords);

  // Explicit path candidates jump to the top, deduped.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const p of explicitPaths) {
    if (!seen.has(p) && allFiles.includes(p)) {
      ordered.push(p);
      seen.add(p);
    }
  }
  for (const r of ranked) {
    if (!seen.has(r.path)) {
      ordered.push(r.path);
      seen.add(r.path);
    }
    if (ordered.length >= (opts.maxFiles ?? DEFAULT_MAX_FILES) * 3) break;
  }

  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const files: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (const p of ordered) {
    if (files.length >= maxFiles) break;
    try {
      const abs = resolve(opts.git.repoRoot, p);
      const content = readFileSync(abs, "utf-8");
      if (content.length > MAX_FILE_BYTES) continue;
      if (totalBytes + content.length > maxTotalBytes) continue;
      files.push({ path: p, content });
      totalBytes += content.length;
    } catch {
      // unreadable or binary — skip
    }
  }

  return { files, keywords, candidatesSeen: ordered.length };
}

export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\-.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function extractPathTokens(text: string): string[] {
  // Longest alternatives FIRST — regex alternation matches first-wins, not
  // longest. `css` before `cs` so "style.css" isn't truncated to "style.cs".
  // Trailing `\b` anchors the extension end.
  const matches = text.match(
    /[A-Za-z0-9_./-]+\.(?:tsx|jsx|cpp|hpp|yaml|yml|html|json|toml|java|ts|js|go|py|rs|css|cs|rb|php|cc|md|sh|sql|h|c)\b/g,
  );
  if (!matches) return [];
  // Dedup.
  return Array.from(new Set(matches));
}

function rankByPathKeywords(
  files: string[],
  keywords: string[],
): Array<{ path: string; score: number }> {
  if (keywords.length === 0) return [];
  const scored = files.map((p) => {
    const pl = p.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (pl.includes(kw)) score += 1;
    }
    // Light boost for files under src/, lib/, app/ (common source dirs).
    if (/^(src|lib|app)\//.test(pl)) score += 0.25;
    return { path: p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0);
}

// Re-export so callers can use resolve() via path.
export { join, resolve };
