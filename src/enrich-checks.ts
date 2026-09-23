/**
 * Runs the project's own checks (tests, type checker, linter) and puts exit codes and
 * match counts in `project.checks` for `require` specs to assert on in code. If a check
 * can answer it, the model is not asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Enricher, Evidence } from "./enrich.ts";
import { treeFingerprint } from "./fingerprint.ts";

export type CheckSpec = {
  /** Shell command to run. Its exit code and output become evidence. */
  command: string;
  /** Optional regex with one capture group; the count of matches becomes `.matches`. */
  countPattern?: string;
  timeoutMs?: number;
};

// Small: `require` reads only `exit`/`matches`; the text is for humans. Full output
// buried the evidence other specs needed.
const MAX_OUT = Number(process.env.ORLY_MAX_CHECK_OUT ?? 400);

export const CACHE_NAME = "checks.json";

/**
 * Results a watcher computed earlier. The gate recomputes the tree fingerprint and drops
 * any entry that does not match: staleness may cost time, never correctness.
 */
function cached(root: string, fingerprint: string | null): Record<string, any> {
  if (!fingerprint) return {};
  try {
    const raw = JSON.parse(readFileSync(join(root, ".orly", CACHE_NAME), "utf8"));
    const out: Record<string, any> = {};
    for (const [name, entry] of Object.entries<any>(raw ?? {})) {
      if (entry?.fingerprint === fingerprint) out[name] = entry.result;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Turn `{name: {command}}` into `project.checks[name] = {exit, out, matches}`. A check that
 * cannot run records `exit: null`, which no numeric `require` satisfies (fails closed).
 */
export function checkEnricher(checks: Record<string, CheckSpec>, cwd: string): Enricher {
  return async (_turn, specs): Promise<Evidence> => {
    // Only checks some `require` spec reads: unused evidence costs run time and dilutes
    // every other judgment in the state.
    const wanted = new Set(
      (specs ?? [])
        .map((s) => s.require?.path)
        .filter((p): p is string => typeof p === "string" && p.startsWith("checks."))
        .map((p) => p.split(".")[1]),
    );
    const names = Object.keys(checks ?? {}).filter((n) => wanted.has(n));
    if (!names.length) return {};

    const fresh = cached(cwd, treeFingerprint(cwd));
    const toRun = names.filter((n) => !(n in fresh));
    if (!toRun.length) return { checks: Object.fromEntries(names.map((n) => [n, fresh[n]])) };
    // In parallel, since checks are the gate's main local latency; commands must
    // therefore be independent of each other.
    const entries = await Promise.all(
      toRun.map(async (name) => {
      const spec = checks[name];
      try {
        const proc = Bun.spawn(["sh", "-c", spec.command], { cwd, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill(), spec.timeoutMs ?? 60_000);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exit = await proc.exited;
        clearTimeout(timer);
        const text = `${stdout}${stderr}`;
        const record: Record<string, unknown> = { exit, out: text.slice(-MAX_OUT) };
        if (spec.countPattern) {
          try {
            record.matches = (text.match(new RegExp(spec.countPattern, "g")) ?? []).length;
          } catch {
            record.matches = null; // a bad pattern must not pass as zero matches
          }
        }
        return [name, record] as const;
      } catch {
        return [name, { exit: null, out: "[check could not run]" }] as const;
      }
      }),
    );
    return { checks: { ...fresh, ...Object.fromEntries(entries) } };
  };
}
