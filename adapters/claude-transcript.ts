/**
 * Reading Claude Code's session transcript.
 *
 * Separate from the adapter so it can be tested: the two filters below are the difference
 * between judging the user's turn and judging something else entirely, and both failures
 * are silent.
 */
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
    // Subagent transcripts are interleaved into the same file; they are a different
    // conversation and judging them as part of this turn would be wrong.
    if (e?.isSidechain === true) continue;
    // Claude Code injects its own notices as user messages — including this hook's own
    // block reason. Left in, the next judgment slices the turn at orly's own complaint and
    // treats it as the user's request: the real goal disappears, the turn shrinks to
    // whatever happened since the block, and the gate judges whether the agent satisfied
    // the gate. isMeta marks every one of them.
    if (e?.isMeta === true) continue;
    if (e?.type === "user" || e?.type === "assistant") {
      out.push({ role: e.type, content: e.message?.content });
    }
  }
  return out;
}
