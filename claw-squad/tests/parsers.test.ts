/**
 * Smoke tests for the agent output parsers.
 *
 * These don't hit the Claude API — they just feed representative LLM
 * responses through our parse functions and assert the resulting shape.
 * Catches regressions when we touch the JSON contract or the prompt format.
 */
import { describe, expect, it } from "vitest";
import { parsePlannerOutput } from "../src/agents/planner.js";
import { parseCoderOutput } from "../src/agents/coder.js";
import { parseReviewerOutput } from "../src/agents/reviewer.js";

describe("parsePlannerOutput", () => {
  it("extracts questions from clarification phase", () => {
    const out = parsePlannerOutput(`## Phase: clarification
## Questions
1. Which language?
2. Which database?
`);
    expect(out.phase).toBe("clarification");
    expect(out.questions).toEqual(["Which language?", "Which database?"]);
  });

  it("extracts understanding from ready phase", () => {
    const out = parsePlannerOutput(`## Phase: ready
## Understanding
Build a CLI that does X and Y.
`);
    expect(out.phase).toBe("ready");
    expect(out.understanding).toContain("Build a CLI");
  });

  it("parses todos JSON", () => {
    const out = parsePlannerOutput(
      "## Phase: todos\n\n```json\n" +
        JSON.stringify({
          todos: [
            { id: "T1", title: "add foo", description: "create foo.ts" },
          ],
        }) +
        "\n```",
    );
    expect(out.phase).toBe("todos");
    expect(out.todos?.[0]?.id).toBe("T1");
    expect(out.todos?.[0]?.status).toBe("pending");
  });

  it("falls back to ready when phase unrecognized", () => {
    const out = parsePlannerOutput("random text without phase markers");
    expect(out.phase).toBe("ready");
  });

  it("recognizes complete phase", () => {
    const out = parsePlannerOutput("## Phase: complete\n\nAll done.");
    expect(out.phase).toBe("complete");
  });
});

describe("parseCoderOutput", () => {
  it("parses file edits", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        commit_message: "feat: add foo",
        rationale: "because X",
        files: [{ path: "foo.ts", action: "create", content: "export {}\n" }],
      }) +
      "\n```";
    const out = parseCoderOutput(text);
    expect(out.blocked).toBe(false);
    expect(out.commitMessage).toBe("feat: add foo");
    expect(out.files).toHaveLength(1);
    expect(out.files?.[0]?.path).toBe("foo.ts");
  });

  it("marks blocked when Coder says so", () => {
    const out = parseCoderOutput(
      "```json\n" +
        JSON.stringify({
          blocked: true,
          reason: "missing schema",
          needs: "clarification on table shape",
        }) +
        "\n```",
    );
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe("missing schema");
  });

  it("blocks on missing JSON fence", () => {
    const out = parseCoderOutput("I will add the file.");
    expect(out.blocked).toBe(true);
  });

  it("blocks on malformed JSON", () => {
    const out = parseCoderOutput("```json\n{not valid}\n```");
    expect(out.blocked).toBe(true);
  });
});

describe("parseReviewerOutput", () => {
  it("parses approve decision", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        decision: "approve",
        summary: "lgtm",
        findings: [],
      }) +
      "\n```";
    const v = parseReviewerOutput(text);
    expect(v.decision).toBe("approve");
    expect(v.findings).toEqual([]);
  });

  it("parses request_changes with findings", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        decision: "request_changes",
        summary: "needs work",
        findings: [
          {
            severity: "high",
            file: "foo.ts",
            line: 10,
            issue: "null deref",
            suggestion: "guard with ?.",
          },
        ],
      }) +
      "\n```";
    const v = parseReviewerOutput(text);
    expect(v.decision).toBe("request_changes");
    expect(v.findings[0]?.severity).toBe("high");
  });

  it("defaults to request_changes when JSON missing (safety)", () => {
    const v = parseReviewerOutput("approve it i guess");
    expect(v.decision).toBe("request_changes");
  });
});
