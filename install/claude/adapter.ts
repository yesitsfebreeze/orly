#!/usr/bin/env bun
/** Claude Code hook, dispatched on `hook_event_name`: Stop -> gate, SessionStart -> brief,
 * PreToolUse -> edit guard, SessionEnd -> temp cleanup. Fails open: every error lets the agent stop. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULTS, endSession, gateTurn, guardEdit, loadSpecFile, messagesFrom, normalizeLastTurn, plannedEdit, sessionBrief, unmet, type Judgment } from "../../orly.ts";

const emit = (json?: unknown): never => {
  if (json) console.log(JSON.stringify(json));
  process.exit(0);
};

let input: any = {};
try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { emit(); }
const cwd = input.cwd ?? process.cwd();
const sessionId = String(input.session_id ?? "unknown");
const event = String(input.hook_event_name ?? "Stop");

// What status.ts draws under the turn's closing line: one score and the top three things behind it.
const statusDir = `${process.env.HOME}/.orly/status`;
const statusPath = `${statusDir}/${sessionId}.json`;
function writeStatus(j: Judgment | undefined, blocked: boolean) {
  if (!j) return rmSync(statusPath, { force: true });
  const { results } = j.verdict;
  const hazards = ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"]
    .map((id) => ({ id, p: j.answers?.[id]?.noul })).filter((h) => typeof h.p === "number").sort((a, b) => b.p - a.p);
  const cov = j.answers?.coverage?.score;
  const parts = [
    results.length ? results.filter((r) => r.met).length / results.length : null,
    typeof cov === "number" ? cov / 3 : null,
    hazards.length ? 1 - hazards[0].p : null,
  ].filter((x): x is number => x !== null);
  const items = [
    ...unmet(results).map((r) => `✗ ${r.spec.id}`),
    ...hazards.filter((h) => h.p >= DEFAULTS.hazard).map((h) => `⚠ ${h.id.replace(/_/g, " ")} ${h.p.toFixed(2)}`),
    ...results.filter((r) => r.met).map((r) => `✓ ${r.spec.id}`),
    ...(loadSpecFile(cwd)?.goals ?? []).map((g) => `◎ ${g.text}`),
    ...(typeof cov === "number" ? [`coverage ${cov.toFixed(1)}/3`] : []),
  ].slice(0, 3);
  const pct = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null;
  try { mkdirSync(statusDir, { recursive: true }); writeFileSync(statusPath, JSON.stringify({ pct, blocked, items })); } catch { /* the bar is a convenience */ }
}

if (event === "SessionEnd") emit((rmSync(statusPath, { force: true }), endSession(sessionId)));

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
      // The transcript can lag the Stop hook; the input carries the closing message itself.
      return messages.length ? normalizeLastTurn(messages, String(input.last_assistant_message ?? "")) : null;
    } catch {
      return null;
    }
  },
});
if (outcome.note) console.error(`orly: ${outcome.note}`);
writeStatus(outcome.judgment, outcome.block);
emit(outcome.block ? { decision: "block", reason: outcome.reason } : outcome.message && { systemMessage: outcome.message });