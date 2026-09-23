/** Parses Claude Code's JSONL session transcript into messages. Separate so it can be tested. */
import type { Msg } from "../src/normalize.ts";

/** Claude Code's transcript is JSONL, one event per line; only two types matter. */
export function messagesFrom(jsonl: string): Msg[] {
  const out: Msg[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a half-written line tells us nothing
    }
    // Subagent events are interleaved here but belong to another conversation.
    if (e?.isSidechain === true) continue;
    // Injected notices (including orly's own block reason) arrive as user messages; left in,
    // one would be taken as the user's request.
    if (e?.isMeta === true) continue;
    if (e?.type === "user" || e?.type === "assistant") {
      out.push({ role: e.type, content: e.message?.content });
    }
  }
  return out;
}
