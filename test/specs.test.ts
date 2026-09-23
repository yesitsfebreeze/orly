import { expect, test } from "bun:test";
import { compose, DEFAULTS } from "../src/gate.ts";
import { advance, DEFAULT_MAX_ROUNDS, resolveKey, STALL_ROUNDS } from "../src/session.ts";
import { scoreSpecs, SPEC_PREFIX, specQuestions, unmet, validateSpecs, type Spec } from "../src/specs.ts";

const specs: Spec[] = [
  { id: "tests_green", instructions: "Do `command_results` show a test run reporting zero failures?" },
  { id: "readme_usage", instructions: "Do `actions_taken` show README.md being edited with a usage section?" },
  { id: "changelog", instructions: "Do `actions_taken` show a CHANGELOG entry being added?", optional: true },
];

// ---------------------------------------------------------------- validation

test("rejects specs that ask for a judgement of taste", () => {
  const problems = validateSpecs([
    { id: "clean", instructions: "Is the resulting implementation clean and idiomatic?" },
  ]);
  expect(problems).toHaveLength(1);
  expect(problems[0].problem).toContain("taste");
});

test("rejects unusable ids and specs too short to judge", () => {
  const problems = validateSpecs([
    { id: "a b", instructions: "Do `actions_taken` show the migration being applied?" },
    { id: "ok", instructions: "is it done" },
    { id: "dup", instructions: "Do `command_results` show the build succeeding?" },
    { id: "dup", instructions: "Do `command_results` show the linter passing?" },
  ]);
  const kinds = problems.map((p) => p.problem);
  expect(kinds.some((k) => k.includes("slug"))).toBe(true);
  expect(kinds.some((k) => k.includes("too short"))).toBe(true);
  expect(kinds.some((k) => k.includes("duplicate"))).toBe(true);
});

test("accepts an evidence-anchored spec", () => {
  expect(validateSpecs(specs)).toEqual([]);
});

// ---------------------------------------------------------------- scoring

test("specs become namespaced Nouls", () => {
  const q = specQuestions(specs);
  expect(Object.keys(q)).toEqual(specs.map((s) => SPEC_PREFIX + s.id));
  expect(q[`${SPEC_PREFIX}tests_green`].type).toBe("noul");
  // The id is for code; the question must carry its own meaning.
  expect(q[`${SPEC_PREFIX}tests_green`].instructions).toContain("zero failures");
});

test("a spec with no answer cannot fail the turn", () => {
  expect(scoreSpecs(specs, {}, 0.7)).toEqual([]);
});

test("an optional spec never blocks on its own", () => {
  const answers = {
    [`${SPEC_PREFIX}tests_green`]: { noul: 0.95 },
    [`${SPEC_PREFIX}readme_usage`]: { noul: 0.91 },
    [`${SPEC_PREFIX}changelog`]: { noul: 0.02 },
  };
  const results = scoreSpecs(specs, answers, 0.7);
  expect(results.filter((r) => r.met)).toHaveLength(2);
  expect(unmet(results)).toHaveLength(0);
});

test("an unmet spec blocks and the reason names it", () => {
  const answers = {
    unverified_claim: { noul: 0.1 },
    placeholder_left: { noul: 0.1 },
    unaddressed_part: { noul: 0.1 },
    silent_failure: { noul: 0.1 },
    coverage: { score: 2.9, confidence: 0.9 },
    [`${SPEC_PREFIX}tests_green`]: { noul: 0.95 },
    [`${SPEC_PREFIX}readme_usage`]: { noul: 0.08 },
    [`${SPEC_PREFIX}changelog`]: { noul: 0.9 },
  };
  const v = compose(answers, DEFAULTS, specs);
  expect(v.block).toBe(true);
  expect(v.reason).toContain('spec "readme_usage"');
  expect(v.reason).toContain("README.md being edited");
  expect(v.line).toContain("specs 2/3");
});

// ---------------------------------------------------------------- loop control

test("the loop runs while specs are still being met", () => {
  let state = null as any;
  for (const met of [1, 2, 3]) {
    const d = advance(state, "g", met);
    expect(d.mayBlock).toBe(true);
    state = d.next;
  }
  expect(state.stalled).toBe(0);
});

test("the loop gives up when no new spec is met", () => {
  let state = advance(null, "g", 2).next;
  let last;
  for (let i = 0; i <= STALL_ROUNDS; i++) {
    last = advance(state, "g", 2);
    state = last.next;
  }
  expect(last!.mayBlock).toBe(false);
  expect(last!.note).toContain("no spec newly met");
});

test("thrashing between two partial states counts as stalled, not as progress", () => {
  // Progress is measured against the best round so far, not the previous one.
  let state = advance(null, "g", 3).next;
  let last;
  for (const met of [1, 3, 1, 3]) {
    last = advance(state, "g", met);
    state = last.next;
  }
  expect(last!.mayBlock).toBe(false);
});

test("the round cap ends the loop even while progress continues", () => {
  let state = null as any;
  let last;
  for (let i = 0; i <= DEFAULT_MAX_ROUNDS; i++) {
    last = advance(state, "g", i); // improving every round
    state = last.next;
  }
  expect(last!.mayBlock).toBe(false);
  expect(last!.note).toContain("round cap");
});

test("a changed goal starts a fresh loop", () => {
  const stale = { goal: "old", rounds: 99, bestMet: 10, stalled: 9 };
  const d = advance(stale, "new goal", 0);
  expect(d.mayBlock).toBe(true);
  expect(d.next.rounds).toBe(1);
});

// ---------------------------------------------------------------- .orly discovery

import { mkdirSync, mkdtempSync, rmSync, writeFileSync as write, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as j } from "node:path";
import { findOrlyDir, loadSpecFile, projectRoot } from "../src/session.ts";

test("finds .orly from a nested working directory", () => {
  // Looking only in cwd would silently disable the gate in subpackages.
  const root = j(tmpdir(), `orly-find-${Date.now()}`);
  const deep = j(root, "pkg", "src", "nested");
  mkdirSync(j(root, ".orly"), { recursive: true });
  mkdirSync(deep, { recursive: true });
  write(j(root, ".orly", "specs.json"), JSON.stringify({ goal: "g", specs: [{ id: "a", instructions: "x" }] }));
  try {
    expect(findOrlyDir(deep)).toBe(j(root, ".orly"));
    expect(loadSpecFile(deep)?.goal).toBe("g");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns null rather than climbing past the filesystem root", () => {
  const lonely = j(tmpdir(), `orly-none-${Date.now()}`, "a", "b");
  mkdirSync(lonely, { recursive: true });
  try {
    expect(findOrlyDir(lonely)).toBeNull();
    expect(loadSpecFile(lonely)).toBeNull();
  } finally {
    rmSync(j(tmpdir(), lonely.split("/")[lonely.split("/").length - 3]), { recursive: true, force: true });
  }
});

test("a spec's own cut overrides the global threshold", () => {
  // A spec's score scale follows its wording, so one global cut does not fit all.
  const scaled: Spec[] = [{ id: "low_scale", instructions: "Does the turn satisfy this?", cut: 0.28 }];
  const answers = { [`${SPEC_PREFIX}low_scale`]: { noul: 0.55 } };
  expect(scoreSpecs(scaled, answers, 0.7)[0].met).toBe(true);
  expect(scoreSpecs([{ ...scaled[0], cut: undefined }], answers, 0.7)[0].met).toBe(false);
});

// ------------------------------------------------- deterministic checks

import { evaluate } from "../src/specs.ts";

test("a decidable fact is decided in code, not sent to the judge", () => {
  const checks: Spec[] = [
    { id: "typechecks", instructions: "n/a", require: { path: "checks.typecheck.errors", op: "equals", value: 0 } },
  ];
  expect(specQuestions(checks)).toEqual({});
  const evidence = { checks: { typecheck: { errors: 0 } } };
  expect(scoreSpecs(checks, {}, 0.7, evidence)[0].met).toBe(true);
  expect(scoreSpecs(checks, {}, 0.7, { checks: { typecheck: { errors: 3 } } })[0].met).toBe(false);
});

test("a failed check reports what it found, not a probability", () => {
  const checks: Spec[] = [
    { id: "typechecks", instructions: "n/a", require: { path: "checks.typecheck.errors", op: "lte", value: 0 } },
  ];
  const v = compose({}, DEFAULTS, checks, { checks: { typecheck: { errors: 4 } } });
  expect(v.block).toBe(true);
  expect(v.reason).toContain('check "typechecks" failed');
  expect(v.reason).toContain("found 4");
  expect(v.reason).not.toContain("p=");
});

test("missing evidence makes a check unmet, never met", () => {
  expect(evaluate({ path: "checks.nope.errors", op: "equals", value: 0 }, {}).met).toBe(false);
  expect(evaluate({ path: "a.b", op: "lte", value: 5 }, { a: {} }).met).toBe(false);
  expect(evaluate({ path: "a.b", op: "present" }, { a: { b: 1 } }).met).toBe(true);
  expect(evaluate({ path: "a.b", op: "absent" }, { a: {} }).met).toBe(true);
});

test("a malformed require is unmet and rejected, never a crash that fails open", () => {
  // A throw in the Stop hook reads as "judge unavailable" and lets every turn through.
  expect(evaluate("verdict includes threshold" as any, {}).met).toBe(false);
  const bad = validateSpecs([
    { id: "a", instructions: "all adapter modules are present", require: "a string" as any },
    { id: "b", instructions: "all adapter modules are present", require: { path: "x", op: "nope" } as any },
    { id: "c", instructions: "all adapter modules are present", require: { path: "x", op: "equals", value: 0 } },
  ]);
  expect(bad.map((p) => p.id)).toEqual(["a", "b"]);
});

test("evidence resolves from the project root, not the working directory", () => {
  // From a subdirectory, evidence files would silently read as missing.
  const root = j(tmpdir(), `orly-root-${Date.now()}`);
  mkdirSync(j(root, ".orly"), { recursive: true });
  mkdirSync(j(root, "pkg", "deep"), { recursive: true });
  try {
    expect(projectRoot(j(root, "pkg", "deep"))).toBe(root);
    expect(projectRoot(root)).toBe(root);
    expect(projectRoot(j(tmpdir(), `no-orly-${Date.now()}`))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check results never reach the model, only the require specs", async () => {
  // A passing check in state would answer "did tests run this turn?" for the transcript.
  let sentState: any;
  const fakeFetch = (async (_url: string, init: any) => {
    sentState = JSON.parse(init.body).state;
    return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 });
  }) as any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const { judge } = await import("../src/gate.ts");
    await judge(
      { user_request: "r", assistant_final_message: "f", assistant_said: "f", actions_taken: [], command_results: [], conclusive: true },
      { apiKey: "k", enrich: async () => ({ checks: { tests: { exit: 0 } }, files: { "a.ts": "x" } }) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(sentState.project.files).toBeDefined();
  expect(sentState.project.checks).toBeUndefined();
});

test("the key resolves for any host, not just the one with a hook", () => {
  const root = mkdtempSync(join(tmpdir(), "orly-key-"));
  const saved = process.env.TYPESAFE_API_KEY;
  try {
    mkdirSync(join(root, ".orly"));
    delete process.env.TYPESAFE_API_KEY;
    expect(resolveKey(root)).toBeUndefined();

    writeFileSync(join(root, ".orly", "config.json"), JSON.stringify({ keyCommand: "echo from-the-keychain" }));
    expect(resolveKey(root)).toBe("from-the-keychain");

    // The environment wins, so a config file cannot swap a host's identity.
    process.env.TYPESAFE_API_KEY = "from-the-env";
    expect(resolveKey(root)).toBe("from-the-env");
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spec may name the command it forbids, without that reading as taste", () => {
  // Taste words inside a code span (`clean`) are command text, not taste.
  expect(validateSpecs([
    { id: "no_destructive_git", instructions: "Do `command_results` show no `git clean -fd` and no `git reset --hard`?" },
  ])).toEqual([]);
  // Taste outside a code span still fails.
  expect(validateSpecs([{ id: "taste", instructions: "Is the code clean and well structured after `git commit`?" }]))
    .toHaveLength(1);
  // A spec that is only a code span is too short to judge.
  expect(validateSpecs([{ id: "thin", instructions: "`bun test`" }])).toHaveLength(1);
});

test("~/.orly is the user layer, never a project gate", () => {
  const home = mkdtempSync(join(tmpdir(), "orly-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".orly", "servers"), { recursive: true });
    mkdirSync(join(home, "code", "app"), { recursive: true });
    expect(findOrlyDir(join(home, "code", "app"))).toBeNull();
    mkdirSync(join(home, "code", ".orly"));
    expect(findOrlyDir(join(home, "code", "app"))).toBe(join(home, "code", ".orly"));
  } finally {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
