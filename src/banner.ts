/**
 * The owl status banner every adapter prints after a judgment: one verdict line from the
 * CLI, spread over four rows with the owl drawn down the left.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The owl, one row per status line; each row is padded to OWL_PAD before the text.
const OWL = [`|  , .`, `| {@,@}`, `| /) )`, `|  '"`];
const OWL_PAD = 8; // indent where the text starts
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

/** What the last judgment of a session looked like, for a status line to render between turns. */
export type Status = {
  at: string;
  /** The project the turn ran in, so a bar without a session id can find its latest. */
  cwd?: string;
  block: boolean;
  /** The CLI's verdict line, " · "-joined. */
  line: string;
  /** Unmet specs, most important goal first: id and what was found. */
  unmet: Array<{ id: string; found: string }>;
  /** Why the gate let a still-failing turn end, e.g. the round cap. */
  note?: string;
};

export const statusFile = (dir: string, sessionId: string) => join(dir, `orly-status-${sessionId}.json`);

export function saveStatus(dir: string, sessionId: string, status: Status): void {
  try {
    writeFileSync(statusFile(dir, sessionId), JSON.stringify(status));
  } catch {
    /* the status line is cosmetic; the gate never depends on it */
  }
}

export function readStatus(dir: string, sessionId: string): Status | null {
  try {
    return JSON.parse(readFileSync(statusFile(dir, sessionId), "utf8")) as Status;
  } catch {
    return null;
  }
}

/** The newest status judged under `root`, for a bar that knows no session id. */
export function latestStatus(dir: string, root: string): Status | null {
  let best: { t: number; s: Status } | null = null;
  for (const f of readdirSync(dir).filter((f) => /^orly-status-.*\.json$/.test(f))) {
    try {
      const t = statSync(join(dir, f)).mtimeMs;
      if (best && t <= best.t) continue;
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Status;
      if (s.cwd && (s.cwd === root || s.cwd.startsWith(root + "/"))) best = { t, s };
    } catch {
      /* a file mid-write or gone: skip it */
    }
  }
  return best?.s ?? null;
}

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/**
 * The owl for a status line: verdict, specs and round; what is unmet; the judge's detail;
 * the top goal. Before the first judgment it says what is armed.
 */
export function statusLines(
  s: Status | null,
  ctx: { specs: number; goals: string[]; round?: number; maxRounds: number; now?: number },
): string[] {
  const goal = ctx.goals.length ? `goal 1/${ctx.goals.length} ${clip(ctx.goals[0], 70)}` : "no goal yet";
  if (!s) return owlBlock([`orly · ${ctx.specs} specs armed · no turn judged yet`, "", "", `${DIM}${goal}${OFF}`]).split("\n");
  const parts = s.line.split(" · ").slice(1);
  const specs = parts.find((p) => p.startsWith("specs ")) ?? "";
  const detail = parts.filter((p) => /^(coverage|next=)| tok$|^waited/.test(p)).join(" · ");
  const verdict = s.note ? `${YELLOW}◐ LET GO${OFF}` : s.block ? `${RED}⛔ BLOCK${OFF}` : `${GREEN}✓ PASS${OFF}`;
  const round = ctx.round ? ` · round ${ctx.round}/${ctx.maxRounds}` : "";
  const unmet = s.unmet.length
    ? `unmet ${s.unmet.length}: ${clip(s.unmet.slice(0, 3).map((u) => `${u.id} (${u.found})`).join(" · "), 110)}`
    : "every spec met";
  return owlBlock([
    `orly ${verdict} · ${specs}${round} · ${ago(s.at, ctx.now ?? Date.now())}${s.note ? ` · ${s.note}` : ""}`,
    unmet,
    `${DIM}${detail}${OFF}`,
    `${DIM}${goal}${OFF}`,
  ]).split("\n");
}
