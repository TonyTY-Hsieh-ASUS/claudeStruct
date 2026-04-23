/**
 * Coder agent: implement a single TODO item, return file edits + commit msg.
 *
 * The Coder does NOT touch git or GitHub directly. The orchestrator takes the
 * Coder's `files[]` output, writes it to disk, runs git add/commit, and
 * (optionally) pushes and opens a PR. Keeping the agent pure-functional makes
 * it trivially unit-testable and keeps the sandbox boundary clean.
 *
 * Provider-agnostic: takes an already-built Provider instance so the user
 * can point Coder at any backend (Anthropic, OpenAI, local Ollama, ...).
 */

import { loadPrompt } from "../prompts.js";
import type { InvokeResult, Provider } from "../providers/types.js";
import type { ReviewVerdict, TodoItem } from "../types.js";

export interface CoderFileEdit {
  path: string;
  action: "create" | "modify" | "delete";
  /** Absent for delete. */
  content?: string;
}

export interface CoderOutcome {
  blocked: boolean;
  reason?: string;
  needs?: string;
  commitMessage?: string;
  rationale?: string;
  files?: CoderFileEdit[];
  message: string;
  usage: InvokeResult;
}

interface CoderInput {
  requirement: string;
  todo: TodoItem;
  /** File snapshots the orchestrator gathered for context. */
  fileContext: Array<{ path: string; content: string }>;
  /** Reviewer feedback from a previous round on this task. */
  reviewerFeedback?: ReviewVerdict;
  provider: Provider;
  onText?: (chunk: string) => void;
}

function buildUserMessage(input: CoderInput): string {
  const parts: string[] = [];

  parts.push("## Original requirement");
  parts.push(input.requirement.trim());
  parts.push("");

  parts.push(`## TODO (${input.todo.id})`);
  parts.push(`Title: ${input.todo.title}`);
  parts.push(`Description: ${input.todo.description}`);
  parts.push("");

  if (input.reviewerFeedback) {
    parts.push("## Previous Reviewer feedback — address each finding");
    parts.push(`Summary: ${input.reviewerFeedback.summary}`);
    for (const f of input.reviewerFeedback.findings) {
      parts.push(
        `- [${f.severity}] ${f.file ?? "?"}:${f.line ?? "?"} — ${f.issue}`,
      );
      parts.push(`  Fix: ${f.suggestion}`);
    }
    parts.push("");
  }

  if (input.fileContext.length > 0) {
    parts.push("## Current file contents");
    for (const f of input.fileContext) {
      parts.push(`### ${f.path}`);
      parts.push("```");
      parts.push(f.content);
      parts.push("```");
      parts.push("");
    }
  }

  parts.push(
    "Produce the JSON response per the system prompt. Full file contents, not diffs.",
  );
  return parts.join("\n");
}

export function parseCoderOutput(text: string): Omit<CoderOutcome, "message" | "usage"> {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch?.[1]) {
    return {
      blocked: true,
      reason: "Coder did not return a ```json block.",
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (parsed.blocked === true) {
      return {
        blocked: true,
        reason: String(parsed.reason ?? "<no reason given>"),
        needs: parsed.needs ? String(parsed.needs) : undefined,
      };
    }
    return {
      blocked: false,
      commitMessage: String(parsed.commit_message ?? "chore: update"),
      rationale: parsed.rationale ? String(parsed.rationale) : undefined,
      files: Array.isArray(parsed.files) ? parsed.files : [],
    };
  } catch (err) {
    return {
      blocked: true,
      reason: `Coder produced invalid JSON: ${(err as Error).message}`,
    };
  }
}

export async function runCoder(input: CoderInput): Promise<CoderOutcome> {
  const systemPrompt = loadPrompt("coder");
  const userMessage = buildUserMessage(input);

  const usage = await input.provider.invoke({
    role: "coder",
    systemPrompt,
    userMessage,
    onText: input.onText,
  });

  return {
    ...parseCoderOutput(usage.text),
    message: usage.text,
    usage,
  };
}
