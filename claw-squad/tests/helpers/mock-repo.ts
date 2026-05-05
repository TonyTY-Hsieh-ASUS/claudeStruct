/**
 * Throwaway git repo for orchestrator integration tests.
 *
 * The orchestrator's Coder phase calls `applyAndCommit` which expects
 * a real git repo. This helper bootstraps one in a tmpdir with a
 * single seed file + a baseline commit. Used by the Phase 1 → 3 e2e
 * test scenarios so the commit / revert paths exercise real git.
 *
 * Uses spawnSync (no shell) over execSync to avoid shell-injection
 * surface — even though every argv here is a static literal, the
 * convention keeps lint hooks happy and the helper safe to extend.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MockRepo {
  root: string;
  cleanup: () => void;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

export function makeMockRepo(
  seedFiles: Record<string, string> = { "seed.txt": "seed\n" },
): MockRepo {
  const root = mkdtempSync(join(tmpdir(), "claw-orch-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  // Defeat any host-level gitconfig that forces signing; the temp repo
  // is throwaway and we don't want CI variance from gpg setup.
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgsign", "false");
  git(root, "config", "gpg.format", "openpgp");
  for (const [path, content] of Object.entries(seedFiles)) {
    writeFileSync(join(root, path), content, "utf-8");
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
