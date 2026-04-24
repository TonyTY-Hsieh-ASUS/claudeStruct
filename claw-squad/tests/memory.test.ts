import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLesson,
  appendPattern,
  lessonFromCompletedTask,
  readMemorySnippet,
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
});
