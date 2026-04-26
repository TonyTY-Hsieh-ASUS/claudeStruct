/**
 * Plugin SDK (W7.4).
 *
 * Lets third parties contribute new subagents and skills without
 * forking the orchestrator. A plugin is an npm package whose name
 * starts with ``claudestruct-plugin-``. Its default export is a
 * :class:`ClawSquadPlugin` object.
 *
 * Discovery (auto):
 *   1. scan ``<repoRoot>/node_modules`` for directories matching
 *      ``claudestruct-plugin-*``
 *   2. ``require()`` each one's main entry point
 *   3. validate the default export against :func:`isPlugin`
 *   4. merge ``subagents`` / ``skills`` into the orchestrator config
 *
 * Discovery (explicit, for tests / vendored plugins):
 *   - pass an array of already-loaded :class:`ClawSquadPlugin` objects
 *     to :func:`mergePlugins`. Useful when a plugin lives in the same
 *     repo (no separate ``node_modules`` entry).
 *
 * Validation rules:
 *   - ``name`` is non-empty and unique across plugins
 *   - ``apiVersion`` matches the major SDK version (``1``); future
 *     breaking changes bump the SDK major and ignore older plugins
 *     with a warning rather than crashing the host
 *   - ``subagents`` items must already be valid :class:`SubagentSpec`
 *     (the host resolves the ``provider`` field at boot — plugin
 *     authors return a :class:`SubagentContribution` whose
 *     ``provider`` is just the config, not a constructed Provider)
 *
 * The SDK intentionally does NOT let plugins replace Planner / Coder /
 * Reviewer roles — those are core, and a third party flipping the
 * orchestrator state machine breaks every other plugin. New roles
 * land via subagents (delegated, opt-in).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import type { ProviderConfig } from "./providers/types.js";
import type { Skill } from "./skills.js";

/** Bumped only on breaking SDK changes. Plugins declaring a different
 * major are skipped at load time with a warning. */
export const PLUGIN_API_VERSION = 1;

/** Subagent contribution from a plugin. ``provider`` is the
 * configuration; the host constructs the actual Provider at boot so
 * the plugin doesn't need to bundle SDKs.
 */
export interface SubagentContribution {
  name: string;
  description: string;
  systemPrompt: string;
  provider: ProviderConfig;
}

/** Skill contribution from a plugin. Same shape as a local skill,
 * minus ``path`` (the host fills it in to point at the plugin's
 * package directory).
 */
export type SkillContribution = Omit<Skill, "path">;

export interface ClawSquadPlugin {
  /** Major version of the SDK this plugin targets. */
  apiVersion: number;
  /** Stable identifier; conventionally the npm package name. */
  name: string;
  /** Human-readable one-liner. */
  description?: string;
  /** Subagents this plugin contributes to the catalog. */
  subagents?: SubagentContribution[];
  /** Skills this plugin contributes to the in-memory skill list. */
  skills?: SkillContribution[];
}

export interface MergedPlugins {
  plugins: ClawSquadPlugin[];
  subagents: SubagentContribution[];
  skills: SkillContribution[];
  warnings: string[];
}

const PLUGIN_NAME_PREFIX = "claudestruct-plugin-";


/** Runtime check that an arbitrary value implements the plugin shape.
 * Kept intentionally permissive — we want a clear warning, not a hard
 * crash, when someone publishes a malformed plugin. */
export function isPlugin(value: unknown): value is ClawSquadPlugin {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.apiVersion !== "number") return false;
  if (typeof v.name !== "string" || v.name.length === 0) return false;
  if (v.subagents !== undefined && !Array.isArray(v.subagents)) return false;
  if (v.skills !== undefined && !Array.isArray(v.skills)) return false;
  return true;
}


/** Find ``node_modules`` candidates that match the plugin name prefix.
 * Returns absolute paths to each candidate package directory. */
export function discoverPluginPaths(repoRoot: string): string[] {
  const nodeModules = resolvePath(repoRoot, "node_modules");
  if (!existsSync(nodeModules)) return [];
  let entries: string[];
  try {
    entries = readdirSync(nodeModules);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(PLUGIN_NAME_PREFIX)) continue;
    const fullPath = join(nodeModules, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    matches.push(fullPath);
  }
  return matches.sort();
}


/** Resolve the entry point file from a plugin's ``package.json`` —
 * supports CommonJS ``main`` and ESM ``exports["."]`` shapes.
 * Returns null when the package is unloadable. */
function resolvePluginEntry(packageDir: string): string | null {
  const pkgJsonPath = join(packageDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    if (typeof pkg.main === "string" && pkg.main.length > 0) {
      const candidate = resolvePath(packageDir, pkg.main);
      if (existsSync(candidate)) return candidate;
    }
    const exportsField = pkg.exports;
    if (exportsField && typeof exportsField === "object") {
      const root = (exportsField as Record<string, unknown>)["."];
      if (typeof root === "string") {
        const candidate = resolvePath(packageDir, root);
        if (existsSync(candidate)) return candidate;
      }
    }
    // Fallbacks before giving up.
    for (const fallback of ["index.js", "index.mjs", "dist/index.js"]) {
      const candidate = resolvePath(packageDir, fallback);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}


/** Load a single plugin module. Returns the validated plugin or a
 * warning describing why the module was skipped. */
export async function loadPluginAt(
  packageDir: string,
): Promise<{ plugin: ClawSquadPlugin } | { warning: string }> {
  const entry = resolvePluginEntry(packageDir);
  if (!entry) {
    return { warning: `${packageDir}: could not resolve entry point` };
  }
  let mod: { default?: unknown } & Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (err) {
    return { warning: `${packageDir}: import failed: ${(err as Error).message}` };
  }
  const candidate = mod.default ?? mod;
  if (!isPlugin(candidate)) {
    return { warning: `${packageDir}: default export is not a valid ClawSquadPlugin` };
  }
  if (Math.floor(candidate.apiVersion) !== PLUGIN_API_VERSION) {
    return {
      warning:
        `${packageDir}: apiVersion ${candidate.apiVersion} does not match host ` +
        `${PLUGIN_API_VERSION}; skipping (upgrade the plugin or pin the host).`,
    };
  }
  return { plugin: candidate };
}


/** Merge an array of plugins into flat subagent / skill lists.
 * Duplicate subagent names across plugins surface as warnings; the
 * earlier plugin (alphabetical by directory) wins so behavior is
 * deterministic across hosts. */
export function mergePlugins(plugins: ClawSquadPlugin[]): MergedPlugins {
  const subagents: SubagentContribution[] = [];
  const skills: SkillContribution[] = [];
  const warnings: string[] = [];
  const seenSubagents = new Set<string>();
  const seenSkills = new Set<string>();
  const seenPlugins = new Set<string>();

  for (const p of plugins) {
    if (seenPlugins.has(p.name)) {
      warnings.push(`plugin "${p.name}" is loaded twice; ignoring duplicate`);
      continue;
    }
    seenPlugins.add(p.name);
    for (const s of p.subagents ?? []) {
      if (seenSubagents.has(s.name)) {
        warnings.push(
          `plugin "${p.name}" contributes subagent "${s.name}" but the name ` +
          `is already taken; skipping (first plugin wins).`,
        );
        continue;
      }
      seenSubagents.add(s.name);
      subagents.push(s);
    }
    for (const sk of p.skills ?? []) {
      if (seenSkills.has(sk.name)) {
        warnings.push(
          `plugin "${p.name}" contributes skill "${sk.name}" but the name ` +
          `is already taken; skipping (first plugin wins).`,
        );
        continue;
      }
      seenSkills.add(sk.name);
      skills.push(sk);
    }
  }
  return { plugins, subagents, skills, warnings };
}


/** Convenience: discover, load, and merge in one call. ``repoRoot``
 * is searched for ``node_modules/claudestruct-plugin-*``. */
export async function loadPluginsFromRepo(
  repoRoot: string,
): Promise<MergedPlugins> {
  const paths = discoverPluginPaths(repoRoot);
  const plugins: ClawSquadPlugin[] = [];
  const warnings: string[] = [];
  for (const p of paths) {
    const res = await loadPluginAt(p);
    if ("plugin" in res) {
      plugins.push(res.plugin);
    } else {
      warnings.push(res.warning);
    }
  }
  const merged = mergePlugins(plugins);
  return { ...merged, warnings: [...warnings, ...merged.warnings] };
}
