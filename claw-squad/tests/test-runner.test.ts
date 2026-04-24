/**
 * test-runner tests. We shell out to /bin/sh in the real child process
 * since the whole point is to verify that. No mocks — these are
 * integration tests against the host shell.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTestCommand, runTests } from "../src/test-runner.js";

describe("runTests", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when no command is set", () => {
    const r = runTests({ repoRoot: root, command: undefined, sandboxEnabled: false });
    expect(r).toBeUndefined();
  });

  it("returns passed=true on exit 0", () => {
    const r = runTests({
      repoRoot: root,
      command: "true",
      sandboxEnabled: false,
    });
    expect(r?.passed).toBe(true);
    expect(r?.exitCode).toBe(0);
  });

  it("returns passed=false on non-zero exit and captures output", () => {
    const r = runTests({
      repoRoot: root,
      command: "echo 'bad'; exit 1",
      sandboxEnabled: false,
    });
    expect(r?.passed).toBe(false);
    expect(r?.exitCode).toBe(1);
    expect(r?.output).toContain("bad");
  });

  it("honors timeoutMs", () => {
    const r = runTests({
      repoRoot: root,
      command: "sleep 5",
      timeoutMs: 200,
      sandboxEnabled: false,
    });
    expect(r?.passed).toBe(false);
  });

  it("truncates very long output", () => {
    const r = runTests({
      repoRoot: root,
      // Produce ~30 KB of output.
      command: "head -c 30000 /dev/urandom | base64",
      maxOutputBytes: 2000,
      sandboxEnabled: false,
    });
    expect(r?.output.length).toBeLessThanOrEqual(2200); // head+tail + marker
    expect(r?.output).toContain("truncated");
  });

  it("runs in repoRoot", () => {
    writeFileSync(join(root, "marker.txt"), "hello", "utf-8");
    const r = runTests({
      repoRoot: root,
      command: "cat marker.txt",
      sandboxEnabled: false,
    });
    expect(r?.output).toContain("hello");
  });
});

describe("detectTestCommand", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-det-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects npm test when package.json exists", () => {
    writeFileSync(join(root, "package.json"), "{}");
    expect(detectTestCommand(root)).toContain("npm");
  });

  it("detects pytest for Python projects", () => {
    writeFileSync(join(root, "pyproject.toml"), "");
    expect(detectTestCommand(root)).toContain("pytest");
  });

  it("detects go test for go.mod", () => {
    writeFileSync(join(root, "go.mod"), "module x");
    expect(detectTestCommand(root)).toContain("go test");
  });

  it("returns undefined for an empty repo", () => {
    expect(detectTestCommand(root)).toBeUndefined();
  });

  it("prefers package.json over Makefile", () => {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
    expect(detectTestCommand(root)).toContain("npm");
  });
});
