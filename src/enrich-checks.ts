/**
 * Running the project's own checks and putting the results in evidence.
 *
 * This is what turns orly from "judge the transcript" into a pipeline over live code. A
 * language server, a type checker, a linter or a test runner already knows the truth —
 * exactly, not probably. Run it, put the numbers in `project.checks`, and let a `require`
 * spec assert on them in code.
 *
 * The division of labour that matters: if a check can answer it, the model must not be
 * asked. Diagnostics counts, exit codes and symbol presence are facts. The model is for
 * what is left over — whether the work matches what was asked, whether a claim is backed,
 * whether a stub stands in for the request. Those have no command that decides them.
 */
import type { Enricher, Evidence } from "./enrich.ts";

export type CheckSpec = {
  /** Shell command to run. Its exit code and output become evidence. */
  command: string;
  /** Optional regex with one capture group; the count of matches becomes `.matches`. */
  countPattern?: string;
  timeoutMs?: number;
};

// Small on purpose. A `require` spec asserts on `exit` and `matches`; the text is only
// there for a human reading a blocked turn. Dumping a whole test run into state buries
// the evidence a judgment actually needs — measured, it pushed one state from 6k to 28k
// chars and the file-evidence specs stopped finding what they were pointed at.
const MAX_OUT = Number(process.env.ORLY_MAX_CHECK_OUT ?? 400);

/**
 * Turn `{name: {command}}` into `project.checks[name] = {exit, out, matches}`.
 *
 * A check that cannot run records `exit: null`, which no numeric `require` will satisfy —
 * an enricher that failed must never read as a passing gate.
 */
export function checkEnricher(checks: Record<string, CheckSpec>, cwd: string): Enricher {
  return async (): Promise<Evidence> => {
    const names = Object.keys(checks ?? {});
    if (!names.length) return {};
    const out: Record<string, unknown> = {};
    for (const name of names) {
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
        out[name] = record;
      } catch {
        out[name] = { exit: null, out: "[check could not run]" };
      }
    }
    return { checks: out };
  };
}
