/**
 * End-to-end orchestrator integration tests.
 *
 * Why this file exists: the existing 24 unit-test files cover the
 * pieces (parsers, totals, snapshot, applier, providers, dashboards)
 * but nothing exercises the full `Phase 1 → Phase 2 → Phase 3` loop
 * with the orchestrator coordinating real agents on a real (tmp) git
 * repo. Refactors of `runOrchestrator` ship blind without this.
 *
 * Approach: vi.mock the provider registry so `createProvider` returns
 * our `MockProvider` (one per role, scripted FIFO). Everything else
 * runs for real — git, run-log, snapshot, totals, memory.
 *
 * Three scenarios pinned today:
 *   1. Happy path — Planner ready → 1 TODO → Coder edits → Reviewer
 *      approves → reason="complete".
 *   2. Rollback — Coder/Reviewer hit `maxReviewRounds` without approval;
 *      task gets `rolledBack=true` and the branch reverts to the
 *      starting ref.
 *   3. Budget cap — `maxCostUsd` trips after the first Planner call;
 *      orchestrator exits with reason="aborted"; snapshot persisted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider, ProviderConfig } from "../src/providers/types.js";
import type { AgentRole } from "../src/types.js";
import { MockProvider, type MockTurn } from "./helpers/mock-provider.js";
import { makeMockUi } from "./helpers/mock-ui.js";
import { makeMockRepo, type MockRepo } from "./helpers/mock-repo.js";

// --- vi.mock seam ---
//
// Each test populates `mockScripts` before calling runOrchestrator.
// The mocked createProvider hands out a fresh MockProvider per role
// using the script registered for that role.

const mockScripts: Partial<Record<AgentRole, MockTurn[]>> = {};

vi.mock("../src/providers/registry.js", async () => {
  const real = await vi.importActual<
    typeof import("../src/providers/registry.js")
  >("../src/providers/registry.js");
  return {
    ...real,
    createProvider: (cfg: ProviderConfig): Provider => {
      // The registry uses the cfg.name to pick a class; we ignore it
      // and route by the *role* the caller registered. We piggy-back on
      // a custom field set by the test harness in `agentConfig`.
      const role = (cfg as ProviderConfig & { __mockRole?: AgentRole }).__mockRole;
      if (!role) {
        throw new Error(
          "test bug: ProviderConfig missing __mockRole; tests must mark each role's cfg",
        );
      }
      const script = mockScripts[role];
      if (!script) {
        throw new Error(`test bug: no script registered for role ${role}`);
      }
      return new MockProvider(role, script);
    },
  };
});

// Import AFTER the vi.mock declaration — module ordering matters here.
import { runOrchestrator } from "../src/orchestrator.js";
import { snapshotPath } from "../src/snapshot.js";

function makeAgentConfig(): import("../src/config.js").AgentConfig {
  // Each role's cfg carries an internal __mockRole tag the mocked
  // createProvider reads to pick the right script. The real fields
  // (name/model) are present so the validators don't trip; their
  // values are ignored downstream.
  const tag = (role: AgentRole): ProviderConfig =>
    ({
      name: "anthropic",
      model: "mock",
      __mockRole: role,
    }) as ProviderConfig & { __mockRole: AgentRole };
  return { planner: tag("planner"), coder: tag("coder"), reviewer: tag("reviewer") };
}

function setScripts(scripts: Partial<Record<AgentRole, MockTurn[]>>) {
  for (const k of Object.keys(mockScripts) as AgentRole[]) delete mockScripts[k];
  Object.assign(mockScripts, scripts);
}

const PLANNER_TODOS = [
  {
    text: `## Phase: todos\n\n\`\`\`json\n${JSON.stringify({
      todos: [{ id: "T1", title: "add foo file", description: "create foo.txt" }],
    })}\n\`\`\``,
  },
];

const PLANNER_LOOP_COMPLETE = [{ text: "## Phase: complete\n\nAll done." }];

const CODER_HAPPY = [
  {
    text:
      "```json\n" +
      JSON.stringify({
        commit_message: "feat: add foo",
        rationale: "needed for T1",
        files: [{ path: "foo.txt", action: "create", content: "hi\n" }],
      }) +
      "\n```",
  },
];

const REVIEWER_APPROVE = [
  {
    text:
      "```json\n" +
      JSON.stringify({ decision: "approve", summary: "lgtm", findings: [] }) +
      "\n```",
  },
];

const REVIEWER_REQUEST_CHANGES = (n: number): MockTurn[] =>
  Array.from({ length: n }, () => ({
    text:
      "```json\n" +
      JSON.stringify({
        decision: "request_changes",
        summary: "still off",
        findings: [
          { severity: "high", file: "foo.txt", line: 1, issue: "x", suggestion: "y" },
        ],
      }) +
      "\n```",
  }));

describe("orchestrator integration", () => {
  let repo: MockRepo;

  beforeEach(() => {
    repo = makeMockRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("happy path: 1 TODO, Coder + Reviewer approve, reason=complete", async () => {
    setScripts({
      planner: [...PLANNER_TODOS, ...PLANNER_LOOP_COMPLETE],
      coder: CODER_HAPPY,
      reviewer: REVIEWER_APPROVE,
    });

    const ui = makeMockUi();
    const result = await runOrchestrator({
      config: {
        repoRoot: repo.root,
        maxClarifications: 3,
        maxReviewRounds: 3,
        maxLoops: 5,
        requireHumanApproval: false,
        sandboxEnabled: false,
        selfLearning: false,
        githubEnabled: false,
      },
      agentConfig: makeAgentConfig(),
      requirement: "create a foo file",
      ui,
    });

    expect(result.reason).toBe("complete");
    expect(result.state.todos).toHaveLength(1);
    expect(result.state.todos[0]!.status).toBe("done");
    expect(result.state.todos[0]!.rolledBack).toBeFalsy();
    expect(existsSync(join(repo.root, "foo.txt"))).toBe(true);
    expect(result.totals.overall.calls).toBeGreaterThan(0);
    expect(result.totals.perRole.coder.calls).toBe(1);
    expect(result.totals.perRole.reviewer.calls).toBe(1);
  });

  it("rollback: Coder/Reviewer exhaust maxReviewRounds → todo rolledBack", async () => {
    setScripts({
      planner: [...PLANNER_TODOS, ...PLANNER_LOOP_COMPLETE],
      coder: [...CODER_HAPPY, ...CODER_HAPPY], // Coder keeps producing the same edit
      reviewer: REVIEWER_REQUEST_CHANGES(2), // Reviewer never approves
    });

    const ui = makeMockUi();
    const result = await runOrchestrator({
      config: {
        repoRoot: repo.root,
        maxClarifications: 3,
        maxReviewRounds: 2, // tight cap for the test
        maxLoops: 3,
        requireHumanApproval: false,
        sandboxEnabled: false,
        selfLearning: false,
        githubEnabled: false,
        rollbackOnMaxRounds: true,
      },
      agentConfig: makeAgentConfig(),
      requirement: "create a foo file",
      ui,
    });

    expect(result.state.todos[0]!.rolledBack).toBe(true);
    // Branch was reverted: foo.txt is NOT on the seed commit.
    expect(existsSync(join(repo.root, "foo.txt"))).toBe(false);
  });

  it("budget cap: maxCostUsd trips → reason=aborted + snapshot persisted", async () => {
    // Tiny cap; the mock's per-call cost (anthropic rate × small token
    // counts) should still cross it after the first Planner call.
    setScripts({
      planner: [
        // First call carries large enough usage to trip the cost cap.
        {
          text: PLANNER_TODOS[0]!.text,
          inputTokens: 10_000_000, // big number → real $ via PROVIDER_RATES
          outputTokens: 100_000,
        },
        ...PLANNER_LOOP_COMPLETE,
      ],
      coder: CODER_HAPPY,
      reviewer: REVIEWER_APPROVE,
    });

    const ui = makeMockUi();
    const result = await runOrchestrator({
      config: {
        repoRoot: repo.root,
        maxClarifications: 3,
        maxReviewRounds: 3,
        maxLoops: 5,
        requireHumanApproval: false,
        sandboxEnabled: false,
        selfLearning: false,
        githubEnabled: false,
        maxCostUsd: 0.01, // pennies — guaranteed trip
      },
      agentConfig: makeAgentConfig(),
      requirement: "create a foo file",
      ui,
    });

    expect(result.reason).toBe("aborted");
    expect(existsSync(snapshotPath(repo.root))).toBe(true);
    const snap = JSON.parse(
      readFileSync(snapshotPath(repo.root), "utf-8"),
    ) as { state: { todos: unknown[] } };
    // Snapshot captured the state at abort.
    expect(snap.state).toBeDefined();
  });
});
