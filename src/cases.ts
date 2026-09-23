/**
 * Regression cases. Every judged turn is saved locally (never committed) with the evidence
 * the judge saw; a misjudged one is promoted to a case: frozen turn, expected verdict, and
 * the spec that must catch it. Replay runs every case against the current specs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Turn, Verdict } from "./gate.ts";
import type { Evidence } from "./enrich.ts";

export const TURNS = "turns";
export const CASES = "cases";
export const HISTORY = "replay.jsonl";
// ponytail: fixed window of recent turns; a mistake is reported within a few turns, raise if 50 proves too few.
const KEEP_TURNS = 50;

export type SavedTurn = {
  at: string;
  session: string;
  turn: Turn;
  evidence?: Evidence;
  blocked: boolean;
  unmet: string[];
};

export type Case = {
  /** What went wrong, in the user's words. */
  note: string;
  expect: {
    block: boolean;
    /** Spec ids that must come back unmet: the spec written to catch this mistake. */
    unmet?: string[];
  };
  from: string;
  turn: Turn;
  evidence?: Evidence;
};

export type Outcome = { name: string; ok: boolean; problem?: string; blocked: boolean };

/** Keep one judged turn for later promotion. Never throws: saving is not judging. */
export function saveTurn(orlyDir: string, saved: SavedTurn): string | undefined {
  if (process.env.ORLY_NO_LOG) return;
  try {
    const dir = join(orlyDir, TURNS);
    mkdirSync(dir, { recursive: true });
    const id = `${saved.at.replace(/[:.]/g, "-")}-${saved.session.slice(0, 8)}`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(saved));
    const all = listTurns(orlyDir);
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_TURNS))) unlinkSync(join(dir, `${old}.json`));
    return id;
  } catch {
    return;
  }
}

/** Saved turn ids, oldest first. */
export function listTurns(orlyDir: string): string[] {
  const dir = join(orlyDir, TURNS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
}

export function readTurn(orlyDir: string, id: string): SavedTurn {
  const ids = listTurns(orlyDir);
  const pick = id === "last" ? ids.at(-1) : ids.find((t) => t === id || t.startsWith(id));
  if (!pick) throw new Error(id === "last" ? "no saved turns yet" : `no saved turn matches "${id}"`);
  return { ...JSON.parse(readFileSync(join(orlyDir, TURNS, `${pick}.json`), "utf8")), id: pick } as SavedTurn;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "case";

/** Promote a saved turn to a committed case. Returns the case file's path. */
export function promote(orlyDir: string, from: SavedTurn & { id?: string }, expect: Case["expect"], note: string): string {
  const dir = join(orlyDir, CASES);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${slug(note)}.json`);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${slug(note)}_${i}.json`);
  const c: Case = { note, expect, from: from.id ?? from.at, turn: from.turn, evidence: from.evidence };
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`);
  return path;
}

export function readCases(orlyDir: string): Array<Case & { name: string }> {
  const dir = join(orlyDir, CASES);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), name: basename(f, ".json") }));
}

/** Did the verdict on a replayed case come out the way the case says it must? */
export function check(c: Case & { name: string }, verdict: Verdict, specIds: string[]): Outcome {
  const base = { name: c.name, blocked: verdict.block };
  for (const id of c.expect.unmet ?? []) {
    if (!specIds.includes(id)) return { ...base, ok: false, problem: `spec "${id}" does not exist in .orly/specs/` };
    const r = verdict.results.find((x) => x.spec.id === id);
    if (!r || r.met) return { ...base, ok: false, problem: `spec "${id}" did not fire` };
  }
  if (verdict.block !== c.expect.block)
    return { ...base, ok: false, problem: c.expect.block ? "passed, should have blocked" : "blocked, should have passed" };
  return { ...base, ok: true };
}

export type Run = { at: string; total: number; right: number; wrong: string[] };

/** Append one replay to the history and return the history, oldest first. */
export function recordRun(orlyDir: string, run: Run): Run[] {
  const path = join(orlyDir, HISTORY);
  const prior = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run)
    : [];
  writeFileSync(path, [...prior, run].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return [...prior, run];
}
