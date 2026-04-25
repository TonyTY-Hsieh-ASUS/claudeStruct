/**
 * Lock the transport policy resolution.
 *
 * Both Anthropic and OpenAI-compat providers consult `transportPolicy()`
 * once per construction, so a regression here silently weakens timeout
 * / retry behavior for every agent in the squad. The cases pin: the
 * defaults, the env-var overrides, and the fallback when env vars are
 * malformed (we never want a typo'd env var to set retries to NaN).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transportPolicy } from "../src/providers/transport.js";

describe("transportPolicy", () => {
  let prevTimeout: string | undefined;
  let prevRetries: string | undefined;
  beforeEach(() => {
    prevTimeout = process.env.CLAW_SQUAD_TIMEOUT;
    prevRetries = process.env.CLAW_SQUAD_MAX_RETRIES;
    delete process.env.CLAW_SQUAD_TIMEOUT;
    delete process.env.CLAW_SQUAD_MAX_RETRIES;
  });
  afterEach(() => {
    if (prevTimeout === undefined) delete process.env.CLAW_SQUAD_TIMEOUT;
    else process.env.CLAW_SQUAD_TIMEOUT = prevTimeout;
    if (prevRetries === undefined) delete process.env.CLAW_SQUAD_MAX_RETRIES;
    else process.env.CLAW_SQUAD_MAX_RETRIES = prevRetries;
  });

  it("defaults to 5 min timeout and 3 retries", () => {
    const p = transportPolicy();
    expect(p.timeoutMs).toBe(5 * 60 * 1000);
    expect(p.maxRetries).toBe(3);
  });

  it("respects valid CLAW_SQUAD_TIMEOUT", () => {
    process.env.CLAW_SQUAD_TIMEOUT = "120000";
    expect(transportPolicy().timeoutMs).toBe(120_000);
  });

  it("respects valid CLAW_SQUAD_MAX_RETRIES and floors decimals", () => {
    process.env.CLAW_SQUAD_MAX_RETRIES = "5.7";
    expect(transportPolicy().maxRetries).toBe(5);
  });

  it("falls back when env vars are malformed", () => {
    process.env.CLAW_SQUAD_TIMEOUT = "soon";
    process.env.CLAW_SQUAD_MAX_RETRIES = "lots";
    const p = transportPolicy();
    expect(p.timeoutMs).toBe(5 * 60 * 1000);
    expect(p.maxRetries).toBe(3);
  });

  it("falls back on negative values", () => {
    process.env.CLAW_SQUAD_TIMEOUT = "-1";
    process.env.CLAW_SQUAD_MAX_RETRIES = "-2";
    const p = transportPolicy();
    expect(p.timeoutMs).toBe(5 * 60 * 1000);
    expect(p.maxRetries).toBe(3);
  });
});
