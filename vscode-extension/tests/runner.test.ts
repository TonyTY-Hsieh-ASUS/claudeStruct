/**
 * Pure-logic tests for the runner module. Doesn't import the `vscode`
 * API surface so vitest can drive it without the VS Code test runner.
 */

import { describe, expect, it, vi } from "vitest";
import { buildArgs, runCs, type CliConfig } from "../src/runner.js";


function baseConfig(over: Partial<CliConfig> = {}): CliConfig {
  return {
    cliPath: "cs",
    maxBytes: 0,
    effort: "",
    extraArgs: [],
    ...over,
  };
}


describe("buildArgs", () => {
  it("uses the default review prompt when description is empty", () => {
    const args = buildArgs({
      task: "review",
      description: "",
      config: baseConfig(),
    });
    expect(args[0]).toBe("review");
    expect(args[1]).toContain("Review");
  });

  it("forwards an explicit description verbatim", () => {
    const args = buildArgs({
      task: "review",
      description: "look for SQL injection",
      config: baseConfig(),
    });
    expect(args).toEqual(["review", "look for SQL injection"]);
  });

  it("requires a description for non-review tasks", () => {
    expect(() =>
      buildArgs({ task: "dev", description: "", config: baseConfig() }),
    ).toThrow(/dev/);
    expect(() =>
      buildArgs({ task: "plan", description: "   ", config: baseConfig() }),
    ).toThrow(/plan/);
  });

  it("appends --max-bytes only when > 0", () => {
    const noFlag = buildArgs({
      task: "review", description: "", config: baseConfig({ maxBytes: 0 }),
    });
    expect(noFlag).not.toContain("--max-bytes");
    const withFlag = buildArgs({
      task: "review", description: "",
      config: baseConfig({ maxBytes: 100000 }),
    });
    expect(withFlag).toEqual(
      expect.arrayContaining(["--max-bytes", "100000"]),
    );
  });

  it("appends --effort only when non-empty", () => {
    const noFlag = buildArgs({
      task: "review", description: "", config: baseConfig({ effort: "" }),
    });
    expect(noFlag).not.toContain("--effort");
    const withFlag = buildArgs({
      task: "review", description: "", config: baseConfig({ effort: "max" }),
    });
    expect(withFlag).toEqual(expect.arrayContaining(["--effort", "max"]));
  });

  it("appends extraArgs verbatim before paths", () => {
    const args = buildArgs({
      task: "review",
      description: "",
      paths: ["src/foo.py"],
      config: baseConfig({
        extraArgs: ["--monthly-cap-usd", "20", "--log-json", "/tmp/x.jsonl"],
      }),
    });
    // Sanity: extraArgs sits between flags and paths.
    const monthlyIdx = args.indexOf("--monthly-cap-usd");
    const pathIdx = args.indexOf("src/foo.py");
    expect(monthlyIdx).toBeGreaterThan(0);
    expect(monthlyIdx).toBeLessThan(pathIdx);
  });

  it("forwards each path positionally at the end", () => {
    const args = buildArgs({
      task: "review",
      description: "",
      paths: ["a.py", "b.py", "subdir/c.py"],
      config: baseConfig(),
    });
    expect(args.slice(-3)).toEqual(["a.py", "b.py", "subdir/c.py"]);
  });

  it("composes flags + paths in the documented order", () => {
    const args = buildArgs({
      task: "dev",
      description: "add retries",
      paths: ["src/client.py"],
      config: baseConfig({
        maxBytes: 50000,
        effort: "high",
        extraArgs: ["--monthly-cap-usd", "5"],
      }),
    });
    expect(args).toEqual([
      "dev",
      "add retries",
      "--max-bytes", "50000",
      "--effort", "high",
      "--monthly-cap-usd", "5",
      "src/client.py",
    ]);
  });
});


describe("runCs", () => {
  it("collects stdout + stderr + exit code", async () => {
    const fakeChild = makeFakeChild();
    const fakeSpawn = vi.fn().mockReturnValue(fakeChild);
    const promise = runCs(
      "cs", ["review"], "/tmp", undefined, { spawn: fakeSpawn as any },
    );
    fakeChild.stdout!.emit("data", Buffer.from("hello "));
    fakeChild.stdout!.emit("data", Buffer.from("world"));
    fakeChild.stderr!.emit("data", Buffer.from("warn: something"));
    fakeChild.emit("close", 0);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn: something");
    expect(fakeSpawn).toHaveBeenCalledWith(
      "cs", ["review"],
      expect.objectContaining({ cwd: "/tmp" }),
    );
  });

  it("streams chunks to onChunk in order", async () => {
    const fakeChild = makeFakeChild();
    const seen: Array<[string, string]> = [];
    const promise = runCs(
      "cs", ["dashboard"], "/tmp",
      (text, source) => { seen.push([source, text]); },
      { spawn: vi.fn().mockReturnValue(fakeChild) as any },
    );
    fakeChild.stdout!.emit("data", Buffer.from("row1\n"));
    fakeChild.stderr!.emit("data", Buffer.from("warn\n"));
    fakeChild.stdout!.emit("data", Buffer.from("row2\n"));
    fakeChild.emit("close", 0);
    await promise;
    expect(seen).toEqual([
      ["stdout", "row1\n"],
      ["stderr", "warn\n"],
      ["stdout", "row2\n"],
    ]);
  });

  it("rejects on spawn error", async () => {
    const fakeChild = makeFakeChild();
    const promise = runCs(
      "cs", ["review"], "/tmp", undefined,
      { spawn: vi.fn().mockReturnValue(fakeChild) as any },
    );
    fakeChild.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("rejects synchronously when spawn throws", async () => {
    const throwSpawn = vi.fn().mockImplementation(() => {
      throw new Error("permission denied");
    });
    await expect(
      runCs("cs", ["review"], "/tmp", undefined, { spawn: throwSpawn as any }),
    ).rejects.toThrow("permission denied");
  });

  it("forwards a non-zero exit code without throwing", async () => {
    const fakeChild = makeFakeChild();
    const promise = runCs(
      "cs", ["review"], "/tmp", undefined,
      { spawn: vi.fn().mockReturnValue(fakeChild) as any },
    );
    fakeChild.emit("close", 2);
    const result = await promise;
    expect(result.exitCode).toBe(2);
  });
});


/** Minimal EventEmitter stand-in shaped like a Node ChildProcess. */
function makeFakeChild() {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
