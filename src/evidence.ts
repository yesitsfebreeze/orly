/**
 * The evidence every host wants, wired once.
 *
 * A judgment is only as good as the state it is handed, and the sources that make that
 * state independent of the agent's narration were assembled separately in the Stop hook
 * and in the CLI. They drifted: the CLI gathered files but never ran the checks, so every
 * `require` spec read as unmet through `orly judge` while passing through the hook, on
 * the same repository. One function now.
 *
 * Three kinds of source, and no vendor among them:
 *
 *   files     the paths a spec names, read at judging time
 *   checks    a command's exit code and match count, asserted in code
 *   context   a command's OUTPUT, put in front of the judge to read
 *
 * That is the whole surface. A ticket, a deploy, a migration status, a knowledge service:
 * each is a command somebody declares, so any tool a shell can run is already integrated
 * and orly knows the name of none of them.
 */
import { combine, fileEnricher, type Enricher } from "./enrich.ts";
import { checkEnricher, type CheckSpec } from "./enrich-checks.ts";
import { contextEnricher, type ContextSpec } from "./enrich-context.ts";
import { loadConfig, projectRoot } from "./session.ts";

export type EvidenceOptions = {
  /** Where the host is standing. The project root is found from here. */
  cwd?: string;
  /** Override the checks from `.orly/config.json`. */
  checks?: Record<string, CheckSpec>;
  /** Override the context sources from `.orly/config.json`. */
  context?: Record<string, ContextSpec>;
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
  const config = loadConfig(cwd);
  const context = opts.context ?? config.context ?? {};
  const enrich: Enricher = async (turn, specs) => {
    // A declared context source is named in `evidence` like a file is, so the file reader
    // has to be told which of those names are not paths. A spec carrying a `gather`
    // instruction names things that may not be files at all: read them if they are, and
    // stay silent rather than reporting absence if they are not.
    const soft = (specs ?? []).filter((s) => s.gather).flatMap((s) => s.evidence ?? []);
    return combine(
      fileEnricher(root, (path) => Bun.file(path).text(), { skip: Object.keys(context), soft }),
      checkEnricher(opts.checks ?? config.checks ?? {}, root),
      contextEnricher(context, root),
    )(turn, specs);
  };
  return enrich;
}
