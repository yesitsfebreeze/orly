#!/usr/bin/env bun
/**
 * GitHub Copilot CLI and coding-agent hooks (.github/hooks/*.json or ~/.copilot/hooks/),
 * dispatched on the event name. Copilot has two spellings of one protocol: camelCase
 * (`agentStop`, `sessionId`, `transcriptPath`) and the Claude-shaped PascalCase aliases.
 * Both are read here.
 *
 *   agentStop / Stop        {decision: "block", reason} forces another turn with the reason
 *                           as the next prompt; Copilot ends the turn after 8 blocks in a row.
 *   sessionStart            the brief, as additionalContext
 *   preToolUse / PreToolUse an edit to a spec file, refused if it weakens the gate
 */
import { join } from "node:path";
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { gateTurn } from "../src/turnend.ts";
import { emit, findTranscript, home, readPayload, silent, turnFromFile } from "./shared.ts";

const input = await readPayload();
const cwd = input.cwd ?? process.cwd();
const event = String(input.hook_event_name ?? input.hookEventName ?? input.event ?? "agentStop");

if (/^sessionStart$/i.test(event)) {
  const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "/orly" });
  if (!brief) silent();
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief }, additionalContext: brief });
}

if (/^preToolUse$/i.test(event)) {
  const ti = input.tool_input ?? input.toolArgs ?? {};
  const edit = plannedEdit(String(input.tool_name ?? input.toolName ?? ""), ti);
  const target = editTarget(ti);
  if (!edit || !target) silent();
  const reason = guardEdit(cwd, target!, edit!);
  if (!reason) silent();
  emit({
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

if (!/^(agentStop|Stop|subagentStop|SubagentStop)$/.test(event)) silent();

const sessionId = String(input.session_id ?? input.sessionId ?? "unknown");
const copilotHome = process.env.COPILOT_HOME ?? join(home(), ".copilot");
const path =
  input.transcript_path ||
  input.transcriptPath ||
  (sessionId !== "unknown" ? join(copilotHome, "session-state", sessionId, "events.jsonl") : null) ||
  findTranscript(sessionId, [join(copilotHome, "session-state")], 2);

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: input.stop_hook_active === true,
  read: () => turnFromFile(path),
});

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ decision: "block", reason: outcome.reason, systemMessage: outcome.banner });
if (outcome.banner || outcome.message) emit({ decision: "allow", systemMessage: outcome.banner ?? outcome.message });
silent();
