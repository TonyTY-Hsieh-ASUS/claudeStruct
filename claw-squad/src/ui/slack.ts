/**
 * Slack UserInterface.
 *
 * Opens a thread in `--slack-channel` on construction and posts
 * activity as thread replies. Clarifications and confirms are posted
 * as questions; answers come back via polling `conversations.replies`
 * every 5 seconds — simpler setup than Socket Mode, at the cost of a
 * few seconds' lag.
 *
 * Transport chosen per user's explicit decision: "Slack = Web API
 * polling" in the approved plan.
 *
 * Non-goals:
 *   - Block Kit buttons for confirm prompts. Free-text `yes`/`no` in
 *     the thread is dead simple to implement and plenty clear.
 *   - Socket Mode / real-time subscribe. Polling at 5s is a fine
 *     trade for a tool used by one operator per channel at a time.
 *
 * Reliability:
 *   - Every Slack API call is wrapped in a try/catch that logs to
 *     stderr and does NOT propagate. A transient 429 or a revoked
 *     token must never abort the orchestrator.
 *   - Streamed model output is batched through BatchedStreamer at
 *     1500ms to stay comfortably under Slack's 1 msg/sec/channel cap.
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

export class SlackUi implements UserInterface {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly pollIntervalMs: number;
  private threadTs: string | undefined;
  private readonly readyPromise: Promise<void>;
  private readonly streamer: BatchedStreamer;

  constructor(opts: SlackUiOptions) {
    const client = opts.client ?? defaultSlackClient();
    this.client = client;
    this.channel = opts.channel;
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

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
        // If we can't even post the opener, later log() calls still
        // won't throw — they'll just be swallowed as no-ops. Surface
        // the diagnostic to stderr so the operator notices.
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
  }

  /** Wait for the opener to resolve. Tests call this before asserting. */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async shutdown(): Promise<void> {
    await this.streamer.shutdown();
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
    await this.safePost(`:warning: ${prompt}\n_Reply \`yes\` or \`no\` in this thread._`);
    const answer = await this.waitForReply();
    return /^\s*y(es)?\s*$/i.test(answer ?? "");
  }

  async askClarifications(questions: string[]): Promise<string[]> {
    await this.readyPromise;
    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      await this.safePost(
        `:question: *${i + 1}/${questions.length}* ${questions[i]}\n_Reply in this thread._`,
      );
      const answer = (await this.waitForReply()) ?? "";
      answers.push(answer);
    }
    return answers;
  }

  trackUsage(
    role: RoleBucket,
    delta: { costUsd: number },
  ): void {
    // Usage is noisy; don't post each call. The run-end summary can
    // be surfaced separately via log() when the orchestrator wants.
    // Keep this method as a no-op sink so the orchestrator stays
    // transport-agnostic. Unused params are fine.
    void role;
    void delta;
  }

  updateState(_state: SquadState): void {
    // Optional hook — not surfaced to Slack yet. Future: periodic
    // TODO summary repost.
  }

  // --- internals ---

  private async safePost(text: string): Promise<string | undefined> {
    await this.readyPromise;
    try {
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        text,
        thread_ts: this.threadTs,
      });
      return res.ts;
    } catch (err) {
      console.error(`[slack] post failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Poll conversations.replies until a new reply arrives in the
   * thread that isn't from us. Returns its text, or undefined after
   * a soft timeout (never throws — the orchestrator can't usefully
   * react to "user never answered" beyond treating it as empty).
   */
  private async waitForReply(): Promise<string | undefined> {
    if (!this.threadTs) return undefined;
    const startedAt = Date.now();
    // Snapshot "last seen" so we only accept replies newer than the
    // question we just posted. Use a timestamp-ish cursor.
    const oldest = (startedAt / 1000).toFixed(6);
    // Hard cap so a run that lost its operator still terminates.
    const hardCapMs = 1000 * 60 * 30;
    while (Date.now() - startedAt < hardCapMs) {
      await sleep(this.pollIntervalMs);
      try {
        const res = await this.client.conversations.replies({
          channel: this.channel,
          ts: this.threadTs,
          oldest,
        });
        const messages = res.messages ?? [];
        // Take the first message that is (a) newer than the question
        // and (b) not from the bot itself. Bot replies have bot_id
        // set; user replies usually have user set and bot_id unset.
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
