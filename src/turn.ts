/** A turn, reduced to the bounded state the judge sees: request, what was said, actions, the output that matters. */

export type Turn = {
  user_request: string; assistant_final_message: string; assistant_said: string; actions_taken: string[]; command_results: string[];
  /** The agent spoke after its last action; otherwise no "was it reported?" question can be judged. */
  conclusive: boolean;
};
export type Msg = { role: string; content?: unknown };

const FAILURE = /\b(fail(?:ed|ure|s|ing)?|errors?|err!|exit (?:code|status) [1-9]|traceback|panic(?:ked)?|not found|cannot find|denied|refused|timed out|assertion)\b/i;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…[${s.length - n} more chars]`);
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const hasResult = (c: unknown) => Array.isArray(c) && c.some((b) => b?.type === "tool_result");
/** Block reasons a host echoes back as user messages are not the request. */
const injected = (t: string) => t.startsWith("orly (an independent") || t.startsWith("orly? refuses");

/** Failures first (up to half), then the tail, in original order: a blind tail drops the early failure. */
export function selectResults(results: string[], max = 12): string[] {
  if (results.length <= max) return results;
  const keep = new Set<number>();
  results.forEach((r, i) => keep.size < max / 2 && FAILURE.test(r) && keep.add(i));
  for (let i = results.length - 1; i >= 0 && keep.size < max; i--) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => results[i]);
}

/** The last turn of an Anthropic-shaped message log: from the last human message to the end. */
export function normalize(all: Msg[]): Turn {
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = textOf(all[i].content).trim();
    if (all[i].role === "user" && !hasResult(all[i].content) && t && !injected(t)) { start = i; break; }
  }
  const said: string[] = [], actions: string[] = [], results: string[] = [];
  let lastAction = -1, lastText = -1;
  all.slice(start + 1).forEach((m, step) => {
    if (m.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) { said.push(t); lastText = step; }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== "tool_use") continue;
        const i = b.input ?? {};
        const target = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? JSON.stringify(i);
        actions.push(clip(`${b.name}: ${String(target).replace(/\s+/g, " ")}`, 300));
        lastAction = step;
      }
    } else if (hasResult(m.content)) {
      for (const b of m.content as any[]) {
        const body = (typeof b.content === "string" ? b.content : textOf(b.content)).replace(/\n{3,}/g, "\n\n");
        if (b.type === "tool_result" && body.trim()) results.push(clip(body, 600));
      }
      lastAction = step;
    }
  });
  return {
    user_request: clip(textOf(all[start]?.content).trim(), 4000),
    assistant_final_message: clip(said.at(-1) ?? "", 4000),
    assistant_said: clip(said.join("\n\n"), 8000),
    actions_taken: actions.slice(-40),
    command_results: selectResults(results),
    conclusive: lastText > lastAction,
  };
}

/** Claude Code's JSONL transcript: one event per line, subagent and injected lines skipped. */
export function turnFromJsonl(jsonl: string): Turn | null {
  const msgs: Msg[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (!e.isSidechain && !e.isMeta && (e.type === "user" || e.type === "assistant")) msgs.push({ role: e.type, content: e.message?.content });
    } catch { /* a half-written line tells us nothing */ }
  }
  return msgs.length ? normalize(msgs) : null;
}
