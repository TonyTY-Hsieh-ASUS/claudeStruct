import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLesson,
  appendPattern,
  lessonFromCompletedTask,
  readMemorySnippet,
  readRelevantMemorySnippet,
} from "../src/memory/memory.js";
import type { ReviewVerdict, TodoItem } from "../src/types.js";

describe("memory", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-mem-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates lessons.md on first write and reads it back", () => {
    appendLesson(root, "task T1 took 3 rounds because of null handling");
    const snippet = readMemorySnippet(root);
    expect(snippet).toContain("task T1 took 3 rounds");
    const raw = readFileSync(join(root, ".claw-squad/memory/lessons.md"), "utf-8");
    expect(raw).toMatch(/^\s*\n## \d{4}-/);
  });

  it("readMemorySnippet returns empty string when nothing written", () => {
    expect(readMemorySnippet(root)).toBe("");
  });

  it("appendPattern writes to patterns.md", () => {
    appendPattern(root, "retry with backoff", "for (let i=0;i<3;i++)...", "flaky network");
    const snippet = readMemorySnippet(root);
    expect(snippet).toContain("retry with backoff");
    expect(snippet).toContain("flaky network");
  });

  it("lessonFromCompletedTask summarizes review history", () => {
    const todo: TodoItem = {
      id: "T3",
      title: "fix crash",
      description: "fix crash in parser",
      status: "done",
      iterations: 2,
    };
    const reviews: ReviewVerdict[] = [
      {
        decision: "request_changes",
        summary: "missed edge case",
        findings: [
          {
            severity: "high",
            issue: "empty input not handled",
            suggestion: "guard with length check",
          },
        ],
      },
      { decision: "approve", summary: "lgtm", findings: [] },
    ];
    const lesson = lessonFromCompletedTask(todo, reviews);
    expect(lesson).toContain("T3");
    expect(lesson).toContain("Iterations to approve: 2");
    expect(lesson).toContain("empty input not handled");
  });

  it("lessonFromCompletedTask emits a distinct shape for rolled-back tasks", () => {
    const todo: TodoItem = {
      id: "T9",
      title: "rewrite parser",
      description: "...",
      status: "abandoned",
      iterations: 3,
      rolledBack: true,
      rollbackReason: "exceeded 3 Coder↔Reviewer rounds",
    };
    const lesson = lessonFromCompletedTask(todo, [
      { decision: "request_changes", summary: "nope", findings: [] },
    ]);
    expect(lesson).toContain("ROLLED BACK");
    expect(lesson).toContain("exceeded 3");
    expect(lesson).toContain("smaller scope");
    // Don't pollute with "Iterations to approve:" — that's for merged tasks.
    expect(lesson).not.toContain("Iterations to approve");
  });

  // --- Relevance-ranked retrieval (W3.3) ---

  it("readRelevantMemorySnippet returns empty when no lessons exist", () => {
    expect(readRelevantMemorySnippet(root, "anything")).toBe("");
  });

  it("falls back to chronological tail when query is empty", () => {
    appendLesson(root, "very old lesson about authentication");
    appendLesson(root, "newer lesson about caching");
    const snippet = readRelevantMemorySnippet(root, "");
    expect(snippet).toContain("authentication");
    expect(snippet).toContain("caching");
  });

  it("ranks lessons by keyword overlap with the query", () => {
    appendLesson(root, "Task A: refactored authentication middleware\nKey issues: cookie parsing bug");
    appendLesson(root, "Task B: improved cache hit rate for prompt caching");
    appendLesson(root, "Task C: added pagination to the user listing endpoint");
    const snippet = readRelevantMemorySnippet(root, "fix authentication bug in cookie path");
    expect(snippet).toContain("Task A");
    // The cache lesson and the pagination lesson are unrelated to auth.
    // They should rank below A — and with such a tight budget below they
    // shouldn't all fit, so the irrelevant ones drop off.
    expect(snippet).toContain("cookie");
  });

  it("falls back to recent tail when no lessons match the query", () => {
    appendLesson(root, "old: refactored xml parser");
    appendLesson(root, "newer: bumped postgres driver version");
    const snippet = readRelevantMemorySnippet(root, "react frontend dark mode toggle");
    // No matches → recent tail is included so Planner sees something.
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippet).toContain("postgres");
  });

  it("respects the byte budget", () => {
    // Pad lessons so individual entries are large.
    for (let i = 0; i < 20; i++) {
      appendLesson(root, `Task ${i}: shared keyword authentication ${"x".repeat(500)}`);
    }
    const snippet = readRelevantMemorySnippet(root, "authentication", 2000);
    // Selected blocks must fit within the budget (modulo the section
    // header, which is small). Patterns section is empty here.
    const lessonsBlock = snippet.split("### Patterns")[0];
    expect(Buffer.byteLength(lessonsBlock, "utf8")).toBeLessThanOrEqual(2500);
  });

  it("ignores stopwords and short tokens in the query", () => {
    appendLesson(root, "Task A: about authentication");
    appendLesson(root, "Task B: caching layer rewrite");
    // Query is mostly stopwords; only "authentication" is a real token.
    const snippet = readRelevantMemorySnippet(root, "what is the authentication for");
    expect(snippet).toContain("Task A");
  });
});
