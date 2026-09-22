/**
 * Enrichment — giving the judge evidence the transcript does not contain.
 *
 * Without this, every spec is judged against what the agent *chose to show*. A spec like
 * "the stub is gone" is then only answerable if the agent happened to print the file, and
 * an agent that never looks can never be caught. That makes the gate narratable: the thing
 * being judged controls the evidence.
 *
 * Enrichment closes that by fetching state independently. Two sources, both optional:
 *   - files a spec names as its evidence, read at judging time
 *   - whatever the project's own knowledge service knows about the goal
 *
 * The interface is deliberately plain, so a host with a different backend — a vector
 * store, an issue tracker, a build server — implements the same shape.
 */
import type { Turn } from "./gate.ts";
import type { Spec } from "./specs.ts";

/** Extra evidence, merged into the state under `project`. */
export type Evidence = Record<string, unknown>;

export type Enricher = (turn: Turn, specs: Spec[]) => Promise<Evidence>;

// Generous, because truncating evidence is worse than not gathering it: a spec asking
// about a section that fell off the end gets a confident answer about a file it never
// fully saw. Measured — a README cut at 2 000 chars lost the link section a spec asked
// about, and the spec scored 0.10 on a file that plainly satisfied it.
const MAX_FILE_CHARS = Number(process.env.ORLY_MAX_FILE_CHARS ?? 12_000);
const MAX_FILES = 8;

/** Every distinct path the specs name as evidence. */
export function evidencePaths(specs: Spec[]): string[] {
  const seen = new Set<string>();
  for (const s of specs) for (const p of s.evidence ?? []) seen.add(p);
  return [...seen].slice(0, MAX_FILES);
}

/**
 * Read the files the specs point at, from disk, now.
 *
 * This is the enricher that matters most and the one with no dependencies: it turns
 * "did the agent tell me the stub is gone" into "is the stub gone".
 */
export function fileEnricher(cwd: string, read: (path: string) => Promise<string>): Enricher {
  return async (_turn, specs) => {
    const paths = evidencePaths(specs);
    if (!paths.length) return {};
    const files: Record<string, string> = {};
    for (const path of paths) {
      try {
        const body = await read(`${cwd}/${path}`.replace(/\/+/g, "/"));
        // Say so loudly when it does happen, so a low score is not mistaken for a verdict
        // about the whole file.
        files[path] =
          body.length > MAX_FILE_CHARS
            ? `${body.slice(0, MAX_FILE_CHARS)}\n…[TRUNCATED: ${body.length - MAX_FILE_CHARS} more chars not shown — do not treat anything below as absent]`
            : body;
      } catch {
        // A path that does not exist is itself evidence, and often the answer.
        files[path] = "[file does not exist]";
      }
    }
    return { files };
  };
}

/** Run several enrichers, letting any of them fail without taking the judgment down. */
export function combine(...enrichers: Enricher[]): Enricher {
  return async (turn, specs) => {
    const out: Evidence = {};
    const settled = await Promise.allSettled(enrichers.map((e) => e(turn, specs)));
    for (const r of settled) if (r.status === "fulfilled") Object.assign(out, r.value);
    return out;
  };
}

/** Attach evidence to a turn without letting it masquerade as something the agent did. */
export function withEvidence(turn: Turn, evidence: Evidence): Turn & { project?: Evidence } {
  if (!evidence || !Object.keys(evidence).length) return turn;
  return { ...turn, project: evidence };
}
