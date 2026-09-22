/**
 * Turning an agent's message log into a `Turn`.
 *
 * Host-agnostic: accepts the two shapes almost every agent already speaks — Anthropic
 * content blocks (`tool_use` / `tool_result`) and OpenAI chat messages (`tool_calls` /
 * `role: "tool"`) — and reduces the last turn to what the judge needs.
 *
 * Everything hard about this file is selection, not parsing. The judge sees only what
 * we put in the state, so a bad selection rule produces a confident, wrong answer that
 * looks exactly like a model error.
 */
import type { Turn } from "./gate.ts";

export const MAX_RESULTS = 12;
export const MAX_ACTIONS = 40;
const MAX_RESULT_CHARS = 600;
const MAX_MESSAGE_CHARS = 4000;

/** Output that means something went wrong, in the shape tools actually print it. */
const FAILURE =
  /\b(fail(?:ed|ure|s|ing)?|errors?|err!|exit (?:code|status) [1-9]|traceback|panic(?:ked)?|not found|cannot find|denied|refused|timed out|assertion)\b/i;

export const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n)}…[${s.length - n} more chars]`;

/** A neutral message shape both dialects reduce to. */
export type Msg = {
  role: "user" | "assistant" | "tool" | string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string }; name?: string; id?: string }>;
  name?: string;
};

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
};

const hasToolResult = (content: unknown) =>
  Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");

/** One readable line per tool call: the name plus whatever field names its target. */
export const describeCall = (name: string, input: any): string => {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = { value: input };
    }
  }
  const target =
    parsed?.command ??
    parsed?.file_path ??
    parsed?.path ??
    parsed?.pattern ??
    parsed?.url ??
    parsed?.query ??
    parsed?.description ??
    parsed?.value ??
    (parsed === undefined ? "" : JSON.stringify(parsed));
  return clip(`${name}: ${String(target).replace(/\s+/g, " ")}`, 300);
};

/**
 * Keep the results that carry the most signal, not simply the most recent ones.
 *
 * A blind tail is the wrong rule here: long turns are exactly where a failure gets
 * forgotten, so a window that drops the oldest output drops failures precisely when
 * `silent_failure` is most likely to be the right answer. Failures are kept first, then
 * the remaining budget is filled from the tail, and the original order is restored.
 */
export function selectResults(results: string[], max = MAX_RESULTS): string[] {
  if (results.length <= max) return results;

  const keep = new Set<number>();
  const failureBudget = Math.floor(max / 2);
  let kept = 0;
  for (let i = 0; i < results.length && kept < failureBudget; i++) {
    if (FAILURE.test(results[i])) {
      keep.add(i);
      kept++;
    }
  }
  for (let i = results.length - 1; i >= 0 && keep.size < max; i--) keep.add(i);

  return [...keep].sort((a, b) => a - b).map((i) => results[i]);
}

/**
 * Reduce a turn's messages to a `Turn`. `messages` must begin at the human request and
 * run to the end of the turn.
 */
export function normalize(messages: Msg[]): Turn {
  const user_request = clip(textOf(messages[0]?.content).trim(), MAX_MESSAGE_CHARS);

  const said: string[] = [];
  const actions_taken: string[] = [];
  const results: string[] = [];
  let lastActionAt = -1;
  let lastTextAt = -1;
  let step = 0;

  for (const m of messages.slice(1)) {
    step++;
    if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) {
        said.push(text);
        lastTextAt = step;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content as any[]) {
          if (b?.type !== "tool_use") continue;
          actions_taken.push(describeCall(b.name, b.input));
          lastActionAt = step;
        }
      }
      for (const c of m.tool_calls ?? []) {
        actions_taken.push(describeCall(c.function?.name ?? c.name ?? "tool", c.function?.arguments));
        lastActionAt = step;
      }
      continue;
    }

    // Tool output arrives as role "tool" (OpenAI) or as tool_result blocks on a user
    // message (Anthropic). A user message that is neither is a genuine human turn.
    if (m.role === "tool") {
      const body = textOf(m.content) || (typeof m.content === "string" ? m.content : "");
      if (body.trim()) results.push(clip(body.replace(/\n{3,}/g, "\n\n"), MAX_RESULT_CHARS));
      lastActionAt = step;
    } else if (hasToolResult(m.content)) {
      for (const b of m.content as any[]) {
        if (b?.type !== "tool_result") continue;
        const body = typeof b.content === "string" ? b.content : textOf(b.content);
        if (body.trim()) results.push(clip(body.replace(/\n{3,}/g, "\n\n"), MAX_RESULT_CHARS));
      }
      lastActionAt = step;
    }
  }

  return {
    user_request,
    assistant_final_message: clip(said.at(-1)?.trim() ?? "", MAX_MESSAGE_CHARS),
    assistant_said: clip(said.join("\n\n"), MAX_MESSAGE_CHARS * 2),
    actions_taken: actions_taken.slice(-MAX_ACTIONS),
    command_results: selectResults(results),
    // The turn is only conclusive once the agent has spoken after its last action.
    conclusive: lastTextAt > lastActionAt,
  };
}

/** Split a full message log at the last genuine human message and normalise that turn. */
export function normalizeLastTurn(messages: Msg[]): Turn {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (hasToolResult(m.content)) continue;
    if (!textOf(m.content).trim()) continue;
    start = i;
    break;
  }
  return normalize(messages.slice(start));
}
