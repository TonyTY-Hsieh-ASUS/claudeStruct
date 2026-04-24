/**
 * Chunk-batching for remote UIs.
 *
 * `streamAgent(role, chunk)` fires every ~N ms with a few bytes of
 * model output. That's fine for a local TTY, but remote transports
 * (Slack thread replies, websocket frames) rate-limit heavily and a
 * per-chunk message would either drop or cost real money in API
 * calls. This module coalesces chunks into time-bucketed flushes and
 * hands each flush to a sink.
 *
 * Contract:
 *   - push(role, chunk) never blocks and never throws.
 *   - The first chunk starts a setTimeout; any chunks inside the
 *     window join that flush. When the timer fires the combined text
 *     (grouped by role) is handed to sink(flushes).
 *   - shutdown() flushes immediately and disables further flushes.
 *
 * Why per-role grouping instead of a single concatenated string? Some
 * transports render roles with different styling (emoji, color). The
 * sink gets to decide.
 */

export interface FlushedGroup {
  role: string;
  text: string;
}

export type FlushSink = (groups: FlushedGroup[]) => void | Promise<void>;

export class BatchedStreamer {
  private buffer: Map<string, string> = new Map();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  /**
   * @param flushMs how long to wait after the first chunk before
   *   flushing. Typical: 250ms for Web UI, 1500ms for Slack.
   * @param sink callback that receives the coalesced groups. Errors
   *   inside the sink are caught — a broken transport must not bubble
   *   up to the orchestrator.
   */
  constructor(
    private readonly flushMs: number,
    private readonly sink: FlushSink,
  ) {}

  push(role: string, chunk: string): void {
    if (this.closed) return;
    if (chunk.length === 0) return;
    const prev = this.buffer.get(role) ?? "";
    this.buffer.set(role, prev + chunk);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushNow(), this.flushMs);
      // Don't keep the event loop alive for the flush timer — the
      // orchestrator's exit shouldn't wait on us.
      this.timer.unref?.();
    }
  }

  /** Flush immediately and dispose. Safe to call more than once. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushNow();
  }

  private async flushNow(): Promise<void> {
    this.timer = undefined;
    if (this.buffer.size === 0) return;
    const groups: FlushedGroup[] = [];
    for (const [role, text] of this.buffer) {
      groups.push({ role, text });
    }
    this.buffer.clear();
    try {
      await this.sink(groups);
    } catch {
      // Remote transport failures are their own problem — swallow so
      // the orchestrator keeps running.
    }
  }
}
