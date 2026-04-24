/**
 * Config loader tests: the merge layering between defaults, config.json,
 * and CLI overrides. This is where future users will debug "why did my
 * --ollama flag get ignored" — so we pin it down now.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_CONFIG,
  loadAgentConfig,
  loadReposFromFile,
  resolveRepos,
} from "../src/config.js";
import type { RunConfig } from "../src/types.js";

function baseRunConfig(repoRoot: string): RunConfig {
  return {
    repoRoot,
    maxClarifications: 3,
    maxReviewRounds: 3,
    maxLoops: 10,
    requireHumanApproval: true,
    sandboxEnabled: false,
    selfLearning: true,
    githubEnabled: false,
  };
}

describe("loadAgentConfig", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-cfg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns defaults when no config file or flags", () => {
    const cfg = loadAgentConfig({ repoRoot: root });
    expect(cfg.planner).toEqual(DEFAULT_AGENT_CONFIG.planner);
    expect(cfg.coder).toEqual(DEFAULT_AGENT_CONFIG.coder);
    expect(cfg.reviewer).toEqual(DEFAULT_AGENT_CONFIG.reviewer);
  });

  it("reads .claw-squad/config.json when present", () => {
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      join(root, ".claw-squad/config.json"),
      JSON.stringify({
        agents: {
          coder: { name: "ollama", model: "qwen2.5-coder:14b" },
        },
      }),
      "utf-8",
    );
    const cfg = loadAgentConfig({ repoRoot: root });
    expect(cfg.coder.name).toBe("ollama");
    expect(cfg.coder.model).toBe("qwen2.5-coder:14b");
    // Defaults fill in for unmentioned roles.
    expect(cfg.planner.name).toBe("anthropic");
  });

  it("CLI flags win over file, file wins over defaults", () => {
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      join(root, ".claw-squad/config.json"),
      JSON.stringify({
        agents: {
          coder: { name: "ollama", model: "file-model" },
        },
      }),
      "utf-8",
    );
    const cfg = loadAgentConfig({
      repoRoot: root,
      cliOverrides: {
        coder: { model: "cli-model" },
      },
    });
    // provider came from file, model came from CLI
    expect(cfg.coder.name).toBe("ollama");
    expect(cfg.coder.model).toBe("cli-model");
  });

  it("rejects unknown provider", () => {
    expect(() =>
      loadAgentConfig({
        repoRoot: root,
        cliOverrides: { coder: { provider: "bogus" } },
      }),
    ).toThrow(/invalid provider/);
  });

  it("rejects invalid effort", () => {
    expect(() =>
      loadAgentConfig({
        repoRoot: root,
        cliOverrides: { coder: { effort: "extreme" } },
      }),
    ).toThrow(/invalid effort/);
  });

  it("rejects missing model", () => {
    expect(() =>
      loadAgentConfig({
        repoRoot: root,
        cliOverrides: { coder: { model: "" } },
      }),
    ).toThrow(/model is required/);
  });

  it("honors explicit --config path", () => {
    const customPath = join(root, "mycfg.json");
    writeFileSync(
      customPath,
      JSON.stringify({
        agents: { planner: { name: "openai", model: "gpt-5" } },
      }),
      "utf-8",
    );
    const cfg = loadAgentConfig({ repoRoot: root, configPath: customPath });
    expect(cfg.planner.name).toBe("openai");
    expect(cfg.planner.model).toBe("gpt-5");
  });

  it("CLI baseURL and apiKey propagate", () => {
    const cfg = loadAgentConfig({
      repoRoot: root,
      cliOverrides: {
        reviewer: {
          provider: "ollama",
          model: "qwen2.5",
          baseURL: "http://farcorner:11434/v1",
          apiKey: "k",
        },
      },
    });
    expect(cfg.reviewer.baseURL).toBe("http://farcorner:11434/v1");
    expect(cfg.reviewer.apiKey).toBe("k");
  });
});

describe("resolveRepos", () => {
  it("synthesizes a default single-repo spec from legacy fields", () => {
    const cfg = baseRunConfig("/repo/foo");
    cfg.githubRepo = "owner/foo";
    const out = resolveRepos(cfg);
    expect(out).toEqual([
      { alias: "default", root: "/repo/foo", githubRepo: "owner/foo" },
    ]);
  });

  it("uses config.repos verbatim when set", () => {
    const cfg = baseRunConfig("/repo/foo");
    cfg.repos = [
      { alias: "fe", root: "/repo/fe", githubRepo: "o/fe" },
      { alias: "be", root: "/repo/be" },
    ];
    expect(resolveRepos(cfg)).toEqual(cfg.repos);
  });

  it("rejects duplicate aliases", () => {
    const cfg = baseRunConfig("/repo/foo");
    cfg.repos = [
      { alias: "x", root: "/a" },
      { alias: "x", root: "/b" },
    ];
    expect(() => resolveRepos(cfg)).toThrow(/duplicate alias/);
  });

  it("rejects empty alias", () => {
    const cfg = baseRunConfig("/repo/foo");
    cfg.repos = [{ alias: "", root: "/a" }];
    expect(() => resolveRepos(cfg)).toThrow(/alias/);
  });

  it("rejects empty root", () => {
    const cfg = baseRunConfig("/repo/foo");
    cfg.repos = [{ alias: "x", root: "" }];
    expect(() => resolveRepos(cfg)).toThrow(/root/);
  });
});

describe("loadReposFromFile", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-cfg-repos-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when no repos key is present", () => {
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      join(root, ".claw-squad/config.json"),
      JSON.stringify({ agents: {} }),
    );
    expect(loadReposFromFile({ repoRoot: root })).toBeUndefined();
  });

  it("returns the repos list verbatim when set", () => {
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      join(root, ".claw-squad/config.json"),
      JSON.stringify({
        repos: [
          { alias: "fe", root: "/fe", githubRepo: "o/fe" },
          { alias: "be", root: "/be" },
        ],
      }),
    );
    expect(loadReposFromFile({ repoRoot: root })).toHaveLength(2);
  });
});
