/**
 * Tests for the skills marketplace (W7.3).
 *
 * Stubs the fetcher with deterministic responses so the suite never
 * touches the network. Round-trips installs through real on-disk
 * `.claw-squad/skills/<id>.md` writes in temp directories.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installSkill,
  listInstalled,
  loadRegistryIndex,
  parseManifest,
  sha256Hex,
  uninstallSkill,
} from "../src/skills-registry.js";


function fakeFetch(routes: Record<string, string | { status: number }>): typeof fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const key = url.toString();
    const value = routes[key];
    if (value === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (typeof value === "object" && "status" in value) {
      return new Response("", { status: value.status });
    }
    return new Response(value, { status: 200 });
  }) as unknown as typeof fetch;
}


describe("parseManifest", () => {
  const valid = {
    id: "py-test",
    version: "1.0.0",
    description: "...",
    url: "https://example/py-test.md",
    sha256: "a".repeat(64),
  };

  it("accepts a minimal valid manifest", () => {
    const out = parseManifest(valid);
    expect(typeof out).toBe("object");
    if (typeof out !== "string") {
      expect(out.id).toBe("py-test");
      expect(out.sha256).toBe("a".repeat(64));
    }
  });

  it("rejects non-objects", () => {
    expect(parseManifest(null)).toMatch(/not an object/);
    expect(parseManifest("manifest")).toMatch(/not an object/);
  });

  it("rejects when a required field is missing", () => {
    const { description, ...without } = valid;
    expect(parseManifest(without)).toMatch(/description/);
  });

  it("rejects when sha256 is the wrong length", () => {
    expect(parseManifest({ ...valid, sha256: "deadbeef" })).toMatch(/64 hex/);
  });

  it("rejects when applyTo contains non-strings", () => {
    expect(parseManifest({ ...valid, applyTo: [1, "x"] })).toMatch(/applyTo/);
  });

  it("normalizes the sha256 to lowercase", () => {
    const out = parseManifest({ ...valid, sha256: "A".repeat(64) });
    if (typeof out !== "string") {
      expect(out.sha256).toBe("a".repeat(64));
    }
  });

  it("preserves optional fields", () => {
    const out = parseManifest({
      ...valid,
      applyTo: ["test_*.py"],
      license: "MIT",
      homepage: "https://example.com",
    });
    if (typeof out !== "string") {
      expect(out.applyTo).toEqual(["test_*.py"]);
      expect(out.license).toBe("MIT");
    }
  });
});


describe("loadRegistryIndex", () => {
  it("loads from a file:// URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-idx-"));
    const indexPath = join(root, "index.json");
    writeFileSync(
      indexPath,
      JSON.stringify([
        {
          id: "py-test", version: "1.0.0", description: "...",
          url: "https://example/py-test.md", sha256: "a".repeat(64),
        },
      ]),
      "utf-8",
    );
    const { manifests, warnings } = await loadRegistryIndex(`file://${indexPath}`);
    expect(manifests).toHaveLength(1);
    expect(warnings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("loads from an https URL via the injected fetcher", async () => {
    const fetcher = fakeFetch({
      "https://r/index.json": JSON.stringify([
        {
          id: "py-test", version: "1.0.0", description: "...",
          url: "https://example/py-test.md", sha256: "b".repeat(64),
        },
      ]),
    });
    const { manifests } = await loadRegistryIndex("https://r/index.json", fetcher);
    expect(manifests[0].id).toBe("py-test");
  });

  it("accepts both [..] and {manifests: [..]} index shapes", async () => {
    const fetcher = fakeFetch({
      "https://r/wrapped.json": JSON.stringify({
        manifests: [
          {
            id: "x", version: "1", description: "...",
            url: "https://e/x.md", sha256: "c".repeat(64),
          },
        ],
      }),
    });
    const { manifests } = await loadRegistryIndex("https://r/wrapped.json", fetcher);
    expect(manifests).toHaveLength(1);
  });

  it("collects warnings for invalid manifests but keeps loading the rest", async () => {
    const fetcher = fakeFetch({
      "https://r/index.json": JSON.stringify([
        { id: "ok", version: "1", description: "...",
          url: "https://e/ok.md", sha256: "d".repeat(64) },
        { id: "bad" /* missing fields */ },
      ]),
    });
    const { manifests, warnings } = await loadRegistryIndex(
      "https://r/index.json", fetcher,
    );
    expect(manifests.map((m) => m.id)).toEqual(["ok"]);
    expect(warnings).toHaveLength(1);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetcher = fakeFetch({ "https://r/index.json": { status: 500 } });
    await expect(
      loadRegistryIndex("https://r/index.json", fetcher),
    ).rejects.toThrow(/500/);
  });
});


describe("installSkill", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-install-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("verifies sha256 and writes the .md plus sidecar manifest", async () => {
    const body = "# python testing\n\nUse pytest.\n";
    const manifest = {
      id: "py-test", version: "1.0.0", description: "...",
      url: "https://e/py-test.md", sha256: sha256Hex(body),
    };
    const fetcher = fakeFetch({ [manifest.url]: body });
    const res = await installSkill(root, manifest, fetcher);
    expect(res.installedPath).toMatch(/\.claw-squad\/skills\/py-test\.md$/);
    expect(readFileSync(res.installedPath, "utf-8")).toBe(body);
    const sidecar = readFileSync(`${res.installedPath}.manifest.json`, "utf-8");
    expect(JSON.parse(sidecar).sha256).toBe(manifest.sha256);
  });

  it("rejects on sha256 mismatch", async () => {
    const body = "tampered body";
    const manifest = {
      id: "py-test", version: "1.0.0", description: "...",
      url: "https://e/py-test.md",
      sha256: sha256Hex("the original body"),
    };
    const fetcher = fakeFetch({ [manifest.url]: body });
    await expect(installSkill(root, manifest, fetcher)).rejects.toThrow(/sha256 mismatch/);
  });

  it("supports file:// urls for air-gapped installs", async () => {
    const body = "local skill";
    const localPath = join(root, "local.md");
    writeFileSync(localPath, body, "utf-8");
    const manifest = {
      id: "local", version: "1.0.0", description: "...",
      url: `file://${localPath}`, sha256: sha256Hex(body),
    };
    const res = await installSkill(root, manifest);
    expect(readFileSync(res.installedPath, "utf-8")).toBe(body);
  });
});


describe("uninstallSkill + listInstalled", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-list-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when no skills are installed", () => {
    expect(listInstalled(root)).toEqual([]);
  });

  it("lists installed skills, with manifest when sidecar is present", async () => {
    const dir = join(root, ".claw-squad", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "hi", "utf-8");
    writeFileSync(join(dir, "b.md"), "hi", "utf-8");
    writeFileSync(
      join(dir, "a.md.manifest.json"),
      JSON.stringify({
        id: "a", version: "1.0", description: "...",
        url: "https://x", sha256: "f".repeat(64),
      }),
      "utf-8",
    );
    const installed = listInstalled(root);
    expect(installed.map((i) => i.id)).toEqual(["a", "b"]);
    expect(installed[0].manifest?.id).toBe("a");
    expect(installed[1].manifest).toBeNull();
  });

  it("uninstall removes both the .md and the sidecar; returns false when absent", async () => {
    const body = "skill body";
    const manifest = {
      id: "rm-me", version: "1.0.0", description: "...",
      url: "https://e/rm.md", sha256: sha256Hex(body),
    };
    const fetcher = fakeFetch({ [manifest.url]: body });
    await installSkill(root, manifest, fetcher);
    expect(uninstallSkill(root, "rm-me")).toBe(true);
    expect(uninstallSkill(root, "rm-me")).toBe(false);
    expect(uninstallSkill(root, "never-existed")).toBe(false);
  });
});
