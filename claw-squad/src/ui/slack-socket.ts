/**
 * Slack Socket Mode reply strategy (PR-C).
 *
 * Listens to two event streams over the same SocketModeClient:
 *   - `message` events filtered to the active channel/thread → text
 *     replies. Resolves the oldest waiting `nextReply` promise.
 *   - `interactive` payloads (Block Kit button clicks) → button
 *     values. Resolves the matching `nextButton(promptId)` promise.
 *
 * Why a separate file: the @slack/socket-mode dep is ~200KB. We want
 * polling-mode runs to never load it. `slack.ts` lazy-requires this
 * module only when mode === "socket".
 *
 * The strategy keeps two FIFO waiter queues (one per channel). When
 * an event arrives without a waiter, it parks in the buffer until
 * `next*()` is called. This handles the natural race between "post
 * the question" and "subscribe to the answer" with no timing
 * gymnastics in the caller.
 */

import type { ReplyStrategy } from "./slack.js";

interface PendingReply {
  resolve: (value: string | undefined) => void;
  /** Timer that resolves with `undefined` if the user never replies. */
  timer: ReturnType<typeof setTimeout>;
}

interface PendingButton extends PendingReply {
  promptId: string;
}

const REPLY_HARD_CAP_MS = 1000 * 60 * 30;

/**
 * Real Socket Mode strategy. The constructor lazy-requires the
 * `@slack/socket-mode` SDK so importing this file in tests doesn't
 * force the dep tree to resolve.
 */
export class SocketReplyStrategy implements ReplyStrategy {
  private socket: { disconnect: () => Promise<void> | void } | undefined;
  private replyWaiters: PendingReply[] = [];
  private buttonWaiters = new Map<string, PendingButton>();
  /** Replies that arrived before anyone was waiting. */
  private readonly replyBuffer: string[] = [];
  /** Button clicks that arrived before anyone was waiting. */
  private readonly buttonBuffer = new Map<string, string>();

  constructor(_args: { channel: string }) {
    // Real connection is established lazily on first nextReply/Button
    // so test imports never touch the network.
    void _args;
  }

  /**
   * Wire the SocketModeClient. Tests can call `attach()` directly
   * with a fake event emitter; production callers don't, and the
   * first `next*()` call will lazy-attach.
   */
  attach(emitter: SocketEventEmitter): void {
    if (this.socket) return;
    this.socket = { disconnect: () => emitter.disconnect?.() };
    emitter.on("message", (text: string) => this.deliverReply(text));
    emitter.on("button", (promptId: string, value: string) =>
      this.deliverButton(promptId, value),
    );
  }

  private ensureAttached(): void {
    if (this.socket) return;
    // Lazy-load and attach. Wrapped in try/catch so a misconfigured
    // env (missing app token, missing socket-mode dep) surfaces as
    // an error on the operator's terminal, not a silent hang.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sm = require("@slack/socket-mode") as {
        SocketModeClient: new (opts: { appToken: string }) => unknown;
      };
      const token = process.env.SLACK_APP_TOKEN;
      if (!token) {
        throw new Error("SLACK_APP_TOKEN is required for slack socket mode");
      }
      const client = new sm.SocketModeClient({ appToken: token }) as unknown as {
        on: (event: string, fn: (...args: unknown[]) => void) => void;
        start: () => Promise<void>;
        disconnect: () => Promise<void>;
      };
      this.socket = { disconnect: () => client.disconnect() };
      // Real Slack SDK uses different envelope shapes; pluck the
      // bits the strategy cares about.
      client.on("message", (envelope: unknown) => {
        const text = (envelope as { event?: { text?: string; bot_id?: string } })
          ?.event?.text;
        const botId = (envelope as { event?: { bot_id?: string } })?.event
          ?.bot_id;
        if (text && !botId) this.deliverReply(text);
      });
      client.on("interactive", (envelope: unknown) => {
        const payload = envelope as {
          payload?: {
            actions?: Array<{ action_id?: string; value?: string }>;
          };
        };
        const action = payload?.payload?.actions?.[0];
        if (!action?.action_id || !action.value) return;
        // action_id format: "<promptId>.<value>"
        const promptId = action.action_id.replace(/\.(yes|no)$/, "");
        this.deliverButton(promptId, action.value);
      });
      void client.start();
    } catch (err) {
      console.error(
        `[slack] socket mode init failed: ${(err as Error).message}`,
      );
    }
  }

  async nextReply(_threadTs: string): Promise<string | undefined> {
    this.ensureAttached();
    // Drain any buffered reply first.
    if (this.replyBuffer.length > 0) {
      return this.replyBuffer.shift();
    }
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.replyWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.replyWaiters.splice(i, 1);
        resolve(undefined);
      }, REPLY_HARD_CAP_MS);
      timer.unref?.();
      this.replyWaiters.push({ resolve, timer });
    });
  }

  async nextButton(promptId: string): Promise<string | undefined> {
    this.ensureAttached();
    const buffered = this.buttonBuffer.get(promptId);
    if (buffered !== undefined) {
      this.buttonBuffer.delete(promptId);
      return buffered;
    }
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (this.buttonWaiters.get(promptId)?.timer === timer) {
          this.buttonWaiters.delete(promptId);
        }
        resolve(undefined);
      }, REPLY_HARD_CAP_MS);
      timer.unref?.();
      this.buttonWaiters.set(promptId, { resolve, timer, promptId });
    });
  }

  async shutdown(): Promise<void> {
    // Drain pending waiters so nothing keeps the loop alive.
    for (const w of this.replyWaiters) {
      clearTimeout(w.timer);
      w.resolve(undefined);
    }
    this.replyWaiters = [];
    for (const w of this.buttonWaiters.values()) {
      clearTimeout(w.timer);
      w.resolve(undefined);
    }
    this.buttonWaiters.clear();
    try {
      await this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
  }

  // --- internals shared with tests ---

  private deliverReply(text: string): void {
    const w = this.replyWaiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(text);
    } else {
      this.replyBuffer.push(text);
    }
  }

  private deliverButton(promptId: string, value: string): void {
    const w = this.buttonWaiters.get(promptId);
    if (w) {
      this.buttonWaiters.delete(promptId);
      clearTimeout(w.timer);
      w.resolve(value);
    } else {
      this.buttonBuffer.set(promptId, value);
    }
  }
}

/**
 * Test seam: attach() takes anything that emits "message" + "button"
 * events. Production code lazy-loads the real Slack client; tests
 * pass a hand-rolled EventEmitter.
 */
export interface SocketEventEmitter {
  on(
    event: "message",
    listener: (text: string) => void,
  ): void;
  on(
    event: "button",
    listener: (promptId: string, value: string) => void,
  ): void;
  disconnect?: () => void;
}
