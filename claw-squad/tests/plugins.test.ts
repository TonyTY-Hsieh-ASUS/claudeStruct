/**
 * Tests for the plugin SDK (W7.4).
 *
 * Exercises validation (`isPlugin`), discovery (`discoverPluginPaths`),
 * loader (`loadPluginAt`), and merger (`mergePlugins`) using temp
 * directories that simulate `node_modules/claudestruct-plugin-foo`
 * package layouts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PLUGIN_API_VERSION,
  type ClawSquadPlugin,
  discoverPluginPaths,
  isPlugin,
  loadPluginAt,
  loadPluginsFromRepo,
  mergePlugins,
} from "../src/plugins.js";


/** Build a fake plugin package on disk. Default entry is CommonJS. */
function makePluginPackage(
  root: string,
  name: string,
  pluginObject: Record<string, unknown>,
  opts: { entry?: "cjs" | "esm" | "missing" } = {},
): string {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  if (opts.entry === "missing") {
    return dir;
  }
  const ext = opts.entry === "esm" ? "mjs" : "js";
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, main: `index.${ext}`, type: opts.entry === "esm" ? "module" : "commonjs" }),
    "utf-8",
  );
  // Both CJS and ESM forms accept ``module.exports = ...`` / ``export default ...``.
  // Vitest runs the import via dynamic import; both forms resolve.
  const body =
    opts.entry === "esm"
      ? `export default ${JSON.stringify(pluginObject)};`
      : `module.exports = ${JSON.stringify(pluginObject)};`;
  writeFileSync(join(dir, `index.${ext}`), body, "utf-8");
  return dir;
}


describe("isPlugin", () => {
  it("accepts a minimal valid plugin", () => {
    expect(isPlugin({ apiVersion: 1, name: "x" })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isPlugin(null)).toBe(false);
    expect(isPlugin("plugin")).toBe(false);
    expect(isPlugin(42)).toBe(false);
  });

  it("rejects when apiVersion is missing or wrong type", () => {
    expect(isPlugin({ name: "x" })).toBe(false);
    expect(isPlugin({ apiVersion: "1", name: "x" })).toBe(false);
  });

  it("rejects when name is empty or missing", () => {
    expect(isPlugin({ apiVersion: 1 })).toBe(false);
    expect(isPlugin({ apiVersion: 1, name: "" })).toBe(false);
  });

  it("rejects when subagents is not an array", () => {
    expect(isPlugin({ apiVersion: 1, name: "x", subagents: "nope" })).toBe(false);
  });

  it("rejects when skills is not an array", () => {
    expect(isPlugin({ apiVersion: 1, name: "x", skills: 42 })).toBe(false);
  });

  it("accepts when subagents and skills are present arrays", () => {
    expect(
      isPlugin({ apiVersion: 1, name: "x", subagents: [], skills: [] }),
    ).toBe(true);
  });
});


describe("discoverPluginPaths", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugin-disc-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when there is no node_modules", () => {
    expect(discoverPluginPaths(root)).toEqual([]);
  });

  it("finds packages matching the prefix", () => {
    makePluginPackage(root, "claudestruct-plugin-foo", { apiVersion: 1, name: "foo" });
    makePluginPackage(root, "claudestruct-plugin-bar", { apiVersion: 1, name: "bar" });
    makePluginPackage(root, "unrelated-package", { apiVersion: 1, name: "x" });
    const paths = discoverPluginPaths(root);
    // Sorted alphabetically.
    expect(paths.map((p) => p.split("/").pop())).toEqual([
      "claudestruct-plugin-bar",
      "claudestruct-plugin-foo",
    ]);
  });

  it("ignores non-directories with the prefix", () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "claudestruct-plugin-fake"),
      "not a dir",
      "utf-8",
    );
    expect(discoverPluginPaths(root)).toEqual([]);
  });
});


describe("loadPluginAt", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugin-load-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads a CJS plugin and validates it", async () => {
    const dir = makePluginPackage(root, "claudestruct-plugin-cjs", {
      apiVersion: PLUGIN_API_VERSION,
      name: "test-cjs",
    });
    const res = await loadPluginAt(dir);
    expect(res).toHaveProperty("plugin");
    if ("plugin" in res) {
      expect(res.plugin.name).toBe("test-cjs");
    }
  });

  it("loads an ESM plugin and validates it", async () => {
    const dir = makePluginPackage(
      root,
      "claudestruct-plugin-esm",
      { apiVersion: PLUGIN_API_VERSION, name: "test-esm" },
      { entry: "esm" },
    );
    const res = await loadPluginAt(dir);
    expect(res).toHaveProperty("plugin");
  });

  it("warns when entry point is missing", async () => {
    const dir = makePluginPackage(
      root,
      "claudestruct-plugin-empty",
      {},
      { entry: "missing" },
    );
    const res = await loadPluginAt(dir);
    expect(res).toHaveProperty("warning");
  });

  it("warns when default export is not a valid plugin", async () => {
    const dir = makePluginPackage(root, "claudestruct-plugin-bad", {
      apiVersion: 1,
      // Missing name.
    });
    const res = await loadPluginAt(dir);
    expect(res).toHaveProperty("warning");
  });

  it("warns when apiVersion does not match the host", async () => {
    const dir = makePluginPackage(root, "claudestruct-plugin-old", {
      apiVersion: 99,
      name: "ahead-of-time",
    });
    const res = await loadPluginAt(dir);
    expect(res).toHaveProperty("warning");
    if ("warning" in res) {
      expect(res.warning).toMatch(/apiVersion 99/);
    }
  });
});


describe("mergePlugins", () => {
  const provider = { kind: "anthropic" as const, model: "claude-sonnet-4-6" };

  function makePlugin(
    name: string,
    extra: Partial<ClawSquadPlugin> = {},
  ): ClawSquadPlugin {
    return { apiVersion: PLUGIN_API_VERSION, name, ...extra };
  }

  it("flattens subagents and skills across plugins", () => {
    const a = makePlugin("a", {
      subagents: [
        { name: "research", description: "...", systemPrompt: "...",
          provider: provider as any },
      ],
    });
    const b = makePlugin("b", {
      skills: [{ name: "py-test", description: "...", body: "..." }],
    });
    const merged = mergePlugins([a, b]);
    expect(merged.subagents.map((s) => s.name)).toEqual(["research"]);
    expect(merged.skills.map((s) => s.name)).toEqual(["py-test"]);
    expect(merged.warnings).toEqual([]);
  });

  it("warns and drops duplicate subagent names", () => {
    const a = makePlugin("a", {
      subagents: [{ name: "research", description: "first",
        systemPrompt: "...", provider: provider as any }],
    });
    const b = makePlugin("b", {
      subagents: [{ name: "research", description: "second",
        systemPrompt: "...", provider: provider as any }],
    });
    const merged = mergePlugins([a, b]);
    expect(merged.subagents).toHaveLength(1);
    expect(merged.subagents[0].description).toBe("first");
    expect(merged.warnings.join("\n")).toMatch(/research.*already taken/);
  });

  it("warns when the same plugin name is registered twice", () => {
    const a = makePlugin("dup");
    const b = makePlugin("dup");
    const merged = mergePlugins([a, b]);
    expect(merged.warnings.join("\n")).toMatch(/loaded twice/);
  });
});


describe("loadPluginsFromRepo", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugin-end-to-end-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty merged result when no plugins are present", async () => {
    const merged = await loadPluginsFromRepo(root);
    expect(merged.plugins).toEqual([]);
    expect(merged.subagents).toEqual([]);
  });

  it("loads valid plugins and surfaces warnings for invalid ones", async () => {
    makePluginPackage(root, "claudestruct-plugin-good", {
      apiVersion: PLUGIN_API_VERSION,
      name: "good",
    });
    makePluginPackage(root, "claudestruct-plugin-bad", {
      apiVersion: 1,
      // Missing name -> invalid
    });
    const merged = await loadPluginsFromRepo(root);
    expect(merged.plugins).toHaveLength(1);
    expect(merged.plugins[0].name).toBe("good");
    expect(merged.warnings.length).toBeGreaterThan(0);
  });
});
