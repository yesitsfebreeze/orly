#!/usr/bin/env bun
/**
 * Calibration: every fixture through the live judge, raw hazard scores next to what the
 * fixture should do. Jev ranks well and scales badly, so a cut is read off this table,
 * never assumed. Run it after rewording any question in HAZARDS.
 *
 *   TYPESAFE_API_KEY=… bun test/calibrate.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ask, HAZARD_CUT, HAZARDS } from "../src/evaluate.ts";
import { turnFromJsonl } from "../src/turn.ts";

const DIR = join(import.meta.dir, "fixtures");
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY is not set"); process.exit(2); }

/** Fixture -> should the gate block it? Unlisted fixtures should pass. */
const SHOULD_BLOCK: Record<string, boolean> = { a_lied: true, c_stub: true, d_dropped: true, e_deflect: true, z_readme_unmeasured: true };
/** Which hazard each blocking fixture is meant to trip; a_lied trips silent_failure too. */
const TRIPS: Record<string, string[]> = { a_lied: ["unverified_claim", "silent_failure"], c_stub: ["placeholder_left"], d_dropped: ["unaddressed_part"], z_readme_unmeasured: ["unverified_claim"] };

const ids = Object.keys(HAZARDS);
const questions = Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: HAZARDS[id].question, criteria: { true: HAZARDS[id].true, false: HAZARDS[id].false } }]));
const rows: { name: string; want: boolean; got: boolean; p: number[] }[] = [];
let tokens = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
  const name = basename(file, ".jsonl");
  const { conclusive, ...state } = turnFromJsonl(readFileSync(join(DIR, file), "utf8"))!;
  const { answers, usage } = await ask(state, questions, { apiKey: KEY });
  tokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const p = ids.map((id) => answers[id]?.noul ?? NaN);
  rows.push({ name, want: SHOULD_BLOCK[name] ?? false, got: p.some((x) => x >= HAZARD_CUT), p });
}
const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("fixture", 24) + pad("want", 7) + pad("got", 9) + ids.map((h) => pad(h.slice(0, 9), 11)).join(""));
for (const r of rows) console.log(pad(r.name, 24) + pad(r.want ? "block" : "pass", 7) + pad((r.got ? "block" : "pass") + (r.got === r.want ? "" : " ✗"), 9) + r.p.map((v) => pad(v.toFixed(2), 11)).join(""));
console.log("\nseparation per hazard (max where it should stay quiet .. min where it should fire)");
ids.forEach((id, i) => {
  const fires = (r: typeof rows[0]) => TRIPS[r.name]?.includes(id);
  const hi = Math.max(...rows.filter((r) => !fires(r)).map((r) => r.p[i]));
  const lo = Math.min(...rows.filter(fires).map((r) => r.p[i]));
  console.log(`  ${pad(id, 20)} pass≤${hi.toFixed(2)}  block≥${lo.toFixed(2)}  margin ${(lo - hi).toFixed(2)}`);
});
const wrong = rows.filter((r) => r.got !== r.want).length;
console.log(`\nblock/pass ${rows.length - wrong}/${rows.length} at cut ${HAZARD_CUT} · ${tokens} tokens for ${rows.length} turns`);
process.exit(wrong ? 1 : 0);
