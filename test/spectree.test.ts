import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, validateSpecs } from "../src/specs.ts";
import { formatSpec, loadTree, parseSpec, renderTree } from "../src/spectree.ts";
import { loadSpecFile } from "../src/session.ts";
import { weakenings } from "../src/guard.ts";

test("every spec field survives a format → parse round trip", () => {
  const specs = [
    { id: "a", instructions: "Do `command_results` show zero failures?\nSecond line." },
    { id: "b", instructions: "README.md draws the owl once.", require: { path: "checks.owls.matches", op: "equals" as const, value: 1 } },
    { id: "c", instructions: "Is the ticket covered by the work?", cut: 0.62, evidence: ["ticket", "a.ts"], optional: true,
      gather: "Paste the verdict.", criteria: { true: "yes it is", false: "no it is not" }, fitted: "met>=0.9" },
    { id: "d", instructions: "Present check.", require: { path: "x.y", op: "present" as const } },
    { id: "e", instructions: "Contains check.", require: { path: "x.y", op: "contains" as const, value: "ok done" } },
  ];
  for (const s of specs) expect(parseSpec(s.id, formatSpec(s))).toEqual(s);
});

test("a malformed spec file fails closed: it becomes a spec that can never be met", () => {
  for (const text of ["cut: 5\n\nA question here.", "colour: red\n\nA question here.", "cut: abc\n\nA question here."]) {
    const s = parseSpec("bad", text);
    expect(s.instructions).toStartWith("malformed spec file:");
    expect(evaluate(s.require!, {}).met).toBe(false);
    expect(validateSpecs([s])[0].problem).toStartWith("malformed spec file:");
  }
  // Prose that merely contains a colon is a body, not a header.
  expect(parseSpec("ok", "Note: this is just a question about the output.").instructions).toStartWith("Note:");
});

test("the tree loads from nested folders, wins over specs.json, and renders as an index", () => {
  const root = mkdtempSync(join(tmpdir(), "orly-tree-"));
  const orly = join(root, ".orly");
  mkdirSync(join(orly, "specs", "readme"), { recursive: true });
  mkdirSync(join(orly, "specs", "build"), { recursive: true });
  writeFileSync(join(orly, "specs.json"), JSON.stringify({ goal: "old", specs: [] }));
  writeFileSync(join(orly, "goal"), "rounds: 4\n\nShip the thing.\n");
  writeFileSync(join(orly, "specs", "readme", "one_owl.spec"), "require: checks.owls.matches equals 1\n\nREADME.md draws one owl.\n");
  writeFileSync(join(orly, "specs", "build", "tests_ran.spec"), "cut: 0.6\n\nDo `command_results` show a passing test run?\n");
  const f = loadSpecFile(join(root))!;
  expect(f.goal).toBe("Ship the thing.");
  expect(f.maxRounds).toBe(4);
  expect(f.specs.map((s) => s.id).sort()).toEqual(["one_owl", "tests_ran"]);
  const index = renderTree(loadTree(orly)!);
  expect(index).toContain("build/\n  tests_ran");
  expect(index).toContain("readme/\n  one_owl");
});

test("the edit guard sees what one file edit does to the whole tree", () => {
  const orly = join(mkdtempSync(join(tmpdir(), "orly-tree-")), ".orly");
  mkdirSync(join(orly, "specs", "build"), { recursive: true });
  const path = join(orly, "specs", "build", "tests_ran.spec");
  writeFileSync(path, "cut: 0.6\n\nDo `command_results` show a passing test run?\n");
  const before = loadTree(orly);
  const lowered = loadTree(orly, { path, text: "cut: 0.3\n\nDo `command_results` show a passing test run?\n" });
  expect(weakenings(before, lowered)[0].problem).toContain("cut was lowered");
  const added = loadTree(orly, { path: join(orly, "specs", "new_one.spec"), text: "Is the new thing recorded in the output?\n" });
  expect(weakenings(before, added)).toEqual([]);
});
