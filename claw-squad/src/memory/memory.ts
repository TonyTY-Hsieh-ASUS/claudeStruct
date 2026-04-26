/**
 * Self-learning memory. Default ON.
 *
 * Two files, both plain Markdown so humans can inspect/edit:
 *   .claw-squad/memory/lessons.md  — reviewer findings + planner reflections
 *   .claw-squad/memory/patterns.md — recurring code patterns that worked
 *
 * On each new Planner invocation, we read both and feed the most recent
 * entries back into the Planner's user turn (NOT the system prompt — that
 * would invalidate the cache byte-for-byte every run).
 *
 * Size guard: we cap each file at 40 KB and auto-rotate the oldest 30% to
 * lessons.archive.md when full. The Planner sees only the live file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewVerdict, TodoItem } from "../types.js";

const MEMORY_DIRNAME = ".claw-squad/memory";
const LESSONS_FILE = "lessons.md";
const PATTERNS_FILE = "patterns.md";
const LESSONS_ARCHIVE = "lessons.archive.md";
const MAX_BYTES = 40_000;
const ROTATE_FRACTION = 0.3;
/** Tail window fed back to the Planner. Keeps the user turn small. */
const RECENT_TAIL_BYTES = 8_000;

function memoryDir(repoRoot: string): string {
  return join(repoRoot, MEMORY_DIRNAME);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Return the tail of each memory file — what Planner actually sees. */
export function readMemorySnippet(repoRoot: string): string {
  const dir = memoryDir(repoRoot);
  const lessons = readIfExists(join(dir, LESSONS_FILE));
  const patterns = readIfExists(join(dir, PATTERNS_FILE));

  const parts: string[] = [];
  if (lessons.length > 0) {
    parts.push("### Lessons (most recent)");
    parts.push(lessons.slice(-RECENT_TAIL_BYTES));
  }
  if (patterns.length > 0) {
    parts.push("");
    parts.push("### Patterns");
    parts.push(patterns.slice(-RECENT_TAIL_BYTES));
  }
  return parts.join("\n");
}

// --- Relevance-ranked retrieval (W3.3) ---
//
// As lessons.md grows, the chronological-tail strategy quietly drops
// older-but-relevant lessons in favor of recent-but-unrelated ones.
// `readRelevantMemorySnippet(query, ...)` instead scores each lesson
// block by keyword overlap with the user's requirement and returns
// the top-scoring lessons that fit within the budget.
//
// Why keyword overlap, not TF-IDF or embeddings?
//   - Lesson corpus is small (40 KB cap → ~50-100 entries). IDF is
//     near-noise on that scale; embeddings add a heavy dependency
//     for marginal gain. Keyword overlap is one pass over the bytes.
//   - Stays deterministic, byte-stable across runs, no model calls.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "is", "are", "was", "were",
  "be", "been", "of", "to", "in", "on", "for", "with", "by", "as", "at",
  "from", "this", "that", "these", "those", "it", "its", "we", "our",
  "you", "your", "they", "them", "their", "i", "me", "my", "do", "does",
  "did", "have", "has", "had", "not", "no", "yes", "so", "than", "then",
  "when", "what", "which", "who", "how", "why", "where", "can", "will",
  "would", "should", "could", "may", "might", "must", "make", "made",
  "use", "used", "using", "want", "need", "needs", "any", "all", "some",
  "each", "every", "more", "less", "very", "just", "also", "only",
]);

function tokenize(text: string): string[] {
  // Split on non-word, lowercase, drop short tokens and stopwords.
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface LessonBlock {
  index: number;        // Order in file; higher = newer.
  text: string;
  tokens: Set<string>;
}

/** Split a lessons file into per-entry blocks. Entries start with `## `. */
function splitLessons(raw: string): LessonBlock[] {
  if (!raw.trim()) return [];
  const parts = raw.split(/\n(?=## )/);
  return parts
    .filter((p) => p.trim().length > 0)
    .map((text, index) => ({
      index,
      text,
      tokens: new Set(tokenize(text)),
    }));
}

function scoreBlock(block: LessonBlock, queryTokens: Set<string>): number {
  let hits = 0;
  for (const t of queryTokens) {
    if (block.tokens.has(t)) hits += 1;
  }
  return hits;
}

/**
 * Pick the top-scoring lessons for `query`, falling back to chronological
 * tail when scores tie or the query is empty.
 *
 * Budget is in bytes; we accumulate blocks newest-first within the highest
 * score band, then the next band, until the budget fills. Block ordering
 * within a band is recency-descending so the Planner sees what worked
 * recently before older but equally-relevant lessons.
 */
export function readRelevantMemorySnippet(
  repoRoot: string,
  query: string,
  budgetBytes: number = RECENT_TAIL_BYTES,
): string {
  const dir = memoryDir(repoRoot);
  const lessons = readIfExists(join(dir, LESSONS_FILE));
  const patterns = readIfExists(join(dir, PATTERNS_FILE));

  const queryTokens = new Set(tokenize(query));
  const blocks = splitLessons(lessons);

  let selected: string[] = [];
  if (blocks.length === 0) {
    // No lessons yet; nothing to rank.
  } else if (queryTokens.size === 0) {
    // Empty / all-stopwords query: behave like the legacy tail.
    selected = [lessons.slice(-budgetBytes)];
  } else {
    const scored = blocks
      .map((b) => ({ b, score: scoreBlock(b, queryTokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.b.index - a.b.index);
    let used = 0;
    for (const { b } of scored) {
      const size = Buffer.byteLength(b.text, "utf8");
      if (used + size > budgetBytes) break;
      selected.push(b.text);
      used += size;
    }
    // Empty selection (zero overlap) → fall back to recent tail so the
    // Planner still sees *something* useful from prior runs.
    if (selected.length === 0) {
      selected = [lessons.slice(-budgetBytes)];
    }
  }

  const parts: string[] = [];
  if (selected.length > 0) {
    parts.push("### Lessons (relevance-ranked)");
    parts.push(selected.join("\n\n"));
  }
  if (patterns.length > 0) {
    parts.push("");
    parts.push("### Patterns");
    parts.push(patterns.slice(-budgetBytes));
  }
  return parts.join("\n");
}

/** Append a lesson. Rotates the file when oversized. */
export function appendLesson(repoRoot: string, entry: string): void {
  const dir = memoryDir(repoRoot);
  ensureDir(dir);
  const path = join(dir, LESSONS_FILE);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const block = `\n\n## ${now}\n${entry.trim()}\n`;

  let current = readIfExists(path);
  current = current + block;

  if (Buffer.byteLength(current, "utf8") > MAX_BYTES) {
    const cutoff = Math.floor(current.length * ROTATE_FRACTION);
    const archivePath = join(dir, LESSONS_ARCHIVE);
    const oldest = current.slice(0, cutoff);
    const remaining = current.slice(cutoff);
    writeFileSync(
      archivePath,
      readIfExists(archivePath) + `\n---\n${oldest}`,
      "utf-8",
    );
    current = remaining;
  }

  ensureDir(dirname(path));
  writeFileSync(path, current, "utf-8");
}

/** Append a pattern (a code snippet + 1-line rationale that worked). */
export function appendPattern(
  repoRoot: string,
  title: string,
  snippet: string,
  rationale: string,
): void {
  const dir = memoryDir(repoRoot);
  ensureDir(dir);
  const path = join(dir, PATTERNS_FILE);
  const block = `\n\n### ${title}\n**Why:** ${rationale}\n\n\`\`\`\n${snippet}\n\`\`\`\n`;

  let current = readIfExists(path);
  current = current + block;
  if (Buffer.byteLength(current, "utf8") > MAX_BYTES) {
    // Patterns don't get archived — just truncate the head. Lossy but bounded.
    current = current.slice(-Math.floor(MAX_BYTES * (1 - ROTATE_FRACTION)));
  }
  writeFileSync(path, current, "utf-8");
}

/**
 * Synthesize a lesson entry from a completed task.
 * Called by the orchestrator right after the Reviewer approves + merges.
 */
export function lessonFromCompletedTask(
  todo: TodoItem,
  reviews: ReviewVerdict[],
): string {
  // Rolled-back tasks get a different shape. We want the next Planner
  // run to notice "last time we tried something like this, it got
  // abandoned" so it can either simplify the scope or flag the risk
  // up-front. Don't emit findings/counts — those belong to merged PRs.
  if (todo.rolledBack) {
    const lines: string[] = [
      `Task: ${todo.id} — ${todo.title} (ROLLED BACK)`,
      `Rounds attempted: ${reviews.length}`,
    ];
    if (todo.rollbackReason) {
      lines.push(`Reason: ${todo.rollbackReason}`);
    }
    lines.push(
      "Next Planner: consider smaller scope or split this into sub-tasks before retrying.",
    );
    return lines.join("\n");
  }

  const rounds = reviews.length;
  const lines: string[] = [];
  lines.push(`Task: ${todo.id} — ${todo.title}`);
  lines.push(`Iterations to approve: ${rounds}`);

  const allFindings = reviews.flatMap((r) => r.findings);
  const bySeverity = allFindings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  if (allFindings.length > 0) {
    const counts = Object.entries(bySeverity)
      .map(([s, n]) => `${s}=${n}`)
      .join(", ");
    lines.push(`Findings across rounds: ${counts}`);

    // Pick the most common high-severity issue for quick recall.
    const highs = allFindings.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );
    if (highs.length > 0) {
      lines.push("Key issues to avoid next time:");
      for (const f of highs.slice(0, 3)) {
        lines.push(`- ${f.issue}`);
      }
    }
  } else {
    lines.push("Approved first pass, no findings.");
  }
  return lines.join("\n");
}
