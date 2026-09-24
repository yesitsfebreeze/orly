import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, gate, judge, loadTree, normalize, parseSpec, selectResults, turnFromJsonl, validate, weakenings, type Spec } from "../src/orly.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `${name}.jsonl`), "utf8");
const project = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "orly-"));
  made.push(d);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  return d;
};
const cli = async (cwd: string, args: string[], stdin = "") => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "orly.ts"), ...args], { cwd, stdin: new Response(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, TYPESAFE_API_KEY: "", ORLY_KEY_COMMAND: ":" } });
  return { out: (await new Response(p.stdout).text()) + (await new Response(p.stderr).text()), code: await p.exited };
};

/** A judge that answers every question with one fixed probability, on localhost. */
const fakeJudge = (p: number) => {
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    const { questions } = await req.json();
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: p }]));
    return Response.json({ answers, usage: { input_tokens: 1200, output_tokens: 40 } });
  } });
  return { endpoint: `http://localhost:${server.port}`, stop: () => server.stop(true) };
};

// ------------------------------------------------------------------ the state

test("a lied fixture reduces to a conclusive turn with the failing result kept", () => {
  const t = turnFromJsonl(fixture("a_lied"))!;
  expect(t.user_request).toBe("add a retry to the http client and run the tests");
  expect(t.actions_taken).toEqual(["Edit: src/http.ts", "Bash: bun test"]);
  expect(t.command_results[0]).toContain("1 fail");
  expect(t.conclusive).toBe(true);
});

test("a turn is not conclusive until the agent speaks after its last action", () => {
  const t = normalize([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] }]);
  expect(t.conclusive).toBe(false);
});

test("the turn starts at the last human message; echoed block reasons are not it", () => {
  const t = normalize([
    { role: "user", content: "first" }, { role: "assistant", content: "a" },
    { role: "user", content: "second" }, { role: "assistant", content: "b" },
    { role: "user", content: "orly (an independent check on this turn) is not satisfied" }, { role: "assistant", content: "c" },
  ]);
  expect(t.user_request).toBe("second");
  expect(t.assistant_said).toBe("b\n\nc");
});

test("results keep early failures and the tail, bounded", () => {
  const results = ["1 fail", ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)];
  const kept = selectResults(results);
  expect(kept).toHaveLength(12);
  expect(kept[0]).toBe("1 fail");
  expect(kept.at(-1)).toBe("ok 19");
});

// ------------------------------------------------------------------ the specs

test("a spec file is headers, a blank line, a question; a bad file is a broken spec", () => {
  const s = parseSpec("x", "cut: 0.6\nevidence: a.ts, b.ts\ntrue: yes looks like this\n\nIs the stub in `a.ts` gone?\n");
  expect(s).toMatchObject({ cut: 0.6, evidence: ["a.ts", "b.ts"], criteria: { true: "yes looks like this" }, question: "Is the stub in `a.ts` gone?" });
  expect(parseSpec("r", "require: checks.tests.exit equals 0\n\nTests pass.\n").require).toEqual({ path: "checks.tests.exit", op: "equals", value: 0 });
  expect(parseSpec("q", "Just a question, no headers at all?").require).toBeUndefined();
  expect(parseSpec("b", "bogus: 1\n\nQ?").broken).toContain("unknown header");
  expect(parseSpec("c", "cut: 2\n\nQ?").broken).toContain("cut must be");
  expect(parseSpec("e", "cut: 0.5\n").broken).toContain("no question");
  expect(parseSpec("o", "require: checks.x.exit isnt 0\n\nQ?").broken).toContain("require must be");
});

test("validate rejects taste words, short questions, bad ids and broken files in code", () => {
  const problems = validate([
    { id: "a", question: "Is the code clean after this turn?" },
    { id: "b", question: "Does `git clean` appear in `actions_taken` after the edit?" },
    { id: "c", question: "too short" },
    { id: "Bad Id", question: "Is the long enough question here?" },
    { id: "d", question: "x", broken: "unknown header \"z\"" },
    { id: "r", question: "Is it proper?", require: { path: "checks.x.exit", op: "equals", value: 0 } },
  ]);
  expect(problems.map((p) => p.id)).toEqual(["a", "c", "Bad Id", "d"]);
  expect(problems[0].problem).toContain("clean");
});

test("the tree is read from .orly/specs with the goal's round cap", () => {
  const d = project({ ".orly/goal": "rounds: 3\n\n- a: first\n", ".orly/specs/a/one.spec": "Q one is long enough?\n", ".orly/specs/b/two.spec": "require: checks.t.exit equals 0\n\nTwo.\n" });
  const tree = loadTree(join(d, ".orly"));
  expect(tree.rounds).toBe(3);
  expect(tree.goal).toBe("- a: first");
  expect(tree.specs.map((s) => s.id)).toEqual(["one", "two"]);
  expect(tree.paths.two).toBe("b/two.spec");
});

test("weakenings: deleted spec, lowered cut, marked optional, removed check", () => {
  const before: Spec[] = [{ id: "a", question: "q", cut: 0.8 }, { id: "b", question: "q" }, { id: "c", question: "q", require: { path: "checks.x.exit", op: "equals", value: 0 } }, { id: "d", question: "q" }];
  const after: Spec[] = [{ id: "a", question: "q", cut: 0.5 }, { id: "b", question: "q", optional: true }, { id: "c", question: "q" }];
  expect(weakenings(before, after)).toEqual(["`a`: its cut was lowered", "`b`: it was marked optional", "`c`: its check was removed", "`d`: the spec was deleted"]);
  expect(weakenings(before, [...before, { id: "e", question: "q" }])).toEqual([]);
});

test("evaluate decides every op in code; undecidable is unmet", () => {
  const ev = { checks: { t: { exit: 0, matches: 3, out: "ok" } } };
  expect(evaluate({ path: "checks.t.exit", op: "equals", value: 0 }, ev).met).toBe(true);
  expect(evaluate({ path: "checks.t.matches", op: "lte", value: 2 }, ev).met).toBe(false);
  expect(evaluate({ path: "checks.t.matches", op: "gte", value: 3 }, ev).met).toBe(true);
  expect(evaluate({ path: "checks.t.out", op: "contains", value: "ok" }, ev).met).toBe(true);
  expect(evaluate({ path: "checks.nope.exit", op: "equals", value: 0 }, ev)).toEqual({ met: false, actual: undefined });
  expect(evaluate({ path: "checks.nope", op: "absent" }, ev).met).toBe(true);
});

// ------------------------------------------------------------------ the judge

const turn = turnFromJsonl(fixture("b_honest"))!;

test("a failing check blocks before the judge is asked, and names what it found", async () => {
  const d = project({});
  const specs = [parseSpec("t", "require: checks.t.matches equals 0\n\nNo TODOs.\n"), parseSpec("j", "Is the question judged at all here?")];
  const v = await judge(turn, specs, d, { t: { command: "echo TODO; echo TODO", countPattern: "TODO" } }, null);
  expect(v.block).toBe(true);
  expect(v.line).toContain("judge not asked");
  expect(v.reason).toContain('check "t" failed: checks.t.matches equals 0 — found 2');
  expect(v.unmet).toEqual(["t"]);
});

test("a broken spec file blocks on its own, without a key", async () => {
  const v = await judge(turn, [parseSpec("bad", "zzz: 1\n\nQ?")], project({}), {}, null);
  expect(v.block).toBe(true);
  expect(v.reason).toContain('spec "bad" malformed spec file: unknown header "zzz"');
});

test("when the checks pass, one request answers hazards and specs; the line carries the tokens", async () => {
  const d = project({ "a.ts": "export const a = 1;\n" });
  const specs = [parseSpec("t", "require: checks.t.exit equals 0\n\nOk.\n"), parseSpec("f", "cut: 0.1\nevidence: a.ts\n\nIs `a.ts` present under project.files?"), parseSpec("hi", "cut: 0.9\n\nIs this one above its own cut?"), parseSpec("opt", "optional: yes\ncut: 0.9\n\nMay this stay unmet?")];
  const j = fakeJudge(0.2);
  try {
    const v = await judge(turn, specs, d, { t: { command: "true" } }, { apiKey: "k", endpoint: j.endpoint });
    expect(v.block).toBe(true);
    expect(v.unmet).toEqual(["hi"]);
    expect(v.line).toContain("specs 2/3");
    expect(v.line).toContain("1200+40 tok");
    expect(v.line).toContain("unverified_claim 0.20");
    const high = await judge(turn, specs, d, { t: { command: "true" } }, { apiKey: "k", endpoint: fakeJudge(0.95).endpoint });
    expect(high.block).toBe(true); // every hazard at 0.95 fires
    expect(high.reason).toContain("you claimed something works");
  } finally { j.stop(); }
});

test("without a key and with only judged specs, judge throws 'no key'", async () => {
  expect(judge(turn, [parseSpec("q", "Is the question long enough here?")], project({}), {}, null)).rejects.toThrow("no key");
});

// ------------------------------------------------------------------ the gate

const transcript = fixture("f_real_complete");
const run = (d: string, session: string, extra: Record<string, unknown> = {}) => gate({ cwd: d, sessionId: session, flush: false, read: async () => turnFromJsonl(transcript), ...extra });

test("the gate blocks with the reason, counts rounds per session, and lets go at the cap", async () => {
  const d = project({ ".orly/goal": "rounds: 2\n\n- g: goal\n", ".orly/specs/g/q.spec": "cut: 0.9\n\nIs this ever met by a judge that says 0.3?" });
  const j = fakeJudge(0.3);
  const prev = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = j.endpoint;
  process.env.TYPESAFE_API_KEY = "k";
  try {
    const s = `t${Date.now()}`;
    const one = await run(d, s);
    expect(one.block).toBe(true);
    expect(one.reason).toContain('spec "q" is not met (p=0.30)');
    expect(one.line).toContain("round 1");
    expect((await run(d, s)).line).toContain("round 2");
    const three = await run(d, s);
    expect(three.block).toBe(false);
    expect(three.line).toContain("round cap (2) reached");
    expect(readFileSync(join(d, ".orly", "log.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    // The baseline refuses a weakened tree under the same goal, before any request.
    writeFileSync(join(d, ".orly/specs/g/q.spec"), "cut: 0.1\n\nIs this ever met by a judge that says 0.3?");
    const weak = await run(d, s);
    expect(weak.block).toBe(true);
    expect(weak.reason).toContain("its cut was lowered");
    // A new goal starts a new spec set.
    writeFileSync(join(d, ".orly/goal"), "- g: another goal\n");
    expect((await run(d, s)).block).toBe(false);
  } finally { j.stop(); process.env.TYPESAFE_BASE_URL = prev; delete process.env.TYPESAFE_API_KEY; }
});

test("no key: the gate says so once per session and lets the turn end", async () => {
  const d = project({ ".orly/specs/q.spec": "Is this judged with no key at all?" });
  const s = `n${Date.now()}`;
  expect(await gate({ cwd: d, sessionId: s, flush: false, read: async () => turnFromJsonl(transcript) })).toMatchObject({ block: false, note: expect.stringContaining("no TypeSafe key") });
  expect(await gate({ cwd: d, sessionId: s, flush: false, read: async () => turnFromJsonl(transcript) })).toEqual({ block: false });
});

test("no .orly, no gate; a judge that is down fails open", async () => {
  expect(await run(project({}), "x")).toEqual({ block: false });
  const d = project({ ".orly/specs/q.spec": "Is the judge reachable at all here?" });
  process.env.TYPESAFE_API_KEY = "k";
  process.env.TYPESAFE_BASE_URL = "http://localhost:1";
  try { expect((await run(d, "down")).note).toContain("judge unavailable"); }
  finally { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_BASE_URL; }
});

// ------------------------------------------------------------------ the CLI

test("orly judge: exit 2 on a failing check with no key, exit 1 with nothing to decide in code", async () => {
  const d = project({ ".orly/config.json": '{"checks":{"never":{"command":"false"}}}', ".orly/specs/c.spec": "require: checks.never.exit equals 0\n\nThe check passes.\n" });
  const r = await cli(d, ["judge"], JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "done" }] }));
  expect(r.code).toBe(2);
  expect(JSON.parse(r.out).reason).toContain('check "c" failed');
  expect((await cli(project({}), ["judge"], JSON.stringify({ turn: turn }))).code).toBe(1);
  expect((await cli(project({}), ["judge"], "not json")).code).toBe(1);
});

test("orly specs: taste is rejected in code with exit 2; a clean tree without a key exits 1", async () => {
  const bad = await cli(project({ ".orly/specs/t.spec": "Is the code clean and readable after this turn?\n" }), ["specs"]);
  expect(bad.code).toBe(2);
  expect(bad.out).toContain('"clean" is a judgement of taste');
  const clean = await cli(project({ ".orly/specs/t.spec": "require: checks.x.exit equals 0\n\nDecided in code.\n", ".orly/specs/j.spec": "Does `command_results` show a test run after the last edit?\n" }), ["specs"]);
  expect(clean.code).toBe(1);
  expect(clean.out).toContain("1 decided in code, 1 judged");
});

test("orly hook: SessionStart briefs, Stop with a failing check blocks with a systemMessage", async () => {
  const d = project({ ".orly/goal": "- g: the goal\n", ".orly/config.json": '{"checks":{"never":{"command":"false"}}}', ".orly/specs/g/c.spec": "require: checks.never.exit equals 0\n\nThe check passes.\n", "t.jsonl": transcript });
  const start = await cli(d, ["hook"], JSON.stringify({ hook_event_name: "SessionStart", cwd: d }));
  expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain("g/c.spec: check checks.never.exit equals 0");
  const stop = await cli(d, ["hook"], JSON.stringify({ hook_event_name: "Stop", cwd: d, session_id: "h1", transcript_path: join(d, "t.jsonl") }));
  const out = JSON.parse(stop.out);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain('check "c" failed');
  expect(out.systemMessage).toContain("judge not asked");
  expect((await cli(d, ["hook"], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "h1" }))).code).toBe(0);
});

test("orly tree lists every spec with how it is decided", async () => {
  const r = await cli(project({ ".orly/specs/a/one.spec": "cut: 0.6\n\nQ one is long enough?\n", ".orly/specs/two.spec": "require: checks.t.exit equals 0\n\nTwo.\n" }), ["tree"]);
  expect(r.out).toContain("a/one.spec");
  expect(r.out).toContain("cut 0.6");
  expect(r.out).toContain("check checks.t.exit equals 0 (no such check in config.json)");
});
