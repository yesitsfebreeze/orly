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
import { combine, fileEnricher } from "../src/enrich.ts";
import { kernMemoryEnricher } from "../src/enrich-kern.ts";
import { label, propose, read } from "../src/log.ts";
import { findOrlyDir, loadSpecFile, projectRoot } from "../src/session.ts";
import { validateSpecs, type Spec } from "../src/specs.ts";

const fail = (msg: string, code = 1): never => {
  console.error(`orly: ${msg}`);
  process.exit(code);
};

const command = process.argv[2] ?? "judge";
if (command === "--help" || command === "-h" || command === "help") {
  console.log(
    [
      "orly judge         read {messages:[…]} or {turn:{…}} on stdin, write a verdict as JSON",
      "                       exit 0 = the turn may end, 2 = it may not, 1 = the gate could not run",
      "orly specs [path]  check that a spec list is decidable from recorded evidence",
      "orly fit           propose cuts from the judgments logged in .orly/log.jsonl",
      "",
      "env: TYPESAFE_API_KEY (required), TYPESAFE_BASE_URL, ORLY_MODEL,",
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
  const key3 = process.env.TYPESAFE_API_KEY;
  if (!key3) fail("TYPESAFE_API_KEY is not set");

  const rest = process.argv.slice(3);
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
  const res3 = await fetch(process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key3}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: process.env.ORLY_MODEL ?? "jev-latest", questions: qs }),
  });
  if (!res3.ok) fail(`${res3.status} ${(await res3.text()).slice(0, 200)}`);
  const out3 = await res3.json();
  const ms = performance.now() - t0;

  let anyNo = false;
  questions.forEach((q, i) => {
    const p = out3.answers?.[`q${i}`]?.noul ?? NaN;
    // 0.5 is a reporting split only — never a decision threshold. Anything you act on
    // needs a cut fitted for that question's wording.
    if (!(p >= 0.5)) anyNo = true;
    console.log(`${p >= 0.5 ? "yes" : "no "} ${p.toFixed(2)}  ${q}`);
  });
  const tok = out3.usage?.input_tokens ?? 0;
  console.error(`${ms.toFixed(0)} ms · ${tok} tok · $${((tok * 0.042) / 1e6).toFixed(6)}`);
  process.exit(anyNo ? 2 : 0);
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

  const problems = validateSpecs(file.specs);
  const rejected = new Set(problems.map((p) => p.id));
  for (const p of problems) console.log(`✗ word   ${p.id}: ${p.problem}`);

  const key2 = process.env.TYPESAFE_API_KEY;
  if (!key2) fail("TYPESAFE_API_KEY is not set");
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
  const res = await fetch(process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key2}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: { goal: file.goal }, model: process.env.ORLY_MODEL ?? "jev-latest", questions }),
  });
  if (!res.ok) fail(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const { answers } = await res.json();
  // Fitted on a mixed list: specs that are genuinely decidable from a transcript scored
  // 0.57–0.74, ones requiring simulated execution or taste scored 0.06–0.08. 0.35 is the
  // midpoint of that gap. Refit if this question's wording changes.
  const cut = Number(process.env.ORLY_CHECKABLE ?? 0.35);
  for (const sp of file.specs as Spec[]) {
    if (rejected.has(sp.id)) continue;
    const p = answers?.[sp.id]?.noul ?? 1;
    if (p < cut) rejected.add(sp.id);
    console.log(`${p >= cut ? "✓" : "✗"} ${p.toFixed(2)}  ${sp.id}: ${sp.instructions}`);
  }
  const bad = rejected.size;
  console.log(bad ? `\n${bad} of ${file.specs.length} spec(s) need rewriting` : `\nall ${file.specs.length} specs are checkable`);
  process.exit(bad ? 2 : 0);
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
  for (const sp of specFile?.specs ?? []) cuts[`spec:${sp.id}`] = sp.cut ?? DEFAULTS.specMet;
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

const key = process.env.TYPESAFE_API_KEY;
if (!key) fail("TYPESAFE_API_KEY is not set");

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

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

try {
  const { verdict, answers, usage } = await judge(turn!, {
    apiKey: key!,
    specs: specFile?.specs,
    enrich: combine(
      fileEnricher(projectRoot(process.cwd()) ?? process.cwd(), (path) => Bun.file(path).text()),
      kernMemoryEnricher(specFile?.goal ?? ""),
    ),
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
