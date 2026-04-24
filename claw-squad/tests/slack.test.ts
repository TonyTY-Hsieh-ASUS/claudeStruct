/**
 * SlackUi tests — use a hand-rolled mock client so we don't need a
 * real bot token or network. The mock exposes hooks for: what was
 * posted, and what the poller should see on its next call.
 */

import { describe, expect, it } from "vitest";
import { SlackUi, type SlackClient } from "../src/ui/slack.js";

function makeMock() {
  const posted: Array<{ text: string; thread_ts?: string }> = [];
  let replyQueue: Array<{ ts: string; text: string; user?: string; bot_id?: string }> = [];
  const client: SlackClient = {
    chat: {
      postMessage: async ({ text, thread_ts }) => {
        posted.push({ text, thread_ts });
        // Return an incrementing ts so the first post (opener) gets
        // ts="1" and becomes the thread parent.
        return { ts: String(posted.length) };
      },
    },
    conversations: {
      replies: async () => {
        // Return whatever the test queued, then clear so the next
        // poll looks empty (simulating we've consumed the reply).
        const out = replyQueue;
        replyQueue = [];
        return { messages: out };
      },
    },
  };
  return {
    client,
    posted,
    queueReply(text: string, opts: { ts?: string; user?: string; bot_id?: string } = {}) {
      const ts = opts.ts ?? String(Date.now() / 1000 + 1);
      replyQueue.push({ ts, text, user: opts.user ?? "U123", bot_id: opts.bot_id });
    },
  };
}

describe("SlackUi", () => {
  it("opens a thread on construction", async () => {
    const m = makeMock();
    const ui = new SlackUi({ channel: "C1", client: m.client, openerText: "hi" });
    await ui.ready();
    expect(m.posted[0]!.text).toBe("hi");
    // Opener has no thread_ts — it IS the thread.
    expect(m.posted[0]!.thread_ts).toBeUndefined();
    await ui.shutdown();
  });

  it("log() posts as a thread reply", async () => {
    const m = makeMock();
    const ui = new SlackUi({ channel: "C1", client: m.client });
    await ui.ready();
    ui.log("progress update");
    // log() is fire-and-forget; give the scheduled post a tick.
    await new Promise((r) => setTimeout(r, 5));
    const reply = m.posted.find((p) => p.text === "progress update");
    expect(reply).toBeDefined();
    expect(reply!.thread_ts).toBe("1"); // child of opener
    await ui.shutdown();
  });

  it("streamAgent chunks are batched into a single post", async () => {
    const m = makeMock();
    const ui = new SlackUi({
      channel: "C1",
      client: m.client,
      streamBatchMs: 20,
    });
    await ui.ready();
    ui.streamAgent("planner", "chunk1 ");
    ui.streamAgent("planner", "chunk2");
    await new Promise((r) => setTimeout(r, 40));
    const streamed = m.posted.filter((p) => p.text.includes("planner"));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]!.text).toContain("chunk1 chunk2");
    await ui.shutdown();
  });

  it("confirm(yes) resolves to true via polled reply", async () => {
    const m = makeMock();
    const ui = new SlackUi({
      channel: "C1",
      client: m.client,
      pollIntervalMs: 5,
    });
    await ui.ready();
    const p = ui.confirm("ship it?");
    m.queueReply("yes");
    await expect(p).resolves.toBe(true);
    await ui.shutdown();
  });

  it("confirm(no) returns false", async () => {
    const m = makeMock();
    const ui = new SlackUi({
      channel: "C1",
      client: m.client,
      pollIntervalMs: 5,
    });
    await ui.ready();
    const p = ui.confirm("ship it?");
    m.queueReply("no");
    await expect(p).resolves.toBe(false);
    await ui.shutdown();
  });

  it("askClarifications collects answers in order", async () => {
    const m = makeMock();
    const ui = new SlackUi({
      channel: "C1",
      client: m.client,
      pollIntervalMs: 5,
    });
    await ui.ready();
    const p = ui.askClarifications(["q1?", "q2?"]);
    // Queue the first reply; then queue the second after the first is consumed.
    m.queueReply("first");
    setTimeout(() => m.queueReply("second"), 20);
    await expect(p).resolves.toEqual(["first", "second"]);
    await ui.shutdown();
  });

  it("ignores bot replies when polling", async () => {
    const m = makeMock();
    const ui = new SlackUi({
      channel: "C1",
      client: m.client,
      pollIntervalMs: 5,
    });
    await ui.ready();
    const p = ui.confirm("ok?");
    // First reply is from the bot itself — should be ignored.
    m.queueReply("echo", { bot_id: "BOT" });
    // Next poll, a real user reply arrives.
    setTimeout(() => m.queueReply("yes"), 15);
    await expect(p).resolves.toBe(true);
    await ui.shutdown();
  });
});
