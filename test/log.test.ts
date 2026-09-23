import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as j } from "node:path";
import { append, label, propose, read, type Judged } from "../src/log.ts";

const rec = (o: Partial<Judged>): Judged => ({
  at: "t", session: "s", blocked: false, scores: {}, unmet: [], hazards: [],
  actions: 0, results: 0, ...o,
});

test("a block followed by real work is labelled as having bought something", () => {
  const out = label([
    rec({ blocked: true, unmet: ["spec:a"], scores: { "spec:a": 0.3 } }),
    rec({ actions: 4, results: 3 }),
  ]);
  expect(out[0].outcome).toBe("worked");
});

test("a block followed by talk alone is labelled as explained away", () => {
  const out = label([rec({ blocked: true }), rec({ actions: 0, results: 0 })]);
  expect(out[0].outcome).toBe("explained");
});

test("labels never cross a session boundary", () => {
  const out = label([rec({ blocked: true, session: "a" }), rec({ session: "b", actions: 9 })]);
  expect(out[0].outcome).toBeUndefined();
});

test("propose finds the cut between blocks that worked and blocks that did not", () => {
  // 0.20/0.25/0.30 caught real work; 0.60/0.65/0.70 fired on turns that were fine.
  const log: Judged[] = [];
  for (const [p, real] of [[0.2, true], [0.25, true], [0.3, true], [0.6, false], [0.65, false], [0.7, false]] as const) {
    log.push(rec({ blocked: true, unmet: ["spec:a"], scores: { "spec:a": p } }));
    log.push(rec({ actions: real ? 5 : 0, results: real ? 5 : 0 }));
  }
  const [p] = propose(log, { "spec:a": 0.9 });
  expect(p.suggested).toBeCloseTo(0.45, 2);   // midpoint of 0.30 and 0.60
  expect(p.direction).toBe("loosen");
  expect(p.support).toBe(6);
});

test("propose stays silent when the two populations overlap", () => {
  // Overlapping scores mean no threshold works — that is a wording fault, not a cut fault.
  const log: Judged[] = [];
  for (const [p, real] of [[0.5, true], [0.4, false], [0.6, true], [0.55, false], [0.45, true], [0.52, false]] as const) {
    log.push(rec({ blocked: true, unmet: ["spec:a"], scores: { "spec:a": p } }));
    log.push(rec({ actions: real ? 5 : 0 }));
  }
  expect(propose(log, { "spec:a": 0.7 })).toEqual([]);
});

test("propose ignores a spec with too little evidence behind it", () => {
  const log = [
    rec({ blocked: true, unmet: ["spec:a"], scores: { "spec:a": 0.2 } }),
    rec({ actions: 3 }),
  ];
  expect(propose(log, { "spec:a": 0.7 })).toEqual([]);
});

test("a dry run can be kept out of the dataset", () => {
  // Cuts are fitted on the log, so fixture replays must not land in it.
  const dir = j(tmpdir(), `orly-nolog-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    process.env.ORLY_NO_LOG = "1";
    append(dir, rec({ blocked: true }));
    expect(read(dir)).toEqual([]);
    delete process.env.ORLY_NO_LOG;
    append(dir, rec({ blocked: true }));
    expect(read(dir)).toHaveLength(1);
  } finally {
    delete process.env.ORLY_NO_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unlabelled block is not evidence for loosening anything", () => {
  // No later turn in the same session, so no block has an outcome yet.
  const log = Array.from({ length: 6 }, (_, i) =>
    rec({ session: `s${i}`, blocked: true, unmet: ["spec:a"], scores: { "spec:a": 0.1 } }),
  );
  expect(label(log).every((r) => r.outcome === undefined)).toBe(true);
  expect(propose(log, { "spec:a": 0.7 })).toEqual([]);
});
