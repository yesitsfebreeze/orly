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

/** `row`, padded with spaces to exactly `width` cells. */
const fit = (segs: Seg[], width: number) => {
  const r = row(segs, width);
  return r + " ".repeat(Math.max(0, width - cells(r.replace(/\x1b\[[0-9;]*m/g, ""))));
};

/** A `w`-cell gauge: filled cells for `n` of `of`. */
const gauge = (n: number, of: number, w: number) => {
  const f = of > 0 ? Math.round(Math.min(1, Math.max(0, n / of)) * w) : 0;
  return "█".repeat(f) + "░".repeat(w - f);
};

/** A horizontal edge `w` cells wide with a title let into it, like `─ goals 3 ──────`. */
const edge = (title: string, w: number) => {
  const t = title ? `─ ${Array.from(title).slice(0, Math.max(0, w - 4)).join("")} ` : "";
  return t + "─".repeat(Math.max(0, w - cells(t)));
};

const COCKPIT_OWL = [" , .", "{@,@}", "/) )", ` '"`];
const GATE = 24; // cells inside the gate panel: a label, a count and a 10-cell gauge

/**
 * The status line as a cockpit, in whole cells and exactly `width` of them (80, the narrowest
 * pane it will meet). Three panels under one sharp-cornered frame: the owl; the gate — verdict
 * and age, specs met, the round against its cap, coverage, each with a gauge; and the goals —
 * one row per goal with its count, its first failing spec and what was found, and its text
 * scrolling in the cells left. The bottom edge carries why a failing turn was let go, else
 * the judge's next step. Below 64 cells the owl panel is dropped first. Colour marks status
 * only; the frame is dim so the readings lead.
 */
export function statusLines(
  s: Status | null,
  ctx: { specs: number; goals: GoalRow[]; round?: number; maxRounds: number; now?: number; width?: number; oneline?: boolean },
): string[] {
  const now = ctx.now ?? Date.now();
  const width = ctx.width ?? 80;
  const open = new Map((s?.unmet ?? []).map((u) => [u.id, u.found]));
  const tick = Math.floor(now / 500); // two cells a second at a one-second redraw
  const parts = s ? s.line.split(" · ").slice(1) : [];
  const [metN, total] = ((parts.find((p) => p.startsWith("specs ")) ?? "").slice(6).split("/").map(Number) as number[]);
  const specsTotal = total || ctx.specs;
  const specsMet = s ? metN ?? specsTotal - open.size : undefined;
  const cover = Number(/^coverage ([\d.]+)/.exec(parts.find((p) => p.startsWith("coverage")) ?? "")?.[1]);
  const next = parts.find((p) => p.startsWith("next="))?.slice(5).replace(/ ([\d.]+)$/, " $1");
  const tok = parts.find((p) => p.endsWith(" tok"));
  const [mark, role] = !s ? ["○ ARMED", ROLE.quiet] : s.note ? ["◐ LET GO", ROLE.warn] : s.block ? ["✗ BLOCK", ROLE.bad] : ["✓ PASS", ROLE.good];

  const failing = (g: GoalRow) => g.specs.filter((id) => open.has(id));
  const why = (ids: string[]) => `✗ ${ids[0]} ${open.get(ids[0])}${ids.length > 1 ? ` +${ids.length - 1}` : ""}`;
  if (ctx.oneline) {
    const first = ctx.goals.map(failing).find((f) => f.length);
    const head: Seg[] = [[mark, ROLE.strong + role], [s ? `  ${specsMet}/${specsTotal} specs · ${ago(s.at, now)}` : `  ${ctx.specs} specs`]];
    return [row([...head, [first ? ` · ${why(first)}` : ""]], width)];
  }

  const withOwl = width >= 64;
  const goalsW = width - GATE - (withOwl ? 15 : 7); // three panels, their borders and one cell of air each side
  const height = Math.max(4, ctx.goals.length);
  const B = ROLE.quiet;
  const bar = (n: number | undefined, of: number, r: string): Seg[] =>
    n === undefined || !Number.isFinite(n) ? [["–".padEnd(11), ROLE.quiet]] : [[gauge(n, of, 10), r], [" "]];
  const gate: Seg[][] = [
    [[mark, ROLE.strong + role], [s ? ago(s.at, now).padStart(GATE - cells(mark)) : "not judged".padStart(GATE - cells(mark)), ROLE.quiet]],
    [["specs ", ROLE.quiet], [`${specsMet ?? "–"}/${specsTotal}`.padEnd(7)], ...bar(specsMet, specsTotal, specsMet === specsTotal ? ROLE.good : ROLE.bad)],
    [["round ", ROLE.quiet], [(ctx.round ? `${ctx.round}/${ctx.maxRounds}` : "–").padEnd(7)], ...bar(ctx.round, ctx.maxRounds, ctx.round && ctx.round >= ctx.maxRounds ? ROLE.warn : "")],
    [["cover ", ROLE.quiet], [(Number.isFinite(cover) ? `${cover.toFixed(1)}/3` : "–").padEnd(7)], ...bar(Number.isFinite(cover) ? cover : undefined, 3, cover < 1.5 ? ROLE.bad : "")],
  ];
  const name = Math.max(0, ...ctx.goals.map((g) => cells(g.group)));
  const count = (n: number | string, of: number) =>
    `${n}/${of}`.padStart(2 * String(Math.max(0, ...ctx.goals.map((g) => g.specs.length))).length + 1);
  const goals: Seg[][] = ctx.goals.map((g, i) => {
    const f = failing(g);
    const segs: Seg[] = [
      [g.group.padEnd(name + 1)],
      [`${count(s ? g.specs.length - f.length : "–", g.specs.length)}  `, s && f.length ? ROLE.bad : ROLE.quiet],
      [f.length ? `${why(f)}  ` : ""],
    ];
    const room = goalsW - segs.reduce((n, [t]) => n + cells(t), 0);
    if (room >= 12) segs.push([scroll(g.text, room, tick + i * 5), ROLE.quiet]); // under 12 cells a goal is noise
    return segs;
  });

  const foot = s?.note ?? [next && `next ${next}`, tok].filter(Boolean).join(" · ");
  const inner = width - 2;
  const top = withOwl ? `┌${"─".repeat(7)}┬${edge("gate", GATE + 2)}┬${edge(`goals ${ctx.goals.length}`, goalsW + 2)}┐` : `┌${edge("gate", GATE + 2)}┬${edge(`goals ${ctx.goals.length}`, goalsW + 2)}┐`;
  const bottom = `└${edge(foot, inner)}┘`;
  const rows: string[] = [`${B}${top}${OFF}`];
  for (let i = 0; i < height; i++) {
    const owl = withOwl ? `${B}│${OFF} ${fit([[COCKPIT_OWL[i] ?? ""]], 5)} ` : "";
    rows.push(
      `${owl}${B}│${OFF} ${fit(gate[i] ?? [], GATE)} ${B}│${OFF} ${fit(goals[i] ?? [], goalsW)} ${B}│${OFF}`,
    );
  }
  // The bottom edge's title is the one reading that must not be missed: undimmed.
  rows.push(foot ? `${B}└─${OFF} ${row([[foot, s?.note ? ROLE.warn : ""]], inner - 4)} ${B}${"─".repeat(Math.max(0, inner - 3 - cells(row([[foot]], inner - 4))))}┘${OFF}` : `${B}${bottom}${OFF}`);
  return rows;
}
