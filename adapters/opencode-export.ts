#!/usr/bin/env bun
/**
 * Translates an OpenCode session export (or bare `{"messages":[…]}`) into the Anthropic
 * dialect `orly judge` reads. Run from the project root that owns .orly/:
 *   opencode export $ID | bun adapters/opencode-export.ts | orly judge
 * The plugin in adapters/opencode.ts does this in-process at the end of every turn.
 */
import { toAnthropic } from "./opencode.ts";

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

console.log(JSON.stringify({ messages: toAnthropic(messages) }));
process.exit(0);