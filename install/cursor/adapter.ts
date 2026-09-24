#!/usr/bin/env bun
/**
 * Cursor hook (.cursor/hooks.json, `"version": 1`), dispatched on `hook_event_name`:
 *
 *   sessionStart   the brief, as additional_context
 *   preToolUse     a spec edit that weakens the gate is denied
 *   stop           a block becomes followup_message, which Cursor submits as the next user
 *                  message (capped by the hook's loop_limit, on top of orly's round cap)
 *
 * Cursor does not document its transcript file. It is read only when it is Claude-style
 * JSONL or {role, content} lines; anything else leaves the turn unjudged, but a weakened
 * gate still blocks, because the baseline is checked before the transcript is read.
 * Fails open: every error lets the agent stop.
 */
import { endSession, gateTurn, guardEdit, messagesFrom, normalizeLastTurn, plannedEdit, sessionBrief, type Msg } from "../../orly.ts";

/** Claude-style `{type, message}` lines, else plain `{role, content}` lines. */
export function cursorMessages(jsonl: string): Msg[] {
  const claude = messagesFrom(jsonl);
  if (claude.length) return claude;
  const out: Msg[] = [];
  for (const line of jsonl.split("\n")) {
    try { const m = JSON.parse(line); if (m?.role === "user" || m?.role === "assistant" || m?.role === "tool") out.push(m); } catch { /* not JSON */ }
  }
  return out;
}

const emit = (json?: unknown): never => {
  if (json) console.log(JSON.stringify(json));
  process.exit(0);
};

if (import.meta.main) {
  let input: any = {};
  try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { emit(); }
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  const sessionId = String(input.conversation_id ?? input.session_id ?? "unknown");
  const event = String(input.hook_event_name ?? "stop");

  if (event === "sessionEnd") emit(endSession(sessionId));
  if (event === "sessionStart") {
    const brief = sessionBrief(cwd, process.env.ORLY_CLI);
    emit(brief && { additional_context: brief });
  }
  if (event === "preToolUse") {
    const ti = input.tool_input ?? {};
    const edit = plannedEdit(String(input.tool_name ?? ""), ti);
    const target = ti.file_path ?? ti.path;
    const reason = edit && typeof target === "string" ? guardEdit(cwd, target, edit) : null;
    emit(reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" });
  }
  if (event !== "stop" || (input.status && input.status !== "completed")) emit(); // an aborted turn is not finished

  const outcome = await gateTurn({
    cwd,
    sessionId,
    answeringBlock: typeof input.loop_count === "number" && input.loop_count > 0,
    read: async () => {
      try {
        const messages = cursorMessages(await Bun.file(input.transcript_path ?? "").text());
        return messages.length ? normalizeLastTurn(messages) : null;
      } catch {
        return null;
      }
    },
  });
  if (outcome.note) console.error(`orly: ${outcome.note}`);
  emit(outcome.block ? { followup_message: outcome.reason } : outcome.message && { user_message: outcome.message });
}
