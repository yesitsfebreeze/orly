#!/usr/bin/env bun
/**
 * The portable entry point. Any agent, in any language, on any harness, can use the gate
 * by piping JSON in and reading JSON out — no plugin, no hook, no runtime coupling.
 *
 *   echo '{"messages":[…]}' | orly judge
 *   echo '{"turn":{…}}'     | orly judge
 *
 * `messages` is a chat log in either the Anthropic (content blocks) or OpenAI
 * (tool_calls / role:"tool") dialect; the last human message onward is judged. `turn` is
 * a pre-normalised Turn for agents whose logs are neither shape.
 *
 * Output: {"block":bool,"reason":string,"line":string,"answers":{…},"usage":{…}}
 * Exit code is 0 when the turn may end and 2 when it may not, so a shell can gate on it.
 */
import { DEFAULTS, judge, type Turn } from "../src/gate.ts";
import { normalize, normalizeLastTurn, type Msg } from "../src/normalize.ts";
import { existsSync } from "node:fs";
import { ask as askJudge } from "../src/client.ts";
import { projectEvidence } from "../src/evidence.ts";
import { CACHE_NAME, checkEnricher } from "../src/enrich-checks.ts";
import { treeFingerprint } from "../src/fingerprint.ts";
import { label, propose, read } from "../src/log.ts";
import { join } from "node:path";
import { findOrlyDir, loadConfig, loadSpecFile, projectRoot, resolveKey } from "../src/session.ts";
import { validateSpecs, type Spec } from "../src/specs.ts";

const fail = (msg: string, code = 1): never => {
  console.error(`orly: ${msg}`);
  process.exit(code);
};

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const command = process.argv[2] ?? "judge";
if (command === "--help" || command === "-h" || command === "help") {
  console.log(
    [
      "orly judge         read {messages:[…]} or {turn:{…}} on stdin, write a verdict as JSON",
      "                       exit 0 = the turn may end, 2 = it may not, 1 = the gate could not run",
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
if (command === "ask") {
  // Ask right now instead of waiting for the end of a turn.
  //
  // The gate answers once, at the boundary, about everything. This answers immediately,
  // about one thing: build a small state, fan out as many yes/no questions as you like,
  // get calibrated numbers back in well under a second. Batching is close to free — the
  // state dominates the cost — so asking ten things costs barely more than asking one.
  //
  //   orly ask "is the stub gone?" src/thing.ts
  //   echo "$DIFF" | orly ask "does this change touch auth?" "is a test included?"
  const key3 = resolveKey();
  if (!key3) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");

  const rest = process.argv.slice(3).filter((a) => a !== "--json");
  const asJson = process.argv.includes("--json");
  const questions: string[] = [];
  const paths: string[] = [];
  // Reading stdin is opt-in via "-". Guessing from isTTY hangs forever wherever stdin is
  // neither a terminal nor a closed pipe, which is most places a tool actually runs.
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

  // The split is a reporting convenience, not a decision threshold: 0.5 is where an
  // unfitted question looks most trustworthy and is least so. Anything you act on needs
  // a cut fitted for that question's wording — which is what --cut is for.
  const cut = num("ORLY_ASK_CUT", 0.5);
  const asked = questions.map((q, i) => {
    const p = answers![`q${i}`]?.noul ?? NaN;
    return { question: q, p: Number.isFinite(p) ? Number(p.toFixed(3)) : null, yes: p >= cut };
  });
  const tok = usage?.input_tokens ?? 0;
  if (asJson) {
    // For a program on the other end: one object, every probability, the cut it was
    // split at, and what it cost. Parsing the human lines is nobody's idea of an API.
    console.log(JSON.stringify({ answers: asked, cut, ms: Math.round(ms), usage, files: paths, questions_asked: asked.length }));
  } else {
    for (const a of asked) console.log(`${a.yes ? "yes" : "no "} ${a.p === null ? " n/a" : a.p.toFixed(2)}  ${a.question}`);
    console.error(`${ms.toFixed(0)} ms · ${tok} tok · $${((tok * 0.042) / 1e6).toFixed(6)}`);
  }
  process.exit(asked.some((a) => !a.yes) ? 2 : 0);
}

if (command === "specs") {
  // Two-stage check on a generated spec list. Stage one is a word filter for judgements
  // about taste; stage two asks Jev itself whether each spec is decidable from recorded
  // evidence — because an LLM asked for specs will cheerfully emit "handles all edge
  // cases correctly", and simulating execution is the one thing Jev is confidently wrong
  // about.
  const path = process.argv[3];
  const file = path ? JSON.parse(await Bun.file(path).text()) : loadSpecFile(process.cwd());
  if (!file?.specs?.length) fail("no specs found — pass a path, or create .orly/specs.json");

  // A `require` spec is decided in code, so "could a transcript settle this?" is the wrong
  // question to ask of it — and asking anyway reports a perfectly good check as broken.
  const judged = (file.specs as Spec[]).filter((s) => !s.require);
  const deterministic = (file.specs as Spec[]).length - judged.length;
  if (deterministic) console.log(`${deterministic} deterministic check(s) skipped — decided in code, not judged\n`);
  file.specs = judged;

  const problems = validateSpecs(file.specs);
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
  // Fitted on a mixed list: specs that are genuinely decidable from a transcript scored
  // 0.57–0.74, ones requiring simulated execution or taste scored 0.06–0.08. 0.35 is the
  // midpoint of that gap. Refit if this question's wording changes.
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
  // Run the project's checks continuously, so a turn does not pay for them.
  //
  // Measured on this repository: nine checks cost 325 ms even run in parallel, against a
  // judge round trip of roughly 450 ms. Computed while the agent is still working, they
  // cost the turn nothing. Every result is stamped with the tree it was computed against,
  // and the gate recomputes that stamp itself and ignores anything that does not match —
  // so a watcher falling behind costs time, never correctness.
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
      // Only write results still describing the tree we started from. An edit landing
      // mid-sweep would otherwise be stamped with a fingerprint it never had.
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
  // Turn logged turns into cut proposals. It only ever prints; applying is a human's call,
  // because the agent being judged is not a neutral party to its own threshold.
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory found from here");
  const records = label(read(dir!));
  if (!records.length) fail(`no judgments logged yet in ${dir}`);

  const blocks = records.filter((r) => r.blocked);
  const worked = blocks.filter((r) => r.outcome === "worked").length;
  const explained = blocks.filter((r) => r.outcome === "explained").length;
  console.log(`${records.length} judged turns · ${blocks.length} blocked · ${worked} bought work · ${explained} talked past`);

  const cuts: Record<string, number> = {};
  // Loaded here, not from the module-level `specFile`: that is declared below, in the
  // judge path, so reading it from this branch is a temporal-dead-zone crash.
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

if (command !== "judge") fail(`unknown command "${command}" — try: orly judge | orly specs | orly fit`);

const key = resolveKey();
if (!key) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");

const raw = await new Response(Bun.stdin.stream()).text();
let input: { messages?: Msg[]; turn?: Turn };
try {
  input = JSON.parse(raw);
} catch {
  fail("stdin was not JSON");
}

let turn: Turn;
if (input!.turn) turn = input!.turn;
else if (Array.isArray(input!.messages)) turn = normalizeLastTurn(input!.messages);
else fail('expected {"messages":[…]} or {"turn":{…}} on stdin');

const specFile = loadSpecFile(process.cwd());

try {
  const { verdict, answers, usage } = await judge(turn!, {
    apiKey: key!,
    specs: specFile?.specs,
    // The same evidence the hook gathers, from the same place, so the CLI and a host
    // adapter can never disagree about the same repository.
    enrich: projectEvidence(),
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
  console.log(JSON.stringify({ ...verdict, answers, usage }));
  process.exit(verdict.block ? 2 : 0);
} catch (e: any) {
  // The caller decides what an unavailable judge means. The CLI will not pretend.
  fail(`judge unavailable (${e?.message ?? e})`);
}

export {};

/** Re-exported so an embedding host can skip the process boundary. */
export { normalize, normalizeLastTurn };
