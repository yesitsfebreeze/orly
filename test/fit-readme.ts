#!/usr/bin/env bun
/**
 * Fit the README specs.
 *
 * These read the live file through `evidence`, so a transcript fixture cannot make them
 * fail — the variable is the FILE. Each spec is measured against a version of the file
 * that satisfies it and one that does not, which is the only way to get a negative case
 * for a spec whose evidence is gathered rather than replayed.
 */
import { loadSpecFile } from "../src/session.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_PREFIX, specQuestions, type Spec } from "../src/specs.ts";

const KEY = process.env.TYPESAFE_API_KEY!;
const ROOT = join(import.meta.dir, "..");
const real = readFileSync(join(ROOT, "README.md"), "utf8");
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");

const noOwl = real.replace(/^```[\s\S]*?```\n\n/, "# orly?\n\n");
const noDocs = real.replace(/## Read more[\s\S]*$/, "MIT.\n");

const base = {
  user_request: "improve orly and tighten the README",
  assistant_final_message: "Done.",
  assistant_said: "Done.",
  actions_taken: ["Edit: orly/README.md"],
};

type Case = { label: string; met: boolean; state: any };

const withFiles = (readme: string, results: string[] = ["Applied 1 edit."]) => ({
  ...base,
  command_results: results,
  project: { files: { "orly/README.md": readme, "orly/llms.txt": llms } },
});

const CASES: Record<string, Case[]> = {
  readme_opens_with_owl: [
    { label: "owl present", met: true, state: withFiles(real) },
    { label: "owl removed", met: false, state: withFiles(noOwl) },
  ],
  readme_points_to_deeper_docs: [
    { label: "links present", met: true, state: withFiles(real) },
    { label: "links removed", met: false, state: withFiles(noDocs) },
  ],
  readme_stays_short: [
    { label: "77 printed", met: true, state: withFiles(real, ["      77 README.md"]) },
    { label: "412 printed", met: false, state: withFiles(real, ["     412 README.md"]) },
    { label: "no count printed", met: false, state: withFiles(real, ["Applied 1 edit."]) },
  ],
};

const specs: Spec[] = loadSpecFile(join(ROOT, "..")).specs;

for (const [id, cases] of Object.entries(CASES)) {
  const spec = specs.find((s) => s.id === id);
  if (!spec) continue;
  const scores: Array<[string, boolean, number]> = [];
  for (const c of cases) {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: c.state, model: "jev-latest", questions: specQuestions([spec]) }),
    });
    const { answers } = await r.json();
    scores.push([c.label, c.met, answers?.[SPEC_PREFIX + id]?.noul ?? NaN]);
  }
  const met = scores.filter((s) => s[1]).map((s) => s[2]);
  const un = scores.filter((s) => !s[1]).map((s) => s[2]);
  const lo = Math.min(...met);
  const hi = Math.max(...un);
  console.log(`\n${id}`);
  for (const [l, m, p] of scores) console.log(`  ${m ? "met  " : "UNMET"}  ${p.toFixed(2)}  ${l}`);
  console.log(`  margin ${(lo - hi).toFixed(2)}   cut ${lo > hi ? ((lo + hi) / 2).toFixed(2) : "NONE — rewording needed"}`);
}
