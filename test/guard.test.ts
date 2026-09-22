import { expect, test } from "bun:test";
import { checkWeakenings, refusal, weakenings, checkAdapterParity } from "../src/guard.ts";
import type { Spec } from "../src/specs.ts";

const set = (specs: Spec[]) => ({ specs });
const base = set([
  { id: "tests_pass", instructions: "Do the results show a passing test run?", cut: 0.52 },
  { id: "claims", instructions: "Is every stated number backed by output?", cut: 0.28 },
]);

test("lowering a cut is refused", () => {
  const after = set([{ ...base.specs[0], cut: 0.2 }, base.specs[1]]);
  const v = weakenings(base, after);
  expect(v).toHaveLength(1);
  expect(v[0].problem).toContain("0.52 → 0.20");
});

test("raising a cut is allowed", () => {
  expect(weakenings(base, set([{ ...base.specs[0], cut: 0.9 }, base.specs[1]]))).toEqual([]);
});

test("deleting a spec is refused", () => {
  expect(weakenings(base, set([base.specs[0]]))[0].problem).toContain("deleted");
});

test("adding a spec is allowed", () => {
  const after = set([...base.specs, { id: "new", instructions: "Does the build succeed?" }]);
  expect(weakenings(base, after)).toEqual([]);
});

test("marking a spec optional is refused", () => {
  expect(weakenings(base, set([{ ...base.specs[0], optional: true }, base.specs[1]]))[0].problem)
    .toContain("optional");
});

test("dropping an explicit cut that was above the default is refused", () => {
  // Removing a line weakens the gate just as effectively as editing one: the cut falls
  // back to the default, which here is lower than what was written.
  const strict = set([{ id: "a", instructions: "Does it hold?", cut: 0.9 }]);
  const loose = set([{ id: "a", instructions: "Does it hold?" }]);
  expect(weakenings(strict, loose, 0.7)[0].problem).toContain("0.90 → 0.70");
});

test("dropping a cut that was below the default is not a weakening", () => {
  const lenient = set([{ id: "a", instructions: "Does it hold?", cut: 0.3 }]);
  const dropped = set([{ id: "a", instructions: "Does it hold?" }]);
  expect(weakenings(lenient, dropped, 0.7)).toEqual([]);
});

test("rewording while keeping a fitted cut is refused", () => {
  // Wording moves the probability more than the threshold does, so a rewrite makes the
  // old fitted number meaningless rather than merely stale.
  const after = set([{ ...base.specs[0], instructions: "Totally different question?" }, base.specs[1]]);
  expect(weakenings(base, after)[0].problem).toContain("refit");
});

test("rewording and dropping the stale cut is allowed", () => {
  const after = set([
    { id: "tests_pass", instructions: "Totally different question?" },
    base.specs[1],
  ]);
  expect(weakenings(after, after)).toEqual([]);
});

test("the refusal names every spec and says what is allowed instead", () => {
  const text = refusal(weakenings(base, set([{ ...base.specs[0], cut: 0.1 }])));
  expect(text).toContain("`tests_pass`");
  expect(text).toContain("`claims`");
  expect(text).toContain("Tightening a cut");
});

import { checkBaseline } from "../src/guard.ts";

test("the backstop catches a weakening that never passed an edit tool", () => {
  const weaker = set([{ ...base.specs[0], cut: 0.1 }, base.specs[1]]);
  const { violations, nextBaseline } = checkBaseline(base, weaker);
  expect(violations).toHaveLength(1);
  // The baseline must not absorb the weakened file, or one blocked turn would be enough
  // to make the weaker version the new normal.
  expect(nextBaseline).toBe(base);
});

test("the backstop adopts a strengthened file as the new baseline", () => {
  const stricter = set([{ ...base.specs[0], cut: 0.95 }, base.specs[1]]);
  const { violations, nextBaseline } = checkBaseline(base, stricter);
  expect(violations).toEqual([]);
  expect(nextBaseline).toBe(stricter);
});

test("the first run adopts whatever is on disk", () => {
  expect(checkBaseline(null, base).nextBaseline).toBe(base);
  expect(checkBaseline({ specs: [] }, base).violations).toEqual([]);
});

test("a new goal may replace the previous goal's specs", () => {
  // Otherwise the first goal a repo ever had could never be replaced: every later spec
  // set would read as deletions of it, and /orly would be unusable a second time.
  const before = { goal: "ship the parser", specs: base.specs };
  const after = { goal: "something else entirely", specs: [{ id: "fresh", instructions: "Does the deploy succeed?" }] };
  const { violations, nextBaseline } = checkBaseline(before, after);
  expect(violations).toEqual([]);
  expect(nextBaseline).toBe(after);
});

test("weakening is still refused within the same goal", () => {
  const g = "ship the parser";
  const before = { goal: g, specs: base.specs };
  const after = { goal: g, specs: [{ ...base.specs[0], cut: 0.01 }, base.specs[1]] };
  expect(checkBaseline(before, after).violations).toHaveLength(1);
});

// ---------------------------------------------------------------- the checks are half the gate

const cfg = (command: string) => ({ checks: { tests: { command } } });

test("deleting a check is refused, because it disarms every spec asserting on it", () => {
  const v = checkWeakenings(cfg("bun test"), { checks: {} });
  expect(v[0].problem).toContain("disarms");
  expect(v[0].id).toBe("tests");
});

test("replacing a command with one that cannot fail is refused", () => {
  for (const sneaky of ["true", "exit 0", " : ", "echo ok"]) {
    expect(checkWeakenings(cfg("bun test"), cfg(sneaky))).toHaveLength(1);
  }
});

test("changing a command to another real one is ordinary work", () => {
  expect(checkWeakenings(cfg("bun test"), cfg("bun test --coverage"))).toEqual([]);
  expect(checkWeakenings(cfg("npm test"), cfg("bun test 2>&1 | tail -5"))).toEqual([]);
});

test("adding a check is always allowed", () => {
  expect(checkWeakenings(cfg("bun test"), { checks: { tests: { command: "bun test" }, lint: { command: "eslint ." } } })).toEqual([]);
});

test("a config that never had checks is not a weakening", () => {
  expect(checkWeakenings(null, cfg("bun test"))).toEqual([]);
});

test("the backstop catches a check deleted through any route", () => {
  // The same reasoning as the spec backstop: PreToolUse only sees edit tools, and a
  // config rewritten by another process never passes it at all. That is not theoretical —
  // it is how all nine checks here were dropped.
  const was = { goal: "g", specs: [{ id: "a", instructions: "x" }], checks: { tests: { command: "bun test" } } };
  const now = { goal: "g", specs: [{ id: "a", instructions: "x" }], checks: {} };
  const { violations, nextBaseline } = checkBaseline(was, now, 0.7);
  expect(violations.map((v) => v.id)).toEqual(["tests"]);
  expect(nextBaseline).toBe(was); // a weakening is never laundered into the baseline
});

test("a context source is guarded the same as a check", () => {
  // It is the evidence a spec reads. Narrowing it to print less is the same move as
  // narrowing a test command to run less.
  const was = { context: { ticket: { command: "jira issue view $T --plain", maxChars: 6000 } } };
  expect(checkWeakenings(was, { context: {} })[0].problem).toContain("context source was deleted");
  expect(checkWeakenings(was, { context: { ticket: { command: "echo ok", maxChars: 6000 } } })).toHaveLength(1);
  expect(checkWeakenings(was, { context: { ticket: { command: "jira issue view $T --plain", maxChars: 500 } } })[0].problem)
    .toContain("clipped shorter");
  // Fetching it differently, or showing more of it, is ordinary work.
  expect(checkWeakenings(was, { context: { ticket: { command: "gh issue view $T", maxChars: 9000 } } })).toEqual([]);
});

test("stripping the full adapter is refused by the backstop", () => {
  // The pi-orly adapter was rewritten to skip the real judge. A stripped
  // adapter means the loop never sees blocks it should — the failure mode
  // orly protects against.
  const was = { piAdapterFull: true };
  const now = { piAdapterFull: false };
  const v = checkAdapterParity(was, now);
  expect(v).toHaveLength(1);
  expect(v[0].id).toBe("pi_orly_adapter");
  expect(v[0].problem).toContain("stripped");
  // Full adapter kept or added is ordinary work.
  expect(checkAdapterParity({ piAdapterFull: true }, { piAdapterFull: true })).toEqual([]);
  expect(checkAdapterParity({}, { piAdapterFull: true })).toEqual([]);
});
