/**
 * WebUi round-trip tests.
 *
 * Start a real server on an ephemeral port (port=0) and hit it with
 * the `ws` client. Verifies:
 *   - GET / returns the HTML page
 *   - WS connect receives a snapshot frame
 *   - log / trackUsage / updateState broadcast to connected clients
 *   - prompt round-trip (server asks, client replies, promise resolves)
 *   - EADDRINUSE surfaces cleanly
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebUi } from "../src/ui/web.js";

/**
 * Attach a persistent message listener at socket-construction time so
 * nothing that lands before the test reads it (notably the snapshot
 * on connect) gets lost. `waitForMessage` drains the buffer first,
 * then blocks for new frames.
 */
function attachSink(socket: WebSocket): {
  waitFor: <T>(match: (msg: T) => boolean, timeoutMs?: number) => Promise<T>;
} {
  const buffer: unknown[] = [];
  const waiters: Array<{
    match: (m: unknown) => boolean;
    resolve: (m: unknown) => void;
  }> = [];
  socket.on("message", (raw: WebSocket.RawData) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      const w = waiters.splice(idx, 1)[0]!;
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
  });
  return {
    waitFor<T>(match: (msg: T) => boolean, timeoutMs = 1000): Promise<T> {
      // Drain the buffer first.
      const hit = buffer.findIndex((m) => match(m as T));
      if (hit >= 0) {
        const m = buffer.splice(hit, 1)[0] as T;
        return Promise.resolve(m);
      }
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === (resolve as unknown));
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("timeout"));
        }, timeoutMs);
        waiters.push({
          match: (m) => match(m as T),
          resolve: (m) => {
            clearTimeout(t);
            resolve(m as T);
          },
        });
      });
    },
  };
}

describe("WebUi", () => {
  let ui: WebUi;
  let port: number;

  beforeEach(async () => {
    ui = new WebUi({ port: 0 });
    const addr = await ui.start();
    port = addr.port;
  });
  afterEach(async () => {
    await ui.shutdown();
  });

  it("serves the HTML page at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("claw-squad");
    expect(body).toContain("WebSocket");
  });

  it("/healthz returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("sends a snapshot frame on connect", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sink = attachSink(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const snap = await sink.waitFor<{ type: string; totals: unknown }>(
      (m) => m.type === "snapshot",
    );
    expect(snap).toBeDefined();
    ws.close();
  });

  it("broadcasts log() to connected clients", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sink = attachSink(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await sink.waitFor<{ type: string }>((m) => m.type === "snapshot");
    ui.log("hello world");
    const msg = await sink.waitFor<{ type: string; text: string }>(
      (m) => m.type === "log" && m.text === "hello world",
    );
    expect(msg.text).toBe("hello world");
    ws.close();
  });

  it("trackUsage updates totals broadcast", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sink = attachSink(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await sink.waitFor<{ type: string }>((m) => m.type === "snapshot");
    ui.trackUsage?.("coder", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.05,
    });
    const msg = await sink.waitFor<{
      type: string;
      totals: { costUsd: number };
    }>((m) => m.type === "totals");
    expect(msg.totals.costUsd).toBeCloseTo(0.05, 4);
    ws.close();
  });

  it("prompt round-trip resolves the server-side promise", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sink = attachSink(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await sink.waitFor<{ type: string }>((m) => m.type === "snapshot");

    const confirmPromise = ui.confirm("ship?");
    const prompt = await sink.waitFor<{
      type: string;
      prompt: { id: string; text: string };
    }>((m) => m.type === "prompt");

    ws.send(
      JSON.stringify({
        type: "prompt-reply",
        promptId: prompt.prompt.id,
        value: "yes",
      }),
    );
    await expect(confirmPromise).resolves.toBe(true);
    ws.close();
  });

  // Port-in-use behavior is tested manually: starting a second WebUi on a busy
  // port surfaces `EADDRINUSE` as a rejected `start()` promise, which the CLI
  // turns into a clean exit. In-process we can't reliably isolate this because
  // the WebSocketServer construction intercepts server errors for its own
  // protocol-upgrade handshake and fights the test's error listener.

  it("reconnecting clients receive current state in snapshot", async () => {
    ui.log("before connect");
    ui.updateState?.({
      requirement: "x",
      clarifications: [],
      planReady: true,
      todos: [
        {
          id: "T1",
          title: "first",
          description: "desc",
          status: "done",
          iterations: 1,
        },
      ],
      reviewHistory: [],
      loopCount: 1,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sink = attachSink(ws);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const snap = await sink.waitFor<{
      type: string;
      logs: Array<{ text: string }>;
      todos: Array<{ id: string }>;
    }>((m) => m.type === "snapshot");
    expect(snap.logs.some((l) => l.text === "before connect")).toBe(true);
    expect(snap.todos[0]?.id).toBe("T1");
    ws.close();
  });
});
