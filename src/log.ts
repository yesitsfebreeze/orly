/**
 * The verdict log: one record per judgment, the dataset `orly fit` proposes cuts from.
 * A block is labelled by the next turn: real work means it found something, talk only means
 * it probably did not. Labels are weak evidence; nothing rewrites a threshold from them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOG_NAME = "log.jsonl";
export const KEEP_RECORDS = 1000; // ponytail: newest win; raise if `orly fit` starves for support.

export type Judged = {
  /** ISO timestamp. */
  at: string;
  session: string;
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
  /** The cuts this verdict was decided at, so `orly fit` knows which cut produced each outcome. */
  thresholds?: Record<string, number>;
  /** Set on the NEXT judgment of the same session: what the agent did after a block. */
  outcome?: "worked" | "explained" | "unknown";
};

export const logPath = (orlyDir: string) => join(orlyDir, LOG_NAME);

export function append(orlyDir: string, record: Judged): void {
  // Dry runs (fixture replays, smoke tests) must not enter the tuning dataset.
  if (process.env.ORLY_NO_LOG) return;
  try {
    mkdirSync(dirname(logPath(orlyDir)), { recursive: true });
    appendFileSync(logPath(orlyDir), `${JSON.stringify(record)}\n`);
    const lines = readFileSync(logPath(orlyDir), "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP_RECORDS) writeFileSync(logPath(orlyDir), `${lines.slice(-KEEP_RECORDS).join("\n")}\n`);
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
 * Label a block by the same session's next turn (sessions interleave in one log): `worked` if it ran commands or made edits,
 * `explained` if it only talked (a sign the cut is too tight). Weak evidence; nothing may
 * loosen a cut from it automatically.
 */
export function label(records: Judged[]): Judged[] {
  const out = records.map((r) => ({ ...r }));
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].blocked) continue;
    const next = out.slice(i + 1).find((r) => r.session === out[i].session);
    if (!next) continue;
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
 * Propose a cut per spec from logged turns: midway between the probabilities of blocks
 * that led to work (should fire) and blocks that were only explained (should not).
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
