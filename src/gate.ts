/**
 * The Stop-time gate. Requirements are evaluated with the same mechanism as `orly eval`; a violated
 * one blocks before any turn question is asked. Then the turn questions go to the judge in one
 * request. Fails open on its own faults: a judge that is down must not become a wall.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aboutTurn, evaluate, judgeTurn, type Transport, type Usage } from "./evaluate.ts";
import { ADVICE, findOrlyDir, loadConfig, loadTree, REFUSAL, weakenings, type Spec, type SpecTree } from "./specs.ts";
import type { Turn } from "./turn.ts";

export const NO_KEY = 'orly? has no TypeSafe key, so only `require` checks are enforced. Set TYPESAFE_API_KEY, or {"keyCommand": "…"} in .orly/config.json.';
export type Verdict = { block: boolean; reason: string; line: string; unmet: string[]; usage?: Usage; answers?: Record<string, any> };
export type GateInput = { cwd: string; sessionId: string; read: () => Promise<Turn | null>; answeringBlock?: boolean; flush?: boolean };
export type Outcome = { block: boolean; reason?: string; line?: string; note?: string };

/** `TYPESAFE_API_KEY`, else the output of `keyCommand` (hooks do not inherit the shell's environment). */
export function resolveKey(orlyDir: string | null): Transport | null {
  if (process.env.TYPESAFE_API_KEY) return { apiKey: process.env.TYPESAFE_API_KEY };
  const command = process.env.ORLY_KEY_COMMAND ?? (orlyDir && loadConfig(orlyDir).keyCommand);
  if (typeof command !== "string" || !command.trim()) return null;
  const key = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return key ? { apiKey: key } : null;
}

const compose = (fired: string[], parts: string[], unmet: string[], extra: Partial<Verdict> = {}): Verdict => ({
  block: fired.length > 0, unmet, ...extra,
  line: `orly ${fired.length ? "⛔ block" : "✓ pass"} · ${parts.join(" · ")}`,
  reason: fired.length ? ["orly (an independent check on this turn) is not satisfied that the request is finished:", ...fired, "",
    "Fix what is named above, then end the turn again. If it genuinely cannot be done, say so plainly to the user and name what is left and why — that also satisfies the gate."].join("\n") : "",
});

/** Requirements first, at no token cost when nothing changed; a violation blocks. Only then the turn. Throws "no key". */
export async function judge(turn: Turn, specs: Spec[], root: string, checks: Record<string, any>, t: Transport | null, orlyDir?: string): Promise<Verdict> {
  const { results, usage } = await evaluate(specs, root, checks, t, orlyDir);
  const code = results.filter((r) => !aboutTurn(r.spec));
  const n = (status: string) => code.filter((r) => r.status === status).length;
  const parts = [`requirements ${n("satisfied")}/${code.length}${n("unknown") ? ` (${n("unknown")} unknown)` : ""}`];
  const violated = code.filter((r) => r.status === "violated");
  if (violated.length) {
    const fired = violated.map((r) => `- requirement "${r.spec.id}" is violated (${r.evidence}): ${r.spec.question}`);
    return compose(fired, [...parts, "turn not judged"], violated.map((r) => r.spec.id), { usage });
  }
  if (!t) throw new Error("no key");
  const tq = await judgeTurn(turn, specs.filter(aboutTurn), t);
  const tokens = [usage, tq.usage].filter(Boolean) as Usage[];
  if (tokens.length) parts.push(`${tokens.reduce((s, u) => s + u.input_tokens, 0)}+${tokens.reduce((s, u) => s + u.output_tokens, 0)} tok`);
  return compose(tq.fired, [...parts, ...tq.parts], tq.unmet, { usage: tq.usage, answers: tq.answers });
}

const tmp = (session: string, kind: string) => join(tmpdir(), `orly-${kind}-${session}`);
export const endSession = (session: string) => ["rounds", "nokey"].forEach((k) => rmSync(tmp(session, k), { force: true }));

/** Backstop for edits nothing else saw: the spec set may not get weaker under the same goal. */
function weakened(orlyDir: string, tree: SpecTree): string[] {
  const path = join(orlyDir, "baseline.json");
  let base: { goal: string; specs: Spec[] } | null = null;
  try { base = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run */ }
  const weak = base && base.goal === tree.goal ? weakenings(base.specs, tree.specs) : [];
  if (!weak.length) try { writeFileSync(path, JSON.stringify({ goal: tree.goal, specs: tree.specs })); } catch { /* costs only the backstop */ }
  return weak;
}

/** The whole gate for one turn. */
export async function gate(input: GateInput): Promise<Outcome> {
  const orlyDir = findOrlyDir(input.cwd);
  if (!orlyDir) return { block: false };
  const tree = loadTree(orlyDir);
  const weak = weakened(orlyDir, tree);
  if (weak.length) return { block: true, reason: [REFUSAL, ...weak.map((w) => `- ${w}`), "", ADVICE].join("\n"), line: "orly ⛔ block · spec tree weakened" };
  if (input.answeringBlock && !tree.specs.length) return { block: false }; // without specs, block at most once

  let turn = await input.read();
  if (!turn) return { block: false, note: "transcript unreadable" };
  // The host may fire before the closing message is flushed; wait until the agent spoke after its last action.
  for (let i = 0; input.flush !== false && i < 12 && !turn.conclusive && turn.actions_taken.length; i++) {
    await Bun.sleep(150);
    turn = (await input.read()) ?? turn;
  }
  if (!turn.user_request || (!turn.actions_taken.length && !turn.assistant_said)) return { block: false };
  if (!turn.conclusive) return { block: false, note: "closing message never reached the transcript" };

  let v: Verdict;
  try { v = await judge(turn, tree.specs, dirname(orlyDir), loadConfig(orlyDir).checks ?? {}, resolveKey(orlyDir), orlyDir); }
  catch (e: any) {
    if (e?.message !== "no key") return { block: false, note: `judge unavailable (${e?.message ?? e})` };
    // The requirements were still evaluated; say once per session that the turn was not judged.
    if (existsSync(tmp(input.sessionId, "nokey"))) return { block: false };
    try { writeFileSync(tmp(input.sessionId, "nokey"), ""); } catch { /* costs only the once-per-session part */ }
    return { block: false, note: NO_KEY };
  }
  if (!v.block) return { block: false, line: v.line };

  // Round cap: an unsatisfiable spec must not trap the agent. Counted per session, reset when the goal changes.
  let rounds = { goal: tree.goal, n: 0 };
  try { const r = JSON.parse(readFileSync(tmp(input.sessionId, "rounds"), "utf8")); if (r.goal === tree.goal) rounds = r; } catch { /* new loop */ }
  rounds.n++;
  try { writeFileSync(tmp(input.sessionId, "rounds"), JSON.stringify(rounds)); } catch { /* losing the counter loses only the cap */ }
  if (rounds.n > tree.rounds) return { block: false, line: `${v.line} · round cap (${tree.rounds}) reached, ${v.unmet.length} spec(s) still unmet` };
  return { block: true, reason: v.reason, line: `${v.line} · round ${rounds.n}` };
}

/** The brief a session starts with: the gate is on, this is the goal, these are the requirements, this is the one rule. */
export function brief(orlyDir: string, cli: string): string {
  const tree = loadTree(orlyDir);
  const how = (s: Spec) => (s.broken ? "MALFORMED, blocks every turn" : s.require ? `check ${s.require.path} ${s.require.op} ${s.require.value ?? ""}`.trim() : `${aboutTurn(s) ? "turn" : "files"}, cut ${s.cut ?? 0.7}`);
  return ["# orly? — the completion gate is active", "",
    `Every turn you end is judged: the requirements in \`.orly/specs/\` against the codebase, plus four built-in honesty checks on the turn. A gap blocks the stop until it is closed. \`orly eval\` shows every requirement's status, evidence and next action now; \`orly\` means \`${cli}\`.`,
    ...(tree.goal ? ["", "Goal:", ...tree.goal.split("\n").map((l) => `  ${l}`)] : []),
    ...(tree.specs.length ? ["", "Requirements:", ...tree.specs.map((s) => `- ${tree.paths[s.id]}: ${how(s)}`)] : ["", "No specs yet: `/orly:orly <goal>` writes them."]),
    "", `**The one rule.** You may add a spec or tighten a cut; you may not delete one or lower a cut to get an easier pass. ${ADVICE}`].join("\n");
}
