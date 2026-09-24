#!/usr/bin/env bun
/**
 * Codex CLI hook (~/.codex/hooks.json or .codex/hooks.json), dispatched on `hook_event_name`.
 * Codex speaks Claude Code's hook dialect: the same stdin fields, `{decision: "block", reason}`
 * on Stop, `hookSpecificOutput` for context and permissions. What differs is the transcript:
 * a rollout JSONL under ~/.codex/sessions, found by session id when `transcript_path` is null.
 * Codex edits through apply_patch, which the pre-tool guard cannot project; the gate's baseline
 * catches those at Stop. Fails open: every error lets the agent stop.
 */
import { Glob } from "bun";
import { join } from "node:path";
import { endSession, gateTurn, guardEdit, normalizeLastTurn, plannedEdit, sessionBrief, type Msg } from "../../orly.ts";

/** Context Codex injects as user messages; none of it is the request. */
const INJECTED = /^\s*(<(environment_context|user_instructions|turn_aborted|permissions|skill|app-context|codex_internal_context)\b|# AGENTS\.md instructions)/i;
const text = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n") : "";

/** A rollout's response items as messages; event, reasoning and developer lines are dropped. */
export function codexMessages(jsonl: string): Msg[] {
  const out: Msg[] = [];
  for (const line of jsonl.split("\n")) {
    let p: any;
    try { const e = JSON.parse(line); if (e?.type !== "response_item") continue; p = e.payload ?? {}; } catch { continue; }
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const body = text(p.content);
      if (p.role === "user" && INJECTED.test(body)) continue;
      out.push({ role: p.role, content: [{ type: "text", text: body }] });
    } else if (/^(function|custom_tool|local_shell)_call$/.test(p.type)) {
      const name = p.name ?? (p.type === "local_shell_call" ? "shell" : "tool");
      out.push({ role: "assistant", content: [{ type: "tool_use", id: p.call_id, name, input: p.arguments ?? p.input ?? p.action }] });
    } else if (/^(function|custom_tool|local_shell)_call_output$/.test(p.type)) {
      let body = text(p.output);
      try { // the shell tool wraps its output in JSON with the exit code
        const o = JSON.parse(body);
        if (typeof o?.output === "string") body = o.output + (o.metadata?.exit_code ? `\n[exit code ${o.metadata.exit_code}]` : "");
      } catch { /* plain text */ }
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: p.call_id, content: body }] });
    }
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
  const cwd = input.cwd ?? process.cwd();
  const sessionId = String(input.session_id ?? "unknown");
  const event = String(input.hook_event_name ?? "Stop");

  if (event === "SessionEnd") emit(endSession(sessionId));
  if (event === "SessionStart") {
    const brief = sessionBrief(cwd, process.env.ORLY_CLI);
    emit(brief && { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } });
  }
  if (event === "PreToolUse") {
    const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
    const target = input.tool_input?.file_path ?? input.tool_input?.path;
    const reason = edit && typeof target === "string" ? guardEdit(cwd, target, edit) : null;
    emit(reason && { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
  if (event !== "Stop") emit();

  const sessions = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "sessions");
  const find = () => { try { for (const f of new Glob(`**/*${sessionId}.jsonl`).scanSync(sessions)) return join(sessions, f); } catch { /* no sessions dir */ } };
  const outcome = await gateTurn({
    cwd,
    sessionId,
    answeringBlock: input.stop_hook_active === true,
    read: async () => {
      try {
        const messages = codexMessages(await Bun.file(input.transcript_path || find() || "").text());
        return messages.length ? normalizeLastTurn(messages) : null;
      } catch {
        return null;
      }
    },
  });
  if (outcome.note) console.error(`orly: ${outcome.note}`);
  emit(outcome.block ? { decision: "block", reason: outcome.reason } : outcome.message && { systemMessage: outcome.message });
}
