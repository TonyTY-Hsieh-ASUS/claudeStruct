/**
 * Shared HTTP timeout + retry policy for the Anthropic and OpenAI-compat
 * provider clients.
 *
 * Both SDKs accept `timeout` and `maxRetries` in their constructors and
 * already handle exponential backoff for 5xx / 429 internally. We just
 * pin sensible defaults and let env vars override — no hand-rolled
 * retry loop.
 *
 * Defaults:
 *   - timeout 5 min: long agent tasks still respond in bursts; a hung
 *     connection beyond that is a transport problem, not slow inference.
 *   - 3 retries: absorbs a brief regional blip; bigger numbers compound
 *     latency for already-doomed requests.
 *
 * Env vars:
 *   - CLAW_SQUAD_TIMEOUT      ms (numeric)
 *   - CLAW_SQUAD_MAX_RETRIES  count (numeric, integer)
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

export interface TransportPolicy {
  timeoutMs: number;
  maxRetries: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readInteger(name: string, fallback: number): number {
  const n = readNumber(name, fallback);
  return Math.floor(n);
}

export function transportPolicy(): TransportPolicy {
  return {
    timeoutMs: readNumber("CLAW_SQUAD_TIMEOUT", DEFAULT_TIMEOUT_MS),
    maxRetries: readInteger("CLAW_SQUAD_MAX_RETRIES", DEFAULT_MAX_RETRIES),
  };
}
