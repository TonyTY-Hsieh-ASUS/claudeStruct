/**
 * ci-wait pure-logic tests. The polling loop hits the real Octokit in
 * integration, but `evaluateChecks` is the decision heart and can be
 * unit-tested cleanly.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateChecks,
  summarizeChecks,
  type CheckSummary,
} from "../src/github/ci-wait.js";

function c(
  name: string,
  status: string,
  conclusion: string | null = null,
): CheckSummary {
  return { name, status, conclusion };
}

describe("evaluateChecks", () => {
  it("pending when empty", () => {
    expect(evaluateChecks([])).toBe("pending");
  });

  it("pending when any check still running", () => {
    expect(
      evaluateChecks([
        c("a", "completed", "success"),
        c("b", "in_progress"),
      ]),
    ).toBe("pending");
  });

  it("passed when all completed + success/neutral/skipped", () => {
    expect(
      evaluateChecks([
        c("a", "completed", "success"),
        c("b", "completed", "neutral"),
        c("c", "completed", "skipped"),
      ]),
    ).toBe("passed");
  });

  it("failed on any failure", () => {
    expect(
      evaluateChecks([
        c("a", "completed", "success"),
        c("b", "completed", "failure"),
      ]),
    ).toBe("failed");
  });

  it("failed on timed_out, cancelled, action_required", () => {
    expect(evaluateChecks([c("a", "completed", "timed_out")])).toBe("failed");
    expect(evaluateChecks([c("a", "completed", "cancelled")])).toBe("failed");
    expect(evaluateChecks([c("a", "completed", "action_required")])).toBe("failed");
  });

  it("pending on unknown conclusion", () => {
    expect(evaluateChecks([c("a", "completed", "stale")])).toBe("pending");
  });
});

describe("summarizeChecks", () => {
  it("shows counts compactly", () => {
    const s = summarizeChecks([
      c("a", "completed", "success"),
      c("b", "completed", "success"),
      c("c", "completed", "failure"),
      c("d", "in_progress"),
    ]);
    expect(s).toContain("✓2");
    expect(s).toContain("✗1");
    expect(s).toContain("⋯1");
  });

  it("no question mark when no other states", () => {
    expect(summarizeChecks([c("a", "completed", "success")])).not.toContain("?");
  });
});
