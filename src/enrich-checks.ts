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
  return async (_turn, specs): Promise<Evidence> => {
    // Only run the checks some `require` spec actually reads.
    //
    // Evidence nothing consumes is not free: it is text in every state, competing for
    // attention with the questions that do matter. Measured — carrying all nine check
    // results collapsed one judgment spec's separation from 0.34 to 0.07 and another's
    // from 0.72 to 0.06, purely by being there. It also saves running the commands.
    const wanted = new Set(
      (specs ?? [])
        .map((s) => s.require?.path)
        .filter((p): p is string => typeof p === "string" && p.startsWith("checks."))
        .map((p) => p.split(".")[1]),
    );
    const names = Object.keys(checks ?? {}).filter((n) => wanted.has(n));
    if (!names.length) return {};
    // In parallel: these are the gate's own latency, and they are the only local cost in
    // a judgment that is not microseconds — measured on this repository, nine checks cost
    // 1 069 ms run one after another and are bounded by the slowest at 522 ms. The judge
    // round trip alongside them is around 480 ms, so a sequential sweep doubles the wait.
    //
    // The commands must therefore be independent of each other. That is what a check is —
    // a question about the tree, not a step in a build — and every CI runs them this way.
    const entries = await Promise.all(
      names.map(async (name) => {
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
    return { checks: Object.fromEntries(entries) };
  };
}
