/**
 * Tests for `src/index/io.ts` (cross-tool JSONL export/import).
 *
 * Mirror of Python's `tests/test_index_io.py`. Same JSONL schema,
 * same skip-malformed semantics — without those we'd have built two
 * incompatible bridges.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportToJsonl, importFromJsonl } from "../src/index/io.js";
import { Index } from "../src/index/store.js";

describe("exportToJsonl", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "claw-io-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("writes one JSONL row per entry, sorted by path", () => {
    const idx = Index.open("/repo", { indexRoot: parent });
    idx.upsert({ relPath: "z.ts", sha256: "z", embedding: [1, 0] });
    idx.upsert({ relPath: "a.ts", sha256: "a", embedding: [0, 1] });
    idx.upsert({ relPath: "m.ts", sha256: "m", embedding: [0.5, 0.5] });
    idx.commit();

    const out = join(parent, "shared.jsonl");
    const stats = exportToJsonl("/repo", out, { indexRoot: parent });
    expect(stats.rows).toBe(3);

    const lines = readFileSync(out, "utf-8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).relPath)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("preserves embedding values exactly (no float lossy round-trip)", () => {
    const idx = Index.open("/repo", { indexRoot: parent });
    const embedding = [0.123456789, -0.987654321, 1e-9, 1.0];
    idx.upsert({ relPath: "x.ts", sha256: "x", embedding });
    idx.commit();

    const out = join(parent, "out.jsonl");
    exportToJsonl("/repo", out, { indexRoot: parent });
    const row = JSON.parse(readFileSync(out, "utf-8").trim());
    expect(row.embedding).toEqual(embedding);
  });

  it("creates parent dirs of --out", () => {
    const idx = Index.open("/repo", { indexRoot: parent });
    idx.upsert({ relPath: "a.ts", sha256: "x", embedding: [1] });
    idx.commit();

    const out = join(parent, "deep", "nested", "out.jsonl");
    exportToJsonl("/repo", out, { indexRoot: parent });
    expect(readFileSync(out, "utf-8").length).toBeGreaterThan(0);
  });

  it("empty index writes empty file", () => {
    const out = join(parent, "out.jsonl");
    const stats = exportToJsonl("/repo", out, { indexRoot: parent });
    expect(stats.rows).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  it("output schema matches the cs index export contract", () => {
    // The cross-tool JSONL must use the keys `relPath`, `sha256`,
    // `embedding` — Python's `cs index import` reads exactly this
    // shape. A drift in either would silently turn into a 0-row
    // import on the other side.
    const idx = Index.open("/repo", { indexRoot: parent });
    idx.upsert({ relPath: "foo.ts", sha256: "bar", embedding: [1.0] });
    idx.commit();

    const out = join(parent, "out.jsonl");
    exportToJsonl("/repo", out, { indexRoot: parent });
    const row = JSON.parse(readFileSync(out, "utf-8").trim());
    expect(Object.keys(row).sort()).toEqual(
      ["embedding", "relPath", "sha256"].sort(),
    );
  });
});

describe("importFromJsonl", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "claw-io-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("round-trips with exportToJsonl into a different index", () => {
    const srcRoot = join(parent, "src");
    const dstRoot = join(parent, "dst");

    const src = Index.open("/repo", { indexRoot: srcRoot });
    src.upsert({ relPath: "a.ts", sha256: "aaa", embedding: [1, 0] });
    src.upsert({ relPath: "b.ts", sha256: "bbb", embedding: [0, 1] });
    src.commit();

    const bridge = join(parent, "bridge.jsonl");
    exportToJsonl("/repo", bridge, { indexRoot: srcRoot });
    const stats = importFromJsonl("/repo", bridge, { indexRoot: dstRoot });
    expect(stats.rows).toBe(2);
    expect(stats.skippedMalformed).toBe(0);

    const dst = Index.open("/repo", { indexRoot: dstRoot });
    expect(dst.getSha("a.ts")).toBe("aaa");
    expect(dst.getSha("b.ts")).toBe("bbb");
    // Cosine query on the destination should find the right row —
    // proves the embedding survived the JSON round-trip intact.
    const hits = dst.query([1, 0], 1);
    expect(hits[0].relPath).toBe("a.ts");
  });

  it("overwrites existing rows on key conflict", () => {
    const idx = Index.open("/repo", { indexRoot: parent });
    idx.upsert({ relPath: "a.ts", sha256: "old", embedding: [1, 0] });
    idx.commit();

    const bridge = join(parent, "bridge.jsonl");
    writeFileSync(
      bridge,
      JSON.stringify({ relPath: "a.ts", sha256: "new", embedding: [0, 1] }) +
        "\n",
      "utf-8",
    );
    importFromJsonl("/repo", bridge, { indexRoot: parent });

    const reopened = Index.open("/repo", { indexRoot: parent });
    expect(reopened.stats().entries).toBe(1);
    expect(reopened.getSha("a.ts")).toBe("new");
  });

  it("skips malformed lines without aborting", () => {
    const bridge = join(parent, "bridge.jsonl");
    writeFileSync(
      bridge,
      [
        JSON.stringify({ relPath: "good1.ts", sha256: "x", embedding: [1] }),
        "{not-json,broken",
        JSON.stringify({ relPath: "missing-fields.ts" }),
        JSON.stringify([1, 2, 3]), // not a dict
        JSON.stringify({ relPath: "good2.ts", sha256: "y", embedding: [1] }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const stats = importFromJsonl("/repo", bridge, { indexRoot: parent });
    expect(stats.rows).toBe(2);
    expect(stats.skippedMalformed).toBe(3);
  });

  it("rejects rows whose embedding contains non-numeric values", () => {
    // Coercing strings to floats would silently corrupt cosine
    // ranking. Skip + count instead.
    const bridge = join(parent, "bridge.jsonl");
    writeFileSync(
      bridge,
      JSON.stringify({
        relPath: "x.ts",
        sha256: "x",
        embedding: ["1.0", "2.0"],
      }) + "\n",
      "utf-8",
    );
    const stats = importFromJsonl("/repo", bridge, { indexRoot: parent });
    expect(stats.rows).toBe(0);
    expect(stats.skippedMalformed).toBe(1);
  });

  it("handles empty file", () => {
    const bridge = join(parent, "empty.jsonl");
    writeFileSync(bridge, "", "utf-8");
    const stats = importFromJsonl("/repo", bridge, { indexRoot: parent });
    expect(stats.rows).toBe(0);
    expect(stats.skippedMalformed).toBe(0);
  });

  it("throws when input file doesn't exist", () => {
    expect(() =>
      importFromJsonl("/repo", join(parent, "missing.jsonl"), {
        indexRoot: parent,
      }),
    ).toThrow(/cannot read/);
  });
});
