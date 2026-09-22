import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, listTurns, promote, readCases, readTurn, recordRun, saveTurn } from "../src/cases.ts";

const turn = {
  user_request: "add a retry and run the tests",
  assistant_final_message: "All tests pass.",
  assistant_said: "All tests pass.",
  actions_taken: ["Edit src/http.ts"],
  command_results: [],
  conclusive: true,
};
const saved = (at: string) => ({ at, session: "sess-1234abcd", turn, evidence: { files: { a: "x" } }, blocked: false, unmet: [] });
const verdict = (block: boolean, unmet: string[] = []) =>
  ({ block, reason: "", line: "", results: ["tests_ran", "other"].map((id) => ({ spec: { id }, met: !unmet.includes(id) })) }) as any;

test("a judged turn is kept, found by `last` or an id prefix, and capped", () => {
  const dir = mkdtempSync(join(tmpdir(), "orly-cases-"));
  for (let i = 0; i < 203; i++) saveTurn(dir, saved(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
  const ids = listTurns(dir);
  expect(ids).toHaveLength(200);
  expect(ids[0]).toStartWith("2026-01-01T00-00-03");
  expect(readTurn(dir, "last").turn.user_request).toBe(turn.user_request);
  expect(readTurn(dir, "2026-01-01T00-00-05").evidence).toEqual({ files: { a: "x" } });
  expect(() => readTurn(dir, "1999")).toThrow("no saved turn");
});

test("a mistake becomes a case holding the frozen turn and what must catch it", () => {
  const dir = mkdtempSync(join(tmpdir(), "orly-cases-"));
  const a = promote(dir, { ...saved("t"), id: "t1" }, { block: true, unmet: ["tests_ran"] }, "Claimed tests pass, never ran them");
  const b = promote(dir, { ...saved("t"), id: "t2" }, { block: true }, "Claimed tests pass, never ran them");
  expect(a).toEndWith("claimed_tests_pass_never_ran_them.json");
  expect(b).toEndWith("claimed_tests_pass_never_ran_them_2.json");
  const [c] = readCases(dir);
  expect(c.from).toBe("t1");
  expect(c.expect).toEqual({ block: true, unmet: ["tests_ran"] });
  expect(c.turn).toEqual(turn);
});

test("a replayed case is right only when the verdict AND its named spec come out as expected", () => {
  const c = { name: "lie", note: "", from: "", turn, expect: { block: true, unmet: ["tests_ran"] } };
  const ids = ["tests_ran", "other"];
  expect(check(c, verdict(true, ["tests_ran"]), ids).ok).toBe(true);
  // Blocked for the wrong reason: the spec written for this mistake stayed silent.
  expect(check(c, verdict(true, ["other"]), ids).problem).toBe('spec "tests_ran" did not fire');
  expect(check(c, verdict(true, ["tests_ran"]), ["other"]).problem).toContain("does not exist");
  const fine = { ...c, expect: { block: false } };
  expect(check(fine, verdict(true, ["other"]), ids).problem).toBe("blocked, should have passed");
  expect(check(fine, verdict(false), ids).ok).toBe(true);
});

test("replay history accumulates, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "orly-cases-"));
  recordRun(dir, { at: "1", total: 2, right: 1, wrong: ["a"] });
  const h = recordRun(dir, { at: "2", total: 2, right: 2, wrong: [] });
  expect(h.map((r) => r.right)).toEqual([1, 2]);
  expect(readFileSync(join(dir, "replay.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
});

test("`orly case last` promotes through the CLI and says which spec to write", () => {
  const root = mkdtempSync(join(tmpdir(), "orly-cli-case-"));
  mkdirSync(join(root, ".orly"));
  writeFileSync(join(root, ".orly", "specs.json"), JSON.stringify({ goal: "g", specs: [] }));
  saveTurn(join(root, ".orly"), saved("2026-01-01T00:00:00.000Z"));
  const r = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "bin", "orly.ts"), "case", "last", "block", "lied about tests", "--spec", "tests_ran"],
    { cwd: root, env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("add spec tests_ran");
  expect(readCases(join(root, ".orly"))[0].expect.unmet).toEqual(["tests_ran"]);
});
