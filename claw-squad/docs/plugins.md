# Plugins (W7.4)

Third parties extend `claw-squad` by publishing an npm package whose
name starts with `claudestruct-plugin-`. The package's default export
is a `ClawSquadPlugin` object that contributes new subagents and
skills to the orchestrator's catalog.

The plugin SDK does **not** let plugins replace the Planner / Coder /
Reviewer roles — those are core, and a third party flipping the
orchestrator state machine breaks every other plugin. New roles land
via subagents (delegated, opt-in).

## Authoring a plugin

```ts
// claudestruct-plugin-research/src/index.ts
import type { ClawSquadPlugin } from "claudestruct-plugin-sdk";

const plugin: ClawSquadPlugin = {
  apiVersion: 1,
  name: "claudestruct-plugin-research",
  description: "Web-research subagent backed by a cheap Sonnet config",
  subagents: [
    {
      name: "research",
      description: "Summarize a URL into 3 bullets",
      systemPrompt: "You are a research assistant ...",
      provider: { kind: "anthropic", model: "claude-sonnet-4-6" },
    },
  ],
  skills: [
    {
      name: "research-conventions",
      description: "How the team writes research summaries",
      body: "# Research conventions\n\n- Cite sources ...\n",
    },
  ],
};

export default plugin;
```

## Loading rules

1. `claw-squad run` scans `<repoRoot>/node_modules` for directories
   matching `claudestruct-plugin-*`.
2. Each match is `import()`-ed and its default export validated against
   `isPlugin()`.
3. Plugins whose `apiVersion` doesn't match the host's
   [`PLUGIN_API_VERSION`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/src/plugins.ts) are skipped with a
   warning. Bumping the host major is a breaking change.
4. `mergePlugins()` flattens contributions; duplicate subagent names
   are dropped (first wins, deterministic by directory order) with
   a warning.

## Required vs optional fields

| Field         | Required | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| `apiVersion`  | yes      | integer; must equal the host's `PLUGIN_API_VERSION`|
| `name`        | yes      | non-empty string; conventionally the package name  |
| `description` | no       | shown in `claw-squad plugins list`                 |
| `subagents`   | no       | array of `SubagentContribution`                    |
| `skills`      | no       | array of `SkillContribution`                       |

## SubagentContribution shape

The host constructs the actual `Provider` at boot from the
`provider: ProviderConfig` field. Plugin authors don't bundle SDKs.

```ts
interface SubagentContribution {
  name: string;
  description: string;
  systemPrompt: string;
  provider: ProviderConfig;
}
```

See [`agents.md`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/docs/agents.md)
for the orchestrator's existing subagent contract and
[`providers.md`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/docs/providers.md)
for the supported provider configs.

## SkillContribution shape

Same as a local skill (`skills.ts`) minus `path`. The host fills in
`path` to point at the plugin's package directory so error messages
stay actionable.

```ts
interface SkillContribution {
  name: string;
  description: string;
  body: string;
  applyTo?: string[];
}
```

## Testing your plugin

The plugin SDK is itself published as a TypeScript module — pull it in
as a `peerDependency` and write your own tests against the
`ClawSquadPlugin` interface. The host's `mergePlugins()` is exposed
for integration tests.

## Registering a plugin without npm

For vendored or in-repo plugins, you can opt out of auto-discovery
and pass plugin objects directly to the orchestrator config. See
`mergePlugins()` in [`src/plugins.ts`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/src/plugins.ts) —
it accepts a plain array of `ClawSquadPlugin` values.

## Discovery diagnostics

Run `claw-squad run --dry-run` and scan the warnings: every skipped
plugin surfaces a one-line reason (`apiVersion` mismatch, missing
default export, etc.). Use these to debug a plugin that "doesn't show
up" in the catalog.
