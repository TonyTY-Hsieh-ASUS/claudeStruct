/**
 * Ink-based TUI. Opt-in via --tui.
 *
 * Architecture:
 *   - `TuiUi` is a class that implements the orchestrator's
 *     UserInterface. It wires each UI call (log / streamAgent /
 *     askClarifications / confirm) into React state updates on a
 *     mounted Ink tree.
 *   - The Ink <App/> component reads that state and re-renders.
 *   - For interactive prompts (confirm / clarifications) we use Ink's
 *     useInput. Each prompt blocks the orchestrator via an unresolved
 *     Promise; pressing Enter / y / n resolves it.
 *
 * Keyboard shortcuts (PR-3):
 *   q              — graceful quit (sets budgetExceeded; orchestrator
 *                    exits at next checkBudget).
 *   j / k          — scroll the activity pane.
 *   p c r a        — filter activity by role (planner / coder /
 *                    reviewer / all).
 *   s              — filter by subagent.
 *   ?              — toggle help overlay.
 *
 * Per-role cost tracking lives in the header so "who is burning the
 * budget" is visible at a glance — same four buckets the CLI summary
 * uses after a run.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import {
  ROLE_BUCKETS,
  type AgentRole,
  type RoleBucket,
  type SquadState,
} from "../types.js";
import type { UserInterface } from "../orchestrator.js";

interface LogLine {
  id: number;
  /** Role tag, if any. `undefined` means a plain orchestrator log line. */
  role?: RoleBucket | "orchestrator";
  ts: string;
  text: string;
}

interface AppProps {
  state: TuiState;
  subscribe: (fn: () => void) => () => void;
}

interface PerRoleTotal {
  calls: number;
  costUsd: number;
}

interface TuiState {
  logs: LogLine[];
  streamBuffer: string;
  activeRole: AgentRole | "idle";
  /** Name of the currently-running subagent, or undefined. */
  inflightSubagent?: string;
  /** Skills activated for the current task. */
  activeSkills: string[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  };
  perRole: Record<RoleBucket, PerRoleTotal>;
  squadState?: SquadState;
  pendingPrompt?: PendingPrompt;
  /** Filter applied to the activity pane. undefined = show all. */
  filter?: RoleBucket;
  /** Lines skipped from the tail by j/k scrolling. */
  scrollOffset: number;
  helpVisible: boolean;
  /** Resolves the quit promise when the user presses `q`. */
  quitRequested: boolean;
}

type PendingPrompt =
  | { kind: "confirm"; message: string; resolve: (ok: boolean) => void }
  | {
      kind: "clarifications";
      questions: string[];
      answers: string[];
      currentIndex: number;
      buffer: string;
      resolve: (answers: string[]) => void;
    };

function emptyPerRole(): Record<RoleBucket, PerRoleTotal> {
  const out = {} as Record<RoleBucket, PerRoleTotal>;
  for (const b of ROLE_BUCKETS) out[b] = { calls: 0, costUsd: 0 };
  return out;
}

/**
 * Subscription model: TuiUi mutates `currentState` in place and calls
 * every subscriber. React hooks subscribe in App to force a re-render.
 * Using a plain object + subscribers (instead of a full store lib)
 * keeps the dep list tight.
 */
class Store {
  state: TuiState = {
    logs: [],
    streamBuffer: "",
    activeRole: "idle",
    activeSkills: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    perRole: emptyPerRole(),
    scrollOffset: 0,
    helpVisible: false,
    quitRequested: false,
  };
  private subscribers = new Set<() => void>();
  private nextId = 1;
  onQuit?: () => void;

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };

  private notify(): void {
    for (const s of this.subscribers) s();
  }

  appendLog(text: string, role?: LogLine["role"]): void {
    const logs = [
      ...this.state.logs,
      {
        id: this.nextId++,
        role,
        ts: timestamp(),
        text: stripTrailingNewlines(text),
      },
    ];
    while (logs.length > 500) logs.shift();
    this.state = { ...this.state, logs };
    this.notify();
  }

  appendStream(role: AgentRole, chunk: string): void {
    const combined = this.state.streamBuffer + chunk;
    const parts = combined.split("\n");
    const carry = parts.pop() ?? "";
    const newLogs = parts.map((p) => ({
      id: this.nextId++,
      role: role as RoleBucket,
      ts: timestamp(),
      text: p,
    }));
    const logs = [...this.state.logs, ...newLogs];
    while (logs.length > 500) logs.shift();
    this.state = {
      ...this.state,
      logs,
      streamBuffer: carry,
      activeRole: role,
    };
    this.notify();
  }

  setActive(role: AgentRole | "idle"): void {
    this.state = { ...this.state, activeRole: role };
    this.notify();
  }

  setInflightSubagent(name: string | undefined): void {
    this.state = { ...this.state, inflightSubagent: name };
    this.notify();
  }

  setActiveSkills(names: string[]): void {
    this.state = { ...this.state, activeSkills: names };
    this.notify();
  }

  addUsage(
    role: RoleBucket,
    delta: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
    },
  ): void {
    const t = this.state.tokens;
    const existing = this.state.perRole[role];
    const perRole = {
      ...this.state.perRole,
      [role]: {
        calls: existing.calls + 1,
        costUsd: existing.costUsd + delta.costUsd,
      },
    };
    this.state = {
      ...this.state,
      tokens: {
        input: t.input + delta.input,
        output: t.output + delta.output,
        cacheRead: t.cacheRead + delta.cacheRead,
        cacheWrite: t.cacheWrite + delta.cacheWrite,
        costUsd: t.costUsd + delta.costUsd,
      },
      perRole,
    };
    this.notify();
  }

  setSquadState(s: SquadState): void {
    this.state = { ...this.state, squadState: { ...s, todos: [...s.todos] } };
    this.notify();
  }

  setPending(p: PendingPrompt | undefined): void {
    this.state = { ...this.state, pendingPrompt: p };
    this.notify();
  }

  setFilter(filter?: RoleBucket): void {
    this.state = { ...this.state, filter, scrollOffset: 0 };
    this.notify();
  }

  scroll(delta: number): void {
    const next = Math.max(0, this.state.scrollOffset + delta);
    this.state = { ...this.state, scrollOffset: next };
    this.notify();
  }

  toggleHelp(): void {
    this.state = { ...this.state, helpVisible: !this.state.helpVisible };
    this.notify();
  }

  requestQuit(): void {
    this.state = { ...this.state, quitRequested: true };
    this.notify();
    this.onQuit?.();
  }
}

const App: React.FC<AppProps> = ({ state, subscribe }) => {
  const [, forceRender] = useState(0);
  useEffect(
    () => subscribe(() => forceRender((n) => n + 1)),
    [subscribe],
  );

  // Global hotkeys: only active when no prompt is pending. useInput is
  // conditional via the `isActive` option so clarifications can own
  // keystrokes without fighting us for them.
  useInput(
    (input, key) => {
      if (input === "?") {
        store.toggleHelp();
        return;
      }
      if (input === "q") {
        store.requestQuit();
        return;
      }
      if (input === "j" || key.downArrow) {
        store.scroll(-1);
        return;
      }
      if (input === "k" || key.upArrow) {
        store.scroll(1);
        return;
      }
      if (input === "a") store.setFilter(undefined);
      else if (input === "p") store.setFilter("planner");
      else if (input === "c") store.setFilter("coder");
      else if (input === "r") store.setFilter("reviewer");
      else if (input === "s") store.setFilter("subagent");
    },
    { isActive: !state.pendingPrompt },
  );

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Header, { state }),
    React.createElement(SubagentBadge, {
      name: state.inflightSubagent,
      skills: state.activeSkills,
    }),
    React.createElement(TodoPanel, { todos: state.squadState?.todos ?? [] }),
    React.createElement(ActivityPane, {
      logs: state.logs,
      filter: state.filter,
      scrollOffset: state.scrollOffset,
    }),
    state.helpVisible ? React.createElement(HelpOverlay) : null,
    state.pendingPrompt
      ? React.createElement(PendingPromptView, { pending: state.pendingPrompt })
      : null,
    state.quitRequested
      ? React.createElement(
          Text,
          { dimColor: true },
          "[q] quit requested — orchestrator will exit at next checkpoint…",
        )
      : null,
  );
};

const Header: React.FC<{ state: TuiState }> = ({ state }) => {
  const t = state.tokens;
  const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const cells = ROLE_BUCKETS.map((b) => {
    const r = state.perRole[b];
    return `${b}:${r.calls}×/$${r.costUsd.toFixed(3)}`;
  }).join("  ");
  return React.createElement(
    Box,
    { borderStyle: "round", padding: 1, marginBottom: 1 },
    React.createElement(
      Box,
      { flexDirection: "column", width: "100%" },
      React.createElement(
        Text,
        { bold: true, color: "cyan" },
        `claw-squad  •  active: ${state.activeRole}  •  ?=help`,
      ),
      React.createElement(
        Text,
        null,
        `in ${t.input.toLocaleString()}  out ${t.output.toLocaleString()}  cache ${t.cacheRead.toLocaleString()}↓/${t.cacheWrite.toLocaleString()}↑  total ${totalTokens.toLocaleString()}  $${t.costUsd.toFixed(4)}`,
      ),
      React.createElement(Text, { dimColor: true }, cells),
    ),
  );
};

const SubagentBadge: React.FC<{ name?: string; skills: string[] }> = ({
  name,
  skills,
}) => {
  if (!name && skills.length === 0) return null;
  const parts: string[] = [];
  if (name) parts.push(`subagent: ${name}`);
  if (skills.length > 0) parts.push(`skills: ${skills.join(", ")}`);
  return React.createElement(
    Box,
    { paddingX: 1, marginBottom: 1 },
    React.createElement(Text, { color: "magenta" }, parts.join("  •  ")),
  );
};

const TodoPanel: React.FC<{ todos: SquadState["todos"] }> = ({ todos }) => {
  if (todos.length === 0) return null;
  return React.createElement(
    Box,
    {
      borderStyle: "single",
      paddingX: 1,
      flexDirection: "column",
      marginBottom: 1,
    },
    React.createElement(Text, { bold: true }, "TODO"),
    ...todos.map((t) =>
      React.createElement(
        Text,
        { key: t.id, color: colorForStatus(t.status) },
        `  ${statusGlyph(t.status)} ${t.id}  ${t.title}${t.mergedPrNumber ? `  (PR #${t.mergedPrNumber})` : ""}${t.rolledBack ? "  ↺" : ""}`,
      ),
    ),
  );
};

const ActivityPane: React.FC<{
  logs: LogLine[];
  filter?: RoleBucket;
  scrollOffset: number;
}> = ({ logs, filter, scrollOffset }) => {
  const filtered = filter ? logs.filter((l) => l.role === filter) : logs;
  const windowSize = 20;
  const end = filtered.length - scrollOffset;
  const start = Math.max(0, end - windowSize);
  const tail = filtered.slice(start, end);
  const label = filter ? `activity [${filter}]` : "activity";
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { dimColor: true },
      `${label} — showing ${tail.length}/${filtered.length}${scrollOffset > 0 ? ` (scrolled +${scrollOffset})` : ""}`,
    ),
    ...tail.map((l) =>
      React.createElement(
        Text,
        { key: l.id, color: colorForRole(l.role) },
        `${l.ts}  ${l.text}`,
      ),
    ),
  );
};

const HelpOverlay: React.FC = () =>
  React.createElement(
    Box,
    { borderStyle: "double", paddingX: 1, marginTop: 1, flexDirection: "column" },
    React.createElement(Text, { bold: true }, "Keyboard shortcuts"),
    React.createElement(Text, null, "  q         graceful quit (next checkpoint)"),
    React.createElement(Text, null, "  j / ↓     scroll activity down"),
    React.createElement(Text, null, "  k / ↑     scroll activity up"),
    React.createElement(Text, null, "  a         filter: all"),
    React.createElement(Text, null, "  p/c/r/s   filter: planner/coder/reviewer/subagent"),
    React.createElement(Text, null, "  ?         toggle this help"),
  );

const PendingPromptView: React.FC<{ pending: PendingPrompt }> = ({
  pending,
}) => {
  // useInput must be called unconditionally — branching inside the
  // handler rather than branching the hook call. This keeps the Rules
  // of Hooks satisfied across re-renders.
  useInput((input, key) => {
    if (pending.kind === "confirm") {
      if (key.return || input === "y" || input === "Y") {
        pending.resolve(true);
      } else if (input === "n" || input === "N" || key.escape) {
        pending.resolve(false);
      }
      return;
    }
    // clarifications
    const { questions, currentIndex, buffer } = pending;
    if (key.return) {
      const nextAnswers = [...pending.answers, buffer];
      if (currentIndex + 1 >= questions.length) {
        pending.resolve(nextAnswers);
      } else {
        Object.assign(pending, {
          answers: nextAnswers,
          currentIndex: currentIndex + 1,
          buffer: "",
        });
      }
      return;
    }
    if (key.backspace || key.delete) {
      pending.buffer = buffer.slice(0, -1);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      pending.buffer = buffer + input;
    }
  });

  if (pending.kind === "confirm") {
    return React.createElement(
      Box,
      { borderStyle: "double", paddingX: 1, marginTop: 1 },
      React.createElement(
        Text,
        { color: "yellow" },
        `${pending.message}  [y/N] `,
      ),
    );
  }
  const q = pending.questions[pending.currentIndex] ?? "";
  return React.createElement(
    Box,
    { borderStyle: "double", paddingX: 1, marginTop: 1, flexDirection: "column" },
    React.createElement(
      Text,
      { color: "cyan" },
      `[Planner] ${pending.currentIndex + 1}/${pending.questions.length}`,
    ),
    React.createElement(Text, null, q),
    React.createElement(Text, { color: "green" }, `> ${pending.buffer}`),
  );
};

function statusGlyph(s: SquadState["todos"][number]["status"]): string {
  switch (s) {
    case "done":
      return "✓";
    case "in_progress":
      return "◐";
    case "abandoned":
      return "✗";
    default:
      return "·";
  }
}

function colorForStatus(
  s: SquadState["todos"][number]["status"],
): string | undefined {
  switch (s) {
    case "done":
      return "green";
    case "in_progress":
      return "yellow";
    case "abandoned":
      return "red";
    default:
      return undefined;
  }
}

function colorForRole(r?: LogLine["role"]): string | undefined {
  switch (r) {
    case "planner":
      return "cyan";
    case "coder":
      return "green";
    case "reviewer":
      return "yellow";
    case "subagent":
      return "magenta";
    case "orchestrator":
      return "white";
    default:
      return undefined;
  }
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/g, "");
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Module-scoped store so useInput in App can reach the instance
// without threading it through props. Only one TUI is ever live per
// process (we mount once from cli.ts and unmount on exit).
let store = new Store();

/**
 * UserInterface implementation backed by an Ink render. Construct,
 * mount(), then pass `this` to runOrchestrator. Call unmount() when
 * the orchestrator returns so the process can exit cleanly.
 */
export class TuiUi implements UserInterface {
  private store = store;
  private app?: ReturnType<typeof render>;

  mount(): void {
    this.app = render(
      React.createElement(App, {
        state: this.store.state,
        subscribe: this.store.subscribe,
      }),
    );
  }

  unmount(): void {
    this.app?.unmount();
  }

  /** Register a callback fired when the user presses `q`. */
  onQuit(fn: () => void): void {
    this.store.onQuit = fn;
  }

  /** Feed token usage into the header from the orchestrator. */
  trackUsage(
    role: RoleBucket,
    delta: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
    },
  ): void {
    this.store.addUsage(role, delta);
  }

  updateState(s: SquadState): void {
    this.store.setSquadState(s);
  }

  setInflightSubagent(name?: string): void {
    this.store.setInflightSubagent(name);
  }

  setActiveSkills(names: string[]): void {
    this.store.setActiveSkills(names);
  }

  // UserInterface implementation below.

  log(msg: string): void {
    this.store.appendLog(msg, "orchestrator");
  }

  streamAgent(role: string, chunk: string): void {
    this.store.appendStream(role as AgentRole, chunk);
  }

  confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.store.setPending({
        kind: "confirm",
        message,
        resolve: (ok) => {
          this.store.setPending(undefined);
          resolve(ok);
        },
      });
    });
  }

  askClarifications(questions: string[]): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      this.store.setPending({
        kind: "clarifications",
        questions,
        answers: [],
        currentIndex: 0,
        buffer: "",
        resolve: (answers) => {
          this.store.setPending(undefined);
          resolve(answers);
        },
      });
    });
  }
}
