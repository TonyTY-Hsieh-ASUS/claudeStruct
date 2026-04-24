/**
 * Local web UI.
 *
 * Spins up an http.Server on `--web-ui <port>` (default 3737) and
 * serves a single HTML page + a WebSocket endpoint at /ws. The page
 * is embedded at build time (see web-page.ts) so no separate build
 * step / static directory is needed.
 *
 * Security posture:
 *   - Binds to 127.0.0.1 by default. Remote access is the user's
 *     responsibility (ssh tunnel / ngrok). No auth on the socket.
 *   - No write surface other than replying to the current prompt.
 *   - EADDRINUSE surfaces as a thrown error in start() — the CLI
 *     translates that into a clean exit message, not a hang.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { ROLE_BUCKETS, type RoleBucket, type SquadState } from "../types.js";
import type { UserInterface } from "../orchestrator.js";
import { BatchedStreamer } from "./throttle.js";
import { WEB_PAGE_HTML } from "./web-page.js";

const STREAM_BATCH_MS = 250;

interface LogLine {
  role?: RoleBucket | "orchestrator";
  text: string;
  ts: string;
}

interface PerRoleTotal {
  calls: number;
  costUsd: number;
}

interface Snapshot {
  type: "snapshot";
  active: string;
  subagent?: string;
  totals: { calls: number; costUsd: number; cacheSavedUsd: number };
  perRole: Record<RoleBucket, PerRoleTotal>;
  todos: SquadState["todos"];
  logs: LogLine[];
  prompt?: { id: string; text: string };
}

interface PendingPrompt {
  id: string;
  text: string;
  /** Called with the user's reply. */
  resolve: (value: string) => void;
}

export interface WebUiOptions {
  port?: number;
  host?: string;
}

export class WebUi implements UserInterface {
  private server: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private streamer: BatchedStreamer;

  // Persisted state — sent as a snapshot to every new websocket so
  // the user sees history, not a blank screen.
  private readonly logs: LogLine[] = [];
  private active: string = "idle";
  private subagent: string | undefined;
  private perRole: Record<RoleBucket, PerRoleTotal> = emptyPerRole();
  private totals = { calls: 0, costUsd: 0, cacheSavedUsd: 0 };
  private todos: SquadState["todos"] = [];
  private pendingPrompt: PendingPrompt | undefined;

  constructor(private readonly opts: WebUiOptions = {}) {
    this.server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(WEB_PAGE_HTML);
        return;
      }
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (socket) => this.onConnection(socket));

    this.streamer = new BatchedStreamer(STREAM_BATCH_MS, (groups) => {
      for (const g of groups) {
        this.appendLog({
          role: g.role as LogLine["role"],
          text: g.text,
          ts: timestamp(),
        });
      }
    });
  }

  /** Start listening. Rejects on EADDRINUSE so the CLI can fail cleanly. */
  async start(): Promise<{ port: number; host: string }> {
    const port = this.opts.port ?? 3737;
    const host = this.opts.host ?? "127.0.0.1";
    // Install a persistent error listener BEFORE calling listen() so we
    // never lose an early error emit. The listener is removed after the
    // promise settles.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        this.server.off("error", onError);
        resolve();
      };
      this.server.on("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
    const addr = this.server.address() as AddressInfo;
    return { port: addr.port, host };
  }

  async shutdown(): Promise<void> {
    await this.streamer.shutdown();
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // UserInterface implementation.

  log(msg: string): void {
    this.appendLog({ role: "orchestrator", text: msg, ts: timestamp() });
  }

  streamAgent(role: string, chunk: string): void {
    this.active = role;
    this.broadcast({ type: "active", role });
    this.streamer.push(role, chunk);
  }

  trackUsage(
    role: RoleBucket,
    delta: { costUsd: number; cacheSaved?: number },
  ): void {
    const existing = this.perRole[role];
    this.perRole = {
      ...this.perRole,
      [role]: {
        calls: existing.calls + 1,
        costUsd: existing.costUsd + delta.costUsd,
      },
    };
    this.totals = {
      calls: this.totals.calls + 1,
      costUsd: this.totals.costUsd + delta.costUsd,
      cacheSavedUsd: this.totals.cacheSavedUsd + (delta.cacheSaved ?? 0),
    };
    this.broadcast({
      type: "totals",
      totals: this.totals,
      perRole: this.perRole,
    });
  }

  setInflightSubagent(name?: string): void {
    this.subagent = name;
    this.broadcast({ type: "subagent", name });
  }

  updateState(state: SquadState): void {
    this.todos = state.todos;
    this.broadcast({ type: "todos", todos: state.todos });
  }

  confirm(prompt: string): Promise<boolean> {
    return this.askPrompt(`[Confirm] ${prompt}  (type yes/no)`).then((ans) =>
      /^\s*y(es)?\s*$/i.test(ans ?? ""),
    );
  }

  askClarifications(questions: string[]): Promise<string[]> {
    return (async () => {
      const answers: string[] = [];
      for (const q of questions) {
        answers.push((await this.askPrompt(`[Question] ${q}`)) ?? "");
      }
      return answers;
    })();
  }

  // --- internals ---

  private appendLog(line: LogLine): void {
    this.logs.push(line);
    while (this.logs.length > 1000) this.logs.shift();
    this.broadcast({ type: "log", ...line });
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      try {
        c.send(payload);
      } catch {
        /* drop broken client */
      }
    }
  }

  private onConnection(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => {
      /* closed by event */
    });
    socket.on("message", (raw) => this.onClientMessage(raw.toString()));

    // Send the initial snapshot so reconnecting clients see full state
    // instead of a blank screen.
    const snapshot: Snapshot = {
      type: "snapshot",
      active: this.active,
      subagent: this.subagent,
      totals: this.totals,
      perRole: this.perRole,
      todos: this.todos,
      logs: this.logs.slice(-200),
      prompt: this.pendingPrompt
        ? { id: this.pendingPrompt.id, text: this.pendingPrompt.text }
        : undefined,
    };
    try {
      socket.send(JSON.stringify(snapshot));
    } catch {
      /* client already gone */
    }
  }

  private onClientMessage(raw: string): void {
    let msg: { type?: string; promptId?: string; value?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "prompt-reply") return;
    if (!this.pendingPrompt || msg.promptId !== this.pendingPrompt.id) return;
    const p = this.pendingPrompt;
    this.pendingPrompt = undefined;
    this.broadcast({ type: "prompt-clear" });
    p.resolve(msg.value ?? "");
  }

  private askPrompt(text: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pendingPrompt = { id, text, resolve };
      this.broadcast({ type: "prompt", prompt: { id, text } });
    });
  }
}

function emptyPerRole(): Record<RoleBucket, PerRoleTotal> {
  const out = {} as Record<RoleBucket, PerRoleTotal>;
  for (const b of ROLE_BUCKETS) out[b] = { calls: 0, costUsd: 0 };
  return out;
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
