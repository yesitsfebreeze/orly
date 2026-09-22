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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ask as askJudge } from "../src/client.ts";
import { projectEvidence } from "../src/evidence.ts";
import { CACHE_NAME, checkEnricher } from "../src/enrich-checks.ts";
import { treeFingerprint } from "../src/fingerprint.ts";
import { label, propose, read } from "../src/log.ts";
import { basename, dirname, join } from "node:path";
import { findOrlyDir, loadConfig, loadSpecFile, projectRoot, resolveKey } from "../src/session.ts";
import { validateSpecs, type Spec } from "../src/specs.ts";
import { judgeSidecar, pool, type ClaimResult } from "../src/claims.ts";
import { indexFiles } from "../src/lsp.ts";
import { EXT, formatSpec, loadTree, renderTree, TREE } from "../src/spectree.ts";
import { check, listTurns, promote, readCases, readTurn, recordRun, saveTurn, type Outcome } from "../src/cases.ts";

const fail = (msg: string, code = 1): never => {
  console.error(`orly: ${msg}`);
  process.exit(code);
};

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// What `orly schema` prints and every input error points at: a caller should get the
// shape right on the first try, not by reading this file.
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
      "orly schema        print both input shapes with a working example, and the output shape",
      "orly turns         list recently judged turns (kept locally, newest last)",
      "orly case <turn|last> block|pass \"what went wrong\" [--spec group/id [--ask \"question\"]]",
      "                   freeze the turn as a case, write the spec that must catch it, replay all",
      "orly tree          index the spec tree in .orly/specs/",
      "orly symbols <file>  the definitions a claim can anchor to",
      "orly claims [path…]  judge every <file>.orly sidecar against its code, in parallel;",
      "                   exit 2 if any claim fails (ORLY_CLAIM_CUT, ORLY_CLAIMS_PARALLEL)",
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
  let file: any;
  try {
    file = path ? JSON.parse(await Bun.file(path).text()) : loadSpecFile(process.cwd());
  } catch (e: any) {
    fail(`could not read ${path}: ${e?.code === "ENOENT" ? "no such file" : "not JSON"}`);
  }
  if (!file?.specs?.length) fail("no specs found — pass a path, or create .orly/specs.json");

  // A `require` spec is decided in code, so "could a transcript settle this?" is the wrong
  // question to ask of it — and asking anyway reports a perfectly good check as broken.
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

if (command === "symbols") {
  const path = process.argv[3];
  if (!path) fail("usage: orly symbols <file>");
  const text = await Bun.file(path!).text().catch(() => fail(`could not read ${path}`));
  const root = projectRoot(process.cwd()) ?? process.cwd();
  const defs = (await indexFiles(root, [{ path: path!, text: text as string }], loadConfig(process.cwd()).lsp)).get(path!)!;
  if (defs instanceof Error) fail(defs.message);
  for (const d of defs as any[]) console.log(`${d.anchor.padEnd(40)} ${d.kind.padEnd(12)} ${d.from}-${d.to}`);
  process.exit(0);
}

if (command === "claims") {
  // Every sidecar in the repository: each language's server indexes its files, then one
  // judge request per source file, many files at once.
  const root = projectRoot(process.cwd()) ?? process.cwd();
  const listed = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "*.orly"], { cwd: root, stdout: "pipe" });
  const only = process.argv.slice(3);
  const sidecars = listed.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .filter((f) => !only.length || only.some((o) => f === o || f === `${o}.orly` || f.startsWith(o.replace(/\/?$/, "/"))));
  if (!sidecars.length) fail("no *.orly sidecars found — write one next to a source file, e.g. src/http.ts.orly");
  const key5 = resolveKey();
  if (!key5) fail("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json");
  const cut = num("ORLY_CLAIM_CUT", DEFAULTS.specMet);
  const transport = { apiKey: key5!, endpoint: process.env.TYPESAFE_BASE_URL, model: process.env.ORLY_MODEL, timeoutMs: num("ORLY_TIMEOUT_MS", 12_000) };
  const t0 = performance.now();
  const files = await Promise.all(
    sidecars.map(async (car) => {
      const path = car.slice(0, -".orly".length);
      return { car, path, text: await Bun.file(join(root, path)).text().catch(() => null), sidecar: await Bun.file(join(root, car)).text() };
    }),
  );
  const index = await indexFiles(root, files.filter((f) => f.text !== null) as any, loadConfig(process.cwd()).lsp);
  const tIndex = performance.now();
  const perFile = await pool(files, num("ORLY_CLAIMS_PARALLEL", 8), async (f): Promise<[string, ClaimResult[]]> => {
    try {
      const defs = index.get(f.path) ?? new Error(`${f.path} does not exist`);
      return [f.path, await judgeSidecar(f.path, f.text, defs, f.sidecar, (st, q) => askJudge(st, q, transport), cut)];
    } catch (e: any) {
      return [f.path, [{ anchor: "@file", claim: "", line: 0, ok: false, problem: e?.message ?? String(e) }]];
    }
  });
  let total = 0;
  let bad = 0;
  for (const [src, results] of perFile)
    for (const r of results) {
      total++;
      if (!r.ok) bad++;
      const p = typeof r.p === "number" ? r.p.toFixed(2) : "  - ";
      console.log(`${r.ok ? "ok  " : "FAIL"} ${p}  ${src}:${r.line} ${r.anchor}: ${r.claim}${r.problem ? `  — ${r.problem}` : ""}`);
    }
  const ms = (t: number) => Math.round(t);
  console.log(`\n${total - bad}/${total} claims hold across ${sidecars.length} file(s) — index ${ms(tIndex - t0)} ms, judge ${ms(performance.now() - tIndex)} ms (cut ${cut})`);
  process.exit(bad ? 2 : 0);
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
  // Every mistake becomes a check, in one call: freeze the turn with the evidence the judge
  // saw, write the spec that must catch it if it does not exist yet, and replay every case
  // so the new spec is proven on this mistake without breaking an earlier one.
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
  // The long-term test: every recorded mistake, re-judged by the live judge against the
  // specs as they are now. A spec change that fixes one case and breaks another shows here.
  const dir = findOrlyDir(process.cwd());
  if (!dir) fail("no .orly directory here or above");
  process.exit((await replay(dir!, process.argv.slice(3))) ? 0 : 2);
}

if (command !== "judge") fail(`unknown command "${command}" — try: orly --help`);

// Shape first, key second: a caller fixing its input should not have to get a key to
// find out the input was wrong, and a bad shape should never cost a request.
const raw = await new Response(Bun.stdin.stream()).text();
let input: { messages?: Msg[]; turn?: Turn };
try {
  input = JSON.parse(raw);
} catch {
  fail("stdin was not JSON — run `orly schema` for the expected shape");
}
const problem = inputProblem(input!);
if (problem) fail(`${problem} — run \`orly schema\` for the expected shape`);

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
    // The same evidence the hook gathers, from the same place, so the CLI and a host
    // adapter can never disagree about the same repository.
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
  // The caller decides what an unavailable judge means. The CLI will not pretend.
  fail(`judge unavailable (${e?.message ?? e})`);
}

export {};

/** Re-exported so an embedding host can skip the process boundary. */
export { normalize, normalizeLastTurn };
