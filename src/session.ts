/**
 * Loop control and spec/config loading. An unsatisfiable spec must not trap the agent, so the
 * loop ends in code: every spec met, the agent declares what it could not do, or the round
 * cap / stall limit is hit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import type { Spec, SpecFile } from "./specs.ts";
import { loadTree } from "./spectree.ts";

export const SPEC_PATH = ".orly/specs.json";
export const DEFAULT_MAX_ROUNDS = 6;
/** Rounds without a single newly-met spec before we conclude the loop is stuck. */
export const STALL_ROUNDS = 2;

export type RoundState = {
  goal: string;
  rounds: number;
  /** Best number of specs met in any round so far. */
  bestMet: number;
  /** Consecutive rounds that did not beat `bestMet`. */
  stalled: number;
};

/**
 * Find `.orly` by walking up from `start`, as git finds `.git`, so the gate stays on when the
 * agent cd's into a subdirectory. ~/.orly is the user layer, never a project.
 */
export function findOrlyDir(start: string): string | null {
  let dir = start;
  const { root } = parse(dir);
  const user = userOrlyDir();
  for (;;) {
    const here = join(dir, ".orly");
    if (here !== user && existsSync(here)) return here;
    if (dir === root) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The directory holding `.orly`. Spec `evidence` paths resolve against it, never the cwd. */
export function projectRoot(cwd: string): string | null {
  const dir = findOrlyDir(cwd);
  return dir ? dirname(dir) : null;
}

/**
 * The API key: `TYPESAFE_API_KEY`, else the output of the user-configured `keyCommand`
 * (hooks do not inherit the interactive shell's environment).
 */
export function resolveKey(cwd: string = process.cwd()): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const command = process.env.ORLY_KEY_COMMAND ?? loadConfig(cwd).keyCommand;
  if (typeof command !== "string" || !command.trim()) return undefined;
  try {
    const out = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", stderr: "ignore" });
    return out.stdout.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Whatever `.orly/config.json` holds, or an empty object. */
export function loadConfig(cwd: string): Record<string, any> {
  const dir = findOrlyDir(cwd);
  if (!dir) return {};
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** The user-level layer, shared by every project on this machine. */
export const userOrlyDir = () => join(process.env.HOME || homedir(), ".orly");

/** `~/.orly/cuts.json`: spec id to fitted cut, inherited by any project spec without its own `cut`. */
export function loadUserCuts(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(join(userOrlyDir(), "cuts.json"), "utf8"));
    const out: Record<string, number> = {};
    for (const [id, v] of Object.entries(raw)) if (typeof v === "number") out[id] = v;
    return out;
  } catch {
    return {};
  }
}

/** Specs that apply in every project, e.g. "never claim what the output does not show". */
export function loadUserSpecs(): Spec[] {
  try {
    const raw = JSON.parse(readFileSync(join(userOrlyDir(), "specs.json"), "utf8"));
    return Array.isArray(raw?.specs) ? raw.specs : [];
  } catch {
    return [];
  }
}

/**
 * Merge the two layers: the project's specs, plus any user-level spec it has not overridden,
 * with user-level cuts filled in where a spec states none.
 */
export function resolveSpecs(projectSpecs: Spec[]): Spec[] {
  const cuts = loadUserCuts();
  const byId = new Map<string, Spec>();
  for (const s of loadUserSpecs()) byId.set(s.id, s);
  for (const s of projectSpecs) byId.set(s.id, s); // the project always wins
  return [...byId.values()].map((s) => (typeof s.cut === "number" ? s : { ...s, cut: cuts[s.id] }));
}

export function loadSpecFile(cwd: string): SpecFile | null {
  const orlyDir = findOrlyDir(cwd);
  if (!orlyDir) return null;
  // The spec tree wins; a single specs.json is still read for projects that have one.
  const tree = loadTree(orlyDir);
  if (tree) return { ...tree, specs: resolveSpecs(tree.specs) };
  const path = join(orlyDir, "specs.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.specs)) return null;
    return { ...parsed, specs: resolveSpecs(parsed.specs) } as SpecFile;
  } catch {
    // A malformed spec file must not take the gate down with it.
    return null;
  }
}

const statePath = (dir: string, sessionId: string) => join(dir, `orly-rounds-${sessionId}.json`);

export function readRounds(dir: string, sessionId: string): RoundState | null {
  try {
    return JSON.parse(readFileSync(statePath(dir, sessionId), "utf8")) as RoundState;
  } catch {
    return null;
  }
}

export function writeRounds(dir: string, sessionId: string, state: RoundState): void {
  try {
    mkdirSync(dirname(statePath(dir, sessionId)), { recursive: true });
    writeFileSync(statePath(dir, sessionId), JSON.stringify(state));
  } catch {
    // Losing the counter loses the cap; the block-per-chain floor still applies.
  }
}

export type LoopDecision = {
  /** May the gate block this round? */
  mayBlock: boolean;
  /** Why not, when it may not. */
  note?: string;
  next: RoundState;
};

/**
 * Decide whether blocking is still justified and carry the counters forward. `met` is specs
 * passed this round; progress is measured against the best round so thrashing counts as stalled.
 */
export function advance(
  prev: RoundState | null,
  goal: string,
  met: number,
  maxRounds = DEFAULT_MAX_ROUNDS,
): LoopDecision {
  // A changed goal is a new loop; the old counters describe different work.
  const base: RoundState =
    prev && prev.goal === goal ? prev : { goal, rounds: 0, bestMet: -1, stalled: 0 };

  const improved = met > base.bestMet;
  const next: RoundState = {
    goal,
    rounds: base.rounds + 1,
    bestMet: Math.max(base.bestMet, met),
    stalled: improved ? 0 : base.stalled + 1,
  };

  if (next.rounds > maxRounds) {
    return {
      mayBlock: false,
      note: `round cap reached (${maxRounds}) — letting the turn end so the user can decide`,
      next,
    };
  }
  if (next.stalled > STALL_ROUNDS) {
    return {
      mayBlock: false,
      note: `no spec newly met in ${next.stalled} rounds — letting the turn end rather than looping`,
      next,
    };
  }
  return { mayBlock: true, next };
}
