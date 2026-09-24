#!/usr/bin/env bun
/**
 * The Claude Code hook dialect, dispatched on `hook_event_name`:
 *
 *   Stop          transcript_path -> Turn -> gate -> {decision: "block", reason}; the owl and
 *                 status go to `orly statusline`, not the transcript
 *   SessionStart  the brief, as additionalContext
 *   PreToolUse    an Edit/Write to a spec file, refused if it weakens the gate
 *   SessionEnd    deletes the session's temp files
 *
 * Also the adapter for every host that speaks this dialect: Factory Droid, Qwen Code,
 * Continue, JetBrains Junie and Antigravity read the same stdin fields and honour the
 * same stdout. Fails open: every error lets the agent stop.
 */
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { endSession, gateTurn } from "../src/turnend.ts";
import { join } from "node:path";
import { emit, findTranscript, home, readPayload, silent, turnFromFile } from "./shared.ts";

const input = await readPayload();
const cwd = input.cwd ?? process.cwd();
const event = String(input.hook_event_name ?? (input.tool_name ? "PreToolUse" : "Stop"));
const root = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.DROID_PLUGIN_ROOT;

if (event === "SessionEnd") {
  endSession(String(input.session_id ?? "unknown"));
  silent();
}

if (event === "SessionStart") {
  const brief = sessionBrief(cwd, {
    cli: root ? `bun "${root}/bin/orly.ts"` : undefined,
    pluginRoot: root,
    goalCommand: process.env.ORLY_GOAL_COMMAND ?? "/orly:orly",
  });
  if (!brief) silent();
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } });
}

if (event === "PreToolUse") {
  const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
  const target = editTarget(input.tool_input);
  if (!edit || !target) silent();
  const reason = guardEdit(cwd, target!, edit!);
  if (!reason) silent();
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

if (event !== "Stop" && event !== "SubagentStop") silent();

const sessionId = String(input.session_id ?? "unknown");
// Droid, Qwen and Continue write the transcript where Claude Code does not; when the
// payload names no path, look where each of them keeps sessions.
const path =
  input.transcript_path ||
  findTranscript(sessionId, [
    join(home(), ".claude", "projects"),
    join(home(), ".factory", "sessions"),
    join(home(), ".qwen", "projects"),
    join(home(), ".continue", "sessions"),
  ]);

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: input.stop_hook_active === true,
  read: () => turnFromFile(path),
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ decision: "block", reason: outcome.reason });
if (outcome.message) emit({ systemMessage: outcome.message });
silent();
