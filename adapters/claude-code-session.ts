#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook: tells the agent the gate is active, which specs it
 * enforces, what the log says each one bought, and the rules for tuning it.
 */
import { sessionBrief } from "../src/brief.ts";

const raw = await new Response(Bun.stdin.stream()).text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const root = process.env.CLAUDE_PLUGIN_ROOT;
const brief = sessionBrief(input.cwd ?? process.cwd(), {
  cli: root ? `bun "${root}/bin/orly.ts"` : undefined,
  pluginRoot: root,
  goalCommand: "/orly:orly",
});
if (!brief) process.exit(0); // no .orly here: this project does not use the gate

console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief },
  }),
);
