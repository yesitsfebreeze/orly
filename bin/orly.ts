#!/usr/bin/env bun
/**
 * orly eval          every requirement against the codebase now: status, where, evidence; exit 2 if any is violated
 * orly judge         {messages:[…]} or {turn:{…}} on stdin → verdict JSON; exit 0 may stop, 2 not done, 1 could not run
 * orly specs         validate .orly/specs: taste and syntax in code, then ask jev whether each question is decidable
 * orly hook          Claude Code hook (Stop, SessionStart, SessionEnd), payload on stdin
 */
import { dirname, join } from "node:path";
import { aboutTurn, ask, evaluate, unassessed } from "../src/evaluate.ts";
import { brief, endSession, gate, judge, resolveKey } from "../src/gate.ts";
import { findOrlyDir, loadConfig, loadTree, validate } from "../src/specs.ts";
import { normalize, turnFromJsonl, type Turn } from "../src/turn.ts";

const [command = "help", ...args] = process.argv.slice(2);
const orlyDir = findOrlyDir(process.cwd());
const root = orlyDir ? dirname(orlyDir) : process.cwd();
const checks = (orlyDir && loadConfig(orlyDir).checks) ?? {};
const fail = (msg: string, code = 1): never => (console.error(`orly: ${msg}`), process.exit(code));
const stdin = async () => { try { return JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { return {}; } };
const tok = (u?: { input_tokens: number; output_tokens: number }) => (u ? `${u.input_tokens}+${u.output_tokens} tok` : "0 tok");

if (command === "eval") {
  if (!orlyDir) fail("no .orly directory here or above");
  const tree = loadTree(orlyDir!);
  const { results, previous, usage } = await evaluate(tree.specs, root, checks, resolveKey(orlyDir), orlyDir!);
  for (const r of results) console.log(`${r.status.padEnd(10)} ${tree.paths[r.spec.id].padEnd(40)} ${(r.where.join(", ") || "—").padEnd(28)} ${r.evidence}${r.reused ? " (reused)" : ""}`);
  const changed = (from: string, to: string) => results.filter((r) => previous[r.spec.id] === from && r.status === to).map((r) => r.spec.id);
  const improved = [...changed("violated", "satisfied"), ...changed("unknown", "satisfied")], regressed = [...changed("satisfied", "violated"), ...changed("unknown", "violated")];
  if (improved.length || regressed.length) console.log(`\nsince last eval: ${improved.length ? `improved ${improved.join(", ")}` : ""}${improved.length && regressed.length ? " · " : ""}${regressed.length ? `regressed ${regressed.join(", ")}` : ""}`);
  const orphan = unassessed(root, tree.specs, checks);
  if (orphan.length) console.log(`\nunassessed: ${orphan.length} tracked file(s) no requirement names: ${orphan.join(", ")}`);
  const n = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} requirements: ${n("satisfied")} satisfied, ${n("violated")} violated, ${n("unknown")} unknown · ${tok(usage)}, ${results.filter((r) => r.reused).length} reused`);
  for (const r of results.filter((r) => r.status === "violated")) console.log(`next: ${r.spec.id} — ${r.spec.question.split("\n")[0]}`);
  process.exit(n("violated") ? 2 : 0);
}

if (command === "hook") {
  const input = await stdin();
  const cwd = input.cwd ?? process.cwd();
  const session = String(input.session_id ?? "unknown");
  const plugin = process.env.CLAUDE_PLUGIN_ROOT;
  if (input.hook_event_name === "SessionEnd") endSession(session);
  if (input.hook_event_name === "SessionStart" && findOrlyDir(cwd))
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief(findOrlyDir(cwd)!, plugin ? `bun "${plugin}/bin/orly.ts"` : "bun bin/orly.ts") } }));
  if (input.hook_event_name === "Stop") {
    const out = await gate({ cwd, sessionId: session, answeringBlock: input.stop_hook_active === true,
      read: async () => { try { return turnFromJsonl(await Bun.file(input.transcript_path).text()); } catch { return null; } } });
    if (out.note) console.error(`orly: ${out.note}`);
    // The one line for the human rides along as a systemMessage; the reason goes back to the agent.
    if (out.block) console.log(JSON.stringify({ decision: "block", reason: out.reason, systemMessage: out.line }));
    else if (out.line || out.note) console.log(JSON.stringify({ systemMessage: out.line ?? out.note }));
  }
  process.exit(0);
}

if (command === "judge") {
  const input = await stdin();
  let turn: Turn | null = null;
  if (input.turn?.user_request !== undefined) turn = input.turn;
  else if (Array.isArray(input.messages)) turn = normalize(input.messages);
  if (!turn) fail('stdin must be {"messages":[…]} (Anthropic content blocks) or {"turn":{…}}');
  try {
    const v = await judge(turn!, orlyDir ? loadTree(orlyDir).specs : [], root, checks, resolveKey(orlyDir), orlyDir ?? undefined);
    console.log(JSON.stringify({ block: v.block, reason: v.reason, line: v.line, unmet: v.unmet, answers: v.answers, usage: v.usage }, null, 2));
    process.exit(v.block ? 2 : 0);
  } catch (e: any) { fail(e?.message === "no key" ? "no API key: set TYPESAFE_API_KEY or a keyCommand in .orly/config.json" : `judge unavailable (${e?.message ?? e})`); }
}

if (command === "specs") {
  if (!orlyDir) fail("no .orly directory here or above");
  const { specs } = loadTree(orlyDir!);
  if (!specs.length) fail("no specs under .orly/specs/");
  const problems = validate(specs);
  for (const p of problems) console.log(`✗ code   ${p.id}: ${p.problem}`);
  const judged = specs.filter((s) => !s.require && !s.broken);
  const bad = new Set(problems.map((p) => p.id));
  console.log(`${specs.length - judged.length} decided in code, ${judged.filter((s) => !aboutTurn(s)).length} judged on files, ${judged.filter(aboutTurn).length} judged on the turn`);
  if (bad.size) { console.log(`\n${bad.size} spec(s) need rewriting`); process.exit(2); }
  const t = resolveKey(orlyDir);
  if (!t) fail("word filter clean; decidability not checked: no API key");
  const q = Object.fromEntries(judged.map((s) => [s.id, { type: "noul", instructions: { spec: s.question,
    question: "Could `spec` be decided for certain purely from a record of which commands an agent ran, what those commands printed, what the agent told the user, and files read from disk? Answer no if deciding it would require reasoning about what code does when executed, or a judgement of taste." },
    criteria: { true: "Such a record is enough to settle it.", false: "Settling it needs execution the record does not contain, or an opinion about quality rather than evidence." } }]));
  const { answers, usage } = await ask({}, q, t!).catch((e) => fail(`judge unavailable (${e?.message ?? e})`));
  const cut = Number(process.env.ORLY_CHECKABLE) || 0.35; // midpoint of the fitted gap: decidable 0.57–0.74, not 0.06–0.08
  for (const s of judged) { const p = answers[s.id]?.noul ?? 1; if (p < cut) bad.add(s.id); console.log(`${p >= cut ? "✓" : "✗"} ${p.toFixed(2)}  ${s.id}: ${s.question}`); }
  console.log(bad.size ? `\n${bad.size} spec(s) need rewriting` : `\nall ${specs.length} specs are checkable`, `· ${tok(usage)}`);
  process.exit(bad.size ? 2 : 0);
}

console.log((await Bun.file(import.meta.path).text()).split("\n").slice(2, 6).map((l) => l.replace(/^ \* /, "")).join("\n"));
process.exit(command === "help" || command === "--help" ? 0 : 1);
