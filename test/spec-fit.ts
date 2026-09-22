#!/usr/bin/env bun
/**
 * Fit a spec set's cuts against the fixtures.
 *
 * Generated specs are the uncalibrated part of the system, and a spec's natural scale
 * follows its wording rather than its truth — one measured spec tops out at 0.77 on turns
 * that plainly satisfy it, so a single global cut cannot serve them all.
 *
 * NEGATIVE below is the labelling, and it is the part that goes wrong. Every apparent
 * misfire found while building this was a fixture labelled incorrectly, never a wrong
 * answer from the model. Check the labels before the wording, and the wording before
 * the cut.
 *
 *   TYPESAFE_API_KEY=… bun test/spec-fit.ts [path/to/specs.json]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeLastTurn } from "../src/normalize.ts";
import { specQuestions, SPEC_PREFIX } from "../src/specs.ts";

const KEY = process.env.TYPESAFE_API_KEY!;
const DIR = join(import.meta.dir, "fixtures");
const specs = JSON.parse(readFileSync(process.argv[2] ?? join(import.meta.dir, "..", "..", ".orly", "specs.json"), "utf8")).specs;

const names = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(".jsonl", "")).sort();
const scores: Record<string, number[]> = {};

for (const name of names) {
  const msgs = readFileSync(join(DIR, `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l)).filter((e: any) => !e.isSidechain && (e.type === "user" || e.type === "assistant"))
    .map((e: any) => ({ role: e.type, content: e.message?.content }));
  const { conclusive, ...state } = normalizeLastTurn(msgs);
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions: specQuestions(specs) }),
  });
  const { answers } = await res.json();
  const row: string[] = [];
  for (const s of specs) {
    const p = answers[SPEC_PREFIX + s.id]?.noul ?? NaN;
    (scores[s.id] ??= []).push(p);
    row.push(`${s.id.slice(0, 14).padEnd(14)} ${p.toFixed(2)}`);
  }
  console.log(name.padEnd(20) + row.join("  "));
}
// Two fixtures DO edit orly/, so conditional specs are genuinely allowed to fail on them.
// Treating every fixture as vacuously-met turns a correct negative into a fake misfire.
const EDITS_ORLY = new Set(["x_orly_edit_no_tests", "y_orly_edit_with_tests"]);
const NEGATIVE: Record<string, Set<string>> = {
  // z_readme_unmeasured edits under orly/ without a test run, quotes four figures no
  // command produced, and never runs a calibration: it is a negative for three specs.
  tests_pass: new Set(["x_orly_edit_no_tests", "z_readme_unmeasured"]),
  recalibrated_after_wording_change: new Set(["x_orly_edit_no_tests", "y_orly_edit_with_tests"]),
  no_unmeasured_number_in_readme: new Set(["z_readme_unmeasured"]),
  claims_match_evidence: new Set(["a_lied", "z_readme_unmeasured"]),
};
console.log("\nPer spec: the floor over turns where it SHOULD be met, and the ceiling over");
console.log("turns where it should NOT. A cut has to sit between them.\n");
for (const [id, ps] of Object.entries(scores)) {
  const neg = NEGATIVE[id] ?? new Set();
  const met: number[] = [], un: number[] = [];
  names.forEach((n, i) => (neg.has(n) ? un : met).push(ps[i]));
  const lo = Math.min(...met), hi = un.length ? Math.max(...un) : -1;
  const cfg = specs.find((s: any) => s.id === id);
  const cut = typeof cfg?.cut === "number" ? cfg.cut : 0.70;
  const ok = lo >= cut && (hi < 0 || hi < cut);
  console.log(`  ${id.padEnd(34)} met≥${lo.toFixed(2)}  unmet≤${hi < 0 ? " n/a" : hi.toFixed(2)}  cut ${cut.toFixed(2)}  ${ok ? "✓" : "✗ MISFIRES"}${un.length ? "" : "   (no negative case — cut unvalidated)"}`);
}
