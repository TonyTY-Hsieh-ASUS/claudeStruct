/**
 * Slack UserInterface.
 *
 * Opens a thread in `--slack-channel` on construction and posts
 * activity as thread replies. Two transports for receiving user
 * answers (clarifications, confirms):
 *
 *   - **polling** (default) — `conversations.replies` every 5s.
 *     Needs only `SLACK_BOT_TOKEN`. Default per the original PR-4
 *     decision; works in any workspace with a bot token.
 *   - **socket** (PR-C) — real-time `@slack/socket-mode` events plus
 *     Block Kit buttons for confirm prompts. Needs `SLACK_APP_TOKEN`
 *     in addition to the bot token. Auto-selected when both env vars
 *     are present and `--slack-mode socket` is asked for (or left
 *     to autodetect).
 *
 * Architecture:
 *   - `SlackUi` owns posting + the streamer.
 *   - `ReplyStrategy` is the receiving side. PollingReplyStrategy and
 *     SocketReplyStrategy both implement `nextReply()` and
 *     `nextButton(promptId)`. Polling can't do buttons (no callback
 *     URL), so it falls back to free-text yes/no.
 *
 * Reliability:
 *   - Every Slack API call is wrapped in try/catch that logs to
 *     stderr and does NOT propagate. A transient 429 or a revoked
 *     token must never abort the orchestrator.
 *   - Streamed model output is batched through BatchedStreamer at
 *     1500ms to stay under Slack's 1 msg/sec/channel cap.
 */

import type { WebClient as WebClientType } from "@slack/web-api";
import type {
  RoleBucket,
  SquadState,
} from "../types.js";
import type { UserInterface } from "../orchestrator.js";
import { BatchedStreamer } from "./throttle.js";

const POLL_INTERVAL_MS = 5_000;
const STREAM_BATCH_MS = 1_500;
/** Cap on how long we'll wait for a single reply before giving up. */
const REPLY_HARD_CAP_MS = 1000 * 60 * 30;

export type SlackMode = "polling" | "socket";

/**
 * Narrow subset of @slack/web-api we actually call. Lets tests swap in
 * a mock without pulling the SDK into the test dep tree.
 */
export interface SlackClient {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }) => Promise<{ ts?: string }>;
  };
  conversations: {
    replies: (args: {
      channel: string;
      ts: string;
      oldest?: string;
    }) => Promise<{
      messages?: Array<{
        ts: string;
        user?: string;
        bot_id?: string;
        text?: string;
      }>;
    }>;
  };
}

export interface ReplyStrategy {
  /**
   * Resolve when the next user message lands in the thread. Returns
   * undefined on hard timeout — the orchestrator treats this as an
   * empty answer rather than failing the run.
   */
  nextReply(threadTs: string): Promise<string | undefined>;
  /**
   * Resolve when the user clicks a button on the prompt with the
   * given action_id. Returns the chosen `value` ("yes" / "no").
   * Polling-mode strategies should fall back to free-text reply
   * matching since they have no button channel.
   */
  nextButton(promptId: string): Promise<string | undefined>;
  shutdown(): Promise<void> | void;
}

export interface SlackUiOptions {
  /** Channel ID, e.g. "C0123…". */
  channel: string;
  /** Free-form requirement / run title posted as the thread opener. */
  openerText?: string;
  /**
   * Injected for tests. When absent, instantiates the real
   * `@slack/web-api` WebClient from env `SLACK_BOT_TOKEN`.
   */
  client?: SlackClient;
  /**
   * Injected for tests. When absent, the constructor builds the
   * strategy implied by `mode`. Tests pass a fake to assert routing
   * without spinning up real Slack.
   */
  replyStrategy?: ReplyStrategy;
  /**
   * "polling" | "socket". Defaults to autodetect: socket when
   * `SLACK_APP_TOKEN` is set, polling otherwise.
   */
  mode?: SlackMode;
  /** Defaults to POLL_INTERVAL_MS; overridable for tests. */
  pollIntervalMs?: number;
  /** Defaults to STREAM_BATCH_MS; overridable for tests. */
  streamBatchMs?: number;
}

/**
 * Mint the real Slack client from env. Split out so tests don't need
 * a token to import this module.
 */
function defaultSlackClient(): SlackClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "SLACK_BOT_TOKEN is not set — required for --slack-channel",
    );
  }
  // Lazy require so the @slack/web-api cost lands only when the user
  // actually opts into the Slack transport.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebClient } = require("@slack/web-api") as {
    WebClient: new (t: string) => WebClientType;
  };
  return new WebClient(token) as unknown as SlackClient;
}

/**
 * Decide the transport mode. Explicit `--slack-mode socket` wins;
 * otherwise pick socket when both tokens are present, else polling.
 */
export function autodetectSlackMode(env: NodeJS.ProcessEnv = process.env): SlackMode {
  return env.SLACK_APP_TOKEN ? "socket" : "polling";
}

export class SlackUi implements UserInterface {
  private readonly client: SlackClient;
  private readonly channel: string;
  private threadTs: string | undefined;
  private readonly readyPromise: Promise<void>;
  private readonly streamer: BatchedStreamer;
  private readonly strategy: ReplyStrategy;
  private readonly mode: SlackMode;

  constructor(opts: SlackUiOptions) {
    const client = opts.client ?? defaultSlackClient();
    this.client = client;
    this.channel = opts.channel;
    this.mode = opts.mode ?? autodetectSlackMode();

    // Post the opener + capture thread ts. Everything else replies
    // into the same thread so the channel stays tidy.
    this.readyPromise = (async () => {
      try {
        const res = await client.chat.postMessage({
          channel: opts.channel,
          text: opts.openerText ?? "claw-squad starting…",
        });
        this.threadTs = res.ts;
      } catch (err) {
        console.error(
          `[slack] failed to open thread: ${(err as Error).message}`,
        );
      }
    })();

    this.streamer = new BatchedStreamer(
      opts.streamBatchMs ?? STREAM_BATCH_MS,
      async (groups) => {
        const body = groups
          .map((g) => `*${roleEmoji(g.role)} ${g.role}*\n\`\`\`\n${g.text}\n\`\`\``)
          .join("\n");
        await this.safePost(body);
      },
    );

    // Pick the strategy. Tests inject one directly; real runs build
    // it lazily from the env-determined mode.
    if (opts.replyStrategy) {
      this.strategy = opts.replyStrategy;
    } else if (this.mode === "socket") {
      this.strategy = createSocketReplyStrategy({
        channel: opts.channel,
      });
    } else {
      this.strategy = new PollingReplyStrategy({
        client: this.client,
        channel: opts.channel,
        pollIntervalMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
      });
    }

    // Surface socket-mode reconnect transitions to the channel so
    // operators see when a long run loses the socket and recovers.
    // SDK auto-reconnects under the hood; this is just the UX layer.
    const sub = (this.strategy as { onConnectionState?: (fn: (s: string) => void) => void })
      .onConnectionState;
    if (typeof sub === "function") {
      sub.call(this.strategy, (state: string) => {
        if (state === "disconnected") {
          void this.safePost(":warning: lost Slack socket — reconnecting…");
        } else if (state === "connected") {
          // Don't spam on the initial connect; only post on recovery.
          if (this.hasAnnouncedConnected) {
            void this.safePost(":white_check_mark: Slack socket reconnected.");
          }
          this.hasAnnouncedConnected = true;
        }
      });
    }
  }

  private hasAnnouncedConnected = false;

  /** Wait for the opener to resolve. Tests call this before asserting. */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async shutdown(): Promise<void> {
    await this.streamer.shutdown();
    await this.strategy.shutdown();
  }

  // UserInterface implementation.

  log(msg: string): void {
    void this.safePost(msg);
  }

  streamAgent(role: string, chunk: string): void {
    this.streamer.push(role, chunk);
  }

  async confirm(prompt: string): Promise<boolean> {
    await this.readyPromise;
    if (this.mode === "socket") {
      // Socket mode: post Block Kit buttons; the user clicks one and
      // the strategy delivers the chosen value via nextButton().
      const promptId = `claw-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await this.safePost(prompt, blockKitConfirm(promptId, prompt));
      const value = await this.strategy.nextButton(promptId);
      if (value !== undefined) return value === "yes";
      // Fall through to free-text in case Block Kit fails or the user
      // replied with text instead of clicking.
    }
    if (this.mode === "polling" || this.mode === "socket") {
      await this.safePost(`:warning: ${prompt}\n_Reply \`yes\` or \`no\` in this thread._`);
    }
    if (!this.threadTs) return false;
    const answer = await this.strategy.nextReply(this.threadTs);
    return /^\s*y(es)?\s*$/i.test(answer ?? "");
  }

  async askClarifications(questions: string[]): Promise<string[]> {
    await this.readyPromise;
    if (!this.threadTs) return questions.map(() => "");
    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      await this.safePost(
        `:question: *${i + 1}/${questions.length}* ${questions[i]}\n_Reply in this thread._`,
      );
      const answer = (await this.strategy.nextReply(this.threadTs)) ?? "";
      answers.push(answer);
    }
    return answers;
  }

  trackUsage(
    role: RoleBucket,
    delta: { costUsd: number },
  ): void {
    // Usage is noisy; don't post each call. Same no-op as PR-4.
    void role;
    void delta;
  }

  updateState(_state: SquadState): void {
    // Future hook — periodic TODO repost.
  }

  // --- internals ---

  private async safePost(
    text: string,
    blocks?: unknown[],
  ): Promise<string | undefined> {
    await this.readyPromise;
    try {
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        text,
        thread_ts: this.threadTs,
        ...(blocks ? { blocks } : {}),
      });
      return res.ts;
    } catch (err) {
      console.error(`[slack] post failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}

// ---------- Polling strategy (PR-4 default) ----------

class PollingReplyStrategy implements ReplyStrategy {
  constructor(
    private readonly opts: {
      client: SlackClient;
      channel: string;
      pollIntervalMs: number;
    },
  ) {}

  async nextReply(threadTs: string): Promise<string | undefined> {
    const startedAt = Date.now();
    const oldest = (startedAt / 1000).toFixed(6);
    while (Date.now() - startedAt < REPLY_HARD_CAP_MS) {
      await sleep(this.opts.pollIntervalMs);
      try {
        const res = await this.opts.client.conversations.replies({
          channel: this.opts.channel,
          ts: threadTs,
          oldest,
        });
        const messages = res.messages ?? [];
        for (const m of messages) {
          if (!m.text) continue;
          if (m.bot_id) continue;
          if (Number(m.ts) <= Number(oldest)) continue;
          return m.text;
        }
      } catch (err) {
        console.error(
          `[slack] poll failed: ${(err as Error).message}`,
        );
      }
    }
    return undefined;
  }

  async nextButton(_promptId: string): Promise<string | undefined> {
    // Polling mode has no callback URL → can't receive button payloads.
    // Fall back: caller will follow up with `nextReply` for free-text.
    return undefined;
  }

  shutdown(): void {
    /* nothing held open */
  }
}

// ---------- Socket strategy (PR-C) ----------

/**
 * Lazy-loaded factory so `@slack/socket-mode` doesn't get pulled in
 * for polling-mode runs. The actual implementation lives in
 * `slack-socket.ts` to keep this file from depending on the heavy
 * SDK at import time.
 */
function createSocketReplyStrategy(args: { channel: string }): ReplyStrategy {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./slack-socket.js") as {
    SocketReplyStrategy: new (args: { channel: string }) => ReplyStrategy;
  };
  return new mod.SocketReplyStrategy(args);
}

// ---------- Block Kit ----------

/**
 * Build a Block Kit payload for a confirm prompt. Two buttons share
 * a stable `action_id` so the socket dispatcher can route any click
 * back to the waiting `nextButton(promptId)` resolver.
 */
export function blockKitConfirm(
  promptId: string,
  prompt: string,
): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *${prompt}*` },
    },
    {
      type: "actions",
      block_id: promptId,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "✓ Confirm" },
          action_id: `${promptId}.yes`,
          value: "yes",
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "✗ Cancel" },
          action_id: `${promptId}.no`,
          value: "no",
        },
      ],
    },
  ];
}

function roleEmoji(role: string): string {
  switch (role) {
    case "planner":
      return ":brain:";
    case "coder":
      return ":hammer_and_wrench:";
    case "reviewer":
      return ":mag:";
    case "subagent":
      return ":robot_face:";
    default:
      return ":speech_balloon:";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
