/**
 * The session brief every host injects when a session starts: the gate is active, these
 * are the specs, this is what the log says each one bought, and these are the rules for
 * tuning it. Host adapters only wrap the text in their own protocol.
 */
import { label, propose, read } from "./log.ts";
import { findOrlyDir, loadConfig, loadSpecFile } from "./session.ts";

export type BriefOptions = {
  /** How to run orly on this host, e.g. `bun /path/to/orly/bin/orly.ts`. Shown as `orly`. */
  cli?: string;
  /** Where the plugin lives, for the fit script. */
  pluginRoot?: string;
  /** How the goal command is spelled on this host, e.g. `/orly:orly` or `/orly`. */
  goalCommand?: string;
};

/** The brief for the project at `cwd`, or null when it does not use the gate. */
export function sessionBrief(cwd: string, opts: BriefOptions = {}): string | null {
  const orlyDir = findOrlyDir(cwd);
  if (!orlyDir) return null;

  const goalCommand = opts.goalCommand ?? "/orly:orly";
  const specFile = loadSpecFile(cwd);
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
      // `require` specs are decided in code and have no cut; show the check instead.
      const how = s.require
        ? `check: ${s.require.path} ${s.require.op} ${String(s.require.value ?? "")}`
        : `cut ${typeof s.cut === "number" ? s.cut.toFixed(2) : "0.70, unfitted"}`;
      lines.push(`- \`${s.id}\` (${how})${s.optional ? " — optional" : ""}`);
    }
  } else {
    lines.push("");
    lines.push(`No goal specs yet — only the built-in honesty checks. \`${goalCommand} <goal>\` writes a set.`);
  }

  // No `checks` means every spec is a judgment; say so rather than stay silent.
  if (specs.length && !Object.keys(loadConfig(cwd).checks ?? {}).length) {
    lines.push("");
    lines.push(
      "No deterministic checks are configured, so every spec above is a judgment. " +
        "Anything a command can decide — exit codes, counts — belongs in `checks` in " +
        "`.orly/config.json` and is then asserted in code, for free and without drift.",
    );
  }

  const blocks = records.filter((r) => r.blocked);
  if (records.length) {
    const worked = blocks.filter((r) => r.outcome === "worked").length;
    const explained = blocks.filter((r) => r.outcome === "explained").length;
    lines.push("");
    lines.push(
      `History here: ${records.length} judged turns, ${blocks.length} blocked` +
        (worked + explained ? ` — ${worked} led to real work, ${explained} the agent only explained away.` : "."),
    );

    // A block is labelled only after its session judges a later turn. Keep unlabelled
    // separate: counting it as worthless would argue for loosening on no evidence.
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

  const fit = opts.pluginRoot ? `bun ${opts.pluginRoot}/test/spec-fit.ts` : "bun test/spec-fit.ts";
  lines.push("");
  if (opts.cli) lines.push(`\`orly\` below means \`${opts.cli}\`.`);
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
  lines.push(`- Fit a cut with \`${fit}\` before changing one.`);
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

  return lines.join("\n");
}
