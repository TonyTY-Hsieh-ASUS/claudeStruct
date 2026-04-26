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
import type { AgentRole, RepoSpec, RunConfig } from "./types.js";
import type { ProviderConfig, ProviderName } from "./providers/types.js";
import { validateConfigFile } from "./config-schema.js";

/**
 * Per-agent provider config. One entry per role; each entry is a full
 * ProviderConfig the registry can hand to a concrete provider.
 */
export type AgentConfig = Record<AgentRole, ProviderConfig> & {
  /**
   * Optional catalog of subagents. Primary agents (currently only
   * Planner) can delegate to these via `## Delegate <name>` directives.
   * Each subagent has its own ProviderConfig + a system prompt. Empty
   * or missing means the feature is off for this run.
   */
  subagents?: Array<{
    name: string;
    description: string;
    systemPrompt: string;
    provider: ProviderConfig;
  }>;
};

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
  const parsed = readConfigFile(
    input.configPath ?? autoConfigPath(input.repoRoot),
  );
  const fromFile = parsed?.agents;
  // Layer defaults -> file -> CLI, then validate.
  const merged: AgentConfig = {
    planner: mergeOne("planner", fromFile?.planner, input.cliOverrides?.planner),
    coder: mergeOne("coder", fromFile?.coder, input.cliOverrides?.coder),
    reviewer: mergeOne("reviewer", fromFile?.reviewer, input.cliOverrides?.reviewer),
  };
  for (const role of (["planner", "coder", "reviewer"] as AgentRole[])) {
    validateConfig(role, merged[role]);
  }
  // Subagents come from the config file verbatim. Validate each one's
  // provider slice the same way.
  if (parsed?.subagents && Array.isArray(parsed.subagents)) {
    merged.subagents = parsed.subagents.map((s, i) => {
      if (!s || typeof s.name !== "string" || s.name.length === 0) {
        throw new Error(`subagents[${i}]: missing name`);
      }
      if (!s.provider || typeof s.provider !== "object") {
        throw new Error(`subagents[${s.name}]: missing provider config`);
      }
      validateConfig(`subagent:${s.name}`, s.provider as ProviderConfig);
      return {
        name: s.name,
        description: typeof s.description === "string" ? s.description : "",
        systemPrompt:
          typeof s.systemPrompt === "string" ? s.systemPrompt : "",
        provider: s.provider as ProviderConfig,
      };
    });
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

function validateConfig(role: string, cfg: ProviderConfig): void {
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
  subagents?: Array<{
    name: string;
    description?: string;
    systemPrompt?: string;
    provider: ProviderConfig;
  }>;
  /**
   * Optional multi-repo spec. When present, supersedes the legacy
   * `repoRoot` / `githubRepo` fields on `RunConfig` — the orchestrator
   * routes each task to the repo its `repoAlias` names.
   */
  repos?: RepoSpec[];
}

/**
 * Read the `repos` list out of the config file on disk, if any. Kept
 * separate from `loadAgentConfig` so the CLI can merge it into
 * `RunConfig` without threading agent logic through that path.
 */
export function loadReposFromFile(input: ConfigInput): RepoSpec[] | undefined {
  const parsed = readConfigFile(
    input.configPath ?? autoConfigPath(input.repoRoot),
  );
  if (!parsed?.repos || parsed.repos.length === 0) return undefined;
  return parsed.repos;
}

/**
 * Collapse the legacy single-repo config keys and the new `repos` list
 * into the canonical form the orchestrator consumes.
 *
 * Order of precedence:
 *   1. If `config.repos` is set and non-empty, use it verbatim.
 *   2. Otherwise synthesize `[{ alias: "default", root, githubRepo }]`.
 *
 * This lets every existing single-repo run keep working without
 * requiring a config migration, while multi-repo configs opt in by
 * listing `repos` explicitly.
 */
export function resolveRepos(config: RunConfig): RepoSpec[] {
  if (config.repos && config.repos.length > 0) {
    // Defensive validation — duplicate aliases would make lookups
    // ambiguous, and empty roots would silently break git invocations.
    const aliases = new Set<string>();
    for (const r of config.repos) {
      if (!r.alias || r.alias.length === 0) {
        throw new Error(`repos[*]: missing alias`);
      }
      if (!r.root || r.root.length === 0) {
        throw new Error(`repos[${r.alias}]: missing root`);
      }
      if (aliases.has(r.alias)) {
        throw new Error(`repos: duplicate alias "${r.alias}"`);
      }
      aliases.add(r.alias);
    }
    return config.repos;
  }
  return [
    {
      alias: "default",
      root: config.repoRoot,
      githubRepo: config.githubRepo,
    },
  ];
}

function readConfigFile(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  // zod gates the file's *shape*: unknown fields, wrong enum values,
  // string-vs-number mistakes get a clear `agents.planner.effort: ...`
  // message. The merge + CLI override path below keeps its existing
  // checks for the post-merge result.
  return validateConfigFile(parsed, path) as ConfigFile;
}
