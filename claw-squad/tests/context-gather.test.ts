/**
 * Context-gather tests. These don't actually shell out to git — we test
 * the pure keyword/path extraction, since that's where the real logic
 * lives. The git.ls-files integration is exercised via the orchestrator
 * path (which tests cover indirectly through snapshot + applier tests).
 */

import { describe, expect, it } from "vitest";
import {
  extractKeywords,
  extractPathTokens,
} from "../src/context-gather.js";

describe("extractKeywords", () => {
  it("returns lowercase tokens longer than 2 chars", () => {
    const kws = extractKeywords("Add a login handler to the auth module");
    expect(kws).toContain("login");
    expect(kws).toContain("handler");
    expect(kws).toContain("auth");
    expect(kws).toContain("module");
  });

  it("filters stopwords and short tokens", () => {
    const kws = extractKeywords("the add of in to on at a an or and but");
    expect(kws).toEqual([]);
  });

  it("deduplicates", () => {
    const kws = extractKeywords("login login Login LOGIN");
    expect(kws).toEqual(["login"]);
  });

  it("handles identifiers with underscores and dots", () => {
    const kws = extractKeywords("update user_profile.ts with validate_email()");
    expect(kws).toContain("user_profile.ts");
    expect(kws).toContain("validate_email");
  });
});

describe("extractPathTokens", () => {
  it("finds .ts file references", () => {
    const paths = extractPathTokens("edit src/api/users.ts to add caching");
    expect(paths).toContain("src/api/users.ts");
  });

  it("finds multiple paths and dedups", () => {
    const paths = extractPathTokens(
      "update a.ts and b.ts, then retouch a.ts",
    );
    expect(paths).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(paths).toHaveLength(2);
  });

  it("recognizes common source extensions", () => {
    const paths = extractPathTokens(
      "touch main.go, lib/util.py, Cargo.toml, README.md, style.css",
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "main.go",
        "lib/util.py",
        "Cargo.toml",
        "README.md",
        "style.css",
      ]),
    );
  });

  it("returns empty for prose with no paths", () => {
    expect(extractPathTokens("fix the bug in the login flow")).toEqual([]);
  });
});
