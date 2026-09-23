/**
 * The evidence every host uses, wired once so hook and CLI cannot drift: files a spec
 * names, checks (exit code and match count, asserted in code) and context (command
 * output the judge reads). Every integration is a declared command; orly names no vendor.
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
 * Every path and command resolves from the directory holding `.orly`, never from `cwd`:
 * from a subdirectory, files silently read as missing and checks fail on a clean tree.
 */
export function projectEvidence(opts: EvidenceOptions = {}): Enricher {
  const cwd = opts.cwd ?? process.cwd();
  const root = projectRoot(cwd) ?? cwd;
  const config = loadConfig(cwd);
  const context = opts.context ?? config.context ?? {};
  const enrich: Enricher = async (turn, specs) => {
    // Context source names are not paths, so the file reader skips them. Names from a
    // `gather` spec may not be files: read them if they are, stay silent if not.
    const soft = (specs ?? []).filter((s) => s.gather).flatMap((s) => s.evidence ?? []);
    return combine(
      fileEnricher(root, (path) => Bun.file(path).text(), { skip: Object.keys(context), soft }),
      checkEnricher(opts.checks ?? config.checks ?? {}, root),
      contextEnricher(context, root),
    )(turn, specs);
  };
  return enrich;
}
