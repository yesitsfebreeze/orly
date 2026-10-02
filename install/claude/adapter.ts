#!/usr/bin/env bun
/** Claude Code hook, dispatched on `hook_event_name`: Stop -> gate (in the background), SessionStart -> brief,
 * PreToolUse -> edit guard, SessionEnd -> temp cleanup. Fails open: every error lets the agent stop. */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_MAX_ROUNDS, DEFAULTS, endSession, gateTurn, guardEdit, isOff, loadSpecFile, messagesFrom, normalizeLastTurn, plannedEdit, readRounds, sessionBrief, unmet, type Judgment } from "../../orly.ts";

const emit = (json?: unknown): never => {
  if (json) console.log(JSON.stringify(json));
  process.exit(0);
};

let input: any = {};
try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { emit(); }
const cwd = input.cwd ?? process.cwd();
const sessionId = String(input.session_id ?? "unknown");
const event = String(input.hook_event_name ?? "Stop");

// The last verdict: one score and the top three things behind it.
const statusDir = `${process.env.HOME}/.orly/status`;
const statusPath = `${statusDir}/${sessionId}.json`;
// Also read by other plugins (a turn deck): the shape is versioned, the file replaced whole.
function writeStatus(j: Judgment | undefined, blocked: boolean) {
  // The core marks a session whose judge found no key; without a judgment that is why.
  const nokey = !j && existsSync(`${tmpdir()}/orly-nokey-${sessionId}`);
  if (!j && !nokey) return rmSync(statusPath, { force: true });
  const results = j?.verdict.results ?? [];
  const spec = loadSpecFile(cwd);
  const hazards = ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"]
    .map((id) => ({ id, p: j?.answers?.[id]?.noul })).filter((h) => typeof h.p === "number").sort((a, b) => b.p - a.p);
  const cov = j?.answers?.coverage?.score;
  const items = [
    ...unmet(results).map((r) => `✗ ${r.spec.id}`),
    ...hazards.filter((h) => h.p >= DEFAULTS.hazard).map((h) => `⚠ ${h.id.replace(/_/g, " ")} ${h.p.toFixed(2)}`),
    ...results.filter((r) => r.met).map((r) => `✓ ${r.spec.id}`),
    ...(spec?.goals ?? []).map((g) => `◎ ${g.text}`),
    ...(typeof cov === "number" ? [`coverage ${cov.toFixed(1)}/3`] : []),
  ].slice(0, 3);
  const status = {
    v: 1, ts: Date.now(), pct: j?.verdict.pct ?? null, blocked, items,
    round: readRounds(sessionId)?.rounds ?? 0, rounds: spec?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    specs: { met: results.filter((r) => r.met).length, total: results.length || (spec?.specs.length ?? 0) }, nokey,
  };
  try {
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(`${statusPath}.tmp`, JSON.stringify(status));
    renameSync(`${statusPath}.tmp`, statusPath);
  } catch { /* the bar is a convenience */ }
}

if (event === "SessionEnd") emit((rmSync(statusPath, { force: true }), endSession(sessionId)));
// `/orly off`: every hook stays inert until `/orly on`; the stale verdict leaves the bar with it.
if (isOff(sessionId)) emit(rmSync(statusPath, { force: true }));

if (event === "SessionStart") {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const brief = sessionBrief(cwd, root && `bun "${root}/orly.ts"`);
  emit(brief && { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief } });
}

const deny = (reason: string | null) =>
  emit(reason && { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

if (event === "PreToolUse") {
  const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
  const target = input.tool_input?.file_path;
  const reason = edit && typeof target === "string" ? guardEdit(cwd, target, edit) : null;
  deny(reason);
}

if (event !== "Stop" && event !== "SubagentStop") emit();

// The Stop hook runs in the background (`asyncRewake` in hooks.json): a pass shows nothing, a failed turn exits 2
// and its stderr reaches the model as a message it weighs itself. The flag marks the stop that follows such a
// message, which is not judged again. ponytail: a host that never wakes the model leaves the flag for the next
// stop, which then goes unjudged once.
const flagPath = `${statusDir}/${sessionId}.flagged`;
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
writeStatus(outcome.judgment, outcome.block);
// One short line: the unmet spec ids and the path of the full verdict, which the model reads when it needs the wording.
const verdictPath = `${statusDir}/${sessionId}.verdict.md`;
if (!outcome.block) emit(rmSync(verdictPath, { force: true }));
try { mkdirSync(statusDir, { recursive: true }); writeFileSync(verdictPath, outcome.reason + "\n"); writeFileSync(flagPath, ""); } catch { /* the line below still names the specs */ }
const unmetIds = [...outcome.reason.matchAll(/^- (?:spec|check) "([^"]+)"/gm)].map((m) => m[1]);
console.error(`orly checked your last turn in the background and does not think it is finished (${unmetIds.join(", ") || "see verdict"}). Full verdict: ${verdictPath}. Read it and decide: continue the work if it is right; if it is wrong, say why in one line and stop. Your next stop is not checked again.`);
process.exit(2);
