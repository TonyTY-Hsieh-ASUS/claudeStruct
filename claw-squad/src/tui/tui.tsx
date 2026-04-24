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
 * Why no ink-text-input dep? The single text field we need (typing an
 * answer to a Planner question) is small enough to implement with
 * useInput. Fewer deps, less version skew.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import type { AgentRole, SquadState } from "../types.js";
import type { UserInterface } from "../orchestrator.js";

interface LogLine {
  id: number;
  text: string;
}

interface AppProps {
  state: TuiState;
  subscribe: (fn: () => void) => () => void;
}

interface TuiState {
  logs: LogLine[];
  streamBuffer: string;
  activeRole: AgentRole | "idle";
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  };
  squadState?: SquadState;
  pendingPrompt?: PendingPrompt;
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
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  };
  private subscribers = new Set<() => void>();
  private nextId = 1;

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };

  private notify(): void {
    for (const s of this.subscribers) s();
  }

  appendLog(text: string): void {
    // Ink renders all log lines every tick, so we cap the buffer to
    // keep render cost bounded.
    const logs = [
      ...this.state.logs,
      { id: this.nextId++, text: stripTrailingNewlines(text) },
    ];
    while (logs.length > 200) logs.shift();
    this.state = { ...this.state, logs };
    this.notify();
  }

  appendStream(role: AgentRole, chunk: string): void {
    // Stream chunks flow fast. Batch them into a single-line buffer;
    // flush to the log on newline. This keeps "live typing" feel
    // without flooding the log history.
    const combined = this.state.streamBuffer + chunk;
    const parts = combined.split("\n");
    const carry = parts.pop() ?? "";
    const newLogs = parts.map((p) => ({
      id: this.nextId++,
      text: `[${role}] ${p}`,
    }));
    const logs = [...this.state.logs, ...newLogs];
    while (logs.length > 200) logs.shift();
    this.state = { ...this.state, logs, streamBuffer: carry, activeRole: role };
    this.notify();
  }

  setActive(role: AgentRole | "idle"): void {
    this.state = { ...this.state, activeRole: role };
    this.notify();
  }

  addUsage(delta: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  }): void {
    const t = this.state.tokens;
    this.state = {
      ...this.state,
      tokens: {
        input: t.input + delta.input,
        output: t.output + delta.output,
        cacheRead: t.cacheRead + delta.cacheRead,
        cacheWrite: t.cacheWrite + delta.cacheWrite,
        costUsd: t.costUsd + delta.costUsd,
      },
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
}

const App: React.FC<AppProps> = ({ state, subscribe }) => {
  // `state` is mutated in place by the store; subscribe on mount so
  // React re-renders.
  const [, forceRender] = useState(0);
  useEffect(
    () => subscribe(() => forceRender((n) => n + 1)),
    [subscribe],
  );

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Header, { state }),
    React.createElement(TodoPanel, { todos: state.squadState?.todos ?? [] }),
    React.createElement(ActivityPane, { logs: state.logs }),
    state.pendingPrompt
      ? React.createElement(PendingPromptView, { pending: state.pendingPrompt })
      : null,
  );
};

const Header: React.FC<{ state: TuiState }> = ({ state }) => {
  const t = state.tokens;
  const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  return React.createElement(
    Box,
    { borderStyle: "round", padding: 1, marginBottom: 1 },
    React.createElement(
      Box,
      { flexDirection: "column", width: "100%" },
      React.createElement(
        Text,
        { bold: true, color: "cyan" },
        `claw-squad  •  active: ${state.activeRole}`,
      ),
      React.createElement(
        Text,
        null,
        `in ${t.input.toLocaleString()}  out ${t.output.toLocaleString()}  cache ${t.cacheRead.toLocaleString()}↓/${t.cacheWrite.toLocaleString()}↑  total ${totalTokens.toLocaleString()}  $${t.costUsd.toFixed(4)}`,
      ),
    ),
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
        `  ${statusGlyph(t.status)} ${t.id}  ${t.title}${t.mergedPrNumber ? `  (PR #${t.mergedPrNumber})` : ""}`,
      ),
    ),
  );
};

const ActivityPane: React.FC<{ logs: LogLine[] }> = ({ logs }) => {
  // Static + windowing: show only the tail (terminal is usually ~40
  // rows). Using <Static> on the tail would let us render more without
  // re-rendering but it'd also skip color updates. The simple windowed
  // approach is plenty fast for our traffic.
  const tail = logs.slice(-20);
  return React.createElement(
    Box,
    { flexDirection: "column" },
    ...tail.map((l) =>
      React.createElement(Text, { key: l.id }, l.text),
    ),
  );
};

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

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/g, "");
}

/**
 * UserInterface implementation backed by an Ink render. Construct,
 * mount(), then pass `this` to runOrchestrator. Call unmount() when
 * the orchestrator returns so the process can exit cleanly.
 */
export class TuiUi implements UserInterface {
  private store = new Store();
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
    // waitUntilExit resolves when Ink finishes rendering; we just
    // clean up synchronously here.
    this.app?.unmount();
  }

  /** Use this to feed token usage into the header from the orchestrator. */
  trackUsage(delta: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
  }): void {
    this.store.addUsage(delta);
  }

  updateState(s: SquadState): void {
    this.store.setSquadState(s);
  }

  // UserInterface implementation below.

  log(msg: string): void {
    this.store.appendLog(msg);
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
