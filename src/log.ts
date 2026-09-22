/**
 * The verdict log — the only thing that makes orly get better instead of staying still.
 *
 * Every judgment appends one record. That log is the dataset: real turns, real
 * probabilities, real outcomes, instead of fixtures one person imagined. Cuts fitted on
 * nine hand-written fixtures are fitted on one person's idea of what going wrong looks
 * like; cuts fitted on a thousand logged turns are fitted on what actually happens.
 *
 * The labels come free. When the gate blocks and the agent's next turn does real work —
 * edits, commands — the block found something. When the gate blocks and the next turn only
 * explains itself and then passes, the block probably cost more than it was worth. Neither
 * label is certain, which is why `orly fit` reports them as evidence and never silently
 * rewrites a threshold.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOG_NAME = "log.jsonl";

export type Judged = {
  /** ISO timestamp. */
  at: string;
  session: string;
  /** The goal these specs came from, so records outlive a changed spec set. */
  goal?: string;
  blocked: boolean;
  /** Every question id to its probability (or Score value). */
  scores: Record<string, number>;
  /** Spec ids that did not meet their cut. */
  unmet: string[];
  /** Which built-in hazards fired. */
  hazards: string[];
  /** Counts, to tell a thin turn from a long one without storing the transcript. */
  actions: number;
  results: number;
  /** Set on the NEXT judgment of the same session: what the agent did after a block. */
  outcome?: "worked" | "explained" | "unknown";
};

export const logPath = (orlyDir: string) => join(orlyDir, LOG_NAME);

export function append(orlyDir: string, record: Judged): void {
  // A dry run must not enter the dataset the gate later tunes itself on. Fixture replays
  // and smoke tests look exactly like real turns once they are a line in the log.
  if (process.env.ORLY_NO_LOG) return;
  try {
    mkdirSync(dirname(logPath(orlyDir)), { recursive: true });
    appendFileSync(logPath(orlyDir), `${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never be the reason a turn cannot be judged.
  }
}

export function read(orlyDir: string): Judged[] {
  const path = logPath(orlyDir);
  if (!existsSync(path)) return [];
  const out: Judged[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a truncated final line is normal for an append-only log */
    }
  }
  return out;
}

/**
 * Label a block by what the agent did next.
 *
 * `worked`   — the following turn ran commands or made edits: the block bought something.
 * `explained`— the following turn only talked and then passed: the block probably cost a
 *              round for nothing, which is the signal a cut is too tight.
 *
 * This is a weak label and it is meant to be. It is evidence to look at, not a fact, and
 * nothing may act on it automatically in the loosening direction.
 */
export function label(records: Judged[]): Judged[] {
  const out = records.map((r) => ({ ...r }));
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].blocked) continue;
    const next = out[i + 1];
    if (next.session !== out[i].session) continue;
    out[i].outcome = next.actions > 0 || next.results > 0 ? "worked" : "explained";
  }
  return out;
}

export type Proposal = {
  id: string;
  /** What the log says the cut should be. */
  suggested: number;
  current: number;
  direction: "tighten" | "loosen";
  /** How many logged turns back this. */
  support: number;
  metFloor: number;
  unmetCeiling: number;
};

/**
 * Propose a cut per spec from logged turns.
 *
 * A block whose next turn did real work is a case the spec SHOULD have caught; a block
 * whose next turn only explained is one it should not have. The usable cut sits between
 * those two populations, exactly as in the fixture harness — but measured on real work.
 */
export function propose(records: Judged[], currentCuts: Record<string, number>, minSupport = 6): Proposal[] {
  const met: Record<string, number[]> = {};
  const unmet: Record<string, number[]> = {};

  for (const r of label(records)) {
    if (!r.blocked || !r.outcome) continue;
    for (const id of r.unmet) {
      const p = r.scores[id];
      if (typeof p !== "number") continue;
      // "worked" ⇒ firing here was right, so this probability belongs below the cut.
      // "explained" ⇒ firing here was wrong, so it belongs above it.
      (r.outcome === "worked" ? unmet : met)[id] ??= [];
      (r.outcome === "worked" ? unmet : met)[id].push(p);
    }
  }

  const out: Proposal[] = [];
  for (const id of new Set([...Object.keys(met), ...Object.keys(unmet)])) {
    const m = met[id] ?? [];
    const u = unmet[id] ?? [];
    if (m.length + u.length < minSupport) continue;
    const metFloor = m.length ? Math.min(...m) : Number.NaN;
    const unmetCeiling = u.length ? Math.max(...u) : Number.NaN;
    if (!Number.isFinite(metFloor) || !Number.isFinite(unmetCeiling)) continue;
    if (metFloor <= unmetCeiling) continue; // no cut separates them; the wording is at fault
    const suggested = Number(((metFloor + unmetCeiling) / 2).toFixed(2));
    const current = currentCuts[id] ?? 0.7;
    if (Math.abs(suggested - current) < 0.03) continue;
    out.push({
      id,
      suggested,
      current,
      direction: suggested > current ? "tighten" : "loosen",
      support: m.length + u.length,
      metFloor,
      unmetCeiling,
    });
  }
  return out;
}
