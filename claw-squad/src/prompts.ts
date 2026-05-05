/**
 * Load the three agent system prompts from disk.
 *
 * Prompts live in `prompts/*.md` as plain Markdown. Keeping them out of
 * TypeScript source means (a) we can edit them without recompiling, and
 * (b) the prompt bytes are exactly stable across runs — critical for the
 * prompt cache.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRole } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the prompts directory.
 *
 * During `tsx src/cli.ts` dev runs, __dirname is `<repo>/src` so we go up one.
 * After `tsc` build, __dirname is `<repo>/dist` so we also go up one.
 * If the user installed the package globally, prompts ship at `../prompts`
 * relative to dist/. Same path works for all three.
 */
function promptsDir(): string {
  return join(__dirname, "..", "prompts");
}

const _cache = new Map<AgentRole, string>();

export function loadPrompt(role: AgentRole): string {
  const cached = _cache.get(role);
  if (cached) return cached;
  const path = join(promptsDir(), `${role}.md`);
  const contents = readFileSync(path, "utf-8");
  _cache.set(role, contents);
  return contents;
}

/**
 * Short content-hash of a prompt. Auto-bumps when the file changes;
 * cheaper than asking humans to maintain version strings, and matches
 * the bytes that determine cache key. Surfaced in the run summary so
 * regressions can be traced to a specific prompt revision.
 */
export function loadPromptVersion(role: AgentRole): string {
  const text = loadPrompt(role);
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 8);
}
