#!/usr/bin/env bun
/**
 * CLI entry point: `echo '{"messages":[…]}' | orly judge` (Anthropic or OpenAI dialect,
 * judged from the last user message) or `{"turn":{…}}` for a pre-normalised Turn.
 * Prints the verdict as JSON; exit 0 = may end, 2 = may not, 1 = could not run.
 * Other subcommands: `orly --help`.
 */
import { DEFAULTS, judge, type Turn } from "../src/gate.ts";
import { normalize, normalizeLastTurn, type Msg } from "../src/normalize.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ask as askJudge } from "../src/client.ts";
import { projectEvidence } from "../src/evidence.ts";
import { CACHE_NAME, checkEnricher } from "../src/enrich-checks.ts";
import { treeFingerprint } from "../src/fingerprint.ts";
import { label, propose, read } from "../src/log.ts";
import { basename, dirname, join } from "node:path";
import { findOrlyDir, loadConfig, loadSpecFile, projectRoot, resolveKey } from "../src/session.ts";
import { validateSpecs, type Spec } from "../src/specs.ts";
import { EXT, formatSpec, loadTree, renderTree, TREE } from "../src/spectree.ts";
import { check, listTurns, promote, readCases, readTurn, recordRun, saveTurn, type Outcome } from "../src/cases.ts";
import { gateTurn } from "../src/turnend.ts";
import { apply } from "../src/install.ts";
import { findHost, HOSTS, plan } from "../adapters/hosts.ts";

const fail = (msg: string, code = 1): never => {
  console.error(`orly: ${msg}`);
  process.exit(code);
};

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// What `orly schema` prints and every input error points at.
const SCHEMA = {
  messages: {
    "stdin": '{"messages":[…]}',
    "dialects": "content blocks (tool_use / tool_result), or tool_calls + role:\"tool\"; judged from the last user message on",
    "example": {
      messages: [
        { role: "user", content: "add a test for parse()" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "3 pass, 0 fail" }] },
        { role: "assistant", content: "Added test/parse.test.ts; bun test: 3 pass, 0 fail." },
      ],
    },
  },
  turn: {
    "stdin": '{"turn":{…}}, for logs in neither dialect',
    "example": {
      turn: {
        user_request: "add a test for parse()",
        assistant_final_message: "Added test/parse.test.ts; bun test: 3 pass, 0 fail.",
        assistant_said: "Added test/parse.test.ts; bun test: 3 pass, 0 fail.",
        actions_taken: ["Bash bun test"],
        command_results: ["3 pass, 0 fail"],
        conclusive: true,
      },
    },
  },
  output: '{"block":bool,"reason":string,"line":string,"answers":{…},"usage":{…}} — exit 0 may stop, 2 may not, 1 could not run',
};

/** Why `input` is not something `orly judge` can read, or null when it is. */
function inputProblem(input: any): string | null {
  if (!input || typeof input !== "object") return "stdin must be a JSON object";
  if (input.turn !== undefined) {
    const t = input.turn;
    if (!t || typeof t !== "object") return "turn must be an object";
    for (const k of ["user_request", "assistant_final_message", "assistant_said"])
      if (typeof t[k] !== "string") return `turn.${k} must be a string`;
    for (const k of ["actions_taken", "command_results"])
      if (!Array.isArray(t[k]) || t[k].some((x: unknown) => typeof x !== "string")) return `turn.${k} must be an array of strings`;
    if (typeof t.conclusive !== "boolean") return "turn.conclusive must be a boolean";
    return null;
  }
  if (!Array.isArray(input.messages)) return 'expected {"messages":[…]} or {"turn":{…}}';
  if (!input.messages.some((m: any) => m?.role === "user")) return "messages has no role:\"user\" entry, so there is no request to judge";
  return null;
}

const command = process.argv[2] ?? "judge";
if (command === "schema") {
  console.log(JSON.stringify(SCHEMA, null, 2));
  process.exit(0);
}
if (command === "--help" || command === "-h" || command === "help") {
  console.log(
    [
      "orly judge         read {messages:[…]} or {turn:{…}} on stdin, write a verdict as JSON",
      "                       exit 0 = the turn may end, 2 = it may not, 1 = the gate could not run",
      "orly gate          same input; the full fail-open gate a hook runs (baseline, round cap, log)",
      "                       prints {block, reason, banner}; exit 0 = may end, 2 = may not, never 1",
      "                       --session <id> names the host session the round cap counts under",
      "orly install <host> [--global] [--dry-run]   wire the gate into a host's hooks and add its /orly command",
      "orly hosts         every host, how it is gated, and what `orly install` writes for it",
      "orly schema        print both input shapes with a working example, and the output shape",
      "orly turns         list recently judged turns (kept locally, newest last)",
      "orly case <turn|last> block|pass \"what went wrong\" [--spec group/id [--ask \"question\"]]",
      "                   freeze the turn as a case, write the spec that must catch it, replay all",
      "orly tree          index the spec tree in .orly/specs/",
      "orly replay [name…]  run every case through the live judge with the current specs",
      "                   exit 2 if any case comes out wrong; history in .orly/replay.jsonl",
      "orly ask Q… [file…] [-] [--json]   ask now, between turns",
      "orly watch         run the checks on every change, so a turn never waits for them",
      "orly specs [path]  check that a spec list is decidable from recorded evidence",
      "orly fit           propose cuts from the judgments logged in .orly/log.jsonl",
      "",
      "env: TYPESAFE_API_KEY or .orly/config.json keyCommand, TYPESAFE_BASE_URL, ORLY_MODEL,",
      "     ORLY_ASK_CUT (the yes/no split for `ask`, default 0.5),",
      "     ORLY_HAZARD, ORLY_MIN_COVERAGE, ORLY_MIN_CONFIDENCE,",
      "     ORLY_MIN_ACTION_P, ORLY_TIMEOUT_MS",
    ].join("\n"),
  );
  process.exit(0);
}
if (command === "hosts") {
  for (const h of HOSTS) {
    const how = h.tier === "native" ? "blocks the stop" : h.tier === "emulated" ? "re-prompts" : "orly judge only";
    console.log(`${h.id.padEnd(10)} ${h.name.padEnd(22)} ${how.padEnd(16)} ${h.adapter ? `adapters/${h.adapter}` : "—"}${h.note ? `\n${" ".repeat(11)}${h.note}` : ""}`);
  }
  process.exit(0);
}
if (command === "install") {
  const id = process.argv[3];
  if (!id || id.startsWith("--")) fail(`which host? one of: ${HOSTS.filter((h) => h.plan).map((h) => h.id).join(", ")}`);
  const host = findHost(id);
  if (!host) fail(`unknown host "${id}" — run \`orly hosts\``);
  if (!host.plan) fail(`${host.name} has no hook that can keep the agent working (${host.events}); pipe its log into \`orly judge\` instead`);
  const global = process.argv.includes("--global");
  const dry = process.argv.includes("--dry-run");
  let plans;
  try {
    plans = plan(host, { global });
  } catch (e: any) {
    fail(`could not plan: ${e?.message ?? e}`);
  }
  for (const p of plans!) {
    console.log(`${p.action.padEnd(9)} ${p.path}`);
    if (dry && p.action !== "unchanged") console.log(p.preview.replace(/^/gm, "    "));
  }
  if (!dry) apply(plans!);
  console.log(`${dry ? "would install" : "installed"} orly for ${host.name} (${global ? "user" : "project"} scope)${host.note ? ` — ${host.note}` : ""}`);
  process.exit(0);
}
if (command === "ask") {
  // Ask yes/no questions now, about named files and/or stdin ("-"), outside a turn.
  //   orly ask "is the stub gone?" src/thing.ts
  //   echo "$DIFF" | orly ask "does this change touch auth?" -
  const key3 = resolveKey();
  if (!key3) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");

  const rest = process.argv.slice(3).filter((a) => a !== "--json");
  const asJson = process.argv.includes("--json");
  const questions: string[] = [];
  const paths: string[] = [];
  // stdin only via "-": guessing from isTTY hangs when stdin is neither a TTY nor a closed pipe.
  const wantsStdin = rest.includes("-");
  for (const a of rest) {
    if (a === "-") continue;
    (existsSync(a) && !a.includes("?") ? paths : questions).push(a);
  }
  if (!questions.length) fail('nothing to ask — try: orly ask "is the stub gone?" src/thing.ts');

  const files: Record<string, string> = {};
  for (const path of paths.slice(0, 8)) {
    try {
      files[path] = (await Bun.file(path).text()).slice(0, 12_000);
    } catch {
      files[path] = "[file does not exist]";
    }
  }
  const piped = wantsStdin ? (await new Response(Bun.stdin.stream()).text()).slice(0, 12_000) : "";

  const state: Record<string, unknown> = {};
  if (Object.keys(files).length) state.files = files;
  if (piped.trim()) state.input = piped;
  if (!Object.keys(state).length) fail('no state — name files to read, or pipe text in with "-"');

  const qs: Record<string, any> = {};
  questions.forEach((q, i) => {
    qs[`q${i}`] = { type: "noul", instructions: `Judging only from the state provided: ${q}` };
  });

  const t0 = performance.now();
  let answers: Record<string, any>;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  try {
    ({ answers, usage } = await askJudge(state, qs, {
      apiKey: key3!,
      endpoint: process.env.TYPESAFE_BASE_URL,
      model: process.env.ORLY_MODEL,
      timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
    }));
  } catch (e: any) {
    fail(`judge unavailable (${e?.message ?? e})`);
  }
  const ms = performance.now() - t0;

  // Reporting split only, not a fitted threshold; act only on a cut fitted to the wording.
  const cut = num("ORLY_ASK_CUT", 0.5);
  const asked = questions.map((q, i) => {
    const p = answers![`q${i}`]?.noul ?? NaN;
    return { question: q, p: Number.isFinite(p) ? Number(p.toFixed(3)) : null, yes: p >= cut };
  });
  const tok = usage?.input_tokens ?? 0;
  if (asJson) {
    console.log(JSON.stringify({ answers: asked, cut, ms: Math.round(ms), usage, files: paths, questions_asked: asked.length }));
  } else {
    for (const a of asked) console.log(`${a.yes ? "yes" : "no "} ${a.p === null ? " n/a" : a.p.toFixed(2)}  ${a.question}`);
    console.error(`${ms.toFixed(0)} ms · ${tok} tok · $${((tok * 0.042) / 1e6).toFixed(6)}`);
  }
  process.exit(asked.some((a) => !a.yes) ? 2 : 0);
}

if (command === "specs") {
  // Two stages: a word filter for taste, then the judge asks whether each spec is
  // decidable from recorded evidence (it is unreliable at simulating execution).
  const path = process.argv[3];
  let file: any;
  try {
    file = path ? JSON.parse(await Bun.file(path).text()) : loadSpecFile(process.cwd());
  } catch (e: any) {
    fail(`could not read ${path}: ${e?.code === "ENOENT" ? "no such file" : "not JSON"}`);
  }
  if (!file?.specs?.length) fail("no specs found — pass a path, or create .orly/specs.json");

  // `require` specs are decided in code, so the decidability question does not apply.
  const problems = validateSpecs(file.specs);
  const judged = (file.specs as Spec[]).filter((s) => !s.require);
  const deterministic = (file.specs as Spec[]).length - judged.length;
  if (deterministic) console.log(`${deterministic} deterministic check(s) skipped — decided in code, not judged\n`);
  file.specs = judged;
  const rejected = new Set(problems.map((p) => p.id));
  for (const p of problems) console.log(`✗ word   ${p.id}: ${p.problem}`);

  const key2 = resolveKey();
  if (!key2) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");
  const questions: Record<string, any> = {};
  for (const sp of file.specs as Spec[]) {
    questions[sp.id] = {
      type: "noul",
      instructions: {
        spec: sp.instructions,
        question:
          "Could `spec` be decided for certain purely from a record of which commands an agent ran, what those commands printed, and what the agent told the user? Answer no if deciding it would require reasoning about what the code would do when executed, or a judgement of taste.",
      },
      criteria: {
        true: "A transcript of commands, their output and the agent's messages is enough to settle it.",
        false:
          "Settling it needs execution the record does not contain, or an opinion about quality rather than evidence.",
      },
    };
  }
  let answers: Record<string, any>;
  try {
    ({ answers } = await askJudge({ goal: file.goal }, questions, {
      apiKey: key2!,
      endpoint: process.env.TYPESAFE_BASE_URL,
      model: process.env.ORLY_MODEL,
      timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
    }));
  } catch (e: any) {
    fail(`judge unavailable (${e?.message ?? e})`);
  }
  // Midpoint of the fitted gap (decidable 0.57–0.74, not 0.06–0.08). Refit if the wording changes.
  const cut = Number(process.env.ORLY_CHECKABLE ?? 0.35);
  for (const sp of file.specs as Spec[]) {
    if (rejected.has(sp.id)) continue;
    const p = answers![sp.id]?.noul ?? 1;
    if (p < cut) rejected.add(sp.id);
    console.log(`${p >= cut ? "✓" : "✗"} ${p.toFixed(2)}  ${sp.id}: ${sp.instructions}`);
  }
  const bad = rejected.size;
  console.log(bad ? `\n${bad} of ${file.specs.length} spec(s) need rewriting` : `\nall ${file.specs.length} specs are checkable`);
  process.exit(bad ? 2 : 0);
}

if (command === "watch") {
  // Run the checks on every tree change so a turn does not wait for them. Each result is
  // stamped with its tree fingerprint; the gate ignores stale ones, so lag costs time, not correctness.
  const root = projectRoot(process.cwd()) ?? process.cwd();
  const checks = loadConfig(process.cwd()).checks ?? {};
  if (!Object.keys(checks).length) fail("no checks in .orly/config.json — nothing to watch");
  const every = num("ORLY_WATCH_MS", 2_000);
  const cachePath = join(findOrlyDir(process.cwd())!, CACHE_NAME);
  console.error(`orly watch · ${Object.keys(checks).length} checks · ${root}`);

  let last: string | null = null;
  for (;;) {
    const fingerprint = treeFingerprint(root);
    if (fingerprint && fingerprint !== last) {
      last = fingerprint;
      const t0 = performance.now();
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, spec]: [string, any]) => {
          const one = await checkEnricher({ [name]: spec }, root)({} as any, [
            { id: name, instructions: "n/a", require: { path: `checks.${name}.exit`, op: "equals" } } as any,
          ]);
          return [name, { fingerprint, at: new Date().toISOString(), result: (one as any).checks?.[name] }] as const;
        }),
      );
      // Write only if the tree did not change mid-sweep, else results carry a wrong fingerprint.
      if (treeFingerprint(root) === fingerprint) {
        await Bun.write(cachePath, JSON.stringify(Object.fromEntries(results), null, 2));
        console.error(`  ${new Date().toTimeString().slice(0, 8)} ${results.length} checks in ${(performance.now() - t0).toFixed(0)} ms`);
      } else {
        last = null; // the tree moved under us; sweep again
      }
    }
    await Bun.sleep(every);
  }
}

if (command === "fit") {
  // Propose cuts from logged turns. Print only: the judged agent must not set its own threshold.
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory found from here");
  const records = label(read(dir!));
  if (!records.length) fail(`no judgments logged yet in ${dir}`);

  const blocks = records.filter((r) => r.blocked);
  const worked = blocks.filter((r) => r.outcome === "worked").length;
  const explained = blocks.filter((r) => r.outcome === "explained").length;
  console.log(`${records.length} judged turns · ${blocks.length} blocked · ${worked} bought work · ${explained} talked past`);

  const cuts: Record<string, number> = {};
  // Not the module-level `specFile`: it is declared below, so reading it here is a TDZ crash.
  for (const sp of loadSpecFile(process.cwd())?.specs ?? []) {
    cuts[`spec:${sp.id}`] = sp.cut ?? DEFAULTS.specMet;
  }
  const proposals = propose(records, cuts);
  if (!proposals.length) {
    console.log("\nNothing to propose: not enough labelled blocks yet, or no cut separates them.");
    console.log("A spec whose populations overlap has a wording problem, not a threshold one.");
    process.exit(0);
  }
  console.log("");
  for (const p of proposals) {
    console.log(
      `${p.id}: ${p.current.toFixed(2)} → ${p.suggested.toFixed(2)}  (${p.direction}, ${p.support} turns, ` +
        `fine-turns floor ${p.metFloor.toFixed(2)} / real-catch ceiling ${p.unmetCeiling.toFixed(2)})`,
    );
  }
  console.log("\nTightening is yours to apply. Loosening should be confirmed by a human:");
  console.log("an agent that lowers its own bar will lower it until nothing fires.");
  process.exit(0);
}

if (command === "turns") {
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory here or above");
  for (const id of listTurns(dir!).slice(-Number(process.argv[3] ?? 15))) {
    const t = readTurn(dir!, id);
    const ask = t.turn.user_request.replace(/\s+/g, " ").slice(0, 70);
    console.log(`${id}  ${t.blocked ? "BLOCK" : "pass "}  ${ask}`);
  }
  process.exit(0);
}

if (command === "tree") {
  const dir = findOrlyDir(process.cwd());
  const tree = dir ? loadTree(dir) : null;
  if (!tree) fail("no .orly/specs/ tree here or above");
  if (tree!.goal) console.log(`goal: ${tree!.goal}\n`);
  console.log(renderTree(tree!));
  console.log(`\n${tree!.specs.length} specs`);
  process.exit(0);
}

/** Re-judge cases against the live judge with the current specs, record the run, print it. */
async function replay(dir: string, only: string[] = []): Promise<boolean> {
  const cases = readCases(dir).filter((c) => !only.length || only.includes(c.name));
  if (!cases.length) fail('no cases yet — make one with `orly case last block "what went wrong" --spec id`');
  const key4 = resolveKey();
  if (!key4) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");
  const specs = loadSpecFile(process.cwd())?.specs ?? [];
  const results = await Promise.all(
    cases.map(async (c): Promise<Outcome> => {
      try {
        const { verdict } = await judge(c.turn, {
          apiKey: key4!,
          specs,
          enrich: async () => c.evidence ?? {},
          endpoint: process.env.TYPESAFE_BASE_URL,
          model: process.env.ORLY_MODEL,
          timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
        });
        return check(c, verdict, specs.map((s) => s.id));
      } catch (e: any) {
        return { name: c.name, ok: false, blocked: false, problem: `judge unavailable (${e?.message ?? e})` };
      }
    }),
  );
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.problem ? `  — ${r.problem}` : ""}`);
  const right = results.filter((r) => r.ok).length;
  const history = only.length
    ? []
    : recordRun(dir, {
        at: new Date().toISOString(),
        total: results.length,
        right,
        wrong: results.filter((r) => !r.ok).map((r) => r.name),
      });
  console.log(`\n${right}/${results.length} cases right`);
  if (history.length > 1) console.log(`history: ${history.slice(-8).map((h) => `${h.right}/${h.total}`).join(" → ")}`);
  return right === results.length;
}

if (command === "case") {
  // Freeze the turn and its evidence as a case, write the spec (--ask) if new, replay all cases.
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory here or above");
  const args = process.argv.slice(3);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const specRef = flag("--spec");
  const question = flag("--ask");
  const noReplay = args.includes("--no-replay") ? (args.splice(args.indexOf("--no-replay"), 1), true) : false;
  const [id, want, note] = args;
  if (!id || (want !== "block" && want !== "pass") || !note || (question !== undefined && !specRef))
    fail('usage: orly case <turn|last> block|pass "what went wrong" [--spec group/id [--ask "question"]] [--no-replay]');
  let saved;
  try {
    saved = readTurn(dir!, id);
  } catch (e: any) {
    fail(`${e.message} — run \`orly turns\``);
  }
  const specId = specRef ? basename(specRef, EXT) : undefined;
  if (specRef && question) {
    const path = join(dir!, TREE, specRef.endsWith(EXT) ? specRef : `${specRef}${EXT}`);
    if (existsSync(path)) fail(`${path} already exists — drop --ask to reuse it`);
    const problems = validateSpecs([{ id: specId!, instructions: question }]);
    if (problems.length) fail(`spec rejected: ${problems.map((p) => p.problem).join("; ")}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatSpec({ id: specId!, instructions: question }));
    console.log(`spec written: ${path}`);
  }
  const path = promote(dir!, saved!, { block: want === "block", ...(specId ? { unmet: [specId] } : {}) }, note);
  console.log(`case written: ${path}`);
  console.log("It holds the turn's transcript and evidence verbatim: read it for secrets before committing.");
  if (specId && !(loadSpecFile(process.cwd())?.specs ?? []).some((s) => s.id === specId)) {
    console.log(`next: write .orly/${TREE}/${specRef}${EXT} (or pass --ask "question"), then \`orly replay\``);
    process.exit(0);
  }
  if (noReplay) process.exit(0);
  console.log("");
  process.exit((await replay(dir!)) ? 0 : 2);
}

if (command === "replay") {
  // Re-judge every case with the current specs; catches a spec change that breaks an old case.
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory here or above");
  process.exit((await replay(dir!, process.argv.slice(3))) ? 0 : 2);
}

if (command !== "judge" && command !== "gate") fail(`unknown command "${command}" — try: orly --help`);

// Validate shape before resolving the key, so a bad input never needs a key or costs a request.
const raw = await new Response(Bun.stdin.stream()).text();
let input: { messages?: Msg[]; turn?: Turn };
try {
  input = JSON.parse(raw);
} catch {
  fail("stdin was not JSON — run `orly schema` for the expected shape");
}
const problem = inputProblem(input!);
if (problem) fail(`${problem} — run \`orly schema\` for the expected shape`);

if (command === "gate") {
  // The hook path over stdin, for a host with no hook protocol of its own: fails open,
  // counts rounds under --session, logs the judgment. A bad input is still exit 1 above.
  const sessionFlag = process.argv.indexOf("--session");
  const sessionId = sessionFlag > 0 ? process.argv[sessionFlag + 1] : undefined;
  const turnIn: Turn = input!.turn ?? normalizeLastTurn(input!.messages!);
  const outcome = await gateTurn({
    cwd: process.cwd(),
    sessionId: String(sessionId ?? process.env.ORLY_SESSION ?? "cli"),
    read: async () => turnIn,
    flush: false,
    answeringBlock: process.argv.includes("--answering-block"),
  });
  if (outcome.note) console.error(`orly: ${outcome.note}`);
  console.log(JSON.stringify(outcome));
  process.exit(outcome.block ? 2 : 0);
}

const key = resolveKey();
if (!key) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");

let turn: Turn;
if (input!.turn) turn = input!.turn;
else turn = normalizeLastTurn(input!.messages!);

const specFile = loadSpecFile(process.cwd());
let seen: Record<string, unknown> | undefined;

try {
  const { verdict, answers, usage } = await judge(turn!, {
    apiKey: key!,
    specs: specFile?.specs,
    // Same evidence as the hook, so CLI and adapters agree on a repository.
    enrich: async (t, s) => (seen = await projectEvidence()(t, s)),
    endpoint: process.env.TYPESAFE_BASE_URL,
    model: process.env.ORLY_MODEL,
    timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
    thresholds: {
      hazard: num("ORLY_HAZARD", DEFAULTS.hazard),
      specMet: num("ORLY_SPEC_MET", DEFAULTS.specMet),
      minCoverage: num("ORLY_MIN_COVERAGE", DEFAULTS.minCoverage),
      minCoverageConfidence: num("ORLY_MIN_CONFIDENCE", DEFAULTS.minCoverageConfidence),
      minActionProbability: num("ORLY_MIN_ACTION_P", DEFAULTS.minActionProbability),
    },
  });
  const orlyDir = findOrlyDir(process.cwd());
  if (orlyDir)
    saveTurn(orlyDir, {
      at: new Date().toISOString(),
      session: String(process.env.ORLY_SESSION ?? "cli"),
      turn: turn!,
      evidence: seen,
      blocked: verdict.block,
      unmet: verdict.results.filter((r) => !r.met && !r.spec.optional).map((r) => `spec:${r.spec.id}`),
    });
  console.log(JSON.stringify({ ...verdict, answers, usage }));
  process.exit(verdict.block ? 2 : 0);
} catch (e: any) {
  // Exit 1: the caller decides whether an unavailable judge means open or closed.
  fail(`judge unavailable (${e?.message ?? e})`);
}

export {};

/** Re-exported so an embedding host can skip the process boundary. */
export { normalize, normalizeLastTurn };
