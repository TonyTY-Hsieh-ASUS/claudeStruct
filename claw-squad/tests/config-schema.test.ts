/**
 * Tests for the zod gate on `.claw-squad/config.json`.
 *
 * The hand-rolled merge already validated the post-merged result. The
 * new zod layer adds two things the merge couldn't:
 *   - Unknown-field rejection (catches typos in the file).
 *   - Field-path errors that include the dotted path.
 *
 * The cases below pin those two behaviors. Coverage of the merge path
 * itself stays in `config.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { validateConfigFile } from "../src/config-schema.js";

describe("validateConfigFile", () => {
  it("accepts a complete valid config", () => {
    const parsed = validateConfigFile(
      {
        agents: {
          planner: { name: "anthropic", model: "claude-opus-4-7", effort: "max" },
          coder: { name: "ollama", model: "qwen2.5-coder:14b" },
          reviewer: { name: "openai", model: "gpt-5", effort: "high" },
        },
      },
      "config.json",
    );
    expect(parsed.agents?.planner?.name).toBe("anthropic");
  });

  it("accepts an empty config (defaults will fill in)", () => {
    const parsed = validateConfigFile({}, "config.json");
    expect(parsed).toEqual({});
  });

  it("rejects an unknown top-level field with the path", () => {
    expect(() =>
      validateConfigFile({ aggents: {} }, "config.json"),
    ).toThrow(/aggents/);
  });

  it("rejects a typo'd role with the agents path", () => {
    expect(() =>
      validateConfigFile(
        { agents: { planne: { name: "anthropic", model: "x" } } },
        "config.json",
      ),
    ).toThrow(/agents.*planne/);
  });

  it("rejects an invalid effort with the field path", () => {
    let captured: string | undefined;
    try {
      validateConfigFile(
        {
          agents: {
            planner: { name: "anthropic", model: "x", effort: "ultra" },
          },
        },
        "/tmp/conf.json",
      );
    } catch (err) {
      captured = (err as Error).message;
    }
    expect(captured).toBeDefined();
    expect(captured).toContain("agents.planner.effort");
  });

  it("rejects an invalid provider name with the field path", () => {
    expect(() =>
      validateConfigFile(
        { agents: { coder: { name: "claude", model: "x" } } },
        "config.json",
      ),
    ).toThrow(/agents\.coder\.name/);
  });

  it("requires subagent provider name + model", () => {
    expect(() =>
      validateConfigFile(
        {
          subagents: [
            { name: "researcher", provider: { model: "x" } as never },
          ],
        },
        "config.json",
      ),
    ).toThrow(/subagents\.0\.provider\.name/);
  });

  it("requires repo alias and root", () => {
    expect(() =>
      validateConfigFile(
        { repos: [{ alias: "", root: "/r" }] },
        "config.json",
      ),
    ).toThrow(/repos\.0\.alias/);
  });

  it("includes the file path in the error preamble", () => {
    let captured: string | undefined;
    try {
      validateConfigFile({ aggents: {} }, "/repo/.claw-squad/config.json");
    } catch (err) {
      captured = (err as Error).message;
    }
    expect(captured).toContain("/repo/.claw-squad/config.json");
  });
});
