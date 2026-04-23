/**
 * Path validation is the main security boundary in TS land. Tests make sure
 * Coder can't walk out of the repo or write to sensitive files.
 */
import { describe, expect, it } from "vitest";
import { validatePath } from "../src/sandbox/applier.js";

describe("validatePath", () => {
  const repo = "/home/user/repo";

  it("allows a simple relative path", () => {
    expect(() => validatePath(repo, "src/foo.ts")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validatePath(repo, "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects .. escapes", () => {
    expect(() => validatePath(repo, "../outside.txt")).toThrow(/outside/);
  });

  it("rejects .git writes", () => {
    expect(() => validatePath(repo, ".git/config")).toThrow(/sensitive/);
  });

  it("rejects .env writes", () => {
    expect(() => validatePath(repo, ".env")).toThrow(/sensitive/);
    expect(() => validatePath(repo, ".env.production")).toThrow(/sensitive/);
  });

  it("rejects .ssh writes", () => {
    expect(() => validatePath(repo, ".ssh/id_rsa")).toThrow(/sensitive/);
  });

  it("rejects nested .git", () => {
    expect(() => validatePath(repo, "subrepo/.git/HEAD")).toThrow(/sensitive/);
  });
});
