/**
 * Skills — on-demand knowledge packets the Coder can load when a task
 * needs domain-specific guidance.
 *
 * Inspired by OpenHarness / claude-code skills. Each skill is a single
 * Markdown file in `.claw-squad/skills/*.md` with YAML frontmatter:
 *
 *   ---
 *   name: python-testing
 *   description: When writing pytest tests; covers fixtures, parametrize, mocking
 *   apply_to: ["test_*.py", "*_test.py", "tests/**"]
 *   ---
 *   # Python testing conventions
 *   ... full guidance here ...
 *
 * The Planner sees a compact list of (name, description) pairs in its
 * user turn. When it writes a TODO, it can tag `skills: ["python-testing"]`
 * in the TODO JSON. The orchestrator then loads the full skill body into
 * the Coder's user turn for that task.
 *
 * Why not just inline guidance into system prompts? Two reasons:
 *   1. System prompts are cached — dumping 10 skills into one blows
 *      the cache budget and burns tokens on skills Coder doesn't need.
 *   2. Skills are project-specific. Teams write their own and commit
 *      them alongside code.
 *
 * apply_to is a convenience: if the Coder is editing a file matching
 * one of the globs, we auto-activate the skill even if Planner didn't
 * tag it. Reduces reliance on the Planner remembering to tag.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";

export interface Skill {
  name: string;
  description: string;
  body: string;
  applyTo?: string[];
  path: string;
}

const SKILLS_DIR = ".claw-squad/skills";

export function skillsDir(repoRoot: string): string {
  return join(repoRoot, SKILLS_DIR);
}

/**
 * Load all skills from disk. Malformed files are skipped with a warning
 * via the provided logger — we don't want a typo in one skill file to
 * kill the whole run.
 */
export function loadSkills(
  repoRoot: string,
  log: (msg: string) => void = () => {},
): Skill[] {
  const dir = skillsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const skills: Skill[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const parsed = parseSkillFile(readFileSync(path, "utf-8"), path);
      if (parsed) skills.push(parsed);
    } catch (err) {
      log(
        `[skills] ${path}: ${err instanceof Error ? err.message : String(err)} — skipping`,
      );
    }
  }
  // Deterministic ordering so the prompt cache prefix stays byte-stable
  // run to run.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Parse a single skill file. Returns null for files lacking frontmatter
 * — we don't want stray .md files in the skills dir getting interpreted
 * as skills.
 */
export function parseSkillFile(source: string, path: string): Skill | null {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error("missing YAML frontmatter");
  }
  const front = match[1];
  const body = match[2];
  if (!front || body === undefined) {
    throw new Error("malformed frontmatter");
  }

  const meta = parseSimpleYaml(front);
  const name = typeof meta.name === "string" ? meta.name : undefined;
  const description =
    typeof meta.description === "string" ? meta.description : undefined;
  if (!name || !description) {
    throw new Error("frontmatter must have `name` and `description`");
  }
  const applyTo = Array.isArray(meta.apply_to)
    ? meta.apply_to.filter((x): x is string => typeof x === "string")
    : undefined;
  return { name, description, body: body.trim(), applyTo, path };
}

/**
 * A minimal YAML subset — enough for frontmatter. We keep it in-house
 * to avoid pulling in a full yaml dependency for ~20 lines of metadata.
 *
 * Supported:
 *   - scalar key: value
 *   - list key: ["a", "b"] or key: [a, b]
 *   - quoted strings (single or double)
 *   - # comments on their own line
 *
 * Not supported (by design): nested maps, block lists, multiline scalars,
 * anchors. If a skill needs those, it's too complex for this format and
 * should be split into separate files.
 */
export function parseSimpleYaml(source: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const valRaw = line.slice(sep + 1).trim();
    if (!key) continue;

    if (valRaw === "") {
      continue; // we don't support nested structures
    }

    // Inline list: ["a", "b"] or [a, b]
    if (valRaw.startsWith("[") && valRaw.endsWith("]")) {
      const inner = valRaw.slice(1, -1);
      const items = inner
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      out[key] = items;
      continue;
    }

    out[key] = stripQuotes(valRaw);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Render the compact catalog the Planner sees. One line per skill —
 * keeps the Planner's user-turn footprint small.
 */
export function renderSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = ["## Available skills (you can tag TODOs with `skills: [name]`):"];
  for (const s of skills) {
    lines.push(`- \`${s.name}\`: ${s.description}`);
  }
  return lines.join("\n");
}

/**
 * Resolve the skills activated for a given Coder task. Combines two
 * sources:
 *   1. Explicit tags on the TodoItem.skills array (set by Planner).
 *   2. apply_to globs that match any file in the Coder's file context.
 */
export function selectSkillsForTask(args: {
  allSkills: Skill[];
  taggedNames?: string[];
  contextFilePaths?: string[];
}): Skill[] {
  const { allSkills, taggedNames, contextFilePaths } = args;
  const picked = new Map<string, Skill>();
  const byName = new Map(allSkills.map((s) => [s.name, s]));

  for (const name of taggedNames ?? []) {
    const s = byName.get(name);
    if (s) picked.set(name, s);
  }

  if (contextFilePaths && contextFilePaths.length > 0) {
    for (const s of allSkills) {
      if (!s.applyTo || s.applyTo.length === 0) continue;
      for (const glob of s.applyTo) {
        if (contextFilePaths.some((p) => picomatch.isMatch(p, glob))) {
          picked.set(s.name, s);
          break;
        }
      }
    }
  }

  return Array.from(picked.values());
}

/** Render activated skills as a block to paste into Coder's user turn. */
export function renderSkillsForCoder(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = ["## Skills activated for this task"];
  for (const s of skills) {
    lines.push("");
    lines.push(`### ${s.name} — ${s.description}`);
    lines.push(s.body);
  }
  return lines.join("\n");
}
