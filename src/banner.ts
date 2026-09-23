/**
 * The owl status banner every adapter prints after a judgment: one verdict line from the
 * CLI, spread over four rows with the owl drawn down the left.
 */

// The owl, one row per status line; each row is padded to OWL_PAD before the text.
const OWL = [` , .`, `{@,@}`, `/) )`, ` '"`];
const OWL_PAD = 7; // indent where the text starts
const OWL_MARGIN = 3; // left margin for the complete status bar

/** Split the CLI's " · "-joined verdict `line` into four rows: verdict and specs, coverage, next, the rest. */
export function statusBar(verdict: { block: boolean; line: string }): string[] {
  const label = verdict.block ? "BLOCK" : "PASS";
  let specs = "";
  let coverage = "";
  let next = "";
  const rest: string[] = [];
  for (const p of verdict.line.split(" · ").slice(1)) {
    if (p.startsWith("specs ")) specs = p;
    else if (p.startsWith("coverage ")) coverage = p;
    else if (p.startsWith("next=")) next = p;
    else rest.push(p);
  }
  return [`${label} · ${specs}`, coverage, next, rest.join(" · ")];
}

export function owlBlock(lines: string[]): string {
  const margin = " ".repeat(OWL_MARGIN);
  return OWL.map((row, i) => (margin + row.padEnd(OWL_PAD) + (lines[i] ?? "")).trimEnd()).join("\n");
}
