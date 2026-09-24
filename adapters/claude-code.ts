#!/usr/bin/env bun
/**
 * Claude Code Stop hook: reads the hook payload on stdin, turns the transcript into a
 * `Turn`, runs the gate and prints the verdict as hook JSON. Fails open: every error lets
 * the agent stop.
 *
 * Also the Stop hook for every host that speaks Claude Code's hook protocol (Factory
 * Droid, Kiro CLI): same stdin fields, same stdout decision.
 */
import { normalizeLastTurn } from "../src/normalize.ts";
import { gateTurn } from "../src/turnend.ts";
import { messagesFrom } from "./claude-transcript.ts";

const raw = await new Response(Bun.stdin.stream()).text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  console.error("orly: could not parse hook input");
  process.exit(0);
}

const outcome = await gateTurn({
  cwd: input.cwd ?? process.cwd(),
  sessionId: String(input.session_id ?? "unknown"),
  answeringBlock: input.stop_hook_active === true,
  read: async () => {
    try {
      return normalizeLastTurn(messagesFrom(await Bun.file(input.transcript_path).text()));
    } catch {
      return null;
    }
  },
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) {
  console.log(JSON.stringify({ decision: "block", reason: outcome.reason, systemMessage: outcome.banner }));
} else if (outcome.banner || outcome.message) {
  console.log(JSON.stringify({ systemMessage: outcome.banner ?? outcome.message }));
}
process.exit(0);
