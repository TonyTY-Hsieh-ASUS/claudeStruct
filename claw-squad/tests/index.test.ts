/**
 * Tests for `src/index/{embed,store,build}.ts`.
 *
 * No real Ollama. The fake `EmbeddingClient` returns deterministic
 * unit vectors so the index + cosine ranking can be exercised end-
 * to-end without spinning up a server.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildIndex,
  smartPaths,
  watchIndex,
} from "../src/index/build.js";
import {
  createEmbeddingClient,
  defaultEmbeddingClient,
  EmbeddingError,
} from "../src/index/embed.js";
import {
  fileSha256,
  Index,
  indexPath,
  loadAll,
  repoFingerprint,
} from "../src/index/store.js";

// --- repoFingerprint / indexPath -----------------------------------

describe("repoFingerprint", () => {
  it("produces a stable 16-char hex id", () => {
    const a = repoFingerprint("/some/repo");
    const b = repoFingerprint("/some/repo");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs across different repo paths", () => {
    expect(repoFingerprint("/repo/a")).not.toBe(repoFingerprint("/repo/b"));
  });
});

describe("indexPath", () => {
  it("respects CLAW_SQUAD_INDEX_DIR via explicit override", () => {
    const p = indexPath("/repo", { indexRoot: "/custom/root" });
    expect(p.startsWith("/custom/root/")).toBe(true);
    expect(p.endsWith(".jsonl")).toBe(true);
  });
});

// --- Index store ---------------------------------------------------

describe("Index store", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-idx-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips an upsert and persists across reopen", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "foo.ts", sha256: "aaa", embedding: [0.1, 0.2, 0.3] });
    idx.commit();

    const reopened = Index.open("/repo", { indexRoot: root });
    expect(reopened.getSha("foo.ts")).toBe("aaa");
    expect(reopened.stats()).toEqual({ entries: 1, dimension: 3 });
  });

  it("upsert replaces existing rows", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "foo.ts", sha256: "v1", embedding: [1, 0] });
    idx.upsert({ relPath: "foo.ts", sha256: "v2", embedding: [0, 1] });
    expect(idx.stats().entries).toBe(1);
    expect(idx.getSha("foo.ts")).toBe("v2");
  });

  it("commit is a no-op when nothing changed", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.commit();
    // No file was created because nothing was dirty.
    expect(existsSync(indexPath("/repo", { indexRoot: root }))).toBe(false);
  });

  it("clear empties the in-memory map and persists on commit", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "a.ts", sha256: "x", embedding: [1] });
    idx.upsert({ relPath: "b.ts", sha256: "y", embedding: [1] });
    idx.commit();

    const reopened = Index.open("/repo", { indexRoot: root });
    expect(reopened.clear()).toBe(2);
    reopened.commit();
    expect(Index.open("/repo", { indexRoot: root }).stats().entries).toBe(0);
  });

  it("loadAll skips corrupt JSONL lines", () => {
    const path = indexPath("/repo", { indexRoot: root });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ relPath: "good.ts", sha256: "x", embedding: [1, 0] }),
        "{not-json,broken}",
        JSON.stringify({ relPath: "good2.ts", sha256: "y", embedding: [0, 1] }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const entries = loadAll(path);
    expect(entries.map((e) => e.relPath)).toEqual(["good.ts", "good2.ts"]);
  });

  it("commit produces deterministic output (sorted by path)", () => {
    const path = indexPath("/repo", { indexRoot: root });
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "z.ts", sha256: "z", embedding: [1] });
    idx.upsert({ relPath: "a.ts", sha256: "a", embedding: [1] });
    idx.upsert({ relPath: "m.ts", sha256: "m", embedding: [1] });
    idx.commit();
    const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).relPath)).toEqual([
      "a.ts",
      "m.ts",
      "z.ts",
    ]);
  });
});

// --- Cosine ranking -----------------------------------------------

describe("Index.query", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-idx-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the nearest entry first", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "east.ts", sha256: "e", embedding: [1, 0] });
    idx.upsert({
      relPath: "ne.ts",
      sha256: "n",
      embedding: [Math.SQRT1_2, Math.SQRT1_2],
    });
    idx.upsert({ relPath: "north.ts", sha256: "N", embedding: [0, 1] });
    const hits = idx.query([1, 0], 3);
    expect(hits.map((h) => h.relPath)).toEqual(["east.ts", "ne.ts", "north.ts"]);
    expect(hits[0].score).toBeCloseTo(1, 9);
    expect(hits[2].score).toBeCloseTo(0, 9);
  });

  it("respects k", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    for (let i = 0; i < 5; i++) {
      idx.upsert({ relPath: `f${i}.ts`, sha256: String(i), embedding: [1, 0] });
    }
    expect(idx.query([1, 0], 3).length).toBe(3);
  });

  it("zero-vector query returns empty", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "a.ts", sha256: "x", embedding: [1, 0] });
    expect(idx.query([0, 0], 5)).toEqual([]);
  });

  it("skips zero-norm rows", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "good.ts", sha256: "g", embedding: [1, 0] });
    idx.upsert({ relPath: "zero.ts", sha256: "z", embedding: [0, 0] });
    expect(idx.query([1, 0], 5).map((h) => h.relPath)).toEqual(["good.ts"]);
  });

  it("dim mismatch raises rather than truncating silently", () => {
    const idx = Index.open("/repo", { indexRoot: root });
    idx.upsert({ relPath: "a.ts", sha256: "x", embedding: [1, 0, 0] });
    expect(() => idx.query([1, 0], 1)).toThrow(/dim mismatch/);
  });
});

// --- fileSha256 ----------------------------------------------------

describe("fileSha256", () => {
  it("is stable across calls", () => {
    expect(fileSha256("hello")).toBe(fileSha256("hello"));
    expect(fileSha256("hello").length).toBe(64);
  });
  it("differs for different content", () => {
    expect(fileSha256("a")).not.toBe(fileSha256("b"));
  });
});

// --- Embedding client wire format ---------------------------------

describe("EmbeddingClient", () => {
  it("short-circuits on empty input (no HTTP call)", async () => {
    const client = createEmbeddingClient({
      baseUrl: "http://does-not-resolve.invalid:1/v1",
    });
    expect(await client.embedBatch([])).toEqual([]);
  });

  it("posts the OpenAI shape and parses the response", async () => {
    const seen: { url?: string; body?: string; auth?: string } = {};
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = init.body as string;
      seen.auth = (init.headers as Record<string, string>).authorization;
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const client = createEmbeddingClient({
        baseUrl: "http://example/v1/",
        model: "test-model",
        apiKey: "sk-test",
      });
      const out = await client.embedBatch(["hello", "world"]);
      expect(out).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
      expect(seen.url).toBe("http://example/v1/embeddings");
      expect(seen.auth).toBe("Bearer sk-test");
      const parsed = JSON.parse(seen.body!);
      expect(parsed.model).toBe("test-model");
      expect(parsed.input).toEqual(["hello", "world"]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("wraps non-2xx responses in EmbeddingError", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("model not found", { status: 404 }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const client = createEmbeddingClient({ baseUrl: "http://x/v1" });
      await expect(client.embedBatch(["q"])).rejects.toBeInstanceOf(
        EmbeddingError,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("rejects when the response misses the data array", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const client = createEmbeddingClient({ baseUrl: "http://x/v1" });
      await expect(client.embedBatch(["q"])).rejects.toBeInstanceOf(
        EmbeddingError,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("rejects when length mismatch (server bug guard)", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [1] }] }),
          { status: 200 },
        ),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const client = createEmbeddingClient({ baseUrl: "http://x/v1" });
      await expect(client.embedBatch(["a", "b"])).rejects.toBeInstanceOf(
        EmbeddingError,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("defaultEmbeddingClient env passthrough", () => {
  const original = {
    base: process.env.CLAW_SQUAD_EMBED_BASE_URL,
    model: process.env.CLAW_SQUAD_EMBED_MODEL,
    key: process.env.CLAW_SQUAD_EMBED_API_KEY,
  };
  afterEach(() => {
    process.env.CLAW_SQUAD_EMBED_BASE_URL = original.base;
    process.env.CLAW_SQUAD_EMBED_MODEL = original.model;
    process.env.CLAW_SQUAD_EMBED_API_KEY = original.key;
  });

  it("reads CLAW_SQUAD_EMBED_BASE_URL / MODEL", () => {
    process.env.CLAW_SQUAD_EMBED_BASE_URL = "http://example:9/v1";
    process.env.CLAW_SQUAD_EMBED_MODEL = "my-embed";
    const c = defaultEmbeddingClient();
    expect(c.baseUrl).toBe("http://example:9/v1");
    expect(c.model).toBe("my-embed");
  });
});

// --- buildIndex / smartPaths -------------------------------------

class FakeEmbed {
  // Deterministic stand-in for a real endpoint: returns a unit vector
  // whose hot axis is `hash(text) % dim`. Sufficient to drive cosine
  // ranking in tests without touching the network.
  readonly model = "fake";
  readonly baseUrl = "fake://";
  constructor(private readonly dim = 8) {}
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let h = 0;
      for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) | 0;
      const idx = ((h % this.dim) + this.dim) % this.dim;
      const v = new Array(this.dim).fill(0);
      v[idx] = 1;
      return v;
    });
  }
}

function makeRepo(parent: string): string {
  const repo = mkdtempSync(join(parent, "repo-"));
  // Real git repo so context-gather's `git ls-files` returns the
  // tracked-files list. Without a checkout, the indexer emits 0
  // walked — that's a separate test below.
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "alpha.ts"), "export function alpha() {}\n");
  writeFileSync(join(repo, "beta.ts"), "export function beta() {}\n");
  execSync("git add -A && git -c commit.gpgsign=false commit -q -m init", {
    cwd: repo,
  });
  return repo;
}

describe("buildIndex", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "claw-build-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("walks tracked source files and embeds them", async () => {
    const repo = makeRepo(parent);
    const stats = await buildIndex(repo, {
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
    });
    expect(stats.walked).toBe(2);
    expect(stats.embedded).toBe(2);
    expect(stats.skippedUnchanged).toBe(0);
    const idx = Index.open(repo, { indexRoot: join(parent, "idx") });
    expect(idx.stats().entries).toBe(2);
  });

  it("skips unchanged files on second build", async () => {
    const repo = makeRepo(parent);
    const fake = new FakeEmbed();
    await buildIndex(repo, { client: fake, indexRoot: join(parent, "idx") });
    const second = await buildIndex(repo, {
      client: fake,
      indexRoot: join(parent, "idx"),
    });
    expect(second.embedded).toBe(0);
    expect(second.skippedUnchanged).toBe(2);
  });

  it("re-embeds after edit", async () => {
    const repo = makeRepo(parent);
    const fake = new FakeEmbed();
    await buildIndex(repo, { client: fake, indexRoot: join(parent, "idx") });
    writeFileSync(join(repo, "alpha.ts"), "export function alpha() { return 99; }\n");
    const second = await buildIndex(repo, {
      client: fake,
      indexRoot: join(parent, "idx"),
    });
    expect(second.embedded).toBe(1);
    expect(second.skippedUnchanged).toBe(1);
  });

  it("returns 0-walked when the directory isn't a git repo", async () => {
    const notARepo = mkdtempSync(join(parent, "plain-"));
    writeFileSync(join(notARepo, "x.ts"), "");
    const stats = await buildIndex(notARepo, {
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
    });
    expect(stats.walked).toBe(0);
  });
});

describe("smartPaths", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "claw-smart-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("returns top-K matches for a query", async () => {
    const repo = makeRepo(parent);
    const fake = new FakeEmbed();
    await buildIndex(repo, { client: fake, indexRoot: join(parent, "idx") });
    const paths = await smartPaths(repo, "alpha", {
      k: 1,
      client: fake,
      indexRoot: join(parent, "idx"),
    });
    expect(paths.length).toBe(1);
  });

  it("returns empty when the index hasn't been built yet", async () => {
    const repo = makeRepo(parent);
    const paths = await smartPaths(repo, "anything", {
      k: 5,
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
    });
    expect(paths).toEqual([]);
  });
});

// --- watchIndex (W10.5d TS-side) ----------------------------------
//
// Mirror of `tests/test_index_watch.py`. The watch loop is a poll
// around `buildIndex`; we use the same `maxIterations` + `sleep`
// injection points the Python side has.

describe("watchIndex", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "claw-watch-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("runs maxIterations passes then returns", async () => {
    const repo = makeRepo(parent);
    const n = await watchIndex(repo, {
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
      maxIterations: 3,
      sleep: async () => {},
    });
    expect(n).toBe(3);
  });

  it("calls sleep between iterations (3 passes = 2 sleeps)", async () => {
    // The post-loop sleep is short-circuited by the maxIterations
    // check, mirroring the Python side's contract.
    const repo = makeRepo(parent);
    const sleeps: number[] = [];
    await watchIndex(repo, {
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
      intervalS: 0.42,
      maxIterations: 3,
      sleep: async (s) => {
        sleeps.push(s);
      },
    });
    expect(sleeps).toEqual([0.42, 0.42]);
  });

  it("second pass embeds 0 (sha-skip on disk-resident index)", async () => {
    const repo = makeRepo(parent);
    const calls: number[] = [];
    class CountingEmbed extends FakeEmbed {
      override async embedBatch(texts: string[]): Promise<number[][]> {
        calls.push(texts.length);
        return super.embedBatch(texts);
      }
    }
    await watchIndex(repo, {
      client: new CountingEmbed(),
      indexRoot: join(parent, "idx"),
      maxIterations: 3,
      sleep: async () => {},
    });
    // First pass embeds 2 files; subsequent passes find unchanged
    // shas and embed 0. The exact sequence proves the loop is
    // sharing state via the disk-resident index.
    expect(calls).toEqual([2]);
  });

  it("re-embeds after a mid-loop edit", async () => {
    const repo = makeRepo(parent);
    const calls: number[] = [];
    class CountingEmbed extends FakeEmbed {
      override async embedBatch(texts: string[]): Promise<number[][]> {
        calls.push(texts.length);
        return super.embedBatch(texts);
      }
    }
    let cycle = 0;
    await watchIndex(repo, {
      client: new CountingEmbed(),
      indexRoot: join(parent, "idx"),
      maxIterations: 3,
      sleep: async () => {
        cycle += 1;
        if (cycle === 1) {
          writeFileSync(
            join(repo, "alpha.ts"),
            "export function alpha() { return 99; }\n",
          );
        }
      },
    });
    // Pass 1 embeds 2; pass 2 (after edit) embeds 1; pass 3 finds
    // the new sha already stored and embeds 0.
    expect(calls).toEqual([2, 1]);
  });

  it("survives an EmbeddingError on a single pass", async () => {
    const repo = makeRepo(parent);
    let pass = 0;
    class FlakyEmbed extends FakeEmbed {
      override async embedBatch(texts: string[]): Promise<number[][]> {
        pass += 1;
        if (pass === 1) {
          throw new EmbeddingError("ollama not running");
        }
        return super.embedBatch(texts);
      }
    }
    const msgs: string[] = [];
    const n = await watchIndex(repo, {
      client: new FlakyEmbed(),
      indexRoot: join(parent, "idx"),
      maxIterations: 2,
      sleep: async () => {},
      onProgress: (m) => msgs.push(m),
    });
    expect(n).toBe(2);
    expect(msgs.some((m) => m.includes("embedding endpoint failed"))).toBe(
      true,
    );
    expect(msgs.some((m) => m.includes("embedded 2"))).toBe(true);
  });

  it("non-Embedding errors surface (not silently swallowed)", async () => {
    // A bug in the storage layer (or a TypeError from a refactor)
    // shouldn't get hidden behind the embed-error retry. Lock the
    // contract that only EmbeddingError is caught.
    const repo = makeRepo(parent);
    class BoomEmbed extends FakeEmbed {
      override async embedBatch(_texts: string[]): Promise<number[][]> {
        throw new TypeError("internal bug");
      }
    }
    await expect(
      watchIndex(repo, {
        client: new BoomEmbed(),
        indexRoot: join(parent, "idx"),
        maxIterations: 2,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("maxIterations=0 returns immediately without calling sleep", async () => {
    const repo = makeRepo(parent);
    let sleepCalled = false;
    const n = await watchIndex(repo, {
      client: new FakeEmbed(),
      indexRoot: join(parent, "idx"),
      maxIterations: 0,
      sleep: async () => {
        sleepCalled = true;
      },
    });
    expect(n).toBe(0);
    expect(sleepCalled).toBe(false);
  });
});
