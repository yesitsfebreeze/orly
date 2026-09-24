#!/usr/bin/env bun
/**
 * Cursor hooks (.cursor/hooks.json, `"version": 1`), dispatched on `hook_event_name`:
 *
 *   stop            the agent finished; {followup_message} is auto-submitted as the next
 *                   user message, so a block becomes the follow-up. Cursor caps automatic
 *                   follow-ups (5 by default), on top of orly's own round cap.
 *   sessionStart    the brief, as additional_context
 *   beforeSubmitPrompt  nothing to say; passes through
 *
 * Cursor has no pre-edit hook, so the Stop-time baseline is the guard. The transcript is
 * read from `transcript_path`; without it the turn cannot be judged and the agent may stop.
 */
import { sessionBrief } from "../src/brief.ts";
import { gateTurn } from "../src/turnend.ts";
import { emit, readPayload, silent, turnFromFile } from "./shared.ts";

const input = await readPayload();
const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
const event = String(input.hook_event_name ?? "stop");

if (event === "sessionStart") {
  const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "/orly" });
  if (!brief) silent();
  emit({ additional_context: brief });
}

if (event !== "stop") silent();
// An aborted or errored generation is not a finished turn.
if (input.status && input.status !== "completed") silent();

const sessionId = String(input.conversation_id ?? input.session_id ?? "unknown");

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: typeof input.loop_count === "number" && input.loop_count > 0,
  read: () => turnFromFile(input.transcript_path),
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ followup_message: `${outcome.reason}\n${outcome.banner ?? ""}` });
if (outcome.banner || outcome.message) console.error(outcome.banner ?? outcome.message);
silent();
