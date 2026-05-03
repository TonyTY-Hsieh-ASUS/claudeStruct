/**
 * Cross-tool JSONL export / import.
 *
 * Mirror of `claudestruct.index_io` (Python side). Same JSONL
 * schema (`{relPath, sha256, embedding}` per line, sorted by path)
 * so a `cs index export` JSONL drops straight into
 * `claw-squad index import` and vice-versa.
 *
 * Why this exists: both tools embed the same files with the same
 * model + per-file cap, but they store the result in different
 * formats (Python = SQLite, TS = JSONL). Without this bridge each
 * tool re-pays the embedding cost on a fresh checkout.
 *
 * The TS side's storage IS already JSONL, so the export is barely
 * more than a sorted re-write of the existing file. We still go
 * through `Index.iterEntries()` to keep the contract identical to
 * the Python side: byte-identical output across runs against the
 * same source state.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Index } from "./store.js";

export interface ExportStats {
  rows: number;
  outputPath: string;
}

export interface ImportStats {
  rows: number;
  skippedMalformed: number;
  inputPath: string;
}

export function exportToJsonl(
  repoRoot: string,
  outputPath: string,
  opts: { indexRoot?: string } = {},
): ExportStats {
  mkdirSync(dirname(outputPath), { recursive: true });
  const idx = Index.open(repoRoot, { indexRoot: opts.indexRoot });
  const lines: string[] = [];
  for (const e of idx.iterEntries()) {
    lines.push(JSON.stringify(e));
  }
  // Single write so an interrupted export never leaves a
  // partially-flushed file at the canonical path.
  writeFileSync(
    outputPath,
    lines.length === 0 ? "" : lines.join("\n") + "\n",
    "utf-8",
  );
  return { rows: lines.length, outputPath };
}

export function importFromJsonl(
  repoRoot: string,
  inputPath: string,
  opts: { indexRoot?: string } = {},
): ImportStats {
  const idx = Index.open(repoRoot, { indexRoot: opts.indexRoot });
  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf-8");
  } catch {
    // A missing input file is a real operator error — abort with
    // an informative throw rather than silently importing zero rows.
    throw new Error(`index import: cannot read ${inputPath}`);
  }
  let rows = 0;
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      skipped += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const rel = obj.relPath;
    const sha = obj.sha256;
    const emb = obj.embedding;
    if (
      typeof rel !== "string" ||
      typeof sha !== "string" ||
      !Array.isArray(emb) ||
      !emb.every((x) => typeof x === "number")
    ) {
      // Defensive: a non-numeric embedding value (string, null) gets
      // skipped rather than coerced. Coercion would silently produce
      // nonsense cosine scores.
      skipped += 1;
      continue;
    }
    idx.upsert({ relPath: rel, sha256: sha, embedding: emb as number[] });
    rows += 1;
  }
  idx.commit();
  return { rows, skippedMalformed: skipped, inputPath };
}
