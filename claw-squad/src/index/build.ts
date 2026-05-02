/**
 * `claw-squad index build` driver.
 *
 * Walks tracked source files (gitignore + extension allowlist via
 * the same `git ls-files` that context-gather already uses), embeds
 * each one (sha-skipped on second build), and commits the index.
 *
 * Uses the same per-file 16 KB cap as the Python side — embedding
 * models truncate anyway (nomic-embed-text is 8192 tokens ≈ 32 KB)
 * and a tighter cap shrinks request payloads + reduces fingerprint
 * churn from trailing-whitespace edits in long files.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git.js";
import {
  type EmbeddingClient,
  defaultEmbeddingClient,
} from "./embed.js";
import { Index, fileSha256 } from "./store.js";

// Match the Python side's defaults so the two surfaces are
// behaviour-equivalent.
const BATCH = 16;
const MAX_FILE_BYTES = 16 * 1024;

// Same source-file extensions the existing context-gather walks.
// Mirrors `claudestruct.context.SOURCE_EXTENSIONS` so the two indexes
// see the same universe of files.
const SOURCE_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".go", ".rs", ".java", ".kt", ".scala",
  ".rb", ".php", ".cs", ".swift", ".m", ".mm",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto",
  ".html", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".ini",
  ".md", ".rst", ".txt",
]);

export interface BuildIndexOptions {
  /** Embedding endpoint. Default: env-driven Ollama on localhost. */
  client?: EmbeddingClient;
  /** Override the index storage location (tests use this). */
  indexRoot?: string;
  /** Per-batch progress callback for the CLI's spinner. */
  onProgress?: (msg: string) => void;
}

export interface BuildIndexStats {
  walked: number;
  embedded: number;
  skippedUnchanged: number;
  skippedUnreadable: number;
}

function listSourceFiles(repoRoot: string): string[] {
  // Same approach as context-gather: ask git for tracked files. If
  // git fails (e.g. not a repo, sandbox-missing), fall through to an
  // empty list — the operator's first task is to actually run inside
  // a checkout, and we surface the resulting "0 walked" stat clearly.
  let listed: string[] = [];
  try {
    listed = runGit(
      { repoRoot, sandboxEnabled: false },
      ["ls-files"],
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
  return listed
    .filter((rel) => {
      const dot = rel.lastIndexOf(".");
      if (dot < 0) return false;
      return SOURCE_EXTENSIONS.has(rel.slice(dot).toLowerCase());
    })
    .sort();
}

function readCapped(absPath: string): Buffer | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    const buf = readFileSync(absPath);
    return buf.length > MAX_FILE_BYTES ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  } catch {
    return null;
  }
}

/**
 * Build (or refresh) the index for `repoRoot`. Skips files whose
 * sha256 matches what's already stored — the "fast subsequent build"
 * path. The HTTP call is the dominant cost; the sha-skip turns a
 * second build of a 50k-file monorepo into a no-op.
 */
export async function buildIndex(
  repoRoot: string,
  opts: BuildIndexOptions = {},
): Promise<BuildIndexStats> {
  const client = opts.client ?? defaultEmbeddingClient();
  const idx = Index.open(repoRoot, { indexRoot: opts.indexRoot });

  const files = listSourceFiles(repoRoot);
  let embedded = 0;
  let skippedUnchanged = 0;
  let skippedUnreadable = 0;

  let pendingPaths: string[] = [];
  let pendingShas: string[] = [];
  let pendingTexts: string[] = [];

  const flush = async (): Promise<void> => {
    if (pendingPaths.length === 0) return;
    const vectors = await client.embedBatch(pendingTexts);
    const rows = pendingPaths.map((relPath, i) => {
      const sha = pendingShas[i];
      const embedding = vectors[i];
      // The fake/real embedding client always returns one vector per
      // input — `embedBatch` raises on length mismatch — so the
      // non-null asserts here are safe under the contract. Express
      // it explicitly so TS narrows away the `| undefined`.
      if (sha === undefined || embedding === undefined) {
        throw new Error("internal: pending arrays out of sync");
      }
      return { relPath, sha256: sha, embedding };
    });
    idx.upsertMany(rows);
    embedded += pendingPaths.length;
    opts.onProgress?.(
      `embedded batch of ${pendingPaths.length} (total: ${embedded})`,
    );
    pendingPaths = [];
    pendingShas = [];
    pendingTexts = [];
  };

  for (const rel of files) {
    const buf = readCapped(join(repoRoot, rel));
    if (buf === null) {
      skippedUnreadable += 1;
      continue;
    }
    const sha = fileSha256(buf);
    if (idx.getSha(rel) === sha) {
      skippedUnchanged += 1;
      continue;
    }
    pendingPaths.push(rel);
    pendingShas.push(sha);
    pendingTexts.push(buf.toString("utf-8"));
    if (pendingPaths.length >= BATCH) await flush();
  }
  await flush();
  idx.commit();

  return {
    walked: files.length,
    embedded,
    skippedUnchanged,
    skippedUnreadable,
  };
}

/**
 * Embed `query`, return the top-K matching repo-relative paths. The
 * orchestrator integration (a future PR) will feed these as
 * `fileContext` paths to the Coder. Empty index → empty list (callers
 * fall back to the existing keyword-rank gatherer).
 */
export async function smartPaths(
  repoRoot: string,
  query: string,
  opts: { k?: number; client?: EmbeddingClient; indexRoot?: string } = {},
): Promise<string[]> {
  const k = opts.k ?? 20;
  const client = opts.client ?? defaultEmbeddingClient();
  const [vector] = await client.embedBatch([query]);
  if (!vector) return [];
  const idx = Index.open(repoRoot, { indexRoot: opts.indexRoot });
  return idx.query(vector, k).map((h) => h.relPath);
}
