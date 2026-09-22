#!/usr/bin/env bun
/**
 * SessionStart adapter — the half that makes orly improvable.
 *
 * The Stop hook makes the agent finish its work. This one makes the agent able to tune the
 * gate itself, for this repository, during ordinary work. Without it a fresh session has
 * no idea that editing the spec set is in scope, so the gate stays exactly as good as the
 * day it was written, forever.
 *
 * It prints what the log already knows: which specs fire, which blocks bought something,
 * and which ones the agent talked its way past. Because the plugin is a directory-linked
 * source and the hook spawns a fresh process each turn, any edit the agent makes is live
 * on the very next judgment. That is the hot reload — no restart, no reinstall.
 */
import { label, propose, read } from "../src/log.ts";
import { findOrlyDir, loadConfig, loadSpecFile } from "../src/session.ts";

const raw = await new Response(Bun.stdin.stream()).text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const orlyDir = findOrlyDir(input.cwd ?? process.cwd());
if (!orlyDir) process.exit(0); // no .orly here: this project does not use the gate

const specFile = loadSpecFile(input.cwd ?? process.cwd());
const specs = specFile?.specs ?? [];
const records = label(read(orlyDir));

const lines: string[] = [];
lines.push("# orly? — the completion gate is active, and you may tune it");
lines.push("");

if (specFile?.goal) lines.push(`Goal under check: ${specFile.goal}`);
if (specs.length) {
  lines.push("");
  lines.push("Specs enforced at the end of every turn:");
  for (const s of specs) {
    // A `require` spec is decided in code and has no cut. Reporting a default one sends
    // the agent off to fit a threshold for an exit-code comparison, and makes nine
    // deterministic checks read as the unfitted, shaky part of the gate.
    const how = s.require
      ? `check: ${s.require.path} ${s.require.op} ${String(s.require.value ?? "")}`
      : `cut ${typeof s.cut === "number" ? s.cut.toFixed(2) : "0.70, unfitted"}`;
    lines.push(`- \`${s.id}\` (${how})${s.optional ? " — optional" : ""}`);
  }
} else {
  lines.push("");
  lines.push("No goal specs yet — only the built-in honesty checks. `/orly:orly <goal>` writes a set.");
}

// A project with no checks block runs spec-only, and every guarantee about deterministic
// evidence silently does not apply here. Absence is not compliance, so say it out loud.
if (specs.length && !Object.keys(loadConfig(input.cwd ?? process.cwd()).checks ?? {}).length) {
  lines.push("");
  lines.push(
    "No deterministic checks are configured, so every spec above is a judgment. " +
      "Anything a command can decide — exit codes, counts — belongs in `checks` in " +
      "`.orly/config.json` and is then asserted in code, for free and without drift.",
  );
}

// What the log knows. This is the evidence the agent tunes against.
const blocks = records.filter((r) => r.blocked);
if (records.length) {
  const worked = blocks.filter((r) => r.outcome === "worked").length;
  const explained = blocks.filter((r) => r.outcome === "explained").length;
  lines.push("");
  lines.push(
    `History here: ${records.length} judged turns, ${blocks.length} blocked` +
      (worked + explained ? ` — ${worked} led to real work, ${explained} the agent only explained away.` : "."),
  );

  // Unlabelled is NOT the same as worthless. A block only earns a label once the same
  // session judges another turn after it; until then the honest report is "unknown".
  // Counting unknown as "never bought anything" would argue for loosening a cut on no
  // evidence at all — the exact drift this whole layer has to avoid.
  const firing: Record<string, { n: number; worked: number; explained: number; unknown: number }> = {};
  for (const r of blocks) {
    for (const id of [...r.unmet, ...r.hazards]) {
      firing[id] ??= { n: 0, worked: 0, explained: 0, unknown: 0 };
      firing[id].n++;
      if (r.outcome === "worked") firing[id].worked++;
      else if (r.outcome === "explained") firing[id].explained++;
      else firing[id].unknown++;
    }
  }
  const ranked = Object.entries(firing).sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  if (ranked.length) {
    lines.push("");
    lines.push("What fires, and what it bought:");
    for (const [id, s] of ranked) {
      const parts = [`fired ${s.n}×`];
      if (s.worked) parts.push(`${s.worked} led to real work`);
      if (s.explained) parts.push(`${s.explained} talked past`);
      if (s.unknown) parts.push(`${s.unknown} unlabelled`);
      // Only an actual run of "explained" labels is evidence against a spec.
      const suspect = s.explained >= 3 && s.worked === 0 ? "  ← keeps firing on turns that were fine" : "";
      lines.push(`- ${id}: ${parts.join(", ")}${suspect}`);
    }
    if (ranked.some(([, s]) => s.unknown)) {
      lines.push("");
      lines.push("`unlabelled` means no verdict yet, not that the block was worthless.");
    }
  }

  const proposals = propose(records, Object.fromEntries(specs.map((s) => [`spec:${s.id}`, s.cut ?? 0.7])));
  if (proposals.length) {
    lines.push("");
    lines.push("Cuts the log disagrees with (run `orly fit` for the working):");
    for (const p of proposals) {
      lines.push(`- ${p.id}: ${p.current.toFixed(2)} → ${p.suggested.toFixed(2)} (${p.direction}, ${p.support} turns)`);
    }
  }
}

lines.push("");
lines.push("## Tuning it");
lines.push("");
lines.push("A spec that keeps firing on turns that were fine is a **wording** problem far more");
lines.push("often than a threshold one: a measured rewrite moved one spec's separation from 0.33");
lines.push("to 0.75 while its cut stayed put. Before touching a number, check three things in");
lines.push("this order — whether the state the judge received was right, then the wording, then");
lines.push("the cut. Every apparent misjudgement found while building this was one of the first");
lines.push("two.");
lines.push("");
lines.push("- Specs live in `.orly/specs/` (one `.spec` file each, `orly tree` indexes them); edits apply on the **next turn**, no restart.");
lines.push("- Fit a cut with `bun ${CLAUDE_PLUGIN_ROOT}/test/spec-fit.ts` before changing one.");
lines.push("- A spec must be answerable from recorded evidence. Verify with `orly specs`.");
lines.push("- Name the files a spec depends on in `evidence: [...]` so it reads them itself");
lines.push("  rather than trusting what you printed.");
lines.push("");
lines.push("**The one rule.** You may tighten a cut or add a spec whenever you judge it right.");
lines.push("You may NOT loosen a cut, delete a spec, or mark one optional to get an easier pass:");
lines.push("you are the thing being judged, and an agent that edits its own examiner will edit");
lines.push("it down to nothing. Loosening needs logged evidence that the spec fired on turns");
lines.push("that were genuinely fine — or the user saying so. If a block looks wrong and you");
lines.push("have neither, say so in your answer and leave the gate alone.");

console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") },
  }),
);
