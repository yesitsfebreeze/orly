import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../src/gate.ts";
import { checkBaseline } from "../src/guard.ts";
import { loadTree, parseGoals, renderTree } from "../src/spectree.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const orly = process.execPath;
const cli = join(import.meta.dir, "..", "bin", "orly.ts");

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
  expect(renderTree(t).split("\n").filter((l) => l.endsWith("/"))).toEqual(["b/", "a/", "misc/"]);
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
