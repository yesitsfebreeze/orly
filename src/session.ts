/**
 * Loop control.
 *
 * A gate that can block is a gate that can trap. Generated specs are guesses, and a spec
 * that can never be satisfied — because it asks for something the environment cannot do,
 * or because it is worded in a way Jev reads differently than its author meant — would
 * otherwise loop the agent forever.
 *
 * Three exits, all of them in code rather than in the model's hands:
 *   - every spec met
 *   - the agent declares plainly what it could not do and why
 *   - the round cap, or two rounds with no improvement
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import type { Spec, SpecFile } from "./specs.ts";

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
 * Find the `.orly` directory by walking up from `start`, the way git finds `.git`.
 *
 * An agent's working directory moves around inside a project — into a subpackage, into
 * the plugin's own folder — while `.orly` sits at the root. Looking only in `cwd` means
 * the gate silently switches itself off the moment the agent cd's anywhere, which is
 * indistinguishable from it being uninstalled.
 */
export function findOrlyDir(start: string): string | null {
  let dir = start;
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, ".orly"))) return join(dir, ".orly");
    if (dir === root) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The project root: the directory holding `.orly`.
 *
 * Every path in a spec's `evidence` is relative to this, never to the working directory.
 * An agent's cwd moves around inside a project, so resolving against it makes a spec pass
 * or fail depending on where the agent happened to be standing — the same spec scored 0.87
 * from the root and 0.11 from a subdirectory, because its files silently read as missing.
 */
export function projectRoot(cwd: string): string | null {
  const dir = findOrlyDir(cwd);
  return dir ? dirname(dir) : null;
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
export const userOrlyDir = () => join(homedir(), ".orly");

/**
 * Cuts learned anywhere, applied everywhere.
 *
 * A spec wording that has been fitted once should not need fitting again in the next repo.
 * `~/.orly/cuts.json` maps a spec id to the cut measured for it, and any project spec that
 * does not state its own `cut` inherits it. This is the mechanism by which working on the
 * tool in one place improves it in all the others.
 */
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
    // Losing the counter costs us the cap, so the block-per-chain floor still applies.
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
 * Decide whether blocking is still justified, and carry the counters forward.
 *
 * `met` is how many specs passed this round. Progress is measured against the best round
 * so far rather than the previous one, so an agent that thrashes between two partial
 * states is treated as stalled instead of as making progress.
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
