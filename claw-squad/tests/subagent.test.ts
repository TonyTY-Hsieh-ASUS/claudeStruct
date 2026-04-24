import { describe, expect, it } from "vitest";
import {
  parseDelegates,
  renderSubagentAnswers,
} from "../src/agents/subagent.js";
import type { InvokeResult } from "../src/providers/types.js";

describe("parseDelegates", () => {
  it("returns empty when no directive", () => {
    expect(parseDelegates("## Phase: ready\nAll clear")).toEqual([]);
  });

  it("extracts a single delegate block", () => {
    const text = `## Phase: ready
## Delegate research
Summarize the auth flow in src/auth/
`;
    const ds = parseDelegates(text);
    expect(ds).toHaveLength(1);
    expect(ds[0]?.name).toBe("research");
    expect(ds[0]?.prompt).toContain("Summarize");
  });

  it("extracts multiple delegate blocks", () => {
    const text = `## Delegate research
Find all callers of foo()

## Delegate grep
find TODOs in src/
`;
    const ds = parseDelegates(text);
    expect(ds).toHaveLength(2);
    expect(ds.map((d) => d.name)).toEqual(["research", "grep"]);
  });

  it("stops a block at the next heading", () => {
    const text = `## Delegate research
First prompt

## Phase: ready
other stuff
`;
    const ds = parseDelegates(text);
    expect(ds).toHaveLength(1);
    expect(ds[0]?.prompt).not.toContain("other stuff");
  });
});

describe("renderSubagentAnswers", () => {
  function fakeUsage(): InvokeResult {
    return {
      text: "",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: "end_turn",
      model: "m",
      provider: "anthropic",
      role: "planner",
    };
  }

  it("returns empty string on empty input", () => {
    expect(renderSubagentAnswers([])).toBe("");
  });

  it("renders answers with headings", () => {
    const out = renderSubagentAnswers([
      { name: "research", answer: "Found 3 callers", usage: fakeUsage() },
      { name: "grep", answer: "Located TODOs", usage: fakeUsage() },
    ]);
    expect(out).toContain("### research");
    expect(out).toContain("Found 3 callers");
    expect(out).toContain("### grep");
  });
});
