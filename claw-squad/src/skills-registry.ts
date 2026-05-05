/**
 * Skills marketplace (W7.3).
 *
 * The local skills loader (`skills.ts`) reads `.claw-squad/skills/*.md`
 * already committed to the repo. The marketplace is the layer above:
 * fetching skills from a remote source and installing them into that
 * directory, with a content-addressed integrity check.
 *
 * Manifest shape (one JSON file per skill, served alongside the .md):
 *
 *   {
 *     "id": "python-testing",          // stable identifier
 *     "version": "1.2.0",              // semver; comparison string-only
 *     "description": "...",
 *     "url": "https://.../python-testing-1.2.0.md",
 *     "sha256": "abcd1234...",         // sha256 of the .md body
 *     "applyTo": ["test_*.py", ...],   // optional glob list
 *     "license": "MIT",                // optional
 *     "homepage": "https://...",       // optional
 *     "publishedAt": "2026-04-26T..."  // optional ISO-8601
 *   }
 *
 * The registry index is a JSON list of these manifests served at a
 * stable URL (default `https://skills.claudestruct.dev/index.json`,
 * configurable via `CLAW_SKILLS_REGISTRY`). Out-of-the-box installs
 * read from there; air-gapped environments can point at a local file
 * or a self-hosted index.
 *
 * Why content-addressed instead of cosign? Cosign is heavy (Go binary
 * dep, OIDC flows, transparency log). For a v1, "the index author
 * publishes the hash and we verify on install" gets us the same
 * tamper-evidence as long as the index host is trusted. Cosign can
 * land later as an optional layer above the sha256 check.
 *
 * The CLI surface (in `cli.ts`):
 *   - `claw-squad skills list`            -- show installed + available
 *   - `claw-squad skills install <id>`    -- fetch by id from registry
 *   - `claw-squad skills install <url>`   -- ad-hoc install of a manifest URL
 *   - `claw-squad skills uninstall <id>`  -- remove from .claw-squad/skills/
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { skillsDir } from "./skills.js";


export const DEFAULT_REGISTRY_URL = "https://skills.claudestruct.dev/index.json";


export interface SkillManifest {
  id: string;
  version: string;
  description: string;
  url: string;
  sha256: string;
  applyTo?: string[];
  license?: string;
  homepage?: string;
  publishedAt?: string;
}


/** Validate an unknown value as a SkillManifest. Returns the manifest
 * on success, or an error string. Never throws. */
export function parseManifest(raw: unknown): SkillManifest | string {
  if (!raw || typeof raw !== "object") return "manifest is not an object";
  const m = raw as Record<string, unknown>;
  for (const k of ["id", "version", "description", "url", "sha256"]) {
    if (typeof m[k] !== "string" || !m[k]) {
      return `manifest field "${k}" is missing or not a string`;
    }
  }
  if (m.applyTo !== undefined) {
    if (!Array.isArray(m.applyTo) || !m.applyTo.every((g) => typeof g === "string")) {
      return `manifest field "applyTo" must be a list of strings`;
    }
  }
  // sha256 is hex-encoded SHA-256 = 64 hex chars.
  if (!/^[a-f0-9]{64}$/i.test(m.sha256 as string)) {
    return `manifest sha256 must be 64 hex chars`;
  }
  return {
    id: m.id as string,
    version: m.version as string,
    description: m.description as string,
    url: m.url as string,
    sha256: (m.sha256 as string).toLowerCase(),
    applyTo: m.applyTo as string[] | undefined,
    license: typeof m.license === "string" ? m.license : undefined,
    homepage: typeof m.homepage === "string" ? m.homepage : undefined,
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : undefined,
  };
}


/** Read a JSON list of manifests from disk or HTTPS. The fetcher is
 * injected so tests can stub it; default is `globalThis.fetch`. */
export async function loadRegistryIndex(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<{ manifests: SkillManifest[]; warnings: string[] }> {
  let body: string;
  if (url.startsWith("file://") || url.startsWith("/")) {
    const path = url.startsWith("file://") ? url.slice("file://".length) : url;
    body = readFileSync(path, "utf-8");
  } else {
    const res = await fetcher(url);
    if (!res.ok) {
      throw new Error(`registry GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    body = await res.text();
  }
  const parsed = JSON.parse(body);
  const list = Array.isArray(parsed) ? parsed : parsed.manifests;
  if (!Array.isArray(list)) {
    throw new Error(`registry index has no manifests list`);
  }
  const manifests: SkillManifest[] = [];
  const warnings: string[] = [];
  for (const item of list) {
    const result = parseManifest(item);
    if (typeof result === "string") {
      warnings.push(`skipped invalid manifest: ${result}`);
      continue;
    }
    manifests.push(result);
  }
  return { manifests, warnings };
}


/** Compute sha256 hex of a string, matching the manifest format. */
export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}


export interface InstallResult {
  manifest: SkillManifest;
  installedPath: string;
}


/** Fetch the .md body, verify the sha256 matches the manifest, and
 * write to `<repoRoot>/.claw-squad/skills/<id>.md`. Throws on any
 * mismatch — silent corruption would defeat the whole point. */
export async function installSkill(
  repoRoot: string,
  manifest: SkillManifest,
  fetcher: typeof fetch = fetch,
): Promise<InstallResult> {
  let body: string;
  if (manifest.url.startsWith("file://") || manifest.url.startsWith("/")) {
    const path = manifest.url.startsWith("file://")
      ? manifest.url.slice("file://".length)
      : manifest.url;
    body = readFileSync(path, "utf-8");
  } else {
    const res = await fetcher(manifest.url);
    if (!res.ok) {
      throw new Error(`skill body GET ${manifest.url} failed: ${res.status} ${res.statusText}`);
    }
    body = await res.text();
  }
  const observed = sha256Hex(body);
  if (observed !== manifest.sha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch for skill "${manifest.id}": manifest=${manifest.sha256}, ` +
      `observed=${observed}. Refusing to install (tampered manifest, stale URL, or wrong file).`,
    );
  }
  const dir = skillsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${manifest.id}.md`);
  writeFileSync(path, body, "utf-8");
  // Sidecar JSON keeps the manifest metadata next to the .md so
  // `skills list` can show provenance later without re-fetching.
  writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), "utf-8");
  return { manifest, installedPath: path };
}


/** Remove a skill (and its sidecar) by id. Returns true if anything
 * was removed, false if nothing matched. */
export function uninstallSkill(repoRoot: string, id: string): boolean {
  const dir = skillsDir(repoRoot);
  if (!existsSync(dir)) return false;
  const md = join(dir, `${id}.md`);
  const sidecar = `${md}.manifest.json`;
  let removed = false;
  for (const path of [md, sidecar]) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        removed = true;
      } catch {
        // Best-effort: tolerate concurrent removals / read-only mounts.
      }
    }
  }
  return removed;
}


/** List installed skills with their sidecar manifests when available. */
export function listInstalled(repoRoot: string): {
  id: string;
  manifest: SkillManifest | null;
  path: string;
}[] {
  const dir = skillsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: { id: string; manifest: SkillManifest | null; path: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const id = entry.slice(0, -".md".length);
    const sidecar = `${path}.manifest.json`;
    let manifest: SkillManifest | null = null;
    if (existsSync(sidecar)) {
      try {
        const raw = JSON.parse(readFileSync(sidecar, "utf-8"));
        const parsed = parseManifest(raw);
        if (typeof parsed !== "string") manifest = parsed;
      } catch {
        // Tolerate a malformed sidecar — the .md is still installed.
      }
    }
    out.push({ id, manifest, path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
