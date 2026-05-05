/**
 * Tests for prompt loading + content-hash version stamping.
 *
 * The version is what users see when chasing down "why did caching
 * stop working" or "why does the agent feel different this week" — so
 * we check it's stable, deterministic, and a hash (not arbitrary text).
 */

import { describe, expect, it } from "vitest";
import { loadPrompt, loadPromptVersion } from "../src/prompts.js";

describe("loadPromptVersion", () => {
  it("returns an 8-char hex string", () => {
    const v = loadPromptVersion("planner");
    expect(v).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic across calls", () => {
    expect(loadPromptVersion("planner")).toBe(loadPromptVersion("planner"));
  });

  it("differs between roles (whose prompts differ)", () => {
    expect(loadPromptVersion("planner")).not.toBe(loadPromptVersion("coder"));
    expect(loadPromptVersion("coder")).not.toBe(loadPromptVersion("reviewer"));
  });

  it("hash matches sha256 of loaded prompt content", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(loadPrompt("coder"), "utf-8")
      .digest("hex")
      .slice(0, 8);
    expect(loadPromptVersion("coder")).toBe(expected);
  });
});
