import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, evaluateRequire, unassessed } from "../src/evaluate.ts";
import { gate, judge } from "../src/gate.ts";
import { loadTree, parseSpec, validate, weakenings, type Spec } from "../src/specs.ts";
import { normalize, selectResults, turnFromJsonl } from "../src/turn.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `${name}.jsonl`), "utf8");
const sh = (cmd: string, cwd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString();
/** A throwaway git project with these files committed, so evaluation results can be reused between runs. */
const project = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "orly-"));
  made.push(d);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  sh("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init --allow-empty", d);
  return d;
};
const cli = async (cwd: string, args: string[], stdin = "") => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "orly.ts"), ...args], { cwd, stdin: new Response(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, TYPESAFE_API_KEY: "", ORLY_KEY_COMMAND: ":" } });
  return { out: (await new Response(p.stdout).text()) + (await new Response(p.stderr).text()), code: await p.exited };
};
/** A judge on localhost that answers every question with one probability and counts its requests. */
const fakeJudge = (p: number) => {
  const j = { calls: 0, endpoint: "", stop: () => server.stop(true) };
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    j.calls++;
    const { questions } = await req.json();
    return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: p }])), usage: { input_tokens: 1200, output_tokens: 40 } });
  } });
  j.endpoint = `http://localhost:${server.port}`;
  return j;
};
const CHECKS = { ok: { command: "true" }, bad: { command: "false" }, todos: { command: "echo TODO; echo TODO", countPattern: "TODO" } };

// ------------------------------------------------------------------ the turn

test("a lied fixture reduces to a conclusive turn with the failing result kept", () => {
  const t = turnFromJsonl(fixture("a_lied"))!;
  expect(t.user_request).toBe("add a retry to the http client and run the tests");
  expect(t.actions_taken).toEqual(["Edit: src/http.ts", "Bash: bun test"]);
  expect(t.command_results[0]).toContain("1 fail");
  expect(t.conclusive).toBe(true);
});

test("a turn is not conclusive until the agent speaks after its last action; echoed block reasons are not the request", () => {
  expect(normalize([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] }]).conclusive).toBe(false);
  const t = normalize([{ role: "user", content: "first" }, { role: "assistant", content: "a" }, { role: "user", content: "second" }, { role: "assistant", content: "b" },
    { role: "user", content: "orly (an independent check on this turn) is not satisfied" }, { role: "assistant", content: "c" }]);
  expect(t.user_request).toBe("second");
  expect(t.assistant_said).toBe("b\n\nc");
});

test("results keep early failures and the tail, bounded", () => {
  const kept = selectResults(["1 fail", ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)]);
  expect(kept).toHaveLength(12);
  expect(kept[0]).toBe("1 fail");
  expect(kept.at(-1)).toBe("ok 19");
});

// ------------------------------------------------------------------ the specs

test("a spec file is headers, a blank line, a question; a bad file is a broken spec", () => {
  expect(parseSpec("x", "cut: 0.6\nevidence: a.ts, b.ts\n\nIs the stub in `a.ts` gone?\n")).toMatchObject({ cut: 0.6, evidence: ["a.ts", "b.ts"], question: "Is the stub in `a.ts` gone?" });
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

test("weakenings: deleted spec, lowered cut, removed check; adding and tightening are free", () => {
  const before: Spec[] = [{ id: "a", question: "q", cut: 0.8 }, { id: "c", question: "q", require: { path: "checks.x.exit", op: "equals", value: 0 } }, { id: "d", question: "q" }];
  expect(weakenings(before, [{ id: "a", question: "q", cut: 0.5 }, { id: "c", question: "q" }])).toEqual(["`a`: its cut was lowered", "`c`: its check was removed", "`d`: the spec was deleted"]);
  expect(weakenings(before, [...before, { id: "e", question: "q" }])).toEqual([]);
});

test("evaluateRequire decides every op in code; a missing value is unknown, never satisfied", () => {
  const ev = { checks: { t: { exit: 0, matches: 3, out: "ok" } } };
  expect(evaluateRequire({ path: "checks.t.exit", op: "equals", value: 0 }, ev).status).toBe("satisfied");
  expect(evaluateRequire({ path: "checks.t.matches", op: "lte", value: 2 }, ev).status).toBe("violated");
  expect(evaluateRequire({ path: "checks.t.matches", op: "gte", value: 3 }, ev).status).toBe("satisfied");
  expect(evaluateRequire({ path: "checks.t.out", op: "contains", value: "ok" }, ev).status).toBe("satisfied");
  expect(evaluateRequire({ path: "checks.nope.exit", op: "equals", value: 0 }, ev)).toEqual({ status: "unknown", actual: undefined });
  expect(evaluateRequire({ path: "checks.nope", op: "absent" }, ev).status).toBe("satisfied");
});

// ------------------------------------------------------------------ evaluate

const SPECS = [
  parseSpec("ok", "require: checks.ok.exit equals 0\n\nOk.\n"),
  parseSpec("todos", "require: checks.todos.matches equals 0\n\nNo TODOs.\n"),
  parseSpec("gone", "require: checks.gone.exit equals 0\n\nNo such check.\n"),
  parseSpec("file", "cut: 0.5\nevidence: a.ts\n\nIs `a.ts` present under project.files?"),
  parseSpec("turn", "Does the turn run the tests after the last edit?"),
];

test("every requirement gets a status, its locations and one line of evidence; no key leaves file questions unknown", async () => {
  const d = project({ "a.ts": "export const a = 1;\n" });
  const { results } = await evaluate(SPECS, d, CHECKS, null, join(d, ".orly"));
  const by = Object.fromEntries(results.map((r) => [r.spec.id, r]));
  expect(by.ok).toMatchObject({ status: "satisfied", where: ["checks.ok"], evidence: "checks.ok.exit equals 0: found 0" });
  expect(by.todos).toMatchObject({ status: "violated", evidence: "checks.todos.matches equals 0: found 2" });
  expect(by.gone).toMatchObject({ status: "unknown", evidence: expect.stringContaining("no such check") });
  expect(by.file).toMatchObject({ status: "unknown", where: ["a.ts"], evidence: expect.stringContaining("no key") });
  expect(by.turn).toMatchObject({ status: "unknown", evidence: expect.stringContaining("about the turn") });
});

test("results are reused while their inputs are unchanged: no check re-runs, no judge request", async () => {
  const d = project({ "a.ts": "export const a = 1;\n", ".gitignore": "ran.log\n", ".orly/goal": "g" });
  const checks = { ...CHECKS, ok: { command: "echo ran >> ran.log" } };
  const j = fakeJudge(0.9);
  try {
    const t = { apiKey: "k", endpoint: j.endpoint };
    const first = await evaluate(SPECS, d, checks, t, join(d, ".orly"));
    expect(first.results.find((r) => r.spec.id === "file")).toMatchObject({ status: "satisfied", reused: false, evidence: "judge p=0.90, cut 0.5" });
    expect(first.usage).toEqual({ input_tokens: 1200, output_tokens: 40 });
    const second = await evaluate(SPECS, d, checks, t, join(d, ".orly"));
    expect(readFileSync(join(d, "ran.log"), "utf8")).toBe("ran\n");
    expect(j.calls).toBe(1);
    expect(second.results.filter((r) => r.reused).map((r) => r.spec.id).sort()).toEqual(["file", "ok", "todos"]);
    expect(second.usage).toBeUndefined();
    // A changed input is evaluated again, and the previous status is reported for the diff.
    writeFileSync(join(d, "a.ts"), "export const a = 2;\n");
    const third = await evaluate(SPECS, d, checks, t, join(d, ".orly"));
    expect(j.calls).toBe(2);
    expect(readFileSync(join(d, "ran.log"), "utf8")).toBe("ran\nran\n");
    expect(third.previous.file).toBe("satisfied");
  } finally { j.stop(); }
});

test("a broken spec file is a violated requirement", async () => {
  const { results } = await evaluate([parseSpec("bad", "zzz: 1\n\nQ?")], project({}), {}, null);
  expect(results[0]).toMatchObject({ status: "violated", evidence: 'malformed spec file: unknown header "zzz"' });
});

test("unassessed lists tracked files no requirement names, by path or parent directory", () => {
  const d = project({ "src/a.ts": "", "src/b.ts": "", "docs/x.txt": "", "orphan.txt": "", ".orly/goal": "g" });
  expect(unassessed(d, [parseSpec("f", "evidence: docs/x.txt\n\nIs it there at all?")], { lines: { command: "cat $(git ls-files 'src/*.ts')" } })).toEqual(["orphan.txt"]);
});

// ------------------------------------------------------------------ the gate

const turn = turnFromJsonl(fixture("b_honest"))!;
const transcript = fixture("f_real_complete");
const run = (d: string, session: string) => gate({ cwd: d, sessionId: session, flush: false, read: async () => turnFromJsonl(transcript) });

test("a violated requirement blocks before the turn is judged, naming what was found", async () => {
  const v = await judge(turn, SPECS, project({}), CHECKS, null);
  expect(v.block).toBe(true);
  expect(v.line).toContain("turn not judged");
  expect(v.reason).toContain('requirement "todos" is violated (checks.todos.matches equals 0: found 2)');
  expect(v.unmet).toEqual(["todos"]);
});

test("when the requirements hold, one request judges hazards and turn specs; the line carries the tokens", async () => {
  const d = project({ "a.ts": "export const a = 1;\n" });
  const specs = [SPECS[0], parseSpec("file", "cut: 0.1\nevidence: a.ts\n\nIs `a.ts` present under project.files?"), SPECS[4], parseSpec("hi", "cut: 0.9\n\nIs this turn spec above its own cut?")];
  const j = fakeJudge(0.2);
  try {
    const v = await judge(turn, specs, d, CHECKS, { apiKey: "k", endpoint: j.endpoint });
    expect(j.calls).toBe(2); // one request for the file questions, one for the turn
    expect(v.block).toBe(true);
    expect(v.unmet).toEqual(["turn", "hi"]);
    expect(v.line).toContain("requirements 2/2");
    expect(v.line).toContain("2400+80 tok");
    expect(v.line).toContain("unverified_claim 0.20");
    const high = await judge(turn, specs, d, CHECKS, { apiKey: "k", endpoint: fakeJudge(0.95).endpoint });
    expect(high.reason).toContain("you claimed something works"); // every hazard at 0.95 fires
  } finally { j.stop(); }
});

test("without a key and with no violation, judge throws 'no key'", async () => {
  expect(judge(turn, [SPECS[0]], project({}), CHECKS, null)).rejects.toThrow("no key");
});

test("the gate blocks with the reason, counts rounds per session, lets go at the cap, refuses a weakened tree", async () => {
  const d = project({ ".orly/goal": "rounds: 2\n\n- g: goal\n", ".orly/specs/g/q.spec": "cut: 0.9\n\nIs this ever met by a judge that says 0.3?" });
  const j = fakeJudge(0.3);
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
    writeFileSync(join(d, ".orly/specs/g/q.spec"), "cut: 0.1\n\nIs this ever met by a judge that says 0.3?");
    expect((await run(d, s)).reason).toContain("its cut was lowered");
    writeFileSync(join(d, ".orly/goal"), "- g: another goal\n"); // a new goal starts a new spec set
    expect((await run(d, s)).block).toBe(false);
  } finally { j.stop(); delete process.env.TYPESAFE_BASE_URL; delete process.env.TYPESAFE_API_KEY; }
});

test("no key: the gate says so once per session; no .orly, no gate; a judge that is down fails open", async () => {
  const d = project({ ".orly/specs/q.spec": "Is this judged with no key at all?" });
  const s = `n${Date.now()}`;
  expect(await run(d, s)).toMatchObject({ block: false, note: expect.stringContaining("no TypeSafe key") });
  expect(await run(d, s)).toEqual({ block: false });
  expect(await run(project({}), "x")).toEqual({ block: false });
  process.env.TYPESAFE_API_KEY = "k";
  process.env.TYPESAFE_BASE_URL = "http://localhost:1";
  try { expect((await run(d, "down")).note).toContain("judge unavailable"); }
  finally { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_BASE_URL; }
});

// ------------------------------------------------------------------ the CLI

test("orly eval prints status, where and evidence per requirement, the diff, the unassessed files; exit 2 when violated", async () => {
  const d = project({ ".orly/config.json": '{"checks":{"ok":{"command":"true"},"flag":{"command":"test -f flag"}}}', ".orly/specs/a.spec": "require: checks.ok.exit equals 0\n\nOk.\n",
    ".orly/specs/flag.spec": "require: checks.flag.exit equals 0\n\nThe flag file exists.\n", ".orly/specs/c.spec": "Does the turn run the tests after the last edit?\n", "orphan.txt": "x" });
  const first = await cli(d, ["eval"]);
  expect(first.code).toBe(2);
  expect(first.out).toMatch(/^satisfied\s+a\.spec\s+checks\.ok\s+checks\.ok\.exit equals 0: found 0$/m);
  expect(first.out).toMatch(/^violated\s+flag\.spec/m);
  expect(first.out).toMatch(/^unknown\s+c\.spec/m);
  expect(first.out).toContain("unassessed: 1 tracked file(s) no requirement names: orphan.txt");
  expect(first.out).toContain("3 requirements: 1 satisfied, 1 violated, 1 unknown · 0 tok, 0 reused");
  expect(first.out).toContain("next: flag");
  writeFileSync(join(d, "flag"), "");
  const second = await cli(d, ["eval"]);
  expect(second.code).toBe(0);
  expect(second.out).toContain("since last eval: improved flag");
  expect((await cli(d, ["eval"])).out).toContain("2 reused");
});

test("orly judge: exit 2 on a violated requirement with no key, exit 1 with nothing to decide in code", async () => {
  const d = project({ ".orly/config.json": '{"checks":{"never":{"command":"false"}}}', ".orly/specs/c.spec": "require: checks.never.exit equals 0\n\nThe check passes.\n" });
  const r = await cli(d, ["judge"], JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "done" }] }));
  expect(r.code).toBe(2);
  expect(JSON.parse(r.out).reason).toContain('requirement "c" is violated');
  expect((await cli(project({}), ["judge"], JSON.stringify({ turn }))).code).toBe(1);
  expect((await cli(project({}), ["judge"], "not json")).code).toBe(1);
});

test("orly specs: taste is rejected in code with exit 2; a clean tree without a key exits 1", async () => {
  const bad = await cli(project({ ".orly/specs/t.spec": "Is the code clean and readable after this turn?\n" }), ["specs"]);
  expect(bad.code).toBe(2);
  expect(bad.out).toContain('"clean" is a judgement of taste');
  const clean = await cli(project({ ".orly/specs/t.spec": "require: checks.x.exit equals 0\n\nDecided in code.\n", ".orly/specs/f.spec": "evidence: a.ts\n\nIs the stub in `a.ts` gone now?\n", ".orly/specs/j.spec": "Does `command_results` show a test run after the last edit?\n" }), ["specs"]);
  expect(clean.code).toBe(1);
  expect(clean.out).toContain("1 decided in code, 1 judged on files, 1 judged on the turn");
});

test("orly hook: SessionStart briefs, Stop with a violated requirement blocks with a systemMessage", async () => {
  const d = project({ ".orly/goal": "- g: the goal\n", ".orly/config.json": '{"checks":{"never":{"command":"false"}}}', ".orly/specs/g/c.spec": "require: checks.never.exit equals 0\n\nThe check passes.\n", "t.jsonl": transcript });
  const start = await cli(d, ["hook"], JSON.stringify({ hook_event_name: "SessionStart", cwd: d }));
  expect(JSON.parse(start.out).hookSpecificOutput.additionalContext).toContain("g/c.spec: check checks.never.exit equals 0");
  const stop = await cli(d, ["hook"], JSON.stringify({ hook_event_name: "Stop", cwd: d, session_id: "h1", transcript_path: join(d, "t.jsonl") }));
  const out = JSON.parse(stop.out);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain('requirement "c" is violated');
  expect(out.systemMessage).toContain("turn not judged");
  expect((await cli(d, ["hook"], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "h1" }))).code).toBe(0);
});
