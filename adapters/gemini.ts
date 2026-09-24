#!/usr/bin/env bun
/**
 * Gemini CLI hooks (settings.json → hooks), dispatched on `hook_event_name`:
 *
 *   AfterAgent    the turn is over; {decision: "deny", reason} sends the reason back as a
 *                 new prompt and the agent keeps working. Same stdin as Claude Code plus
 *                 `prompt` and `prompt_response`.
 *   SessionStart  the brief, as additionalContext
 *   BeforeTool    an edit to a spec file (write_file / replace), refused if it weakens the gate
 *
 * The transcript: `transcript_path` when the CLI fills it, else the chat file under
 * ~/.gemini/tmp/<project>/chats/ that names this session. Qwen Code, a Gemini fork, speaks
 * Claude's dialect instead and uses adapters/claude-code.ts.
 */
import { join } from "node:path";
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit, type PlannedEdit } from "../src/editguard.ts";
import { gateTurn } from "../src/turnend.ts";
import { emit, findTranscript, home, readPayload, silent, turnFromFile } from "./shared.ts";

const input = await readPayload();
const cwd = input.cwd ?? process.cwd();
const event = String(input.hook_event_name ?? "AfterAgent");

if (event === "SessionStart" || event === "BeforeAgent") {
  if (event === "BeforeAgent" && !process.env.ORLY_BRIEF_EVERY_PROMPT) silent();
  const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "/orly" });
  if (!brief) silent();
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: brief } });
}

if (event === "BeforeTool") {
  // Gemini's editing tools: write_file {file_path, content}, replace {file_path, old_string, new_string, expected_replacements}.
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input ?? {};
  let edit: PlannedEdit | null = null;
  if (tool === "write_file") edit = plannedEdit("Write", ti);
  else if (tool === "replace") edit = { kind: "edit", edits: [{ old_string: ti.old_string, new_string: ti.new_string, replace_all: (ti.expected_replacements ?? 1) > 1 }] };
  else edit = plannedEdit(tool, ti);
  const target = editTarget(ti);
  if (!edit || !target) silent();
  const reason = guardEdit(cwd, target!, edit!);
  if (!reason) silent();
  emit({ decision: "deny", reason });
}

if (event !== "AfterAgent") silent();

const sessionId = String(input.session_id ?? "unknown");
const path = input.transcript_path || findTranscript(sessionId, [join(home(), ".gemini", "tmp")], 4);

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: input.stop_hook_active === true,
  read: () => turnFromFile(path),
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ decision: "deny", reason: outcome.reason, systemMessage: outcome.banner });
if (outcome.banner || outcome.message) emit({ systemMessage: outcome.banner ?? outcome.message });
silent();
