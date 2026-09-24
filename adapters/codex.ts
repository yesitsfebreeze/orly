#!/usr/bin/env bun
/**
 * OpenAI Codex CLI hooks (~/.codex/hooks.json or .codex/hooks.json), dispatched on
 * `hook_event_name`. Codex speaks Claude Code's dialect on purpose: the same stdin fields,
 * `{decision: "block", reason}` on Stop, `hookSpecificOutput` for context and permissions.
 * What differs is the transcript: a rollout JSONL under ~/.codex/sessions, and
 * `transcript_path` may be null, in which case it is found by session id.
 */
import { join } from "node:path";
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { gateTurn } from "../src/turnend.ts";
import { emit, findTranscript, home, readPayload, silent, turnFromFile } from "./shared.ts";

const input = await readPayload();
const cwd = input.cwd ?? process.cwd();
const event = String(input.hook_event_name ?? "Stop");

if (event === "SessionStart" || event === "UserPromptSubmit") {
  if (event === "UserPromptSubmit" && !process.env.ORLY_BRIEF_EVERY_PROMPT) silent();
  const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "$orly" });
  if (!brief) silent();
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: brief } });
}

if (event === "PreToolUse") {
  // Codex edits through apply_patch, whose input is a patch, not an old/new pair; the
  // Stop-time baseline catches those. Only a tool with a file path and content is projected.
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
const codexHome = process.env.CODEX_HOME ?? join(home(), ".codex");
const path = input.transcript_path || findTranscript(sessionId, [join(codexHome, "sessions")], 5);

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: input.stop_hook_active === true,
  read: () => turnFromFile(path),
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ decision: "block", reason: outcome.reason, systemMessage: outcome.banner });
if (outcome.banner || outcome.message) emit({ systemMessage: outcome.banner ?? outcome.message });
silent();
