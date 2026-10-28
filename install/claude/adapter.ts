#!/usr/bin/env bun
/** Claude Code hook, dispatched on `hook_event_name`: UserPromptSubmit -> the guard brief, Stop -> the gate
 * (in the background), SessionEnd -> cleanup. Fails open: every error lets the agent stop. */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_MAX_ROUNDS, endSession, gateTurn, guardState, loadSession, messagesFrom, normalizeLastTurn, promptBrief, type GateOutcome } from "../../orly.ts";

const emit = (json?: unknown): never => {
  if (json) console.log(JSON.stringify(json));
  process.exit(0);
};

let input: any = {};
try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { emit(); }
const cwd = input.cwd ?? process.cwd();
const sessionId = String(input.session_id ?? "unknown");
const event = String(input.hook_event_name ?? "Stop");
const root = process.env.CLAUDE_PLUGIN_ROOT;
const cli = root ? `bun "${root}/orly.ts"` : "orly";

// The last verdict, for a status line: one score and the top three items. Shape versioned, file replaced whole.
const statusDir = `${process.env.HOME}/.orly/status`;
const statusPath = `${statusDir}/${sessionId}.json`;
const flagPath = `${statusDir}/${sessionId}.flagged`;
const verdictPath = `${statusDir}/${sessionId}.verdict.md`;
function writeStatus(o: GateOutcome) {
  const guards = o.session.guards;
  if (!guards.length) return rmSync(statusPath, { force: true });
  const met = guards.filter((g) => guardState(g) === "upheld").length;
  const items = [
    ...o.results.filter((r) => !r.met).map((r) => `✗ ${r.guard.id}`),
    ...guards.filter((g) => guardState(g) === "upheld").map((g) => `✓ ${g.id}`),
    ...guards.filter((g) => guardState(g) === "open" || guardState(g) === "check").map((g) => `○ ${g.id}`),
  ].slice(0, 3);
  const status = { v: 1, ts: Date.now(), pct: Math.round((met / guards.length) * 100), blocked: o.block, items, round: o.session.round, rounds: Number(process.env.ORLY_MAX_ROUNDS) || DEFAULT_MAX_ROUNDS, specs: { met, total: guards.length }, nokey: o.message !== undefined };
  try {
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(`${statusPath}.tmp`, JSON.stringify(status));
    renameSync(`${statusPath}.tmp`, statusPath);
  } catch { /* the bar is a convenience */ }
}

if (event === "SessionEnd") {
  for (const f of [statusPath, flagPath, verdictPath]) rmSync(f, { force: true });
  endSession(sessionId);
  emit();
}
if (event === "UserPromptSubmit") emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: promptBrief(loadSession(sessionId), cli) } });
if (event !== "Stop" && event !== "SubagentStop") emit();

// The Stop hook runs in the background (`asyncRewake` in hooks.json): a pass shows nothing, a failed turn exits 2
// and its stderr reaches the model as a message it weighs itself. The flag marks the stop that follows such a
// message, which is not judged again.
const flagged = existsSync(flagPath);
rmSync(flagPath, { force: true });
const outcome = await gateTurn({
  cwd,
  sessionId,
  answeringBlock: flagged || input.stop_hook_active === true,
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
writeStatus(outcome);
if (!outcome.block) emit(rmSync(verdictPath, { force: true }), outcome.message && { systemMessage: outcome.message });
try { mkdirSync(statusDir, { recursive: true }); writeFileSync(verdictPath, outcome.reason + "\n"); writeFileSync(flagPath, ""); } catch { /* the line below still names the guards */ }
const ids = outcome.results.filter((r) => !r.met).map((r) => r.guard.id);
console.error(`orly: guards not upheld after your last turn (${ids.join(", ")}). Full verdict: ${verdictPath}. Finish the work they name; a guard that cannot be met: say so and name why, then stop. Your next stop is not checked again.`);
process.exit(2);
