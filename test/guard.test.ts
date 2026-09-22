import { expect, test } from "bun:test";
import { refusal, weakenings } from "../src/guard.ts";
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
