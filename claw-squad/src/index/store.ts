/**
 * Local embedding index for smart-context retrieval (claw-squad).
 *
 * Stores `(rel_path, sha256, embedding)` rows as JSONL at
 * `~/.claw-squad/index/<repo-fingerprint>.jsonl` — one file per repo
 * so upserting one repo never invalidates another.
 *
 * Why JSONL on disk instead of SQLite (the Python side's choice)?
 *
 * - Zero native deps. better-sqlite3 ships compiled binaries that
 *   fail to install on Alpine / Termux / restricted CI more often
 *   than we want to debug. The smart-context surface should be
 *   `pnpm install`-able everywhere claw-squad already runs.
 * - The data is append-only most of the time (an indexer pass writes
 *   new rows; reads do a full scan for top-K cosine). JSONL fits
 *   that shape natively.
 * - Pure-JS cosine over ~10k rows × 768-1024 dims runs in 100-300 ms
 *   on a GX10 — well inside the latency budget for a one-shot
 *   `claw-squad run --smart-context` query.
 *
 * When the index outgrows that — multi-monorepo deployments,
 * hundreds of thousands of files — the storage layer is the right
 * swap, not the algorithm. `Index.query` is the seam.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";

export interface IndexEntry {
  relPath: string;
  sha256: string;
  embedding: number[];
}

export interface IndexStats {
  entries: number;
  /** 0 when the index is empty; otherwise the dimension of the first row. */
  dimension: number;
}

export interface QueryHit {
  relPath: string;
  /** Cosine similarity in [-1, 1]; closer to 1 = more similar. */
  score: number;
}

export function repoFingerprint(repoRoot: string): string {
  return createHash("sha256")
    .update(pathResolve(repoRoot))
    .digest("hex")
    .slice(0, 16);
}

export function defaultIndexRoot(): string {
  const explicit = process.env.CLAW_SQUAD_INDEX_DIR?.trim();
  if (explicit) return explicit;
  return `${homedir()}/.claw-squad/index`;
}

export function indexPath(
  repoRoot: string,
  opts: { indexRoot?: string } = {},
): string {
  const base = opts.indexRoot ?? defaultIndexRoot();
  return `${base}/${repoFingerprint(repoRoot)}.jsonl`;
}

/**
 * Load every row into memory. Tiny and fast for the sizes we expect;
 * a streaming top-K is a future optimisation if anyone hits it.
 *
 * Corrupt JSONL lines (operator hand-edits, partial writes from a
 * crashed process) are skipped with no error — one bad line shouldn't
 * blacklist the whole index.
 */
export function loadAll(path: string): IndexEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: IndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const rel = obj.relPath;
    const sha = obj.sha256;
    const emb = obj.embedding;
    if (
      typeof rel === "string" &&
      typeof sha === "string" &&
      Array.isArray(emb) &&
      emb.every((x) => typeof x === "number")
    ) {
      out.push({
        relPath: rel,
        sha256: sha,
        embedding: emb as number[],
      });
    }
  }
  return out;
}

/**
 * In-memory index handle. The disk file is the source of truth; the
 * in-memory map lets `getSha` return in O(1) and `upsertMany` defer
 * disk writes until commit-time so a 1000-file index build only does
 * one rewrite.
 *
 * Use `Index.open(repoRoot)` to load (or create) and pair with a
 * single `commit()` at the end of an indexing run.
 */
export class Index {
  private byPath: Map<string, IndexEntry>;
  private dirty: boolean;

  constructor(
    public readonly path: string,
    entries: IndexEntry[],
  ) {
    this.byPath = new Map(entries.map((e) => [e.relPath, e]));
    this.dirty = false;
  }

  static open(
    repoRoot: string,
    opts: { indexRoot?: string } = {},
  ): Index {
    const path = indexPath(repoRoot, opts);
    const entries = loadAll(path);
    return new Index(path, entries);
  }

  // --- Read --------------------------------------------------------

  getSha(relPath: string): string | undefined {
    return this.byPath.get(relPath)?.sha256;
  }

  stats(): IndexStats {
    if (this.byPath.size === 0) return { entries: 0, dimension: 0 };
    const first = this.byPath.values().next().value as IndexEntry;
    return { entries: this.byPath.size, dimension: first.embedding.length };
  }

  /** Top-K rows by cosine similarity to `vector`. */
  query(vector: number[], k = 20): QueryHit[] {
    const normQ = norm(vector);
    if (normQ === 0) return [];
    const scored: Array<{ score: number; relPath: string }> = [];
    for (const entry of this.byPath.values()) {
      const n = norm(entry.embedding);
      if (n === 0) continue;
      // Defensive: dim mismatch produces nonsense scores, raise
      // rather than truncate so the operator notices and rebuilds.
      if (entry.embedding.length !== vector.length) {
        throw new Error(
          `embedding dim mismatch: ${entry.embedding.length} vs ${vector.length}; rebuild the index`,
        );
      }
      const score = dot(vector, entry.embedding) / (normQ * n);
      scored.push({ score, relPath: entry.relPath });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => ({ relPath: s.relPath, score: s.score }));
  }

  // --- Mutation ----------------------------------------------------

  upsert(entry: IndexEntry): void {
    this.byPath.set(entry.relPath, entry);
    this.dirty = true;
  }

  upsertMany(entries: IndexEntry[]): number {
    for (const e of entries) this.byPath.set(e.relPath, e);
    if (entries.length > 0) this.dirty = true;
    return entries.length;
  }

  /** Drop every row. Returns the count for caller messaging. */
  clear(): number {
    const n = this.byPath.size;
    this.byPath.clear();
    this.dirty = true;
    return n;
  }

  /**
   * Persist any pending changes to disk. Atomic: writes to a sibling
   * `.tmp` first, then renames over the canonical path so a crash
   * mid-write can't leave a half-flushed index.
   */
  commit(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    if (this.byPath.size === 0) {
      writeFileSync(tmp, "", "utf-8");
    } else {
      // Sorted by path so two builds against the same source state
      // produce byte-identical files (helps reproducibility checks
      // and makes diffs across builds easier to read).
      const sorted = [...this.byPath.values()].sort((a, b) =>
        a.relPath.localeCompare(b.relPath),
      );
      const lines = sorted.map((e) => JSON.stringify(e));
      writeFileSync(tmp, lines.join("\n") + "\n", "utf-8");
    }
    // Atomic on POSIX: the canonical path either points at the old
    // file or the new one, never a half-written state.
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}

// --- Math helpers ---------------------------------------------------

function dot(a: number[], b: number[]): number {
  // Caller ensures equal length (Index.query checks before invoking).
  // Cache locals so the inner loop doesn't have to re-resolve indexed
  // accesses across the array boundary.
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const ax = a[i] as number;
    const bx = b[i] as number;
    s += ax * bx;
  }
  return s;
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** SHA-256 of file bytes. Lets the indexer detect "no change" cheaply. */
export function fileSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
