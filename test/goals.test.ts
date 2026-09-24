import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../orly.ts";
import { checkBaseline } from "../orly.ts";
import { byRank, loadTree, parseGoals, validateSpecs } from "../orly.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const orly = process.execPath;
const cli = join(import.meta.dir, "..", "orly.ts");

const tree = () => {
  const d = mkdtempSync(join(tmpdir(), "orly-goals-"));
  made.push(d);
  mkdirSync(join(d, ".orly", "specs", "a"), { recursive: true });
  mkdirSync(join(d, ".orly", "specs", "b"), { recursive: true });
  mkdirSync(join(d, ".orly", "specs", "misc"), { recursive: true });
  writeFileSync(join(d, ".orly", "goal"), "rounds: 6\n\n- b: second folder first\n- a: first folder second\n");
  writeFileSync(join(d, ".orly", "specs", "a", "a1.spec"), "require: x equals 1\n\nA one.\n");
  writeFileSync(join(d, ".orly", "specs", "b", "b1.spec"), "require: x equals 1\n\nB one.\n");
  writeFileSync(join(d, ".orly", "specs", "misc", "m1.spec"), "require: x equals 1\n\nM one.\n");
  return d;
};

test("the goal body is a list: `- group: text` per line, a bare paragraph is one goal", () => {
  expect(parseGoals("- readme: say it once\n- goals: a list\n- no group here")).toEqual([
    { group: "readme", text: "say it once" },
    { group: "goals", text: "a list" },
    { text: "no group here" },
  ]);
  expect(parseGoals("one paragraph goal")).toEqual([{ text: "one paragraph goal" }]);
  expect(parseGoals("")).toEqual([]);
});

test("specs are ranked by their folder's goal position; the block, the tree and unmet lists follow it", () => {
  const t = loadTree(join(tree(), ".orly"))!;
  const rank = Object.fromEntries(t.specs.map((s) => [s.id, s.rank]));
  expect(rank).toEqual({ a1: 1, b1: 0, m1: undefined });
  // Goal order (most important first) is how the block and `orly tasks` list them.
  expect([...t.specs].sort(byRank).map((s) => s.id)).toEqual(["b1", "a1", "m1"]);
  const v = compose({}, undefined, t.specs, { x: 0 });
  const order = v.reason.split("\n").filter((l) => l.startsWith("- check")).map((l) => l.match(/"(\w+)"/)![1]);
  expect(order).toEqual(["b1", "a1", "m1"]);
});

test("`orly goal` appends and never overwrites, turning a paragraph goal into the first item", () => {
  const d = mkdtempSync(join(tmpdir(), "orly-goal-cli-"));
  made.push(d);
  mkdirSync(join(d, ".orly"));
  writeFileSync(join(d, ".orly", "goal"), "rounds: 3\n\nthe old paragraph goal\n");
  const run = (...args: string[]) => Bun.spawnSync([orly, cli, "goal", ...args], { cwd: d, stdout: "pipe", stderr: "pipe" });
  expect(run("api", "add retries").exitCode).toBe(0);
  expect(run("and a third").exitCode).toBe(0);
  expect(readFileSync(join(d, ".orly", "goal"), "utf8")).toBe(
    "rounds: 3\n\n- the old paragraph goal\n- api: add retries\n- and a third\n",
  );
  expect(run("Bad Group", "x").exitCode).toBe(1);
});

test("appending a goal keeps the guard baseline; dropping one starts a new one", () => {
  const specs = [{ id: "s", instructions: "q", cut: 0.8 }];
  const base = { goal: "- a: one", specs };
  const weakened = { goal: "- a: one\n- b: two", specs: [{ id: "s", instructions: "q", cut: 0.5 }] };
  expect(checkBaseline(base, weakened).violations.map((v) => v.id)).toEqual(["s"]);
  expect(checkBaseline(base, { ...weakened, goal: "- b: two" }).violations).toEqual([]);
});

test("`orly specs` names every rejected spec and exits 1; a clean tree exits 0", () => {
  const d = tree();
  const run = () => Bun.spawnSync([orly, cli, "specs"], { cwd: d, stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(d, ".orly", "specs", "a", "a1.spec"), "Is the output clean and readable?\n");
  writeFileSync(join(d, ".orly", "specs", "b", "b1.spec"), "cut: 2\n\nDoes `command_results` show the tests passing?\n");
  const bad = run();
  expect(bad.exitCode).toBe(1);
  const out = bad.stdout.toString();
  expect(out).toContain("a/a1.spec");
  expect(out).toContain("b/b1.spec");
  expect(out).toContain("misc/m1.spec"); // body too short to judge
  for (const [f, q] of [["a/a1", "Does `command_results` show `bun test` reporting zero failures?"], ["b/b1", "Does `actions_taken` show README.md being edited?"], ["misc/m1", "require: x equals 1\n\nIs x equal to one in the evidence?"]])
    writeFileSync(join(d, ".orly", "specs", `${f}.spec`), `${q}\n`);
  const good = run();
  expect(good.stdout.toString()).toContain("3 specs");
  expect(good.exitCode).toBe(0);
});

test("`orly specs` rejects a require naming a check that .orly/config.json does not define", () => {
  const d = tree();
  const q = "\n\nDoes the named check exit with status zero?\n";
  writeFileSync(join(d, ".orly", "specs", "a", "a1.spec"), `require: checks.tests.exit equals 0${q}`);
  writeFileSync(join(d, ".orly", "specs", "b", "b1.spec"), `require: checks.tset.exit equals 0${q}`);
  writeFileSync(join(d, ".orly", "specs", "misc", "m1.spec"), `require: x equals 1${q}`);
  writeFileSync(join(d, ".orly", "config.json"), JSON.stringify({ checks: { tests: { command: "true" } } }));
  const r = Bun.spawnSync([orly, cli, "specs"], { cwd: d, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  expect(out).toContain('b/b1.spec: no check "tset" in .orly/config.json');
  expect(out).not.toContain("a/a1.spec");
  expect(r.exitCode).toBe(1);
});

test("a symlink cycle in the spec tree is not followed", () => {
  const d = tree();
  symlinkSync("..", join(d, ".orly", "specs", "a", "loop"));
  expect(loadTree(join(d, ".orly"))!.specs.map((s) => s.id).sort()).toEqual(["a1", "b1", "m1"]);
});

test("`orly goal` refuses to append to a goal file it cannot parse, leaving it untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "orly-goal-bad-"));
  made.push(d);
  mkdirSync(join(d, ".orly"));
  const before = "rounds: 6\nowner: me\n\n- a: first goal\n- b: second goal\n";
  writeFileSync(join(d, ".orly", "goal"), before);
  const r = Bun.spawnSync([orly, cli, "goal", "c", "third"], { cwd: d, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain('unknown header "owner"');
  expect(readFileSync(join(d, ".orly", "goal"), "utf8")).toBe(before);
});

test("an unparseable goal fails closed and does not reset the guard baseline", () => {
  const d = tree();
  const orlyDir = join(d, ".orly");
  writeFileSync(join(orlyDir, "specs", "a", "a1.spec"), "cut: 0.9\n\nDoes `command_results` show tests passing?\n");
  const was = loadTree(orlyDir)!;
  writeFileSync(join(orlyDir, "goal"), "rounds: 6\nowner: me\n\n- b: second folder first\n- a: first folder second\n");
  writeFileSync(join(orlyDir, "specs", "a", "a1.spec"), "cut: 0.1\n\nDoes `command_results` show tests passing?\n");
  const now = loadTree(orlyDir)!;
  expect(validateSpecs(now.specs).map((p) => p.id)).toContain("goal");
  expect(checkBaseline({ goal: was.goal, specs: was.specs }, { goal: now.goal, specs: now.specs }).violations.map((v) => v.id)).toEqual(["a1"]);
});
