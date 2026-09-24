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
const OFF = "\x1b[0m";
// Roles, not pigments: the user's palette supplies the colour. Colour only ever marks status.
const ROLE = { bad: "\x1b[31m", good: "\x1b[32m", warn: "\x1b[33m", quiet: "\x1b[2m", strong: "\x1b[1m" };
type Seg = [text: string, style?: string];
const cells = (t: string) => Array.from(t).length;

/** Lay segments into `width` cells; the segment that overflows is cut with an ellipsis. */
function row(segs: Seg[], width: number): string {
  let out = "";
  let left = width;
  for (const [t, style] of segs) {
    if (left <= 0 || !t) continue;
    let c = Array.from(t);
    if (c.length > left) c = [...c.slice(0, left - 1), "…"];
    left -= c.length;
    out += style ? `${style}${c.join("")}${OFF}` : c.join("");
  }
  return out;
}

/**
 * A `width`-cell window onto `text` that rests at the start, scrolls to the end, rests, and
 * jumps back. An ellipsis at either edge says there is more that way. `tick` is the clock.
 */
export function scroll(text: string, width: number, tick: number, rest = 6): string {
  const c = Array.from(text);
  if (c.length <= width) return text;
  const over = c.length - width;
  const at = Math.min(Math.max((tick % (over + 2 * rest)) - rest, 0), over);
  const win = c.slice(at, at + width);
  if (at > 0) win[0] = "…";
  if (at < over) win[width - 1] = "…";
  return win.join("");
}

/** One goal as the status line sees it. `group` names it; `specs` are the ids serving it. */
export type GoalRow = { group: string; text: string; specs: string[] };

/**
 * The status line, in whole cells and at most `width` of them (80, the narrowest pane it will
 * meet). Row 1 beside the owl: verdict, specs met, round, age. Then one row per goal: its
 * specs met, its first failing spec with what was found, and its text, scrolling in whatever
 * cells are left. Only a failing count or the verdict carries colour.
 */
export function statusLines(
  s: Status | null,
  ctx: { specs: number; goals: GoalRow[]; round?: number; maxRounds: number; now?: number; width?: number; oneline?: boolean },
): string[] {
  const now = ctx.now ?? Date.now();
  const inner = (ctx.width ?? 80) - OWL_MARGIN - OWL_PAD;
  const open = new Map((s?.unmet ?? []).map((u) => [u.id, u.found]));
  const tick = Math.floor(now / 500); // two cells a second at a one-second redraw

  let head: Seg[];
  if (!s) head = [["orly", ROLE.strong], [` ${ctx.specs} specs armed · not judged yet`, ROLE.quiet]];
  else {
    const parts = s.line.split(" · ").slice(1);
    const met = (parts.find((p) => p.startsWith("specs ")) ?? "specs ?").slice(6);
    const detail = parts
      .filter((p) => /^(coverage|next=)/.test(p))
      .map((p) => p.replace(/ \(conf [\d.]+\)/, "").replace("next=", "next "))
      .join(" · ");
    const [mark, role] = s.note ? ["◐ LET GO", ROLE.warn] : s.block ? ["✗ BLOCK", ROLE.bad] : ["✓ PASS", ROLE.good];
    head = [
      [mark, ROLE.strong + role],
      [`  ${met} specs${ctx.round ? ` · round ${ctx.round}/${ctx.maxRounds}` : ""} · ${ago(s.at, now)}`],
      [s.note ? ` · ${s.note}` : detail ? ` · ${detail}` : "", ROLE.quiet],
    ];
  }

  const failing = (g: GoalRow) => g.specs.filter((id) => open.has(id));
  const why = (ids: string[]) => `✗ ${ids[0]} ${open.get(ids[0])}${ids.length > 1 ? ` +${ids.length - 1}` : ""}`;
  if (ctx.oneline) {
    const first = ctx.goals.map(failing).find((f) => f.length);
    return [row([...head.slice(0, 2), [first ? ` · ${why(first)}` : ""]], ctx.width ?? 80)];
  }

  const name = Math.max(0, ...ctx.goals.map((g) => cells(g.group)));
  const count = (n: number | string, of: number) => `${n}/${of}`.padStart(2 * String(Math.max(0, ...ctx.goals.map((g) => g.specs.length))).length + 1);
  const goals = ctx.goals.map((g, i) => {
    const f = failing(g);
    const segs: Seg[] = [
      [`▕${count(s ? g.specs.length - f.length : "–", g.specs.length)}▏`, s && f.length ? ROLE.bad : ROLE.quiet],
      [` ${g.group.padEnd(name)}  `],
      [f.length ? `${why(f)}  ` : ""],
    ];
    const room = inner - segs.reduce((n, [t]) => n + cells(t), 0);
    if (room >= 12) segs.push([scroll(g.text, room, tick + i * 5), ROLE.quiet]); // under 12 cells a goal is noise
    return row(segs, inner);
  });

  // The owl's rule runs down every row, so the goals below the owl still read as its block.
  const margin = " ".repeat(OWL_MARGIN);
  const rows = [row(head, inner), ...goals];
  while (rows.length < OWL.length) rows.push("");
  return rows.map((r, i) => (margin + (OWL[i] ?? "|").padEnd(OWL_PAD) + r).trimEnd());
}
