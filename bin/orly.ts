#!/usr/bin/env bun
/**
 * orly hook          Claude Code hook (Stop, SessionStart, SessionEnd), payload on stdin
 * orly judge         {messages:[…]} or {turn:{…}} on stdin → verdict JSON; exit 0 may stop, 2 not done, 1 could not run
 * orly specs         validate .orly/specs: taste and syntax in code, then ask jev whether each question is decidable
 * orly ask Q [file…] one yes/no now
 * orly tree          index the spec tree and how each spec is decided
 */
import { dirname, join } from "node:path";
import { ask, brief, endSession, findOrlyDir, gate, judge, loadConfig, loadTree, normalize, resolveKey, turnFromJsonl, validate, type Turn } from "../src/orly.ts";

const [command = "help", ...args] = process.argv.slice(2);
const orlyDir = findOrlyDir(process.cwd());
const fail = (msg: string, code = 1): never => (console.error(`orly: ${msg}`), process.exit(code));
const stdin = async () => { try { return JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { return {}; } };

if (command === "hook") {
  const input = await stdin();
  const cwd = input.cwd ?? process.cwd();
  const session = String(input.session_id ?? "unknown");
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (input.hook_event_name === "SessionEnd") endSession(session);
  if (input.hook_event_name === "SessionStart" && findOrlyDir(cwd))
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief(findOrlyDir(cwd)!, root ? `bun "${root}/bin/orly.ts"` : "bun bin/orly.ts") } }));
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
  const tree = orlyDir ? loadTree(orlyDir) : { specs: [] };
  try {
    const v = await judge(turn!, tree.specs, orlyDir ? dirname(orlyDir) : process.cwd(), (orlyDir && loadConfig(orlyDir).checks) ?? {}, resolveKey(orlyDir));
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
  console.log(`${specs.length - judged.length} decided in code, ${judged.length} judged`);
  if (bad.size) { console.log(`\n${bad.size} spec(s) need rewriting`); process.exit(2); }
  const t = resolveKey(orlyDir);
  if (!t) fail("word filter clean; decidability not checked: no API key");
  const q = Object.fromEntries(judged.map((s) => [s.id, { type: "noul", instructions: { spec: s.question,
    question: "Could `spec` be decided for certain purely from a record of which commands an agent ran, what those commands printed, what the agent told the user, and files read from disk? Answer no if deciding it would require reasoning about what code does when executed, or a judgement of taste." },
    criteria: { true: "Such a record is enough to settle it.", false: "Settling it needs execution the record does not contain, or an opinion about quality rather than evidence." } }]));
  const { answers, usage } = await ask({}, q, t!).catch((e) => fail(`judge unavailable (${e?.message ?? e})`));
  const cut = Number(process.env.ORLY_CHECKABLE) || 0.35; // midpoint of the fitted gap: decidable 0.57–0.74, not 0.06–0.08
  for (const s of judged) { const p = answers[s.id]?.noul ?? 1; if (p < cut) bad.add(s.id); console.log(`${p >= cut ? "✓" : "✗"} ${p.toFixed(2)}  ${s.id}: ${s.question}`); }
  console.log(bad.size ? `\n${bad.size} spec(s) need rewriting` : `\nall ${specs.length} specs are checkable`, usage ? `· ${usage.input_tokens}+${usage.output_tokens} tok` : "");
  process.exit(bad.size ? 2 : 0);
}

if (command === "ask") {
  const [question, ...files] = args.filter((a) => a !== "--json");
  if (!question) fail('usage: orly ask "<question>" [file…]');
  const t = resolveKey(orlyDir) ?? fail("no API key: set TYPESAFE_API_KEY or a keyCommand in .orly/config.json");
  const project = { files: Object.fromEntries(await Promise.all(files.map(async (f) => [f, await Bun.file(f).text().catch(() => "[file does not exist]")]))) };
  const { answers, usage } = await ask({ project }, { q: { type: "noul", instructions: question } }, t).catch((e) => fail(`judge unavailable (${e?.message ?? e})`));
  const p = answers.q?.noul ?? 0;
  if (args.includes("--json")) console.log(JSON.stringify({ p, usage }));
  else console.log(`${p >= (Number(process.env.ORLY_ASK_CUT) || 0.5) ? "yes" : "no"} (p=${p.toFixed(2)})${usage ? ` · ${usage.input_tokens}+${usage.output_tokens} tok` : ""}`);
  process.exit(0);
}

if (command === "tree") {
  if (!orlyDir) fail("no .orly directory here or above");
  const tree = loadTree(orlyDir!);
  const checks = loadConfig(orlyDir!).checks ?? {};
  for (const s of tree.specs) {
    const how = s.broken ? `MALFORMED: ${s.broken}` : s.require ? `check ${s.require.path} ${s.require.op} ${s.require.value ?? ""}${checks[s.require.path.split(".")[1]] ? "" : " (no such check in config.json)"}` : `cut ${s.cut ?? 0.7}`;
    console.log(`${tree.paths[s.id].padEnd(40)} ${how.trim()}${s.optional ? " (optional)" : ""}`);
  }
  process.exit(validate(tree.specs).length ? 2 : 0);
}

console.log((await Bun.file(import.meta.path).text()).split("\n").slice(2, 7).map((l) => l.replace(/^ \* /, "")).join("\n"));
process.exit(command === "help" || command === "--help" ? 0 : 1);
