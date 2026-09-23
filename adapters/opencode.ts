#!/usr/bin/env bun
/**
 * Translates an OpenCode session export (or bare `{"messages":[…]}`) into the Anthropic
 * dialect `orly judge` reads. Run from the project root that owns .orly/:
 *   opencode api get /api/experimental/session/$ID/export | bun adapters/opencode.ts | orly judge
 */
import { textOf, type Msg } from "../src/normalize.ts";

let raw = "";
try {
  raw =
    process.argv[2]
      ? await Bun.file(process.argv[2]).text()
      : await new Response(Bun.stdin.stream()).text();
} catch {
  console.error("orly/opencode: could not read the session export");
  process.exit(1);
}

let input: any;
try {
  input = JSON.parse(raw);
} catch {
  console.error("orly/opencode: stdin was not JSON — pipe `opencode api get …/export` output in");
  process.exit(1);
}

const messages: any[] = input?.messages ?? input?.data?.messages;
if (!Array.isArray(messages)) {
  console.error('orly/opencode: expected an OpenCode session export or {"messages":[…]}');
  process.exit(1);
}

/** Map one OpenCode message block onto the Anthropic dialect normalize reads. */
const toAnthropic = (msgs: any[]): Msg[] => {
  const out: Msg[] = [];
  for (const m of msgs) {
    if (m?.type === "user") {
      out.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
      continue;
    }
    if (m?.type !== "assistant") continue;

    const blocks: any[] = [];
    const results: Array<[string, string, boolean]> = [];
    for (const b of m.content ?? []) {
      if (b?.type === "text") {
        blocks.push({ type: "text", text: b.text });
      } else if (b?.type === "tool") {
        blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.state?.input });
        const body = b.state?.content;
        const text = typeof body === "string" ? body : textOf(body).trim();
        if (text) {
          results.push([b.id, text, b.state?.status !== undefined && b.state.status !== "completed"]);
        }
      }
      // reasoning blocks are dropped: not evidence.
    }
    if (blocks.length) out.push({ role: "assistant", content: blocks });
    for (const [id, text, isError] of results) {
      out.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError },
        ],
      });
    }
  }
  return out;
};

console.log(JSON.stringify({ messages: toAnthropic(messages) }));
process.exit(0);