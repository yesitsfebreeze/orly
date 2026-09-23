/**
 * Enrichment — evidence the transcript does not contain, fetched independently so the
 * agent being judged does not control what the judge sees. Built in: files a spec names.
 * Any other backend implements the same `Enricher` shape.
 */
import type { Turn } from "./gate.ts";
import type { Spec } from "./specs.ts";

/** Extra evidence, merged into the state under `project`. */
export type Evidence = Record<string, unknown>;

export type Enricher = (turn: Turn, specs: Spec[]) => Promise<Evidence>;

// Generous: a cut file gets confident wrong answers about what fell off the end
// (at 2 000 chars a README lost the section a spec asked about).
const MAX_FILE_CHARS = Number(process.env.ORLY_MAX_FILE_CHARS ?? 12_000);
const MAX_FILES = 8;

export type FileOptions = {
  /** Names that are not files (declared context sources). Never read. */
  skip?: Iterable<string>;
  /**
   * Names that MAY be files (from `gather` specs). A miss records nothing: "[file does
   * not exist]" about a non-file would read as a finding.
   */
  soft?: Iterable<string>;
};

/**
 * Every distinct path the specs name as evidence, minus `skip`. A non-path read as a path
 * records "[file does not exist]", which looks exactly like a verdict.
 */
export function evidencePaths(specs: Spec[], skip: Iterable<string> = []): string[] {
  const not = new Set(skip);
  const seen = new Set<string>();
  for (const s of specs) for (const p of s.evidence ?? []) if (!not.has(p)) seen.add(p);
  return [...seen].slice(0, MAX_FILES);
}

/** Read the files the specs point at, from disk, now: "is the stub gone", not "did the agent say so". */
export function fileEnricher(
  cwd: string,
  read: (path: string) => Promise<string>,
  opts: FileOptions = {},
): Enricher {
  return async (_turn, specs) => {
    const paths = evidencePaths(specs, opts.skip ?? []);
    const soft = new Set(opts.soft ?? []);
    if (!paths.length) return {};
    const files: Record<string, string> = {};
    for (const path of paths) {
      try {
        const body = await read(`${cwd}/${path}`.replace(/\/+/g, "/"));
        // Mark truncation loudly so a low score is not read as a verdict on the whole file.
        files[path] =
          body.length > MAX_FILE_CHARS
            ? `${body.slice(0, MAX_FILE_CHARS)}\n…[TRUNCATED: ${body.length - MAX_FILE_CHARS} more chars not shown — do not treat anything below as absent]`
            : body;
      } catch {
        // Absence is evidence, unless the name was never claimed to be a path.
        if (!soft.has(path)) files[path] = "[file does not exist]";
      }
    }
    return Object.keys(files).length ? { files } : {};
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
