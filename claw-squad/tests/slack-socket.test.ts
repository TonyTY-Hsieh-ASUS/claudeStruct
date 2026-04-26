/**
 * SocketReplyStrategy dispatcher tests.
 *
 * The strategy lazy-loads `@slack/socket-mode` at first `next*()`
 * call. Tests bypass that by calling `attach()` with a hand-rolled
 * EventEmitter shim, so we never spin up a real WebSocket and never
 * need an APP_TOKEN.
 */

import { describe, expect, it } from "vitest";
import {
  SocketReplyStrategy,
  type ConnectionState,
  type SocketEventEmitter,
} from "../src/ui/slack-socket.js";

function makeEmitter() {
  const messageHandlers: Array<(text: string) => void> = [];
  const buttonHandlers: Array<(promptId: string, value: string) => void> = [];
  const stateHandlers: Array<(state: ConnectionState) => void> = [];
  const emitter: SocketEventEmitter = {
    on: ((event: string, fn: (...args: unknown[]) => void) => {
      if (event === "message") {
        messageHandlers.push(fn as (text: string) => void);
      } else if (event === "button") {
        buttonHandlers.push(fn as (promptId: string, value: string) => void);
      } else if (event === "connectionState") {
        stateHandlers.push(fn as (state: ConnectionState) => void);
      }
    }) as SocketEventEmitter["on"],
    disconnect: () => {
      /* nothing held open */
    },
  };
  return {
    emitter,
    fireMessage: (text: string) => messageHandlers.forEach((fn) => fn(text)),
    fireButton: (promptId: string, value: string) =>
      buttonHandlers.forEach((fn) => fn(promptId, value)),
    fireConnection: (state: ConnectionState) =>
      stateHandlers.forEach((fn) => fn(state)),
  };
}

describe("SocketReplyStrategy", () => {
  it("delivers a message that arrives after nextReply subscribes", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    const p = s.nextReply("T1");
    e.fireMessage("hi");
    await expect(p).resolves.toBe("hi");
    await s.shutdown();
  });

  it("buffers a message that arrives before any waiter is subscribed", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    e.fireMessage("early");
    const got = await s.nextReply("T1");
    expect(got).toBe("early");
    await s.shutdown();
  });

  it("delivers messages in FIFO order", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    e.fireMessage("first");
    e.fireMessage("second");
    expect(await s.nextReply("T1")).toBe("first");
    expect(await s.nextReply("T1")).toBe("second");
    await s.shutdown();
  });

  it("nextButton resolves only for the matching promptId", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    const p = s.nextButton("p1");
    e.fireButton("other", "yes"); // wrong promptId — buffered
    e.fireButton("p1", "no"); // matches → resolves
    await expect(p).resolves.toBe("no");
    // The buffered "other" click should still be available for a
    // future nextButton("other") caller.
    expect(await s.nextButton("other")).toBe("yes");
    await s.shutdown();
  });

  it("buffers button clicks that arrive before nextButton subscribes", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    e.fireButton("p1", "yes");
    expect(await s.nextButton("p1")).toBe("yes");
    await s.shutdown();
  });

  it("attach is idempotent (second call is a no-op)", () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    expect(() => s.attach(e.emitter)).not.toThrow();
  });

  it("shutdown drains pending waiters with undefined and is idempotent", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    const p1 = s.nextReply("T1");
    const p2 = s.nextButton("p1");
    await s.shutdown();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    await expect(s.shutdown()).resolves.toBeUndefined();
  });

  it("forwards connection state transitions to a registered listener", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    const seen: ConnectionState[] = [];
    s.onConnectionState((state) => seen.push(state));
    // Initial replay of the latest known state ("connecting" by default).
    expect(seen).toEqual(["connecting"]);
    e.fireConnection("disconnected");
    e.fireConnection("reconnecting");
    e.fireConnection("connected");
    expect(seen).toEqual([
      "connecting",
      "disconnected",
      "reconnecting",
      "connected",
    ]);
    await s.shutdown();
  });

  it("listener errors do not break the socket", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    s.onConnectionState(() => {
      throw new Error("boom");
    });
    expect(() => e.fireConnection("disconnected")).not.toThrow();
    // Subsequent message delivery still works.
    const p = s.nextReply("T1");
    e.fireMessage("hi");
    await expect(p).resolves.toBe("hi");
    await s.shutdown();
  });

  it("late-bound listener gets a replay of the latest state", async () => {
    const s = new SocketReplyStrategy({ channel: "C1" });
    const e = makeEmitter();
    s.attach(e.emitter);
    e.fireConnection("disconnected");
    e.fireConnection("connected");
    const seen: ConnectionState[] = [];
    s.onConnectionState((state) => seen.push(state));
    expect(seen).toEqual(["connected"]);
    await s.shutdown();
  });
});
