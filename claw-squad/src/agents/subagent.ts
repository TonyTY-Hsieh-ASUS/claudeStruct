/**
 * Subagents — ephemeral one-shot consultations.
 *
 * A subagent is a stateless LLM call the orchestrator makes on behalf
 * of a primary agent (usually the Planner or the Coder) to get a
 * focused answer without polluting the primary's context budget.
 *
 * Use cases:
 *   - Research: "summarize the error handling conventions in src/api/"
 *   - Verification: "does this regex match IPv6?"
 *   - Cheap-model delegation: Planner is on opus-4-7 for reasoning,
 *     but a quick grep-and-summarize can happen on sonnet-4-6 or
 *     even a local Ollama model.
 *
 * Design:
 *   - Subagents live in a named catalog on AgentConfig (e.g. "research",
 *     "grep-summarize"). Each one has its own ProviderConfig and a
 *     system prompt.
 *   - Primary agents request a subagent by emitting `## Delegate <name>\n
 *     <prompt>` in their streamed output (parsed by the orchestrator).
 *   - The subagent answer is appended to the primary's user turn on
 *     the next invocation, so the primary sees it next time it runs.
 *
 * This keeps the extension opt-in: if no subagents are configured,
 * primaries don't know to delegate and behavior is unchanged.
 */

import type { InvokeResult, Provider } from "../providers/types.js";
import type { AgentRole } from "../types.js";

export interface SubagentSpec {
  /** Identifier used in delegate directives like `## Delegate <name>`. */
  name: string;
  /** Short one-liner for primaries to know when to pick this subagent. */
  description: string;
  /** Frozen system prompt; loaded from disk if `promptPath` is set. */
  systemPrompt: string;
  /** The provider already constructed (with hooks if applicable). */
  provider: Provider;
}

export interface SubagentRequest {
  /** Which subagent to invoke — must match a name in the catalog. */
  name: string;
  /** The question / task from the primary. */
  prompt: string;
  /** Which primary role asked — for logging. */
  requestedBy: AgentRole;
}

export interface SubagentResponse {
  name: string;
  answer: string;
  usage: InvokeResult;
}

/**
 * Parse delegate directives out of a primary agent's text stream.
 * Format:
 *
 *   ## Delegate <name>
 *   <free-form prompt, ends at the next heading or end of string>
 *
 * Returns an empty array if the primary didn't delegate. A primary
 * can delegate to multiple subagents in one response; the orchestrator
 * runs them serially and folds the answers back in a single block.
 */
export function parseDelegates(text: string): Array<{ name: string; prompt: string }> {
  const out: Array<{ name: string; prompt: string }> = [];
  // Split on lines starting with `## `. Each section after a split is
  // one heading's content. JS regex doesn't have a clean `\z`, so this
  // split-based approach sidesteps lookahead gymnastics.
  const sections = text.split(/^## +/m).slice(1); // drop leading text
  for (const section of sections) {
    // section looks like "<heading-rest-of-line>\n<body-until-end>"
    const nl = section.indexOf("\n");
    const heading = nl >= 0 ? section.slice(0, nl) : section;
    const body = nl >= 0 ? section.slice(nl + 1) : "";
    const m = heading.match(/^Delegate\s+(.+)\s*$/i);
    if (!m) continue;
    const name = m[1]?.trim();
    const prompt = body.trim();
    if (name && prompt) out.push({ name, prompt });
  }
  return out;
}

/**
 * Run a subagent and return its answer text + usage.
 *
 * The subagent sees only the primary's delegation prompt + its own
 * system prompt — no history of the primary's conversation. This is
 * deliberate: subagents are cheap helpers, not conversational partners.
 */
export async function runSubagent(
  spec: SubagentSpec,
  req: SubagentRequest,
  onText?: (chunk: string) => void,
): Promise<SubagentResponse> {
  const usage = await spec.provider.invoke({
    role: "planner", // bookkeeping: we don't add a new AgentRole variant
    systemPrompt: spec.systemPrompt,
    userMessage: req.prompt,
    onText,
  });
  return { name: spec.name, answer: usage.text, usage };
}

/**
 * Render one or more subagent answers as a block to inject into the
 * primary's next user turn. Primaries see:
 *
 *   ## Subagent answers (from your delegates)
 *   ### researcher
 *   <answer>
 *
 *   ### grep-summarize
 *   <answer>
 */
export function renderSubagentAnswers(answers: SubagentResponse[]): string {
  if (answers.length === 0) return "";
  const parts = ["## Subagent answers (from your delegates)"];
  for (const a of answers) {
    parts.push("");
    parts.push(`### ${a.name}`);
    parts.push(a.answer.trim());
  }
  return parts.join("\n");
}
