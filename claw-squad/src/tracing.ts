/**
 * OpenTelemetry tracing for claw-squad — opt-in, zero-cost when disabled.
 *
 * Mirrors the Python side (`src/claudestruct/tracing.py`) so a single
 * OTel collector can ingest traces from both tools using the same
 * span-name conventions:
 *
 *   - `clawSquad.run`            (root span, one per `runOrchestrator`)
 *     - `clawSquad.planner.call`
 *     - `clawSquad.coder.call`
 *     - `clawSquad.reviewer.call`
 *     - `clawSquad.subagent.call` (with `subagent.name` attribute)
 *
 * Activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it
 * every helper is a no-op and the OTel SDK never loads. The SDK is
 * declared as an `optionalDependencies` block in package.json so a
 * normal `pnpm install` skips it; users who want tracing run
 * `pnpm install @opentelemetry/api @opentelemetry/sdk-node \
 *  @opentelemetry/exporter-trace-otlp-http`.
 *
 * Why HTTP exporter (not gRPC): same reasoning as the Python module —
 * proxies / CDNs frequently block gRPC; HTTP is universally usable
 * and the perf gap is negligible for the CLI's trace volume.
 */

interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
  recordException(err: Error): void;
}

const NOOP_SPAN: Span = {
  setAttribute: () => {},
  end: () => {},
  recordException: () => {},
};

let initialized = false;
let enabled = false;
let tracer: { startSpan(name: string): Span } | null = null;
let shutdownFn: (() => Promise<void>) | null = null;

export function isEnabled(): boolean {
  return enabled;
}

/**
 * Initialise tracing if the OTLP endpoint is set in env. Idempotent;
 * a second call returns the same enabled flag without re-init.
 *
 * Returns a Promise<boolean> because the OTel SDK's dynamic `import`
 * is async. Callers in synchronous orchestration contexts can await
 * this once at startup; the helpers below stay synchronous.
 */
export async function initTracing(serviceName = "claw-squad"): Promise<boolean> {
  if (initialized) return enabled;
  initialized = true;

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) {
    enabled = false;
    return false;
  }

  try {
    // Dynamic import keeps the SDK out of the cold-start cost when
    // tracing is disabled, AND lets `pnpm install` skip the optional
    // dep without breaking compilation. Marked `// @ts-ignore` because
    // the package isn't part of the always-installed type surface.
    // @ts-ignore — optional peer
    const api = await import("@opentelemetry/api");
    // @ts-ignore — optional peer
    const sdkNode = await import("@opentelemetry/sdk-node");
    // @ts-ignore — optional peer
    const otlpHttp = await import("@opentelemetry/exporter-trace-otlp-http");

    const sdk = new sdkNode.NodeSDK({
      serviceName,
      traceExporter: new otlpHttp.OTLPTraceExporter(),
    });
    sdk.start();
    shutdownFn = () => sdk.shutdown();

    const apiTracer = api.trace.getTracer(serviceName);
    tracer = {
      startSpan(name: string): Span {
        const s = apiTracer.startSpan(name);
        return {
          setAttribute(k, v) {
            s.setAttribute(k, v);
          },
          end() {
            s.end();
          },
          recordException(err) {
            s.recordException(err);
          },
        };
      },
    };
    enabled = true;
    return true;
  } catch (err) {
    // Soft dep: don't crash the run, warn once. Users who want tracing
    // should install the OTel packages explicitly.
    process.stderr.write(
      `[tracing] OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry ` +
        `SDK is not installed. Run \`pnpm add @opentelemetry/api ` +
        `@opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http\` ` +
        `to enable tracing.\n` +
        (err instanceof Error ? `[tracing] reason: ${err.message}\n` : ""),
    );
    enabled = false;
    return false;
  }
}

/**
 * Open a span, run the function, end the span. Returns whatever `fn`
 * returns. Exceptions are recorded on the span before re-throwing so
 * the trace shows the failure mode.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!enabled || tracer === null) {
    return fn(NOOP_SPAN);
  }
  const span = tracer.startSpan(name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    span.setAttribute(k, v);
  }
  try {
    return await fn(span);
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/** Flush + shut down the trace pipeline. Call before process exit. */
export async function shutdownTracing(): Promise<void> {
  if (!enabled || shutdownFn === null) return;
  try {
    await shutdownFn();
  } catch {
    // Best-effort: shutdown failure must not mask the real exit code.
  }
}

// ---- Test-only helpers ---------------------------------------------
//
// `_resetForTests` lets vitest reset module-level state between cases
// so the disabled-by-default contract is testable without process
// recycling. Not exported through index; intended for tests only.

export function _resetForTests(): void {
  initialized = false;
  enabled = false;
  tracer = null;
  shutdownFn = null;
}

export function _injectForTests(t: { startSpan(name: string): Span } | null): void {
  tracer = t;
  enabled = t !== null;
  initialized = true;
}
