/**
 * Planner agent: requirements Q&A + TODO list generation + per-loop review.
 *
 * Provider-agnostic: receives an already-constructed Provider from the
 * orchestrator. This keeps the agent cheap to call (no client
 * reinstantiation per turn) and lets the user point Planner at any
 * backend (Anthropic, OpenAI, local Ollama, Gemini, etc.).
 *
 * Token efficiency on Anthropic:
 *  - System prompt is loaded once from disk; the AnthropicProvider marks
 *    it with cache_control ephemeral TTL=1h so repeat calls hit cache.
 *  - Q&A history accumulates in the messages array (after the cached
 *    prefix), so each new question payload is cheap: prior turns hit
 *    the cache.
 *
 * On non-Anthropic providers there's no explicit caching, but OpenAI-class
 * backends do some server-side auto-caching of identical prefixes.
 */

import { loadPrompt } from "../prompts.js";
import type { InvokeResult, Provider } from "../providers/types.js";
import type {
  ClarificationTurn,
  SquadState,
  TodoItem,
} from "../types.js";

export type PlannerPhase = "clarification" | "ready" | "todos" | "complete";

export interface PlannerOutcome {
  phase: PlannerPhase;
  /** Questions emitted in `clarification` phase. */
  questions?: string[];
  /** A short restatement of the scope, in `ready` phase. */
  understanding?: string;
  /** New or revised TODO list, in `todos` phase. */
  todos?: TodoItem[];
  /** Free-form message the orchestrator should show to the user. */
  message: string;
  usage: InvokeResult;
}

interface PlannerInput {
  state: SquadState;
  /** "initial" = first requirement; "loop" = post-task cycle. */
  mode: "initial" | "loop";
  /** Memory snippet the orchestrator prepends to the user turn. */
  memorySnippet?: string;
  /** Summary of just-completed task, used in loop mode. */
  completedTaskSummary?: string;
  provider: Provider;
  onText?: (chunk: string) => void;
}

/** Build the user message the Planner sees on each turn. */
function buildUserMessage(input: PlannerInput): string {
  const { state, mode, memorySnippet, completedTaskSummary } = input;
  const parts: string[] = [];

  if (memorySnippet && memorySnippet.trim().length > 0) {
    parts.push("## Memory (lessons from prior loops)");
    parts.push(memorySnippet.trim());
    parts.push("");
  }

  parts.push("## Requirement");
  parts.push(state.requirement.trim());
  parts.push("");

  if (state.clarifications.length > 0) {
    parts.push("## Clarifications so far");
    for (const turn of state.clarifications) {
      parts.push(`Q: ${turn.question}`);
      parts.push(`A: ${turn.answer ?? "<pending>"}`);
    }
    parts.push("");
  }

  if (mode === "loop") {
    parts.push("## Just-completed task");
    parts.push(completedTaskSummary ?? "<missing summary>");
    parts.push("");
    parts.push("## Current TODO list");
    parts.push(
      state.todos
        .map(
          (t) =>
            `- [${t.status}] ${t.id}: ${t.title}${t.mergedPrNumber ? ` (PR #${t.mergedPrNumber})` : ""}`,
        )
        .join("\n"),
    );
    parts.push("");
    parts.push(
      "Review the TODO list. Mark completed items, adjust as needed, and emit the next item or `## Phase: complete`.",
    );
  } else if (!state.planReady) {
    parts.push(
      "Phase 1: ask any clarifying questions you need, OR emit `## Phase: ready` if the requirement is already clear.",
    );
  } else {
    parts.push("Phase 2: emit the full TODO list as JSON.");
  }

  return parts.join("\n");
}

/** Parse Planner's response. Tolerant: falls back to `ready` if shape is off. */
export function parsePlannerOutput(text: string): {
  phase: PlannerPhase;
  questions?: string[];
  understanding?: string;
  todos?: TodoItem[];
} {
  const phaseMatch = text.match(/##\s*Phase:\s*(\w+)/i);
  const phaseRaw = phaseMatch?.[1]?.toLowerCase() ?? "";
  let phase: PlannerPhase = "ready";
  if (phaseRaw === "clarification") phase = "clarification";
  else if (phaseRaw === "ready") phase = "ready";
  else if (phaseRaw === "complete") phase = "complete";
  else if (text.includes("```json")) phase = "todos";

  if (phase === "clarification") {
    const qSection = text.split(/##\s*Questions/i)[1] ?? "";
    const questions = qSection
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\./.test(l))
      .map((l) => l.replace(/^\d+\.\s*/, ""));
    return { phase, questions };
  }

  if (phase === "todos") {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch?.[1]) return { phase: "ready" };
    try {
      const parsed = JSON.parse(jsonMatch[1]) as {
        todos: Array<
          Pick<TodoItem, "id" | "title" | "description"> & {
            skills?: string[];
          }
        >;
      };
      const todos: TodoItem[] = parsed.todos.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: "pending",
        iterations: 0,
        // Only include `skills` if Planner tagged valid strings.
        ...(Array.isArray(t.skills) && t.skills.length > 0
          ? { skills: t.skills.filter((s): s is string => typeof s === "string") }
          : {}),
      }));
      return { phase, todos };
    } catch {
      return { phase: "ready" };
    }
  }

  if (phase === "ready") {
    const uSection = text.split(/##\s*Understanding/i)[1] ?? "";
    const understanding = uSection.split(/##/)[0]?.trim() ?? undefined;
    return { phase, understanding };
  }

  return { phase };
}

export async function runPlanner(input: PlannerInput): Promise<PlannerOutcome> {
  const systemPrompt = loadPrompt("planner");
  const userMessage = buildUserMessage(input);

  const usage = await input.provider.invoke({
    role: "planner",
    systemPrompt,
    userMessage,
    onText: input.onText,
  });

  const parsed = parsePlannerOutput(usage.text);
  return {
    ...parsed,
    message: usage.text,
    usage,
  };
}

/** Record that we asked a question and got an answer. */
export function recordClarification(
  state: SquadState,
  question: string,
  answer: string,
): ClarificationTurn {
  const turn: ClarificationTurn = { question, answer };
  state.clarifications.push(turn);
  return turn;
}
