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
