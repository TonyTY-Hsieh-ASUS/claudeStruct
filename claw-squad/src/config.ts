/**
 * Config loader: resolves per-agent provider/model from three layers
 * (in ascending precedence):
 *
 *   1. Built-in defaults  (DEFAULT_AGENT_CONFIG — all Anthropic)
 *   2. .claw-squad/config.json in the repo, if present
 *   3. CLI flags (--planner-provider, --coder-model, etc.)
 *
 * The goal is that a user with no config gets the sensible Anthropic
 * defaults (which match the original hardcoded behavior), a team can
 * commit a shared config.json for its project, and individual runs can
 * override via flags without editing files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "./types.js";
import type { ProviderConfig, ProviderName } from "./providers/types.js";

/**
 * Per-agent provider config. One entry per role; each entry is a full
 * ProviderConfig the registry can hand to a concrete provider.
 */
export type AgentConfig = Record<AgentRole, ProviderConfig>;

/**
 * Built-in defaults. All Anthropic — matches what the orchestrator did
 * before the provider abstraction landed. Users who want to stick with
 * cloud Claude don't need to write any config.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  planner: {
    name: "anthropic",
    model: "claude-opus-4-7",
    effort: "max",
  },
  coder: {
    name: "anthropic",
    model: "claude-sonnet-4-6",
    effort: "high",
  },
  reviewer: {
    name: "anthropic",
    model: "claude-opus-4-7",
    effort: "xhigh",
  },
};

const VALID_PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "gemini",
  "minimax",
  "ollama",
  "vllm",
  "sglang",
  "openai-compat",
];

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface AgentCliOverride {
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  effort?: string;
}

export interface ConfigInput {
  repoRoot: string;
  cliOverrides?: Partial<Record<AgentRole, AgentCliOverride>>;
  /** Absolute path to a config file. Overrides the auto-detected one. */
  configPath?: string;
}

export function loadAgentConfig(input: ConfigInput): AgentConfig {
  const fromFile = readConfigFile(input.configPath ?? autoConfigPath(input.repoRoot));
  // Layer defaults -> file -> CLI, then validate.
  const merged: AgentConfig = {
    planner: mergeOne("planner", fromFile?.planner, input.cliOverrides?.planner),
    coder: mergeOne("coder", fromFile?.coder, input.cliOverrides?.coder),
    reviewer: mergeOne("reviewer", fromFile?.reviewer, input.cliOverrides?.reviewer),
  };
  for (const role of Object.keys(merged) as AgentRole[]) {
    validateConfig(role, merged[role]);
  }
  return merged;
}

function mergeOne(
  role: AgentRole,
  fromFile: Partial<ProviderConfig> | undefined,
  fromCli: AgentCliOverride | undefined,
): ProviderConfig {
  const base = DEFAULT_AGENT_CONFIG[role];
  const merged: ProviderConfig = {
    ...base,
    ...(fromFile ?? {}),
  };
  // Explicit `!== undefined` so an empty-string CLI value hits validation
  // (and errors loudly) instead of silently falling back to the default.
  if (fromCli?.provider !== undefined) merged.name = fromCli.provider as ProviderName;
  if (fromCli?.model !== undefined) merged.model = fromCli.model;
  if (fromCli?.baseURL !== undefined) merged.baseURL = fromCli.baseURL;
  if (fromCli?.apiKey !== undefined) merged.apiKey = fromCli.apiKey;
  if (fromCli?.effort !== undefined) {
    merged.effort = fromCli.effort as ProviderConfig["effort"];
  }
  return merged;
}

function validateConfig(role: AgentRole, cfg: ProviderConfig): void {
  if (!VALID_PROVIDERS.includes(cfg.name)) {
    throw new Error(
      `${role}: invalid provider "${cfg.name}". Valid: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
  if (typeof cfg.model !== "string" || cfg.model.length === 0) {
    throw new Error(`${role}: model is required`);
  }
  if (cfg.effort !== undefined && !VALID_EFFORTS.includes(cfg.effort)) {
    throw new Error(
      `${role}: invalid effort "${cfg.effort}". Valid: ${VALID_EFFORTS.join(", ")}`,
    );
  }
}

function autoConfigPath(repoRoot: string): string {
  return join(repoRoot, ".claw-squad", "config.json");
}

interface ConfigFile {
  agents?: {
    planner?: Partial<ProviderConfig>;
    coder?: Partial<ProviderConfig>;
    reviewer?: Partial<ProviderConfig>;
  };
}

function readConfigFile(path: string): ConfigFile["agents"] | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(raw) as ConfigFile;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  return parsed.agents;
}
