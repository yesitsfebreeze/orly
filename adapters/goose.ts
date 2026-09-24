#!/usr/bin/env bun
/**
 * Goose hooks (an Open Plugins `hooks/hooks.json` under .agents/plugins/orly/), dispatched
 * on `event`:
 *
 *   Stop         {decision: "block", reason} keeps the turn going. Goose hands over no
 *                transcript, only `last_assistant_message`, so the turn is rebuilt from
 *                `goose session export` for this session; when that is not possible the
 *                agent may stop, with a note.
 *   SessionStart the brief, as additionalContext
 *   PreToolUse   an edit to a spec file, refused if it weakens the gate
 */
import type { Turn } from "../src/gate.ts";
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { normalizeLastTurn } from "../src/normalize.ts";
import { gateTurn } from "../src/turnend.ts";
import { emit, readPayload, silent } from "./shared.ts";
import { messagesFromAny } from "./transcripts.ts";

const input = await readPayload();
const cwd = input.working_dir ?? input.cwd ?? process.cwd();
const event = String(input.event ?? input.hook_event_name ?? "Stop");

if (event === "SessionStart") {
  const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "orly" });
  if (!brief) silent();
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } });
}

if (event === "PreToolUse") {
  const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
  const target = editTarget(input.tool_input);
  if (!edit || !target) silent();
  const reason = guardEdit(cwd, target!, edit!);
  if (!reason) silent();
  emit({ decision: "block", reason });
}

if (event !== "Stop") silent();

const sessionId = String(input.session_id ?? "unknown");

/** `goose session export --id <id> --format json` prints the session's messages. */
async function exported(): Promise<Turn | null> {
  if (sessionId === "unknown") return null;
  try {
    const p = Bun.spawnSync(["goose", "session", "export", "--id", sessionId, "--format", "json"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    const messages = messagesFromAny(p.stdout.toString());
    if (!messages.length) return null;
    const turn = normalizeLastTurn(messages);
    // Goose hands the closing message over directly; trust it over a flush race.
    if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()) {
      turn.assistant_final_message = input.last_assistant_message;
      turn.conclusive = true;
    }
    return turn;
  } catch {
    return null;
  }
}

const outcome = await gateTurn({ cwd, sessionId, read: exported, flush: false });

if (outcome.note) console.error(`orly: ${outcome.note}`);
if (outcome.block) emit({ decision: "block", reason: outcome.reason, systemMessage: outcome.banner });
if (outcome.banner || outcome.message) emit({ systemMessage: outcome.banner ?? outcome.message });
silent();
