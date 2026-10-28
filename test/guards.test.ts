/** The core: guards per session, decided by a check or by the judge, the stop refused until all hold. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGuard, advance, blockReason, DEFAULT_MAX_ROUNDS, dropGuard, endSession, gateTurn, guardId, loadSession, NO_KEY_MESSAGE, openGuards, promptBrief, readFiles, runCheck, saveSession, type Turn } from "../orly.ts";

const turn: Turn = { user_request: "add retries", assistant_final_message: "added", assistant_said: "added", actions_taken: ["#1 Edit: a.ts"], command_results: ["#1 → ok"], conclusive: true };
const sid = () => `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const dir = mkdtempSync(join(tmpdir(), "orly-guards-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A judge that answers every question with one fixed probability, or per id.
let judgeAnswer: number | Record<string, number> = 0.9;
let judgeCalls = 0;
const server = Bun.serve({ port: 0, fetch: async (req) => {
  judgeCalls++;
  const { questions } = await req.json();
  const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: typeof judgeAnswer === "number" ? judgeAnswer : judgeAnswer[id] ?? 0 }]));
  return Response.json({ answers });
} });
process.env.TYPESAFE_BASE_URL = `http://localhost:${server.port}`;
afterAll(() => server.stop());
const gate = (sessionId: string, extra: Partial<Parameters<typeof gateTurn>[0]> = {}) => gateTurn({ cwd: dir, sessionId, read: async () => turn, apiKey: "k", ...extra });

test("ids come from the question's telling words and stay unique", () => {
  expect(guardId("Do the tests pass after the last edit?")).toBe("tests-pass-last");
  expect(guardId("Do the tests pass after the last edit?", ["tests-pass-last"])).toBe("tests-pass-last-2");
  expect(guardId("x", [], "My Id!")).toBe("my-id");
});

test("guards are added, listed, dropped and persisted per session", () => {
  const s = loadSession(sid());
  const g = addGuard(s, "Does README.md list every plugin in one tier?", { files: ["README.md"] });
  addGuard(s, "Do the tests pass?", { check: "true" });
  expect(() => addGuard(s, "short?")).toThrow("15 characters");
  expect(() => addGuard(s, "Is the code clean and readable now?")).toThrow("taste words");
  addGuard(s, "Is the `clean` script wired in package.json?"); // a taste word inside a code span is command text
  saveSession(s);
  const again = loadSession(s.id);
  expect(again.guards.map((x) => x.id)).toEqual([g.id, "tests-pass", "clean-script-wired"]);
  expect(dropGuard(again, "tests-pass")).toBe(true);
  expect(dropGuard(again, "nope")).toBe(false);
  endSession(s.id);
  expect(loadSession(s.id).guards).toEqual([]);
});

test("no guards: the stop passes and the judge is never asked", async () => {
  const before = judgeCalls;
  const o = await gate(sid());
  expect(o.block).toBe(false);
  expect(judgeCalls).toBe(before);
});

test("a check guard is decided by its exit code, with the output tail in the reason", async () => {
  const s = loadSession(sid());
  addGuard(s, "Does the build pass?", { check: "echo boom >&2; exit 3" });
  saveSession(s);
  const o = await gate(s.id);
  expect(o.block).toBe(true);
  expect(o.reason).toContain("build-pass (check `echo boom >&2; exit 3` exited 3)");
  expect(o.reason).toContain("boom");
  s.guards[0].check = "exit 0";
  saveSession(s);
  expect((await gate(s.id)).block).toBe(false);
});

test("a judged guard is upheld at the cut, retired once met, and the block names the open ones", async () => {
  const s = loadSession(sid());
  addGuard(s, "Does the final message name the changed file?");
  addGuard(s, "Does README.md mention retries?", { files: [join(dir, "README.md")] });
  saveSession(s);
  writeFileSync(join(dir, "README.md"), "retries: yes");
  judgeAnswer = { "final-message-name": 0.95, "readme-mention-retries": 0.2 };
  const first = await gate(s.id);
  expect(first.block).toBe(true);
  expect(first.reason).toContain("- readme-mention-retries (p=0.20)");
  expect(first.reason).toContain("Upheld: final-message-name.");
  expect(openGuards(loadSession(s.id)).map((g) => g.id)).toEqual(["readme-mention-retries"]);
  judgeAnswer = 0.9;
  const before = judgeCalls;
  const second = await gate(s.id);
  expect(second.block).toBe(false);
  expect(judgeCalls).toBe(before + 1);
  expect(openGuards(loadSession(s.id))).toEqual([]);
  // every guard upheld: nothing left to judge
  expect(judgeCalls).toBe((await gate(s.id), before + 1));
});

test("the stop answering a block is not judged again", async () => {
  const s = loadSession(sid());
  addGuard(s, "Does the build pass?", { check: "exit 1" });
  saveSession(s);
  expect((await gate(s.id)).block).toBe(true);
  const o = await gate(s.id, { answeringBlock: true });
  expect(o.block).toBe(false);
  expect(o.note).toContain("not judged again");
});

test("the round cap and the stall rule hand a stuck session back", () => {
  const s = loadSession(sid());
  for (let i = 0; i < DEFAULT_MAX_ROUNDS; i++) expect(advance(s, i)).toBeUndefined();
  expect(advance(s, DEFAULT_MAX_ROUNDS)).toContain("round cap");
  const t = loadSession(sid());
  expect(advance(t, 1)).toBeUndefined();
  expect(advance(t, 1)).toBeUndefined();
  expect(advance(t, 1)).toBeUndefined();
  expect(advance(t, 1)).toContain("no guard newly upheld");
});

test("without a key only checks run, and the message is given once", async () => {
  const s = loadSession(sid());
  addGuard(s, "Does the final message name the changed file?");
  saveSession(s);
  const was = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const first = await gate(s.id, { apiKey: undefined });
    expect(first.block).toBe(false);
    expect(first.message).toBe(NO_KEY_MESSAGE);
    expect((await gate(s.id, { apiKey: undefined })).message).toBeUndefined();
  } finally {
    if (was) process.env.TYPESAFE_API_KEY = was;
  }
});

test("a judge that cannot be reached lets the turn end with a note", async () => {
  const s = loadSession(sid());
  addGuard(s, "Does the final message name the changed file?");
  saveSession(s);
  const url = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = "http://localhost:1";
  try {
    const o = await gate(s.id);
    expect(o.block).toBe(false);
    expect(o.note).toContain("judge unavailable");
  } finally {
    process.env.TYPESAFE_BASE_URL = url;
  }
});

test("checks are killed past their timeout and files are read with a missing marker", () => {
  const r = runCheck("sleep 5", dir, 100);
  expect(r.exit).toBeNull();
  expect(r.out).toContain("killed");
  const files = readFiles(["nope.txt"], dir);
  expect(files["nope.txt"]).toBe("[no such file]");
});

test("the prompt brief carries the session id and the add command", () => {
  const s = loadSession("abc");
  expect(promptBrief(s, "orly")).toContain("orly guard --session abc");
  addGuard(s, "Does the build pass?", { check: "true" });
  expect(promptBrief(s, "orly")).toContain("- build-pass [check]: Does the build pass? (`true`)");
  expect(blockReason([{ guard: s.guards[0], met: false, check: { exit: 1, out: "" } }], s)).toContain("guard not upheld this turn (1 of 1)");
});
