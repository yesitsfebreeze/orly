#!/usr/bin/env bun
/** Claude Code hook, dispatched on `hook_event_name`: Stop -> gate, SessionStart -> brief,
 * PreToolUse -> edit guard, SessionEnd -> temp cleanup. Fails open: every error lets the agent stop. */
import { endSession, gateTurn, guardEdit, messagesFrom, normalizeLastTurn, plannedEdit, sessionBrief } from "../../orly.ts";

const emit = (json?: unknown): never => {
  if (json) console.log(JSON.stringify(json));
  process.exit(0);
};

let input: any = {};
try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { emit(); }
const cwd = input.cwd ?? process.cwd();
const sessionId = String(input.session_id ?? "unknown");
const event = String(input.hook_event_name ?? "Stop");

if (event === "SessionEnd") emit(endSession(sessionId));

if (event === "SessionStart") {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const brief = sessionBrief(cwd, root && `bun "${root}/orly.ts"`);
  emit(brief && { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } });
}

if (event === "PreToolUse") {
  const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
  const target = input.tool_input?.file_path;
  const reason = edit && typeof target === "string" ? guardEdit(cwd, target, edit) : null;
  emit(reason && { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

if (event !== "Stop" && event !== "SubagentStop") emit();

const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: input.stop_hook_active === true,
  read: async () => {
    try {
      const messages = messagesFrom(await Bun.file(input.transcript_path).text());
      return messages.length ? normalizeLastTurn(messages) : null;
    } catch {
      return null;
    }
  },
});
if (outcome.note) console.error(`orly: ${outcome.note}`);
emit(outcome.block ? { decision: "block", reason: outcome.reason } : outcome.message && { systemMessage: outcome.message });