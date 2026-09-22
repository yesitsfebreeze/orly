/**
 * The evidence every host wants, wired once.
 *
 * A judgment is only as good as the state it is handed, and the three sources that make
 * that state independent of the agent's narration — the files a spec names, the project's
 * own checks, whatever kern knows about the goal — were assembled separately in the Stop
 * hook and in the CLI. They drifted: the CLI gathered files but never ran the checks, so
 * every `require` spec read as unmet through `orly judge` while passing through the hook,
 * on the same repository.
 *
 * One function now. A new host gets the same evidence as the reference one by calling it.
 */
import { combine, fileEnricher, type Enricher } from "./enrich.ts";
import { checkEnricher, type CheckSpec } from "./enrich-checks.ts";
import { kernMemoryEnricher } from "./enrich-kern.ts";
import { loadConfig, projectRoot } from "./session.ts";

export type EvidenceOptions = {
  /** Where the host is standing. The project root is found from here. */
  cwd?: string;
  /** The goal, for the knowledge enricher. Omitted means that source is skipped. */
  goal?: string;
  /** Override the checks from `.orly/config.json`. */
  checks?: Record<string, CheckSpec>;
};

/**
 * Every path and command resolves from the directory holding `.orly`, never from `cwd`.
 *
 * An agent's working directory moves inside a project; the project root does not. The
 * same spec scored 0.87 from the root and 0.11 from a subdirectory because its files
 * silently read as missing, and four checks reported failures on a clean tree because
 * `cd sub && …` failed and the shell's error text got counted as a violation. Nothing
 * errored either time.
 */
export function projectEvidence(opts: EvidenceOptions = {}): Enricher {
  const cwd = opts.cwd ?? process.cwd();
  const root = projectRoot(cwd) ?? cwd;
  return combine(
    fileEnricher(root, (path) => Bun.file(path).text()),
    kernMemoryEnricher(opts.goal ?? "", cwd),
    checkEnricher(opts.checks ?? loadConfig(cwd).checks ?? {}, root),
  );
}
