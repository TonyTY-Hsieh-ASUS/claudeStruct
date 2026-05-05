/**
 * Zod schema for `.claw-squad/config.json`.
 *
 * Owning the schema in one place gets us three things the previous
 * scattered checks didn't:
 *
 *   1. Unknown-field detection. Typo `planne` instead of `planner`?
 *      The hand-rolled merge silently dropped it onto the floor.
 *      `.strict()` here rejects it with `Unrecognized key(s) in object: 'planne'`.
 *   2. Field-path errors. Zod reports the path as
 *      `agents.planner.effort`, not `planner: invalid effort`.
 *      Easier to grep when you're staring at a 200-line config.
 *   3. Single source of truth for the file shape. Everything else
 *      (merge, CLI overrides, downstream consumers) keeps its existing
 *      types — this layer just gates what comes off disk.
 *
 * The merge + CLI override logic in config.ts is unchanged: that path
 * is well-tested and zod doesn't help with merging.
 */

import { z } from "zod";

const PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "minimax",
  "ollama",
  "vllm",
  "sglang",
  "openai-compat",
] as const;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * One agent's provider slice. All fields are optional in the config
 * file: anything missing is filled in by DEFAULT_AGENT_CONFIG during
 * the merge phase. We do NOT require `model` here because the CLI
 * `--planner-model` may supply it.
 */
const ProviderConfigSchema = z
  .object({
    name: z.enum(PROVIDERS).optional(),
    model: z.string().min(1).optional(),
    baseURL: z.string().url().or(z.string().min(1)).optional(),
    apiKey: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    /**
     * Free-form passthrough to the underlying SDK (e.g.
     * `reasoning: { effort }` for OpenAI). Schema-level we just
     * accept any object — the SDK call site is the authority.
     */
    extra: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Subagent provider slice — same shape but `name` and `model` are
 * required, since subagents always carry their own concrete provider
 * (no "inherit from default" semantics).
 */
const SubagentProviderSchema = z
  .object({
    name: z.enum(PROVIDERS),
    model: z.string().min(1),
    baseURL: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .strict();

const SubagentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
    provider: SubagentProviderSchema,
  })
  .strict();

const RepoSpecSchema = z
  .object({
    alias: z.string().min(1),
    root: z.string().min(1),
    githubRepo: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

export const ConfigFileSchema = z
  .object({
    agents: z
      .object({
        planner: ProviderConfigSchema.optional(),
        coder: ProviderConfigSchema.optional(),
        reviewer: ProviderConfigSchema.optional(),
      })
      .strict()
      .optional(),
    subagents: z.array(SubagentSchema).optional(),
    repos: z.array(RepoSpecSchema).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * Validate parsed JSON; throw a single Error with one line per issue
 * (`agents.planner.effort: invalid value`). Caller's existing try/catch
 * around `JSON.parse` already handles the "not valid JSON" case.
 */
export function validateConfigFile(raw: unknown, path: string): ConfigFile {
  const result = ConfigFileSchema.safeParse(raw);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `  ${where}: ${issue.message}`;
  });
  throw new Error(
    `invalid ${path}:\n${lines.join("\n")}`,
  );
}
