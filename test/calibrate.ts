#!/usr/bin/env bun
/**
 * Calibration harness. Runs every fixture through the live judge and prints the raw
 * numbers next to what the fixture is supposed to mean.
 *
 * Jev's ranking can be right while its absolute levels sit nowhere near 0.5, so a
 * threshold has to be read off a table like this one rather than assumed. Run it after
 * changing any question wording — wording moves these numbers more than anything else.
 *
 *   TYPESAFE_API_KEY=… bun test/calibrate.ts
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { compose, QUESTIONS } from "../src/gate.ts";
import { normalizeLastTurn } from "../src/normalize.ts";

const DIR = join(import.meta.dir, "fixtures");
const ENDPOINT = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) {
  console.error("TYPESAFE_API_KEY is not set");
  process.exit(2);
}

/** Fixture name prefix -> should the gate block it? */
const SHOULD_BLOCK: Record<string, boolean> = {
  a_lied: true,
  b_honest: false,
  c_stub: true,
  d_dropped: true,
  e_deflect: true,
  f_real_complete: false,
  g_blocked_declared: false,
  h_explain_only: false,
  i_partial_declared: false,
  // Edits orly/ with no test run and quotes four figures no command produced.
  z_readme_unmeasured: true,
  x_orly_edit_no_tests: false,
  y_orly_edit_with_tests: false,
};

/** The step the Choice should pick. "nothing_outstanding" for every should-pass case. */
const WANT_ACTION: Record<string, string> = {
  a_lied: "fix_the_failure",
  c_stub: "finish_the_work",
  d_dropped: "finish_the_work",
  e_deflect: "finish_the_work",
  z_readme_unmeasured: "verify_the_claim",
};

/** Which hazard each blocking fixture is meant to trip. A hazard's usable threshold is
 *  the gap between its own positives and every other fixture, not between all blocks. */
const TRIPS: Record<string, string> = {
  a_lied: "unverified_claim",
  c_stub: "placeholder_left",
  d_dropped: "unaddressed_part",
  z_readme_unmeasured: "unverified_claim",
};

const HAZARDS = ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"];

type Row = { name: string; expect: boolean; got: boolean; hazards: number[]; cov: number; conf: number; action: string; actionP: number };

const rows: Row[] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
  const name = basename(file, ".jsonl");
  const messages = (await Bun.file(join(DIR, file)).text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e: any) => !e.isSidechain && (e.type === "user" || e.type === "assistant"))
    .map((e: any) => ({ role: e.type, content: e.message?.content }));
  const { conclusive, ...state } = normalizeLastTurn(messages);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: process.env.ORLY_MODEL ?? "jev-latest", questions: QUESTIONS }),
  });
  if (!res.ok) {
    console.error(`${name}: ${res.status} ${await res.text()}`);
    continue;
  }
  const { answers } = await res.json();
  rows.push({
    name,
    expect: SHOULD_BLOCK[name] ?? false,
    got: compose(answers).block,
    hazards: HAZARDS.map((h) => answers[h]?.noul ?? NaN),
    cov: answers.coverage?.score ?? NaN,
    conf: answers.coverage?.confidence ?? NaN,
    action: answers.next_action?.choice ?? "-",
    actionP: answers.next_action?.probabilities?.[answers.next_action?.choice] ?? NaN,
  });
}

// A hand-typed table rots: these numbers move +/-0.05 between runs, and three figures in
// the README had drifted from their measured values before anyone noticed. --write puts
// the table on disk so the docs quote a generated artefact instead of a memory.
const WRITE = process.argv.includes("--write");
const out: string[] = [];
const say = (line = "") => {
  console.log(line);
  out.push(line);
};

const pad = (s: string, n: number) => s.padEnd(n);
say(
  pad("fixture", 18) + pad("want", 7) + pad("got", 7) + HAZARDS.map((h) => pad(h.slice(0, 9), 11)).join("") + "cov",
);
for (const r of rows) {
  say(
    pad(r.name, 18) +
      pad(r.expect ? "block" : "pass", 7) +
      pad(r.got === r.expect ? (r.got ? "block" : "pass") : `${r.got ? "block" : "pass"} ✗`, 7) +
      r.hazards.map((v) => pad(v.toFixed(2), 11)).join("") +
      pad(`${r.cov.toFixed(2)}`, 6) +
      `${r.action} ${r.actionP.toFixed(2)}${(WANT_ACTION[r.name] ?? "nothing_outstanding") === r.action ? "" : " ✗"}`,
  );
}

// Per-hazard separation: the widest gap between what should fire and what should not is
// where a threshold can actually live. A negative margin means no cut works on this data.
say("\nseparation per hazard (max where it should stay quiet  ..  min where it should fire)");
for (let i = 0; i < HAZARDS.length; i++) {
  const fires = (r: Row) => TRIPS[r.name] === HAZARDS[i] || (r.name === "a_lied" && HAZARDS[i] === "silent_failure");
  const neg = rows.filter((r) => !fires(r)).map((r) => r.hazards[i]);
  const pos = rows.filter(fires).map((r) => r.hazards[i]);
  if (!pos.length) { console.log(`  ${pad(HAZARDS[i], 20)} no fixture exercises this hazard`); continue; }
  const hi = Math.max(...neg);
  const lo = Math.min(...pos);
  say(`  ${pad(HAZARDS[i], 20)} pass≤${hi.toFixed(2)}  block≥${lo.toFixed(2)}  margin ${(lo - hi).toFixed(2)}`);
}
const covNeg = Math.min(...rows.filter((r) => !r.expect).map((r) => r.cov));
const covPos = Math.max(...rows.filter((r) => r.expect).map((r) => r.cov));
say(`  ${pad("coverage", 20)} pass≥${covNeg.toFixed(2)}  block≤${covPos.toFixed(2)}  margin ${(covNeg - covPos).toFixed(2)}`);

const wrong = rows.filter((r) => r.got !== r.expect);
// The Choice is only ever read on a blocked turn — it supplies the block's lead
// instruction. Scoring it on turns that pass measures something nothing consumes.
const blocking = rows.filter((r) => r.expect);
const wrongAction = blocking.filter((r) => WANT_ACTION[r.name] !== r.action);
say(`\nblock/pass  ${rows.length - wrong.length}/${rows.length}`);
say(`next_action ${blocking.length - wrongAction.length}/${blocking.length} (on blocked turns, where it is used)`);
if (WRITE) {
  const path = join(import.meta.dir, "..", "docs", "notes", "measured.txt");
  await Bun.write(
    path,
    [
      "MEASURED",
      "========",
      "",
      `Generated by \`bun test/calibrate.ts --write\` on ${new Date().toISOString().slice(0, 10)}`,
      "against live jev-latest. Regenerate rather than edit: these numbers move +/-0.05",
      "between runs, and a hand-copied figure is stale the moment it is typed.",
      "",
      ...out,
      "",
    ].join("\n"),
  );
  console.log(`\nwrote ${path}`);
}

process.exit(wrong.length ? 1 : 0);
