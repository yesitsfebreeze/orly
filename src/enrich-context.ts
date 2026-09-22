/**
 * Whatever else decides whether the work is done.
 *
 * `checks` answer facts in code — exit codes, counts — and never reach the model. That is
 * right for a test run and useless for a ticket: "the Jira issue is in review and the
 * acceptance criteria name a rollback" is a reading, not a comparison, and no exit code
 * expresses it.
 *
 * So a project may declare named context sources: one command each, output put in front
 * of the judge under `project.context`. A spec names the source in its `evidence` and asks
 * about it in words. The integration is a command the user wrote, not a plugin this
 * project has to ship — anything with a CLI or a curl is already supported.
 *
 *   "context": { "ticket": { "command": "jira issue view $TICKET --plain" } }
 *
 *   { "id": "ticket_accepted", "evidence": ["ticket"],
 *     "instructions": "Look at `ticket` under `project.context`. Do its acceptance
 *                      criteria all appear in the work recorded in `actions_taken`?" }
 */
import type { Enricher, Evidence } from "./enrich.ts";

export type ContextSpec = {
  /** Shell command. Its output is the evidence. */
  command: string;
  /** Default 6 000. Generous, because a source clipped where the answer was is worse
   *  than no source at all — measured, twice, on files. */
  maxChars?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX = Number(process.env.ORLY_MAX_CONTEXT_CHARS ?? 6_000);

/** Every context source some spec asks about, by name. */
export function wantedSources(sources: Record<string, ContextSpec>, specs: { evidence?: string[] }[]): string[] {
  const named = new Set((specs ?? []).flatMap((s) => s.evidence ?? []));
  return Object.keys(sources ?? {}).filter((n) => named.has(n));
}

/**
 * Run the declared sources a spec actually names.
 *
 * Only those: evidence nothing consumes is not free. Carrying all nine check results
 * collapsed one spec's separation from 0.34 to 0.07 purely by being in the state, and a
 * ticket body is far longer than a check result.
 */
export function contextEnricher(sources: Record<string, ContextSpec>, cwd: string): Enricher {
  return async (_turn, specs): Promise<Evidence> => {
    const names = wantedSources(sources, specs ?? []);
    if (!names.length) return {};
    // In parallel, for the same reason as checks: a ticket fetch and a deploy status have
    // no business queueing behind each other.
    const entries = await Promise.all(
      names.map(async (name) => {
      const spec = sources[name];
      const max = spec.maxChars ?? DEFAULT_MAX;
      try {
        const proc = Bun.spawn(["sh", "-c", spec.command], { cwd, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill(), spec.timeoutMs ?? 30_000);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exit = await proc.exited;
        clearTimeout(timer);
        // A source that could not run must say so in words. Empty text reads as "the
        // ticket says nothing", which is an answer — and the wrong one.
        const text =
          exit === 0
            ? stdout.length > max
              ? `${stdout.slice(0, max)}\n…[TRUNCATED: ${stdout.length - max} more chars not shown — do not treat anything below as absent]`
              : stdout
            : `[context source "${name}" could not be read: exit ${exit}. Treat it as unknown, not as absent.]\n${stderr.slice(0, 400)}`;
        return [name, text] as const;
      } catch {
        return [name, `[context source "${name}" could not be run. Treat it as unknown, not as absent.]`] as const;
      }
      }),
    );
    return { context: Object.fromEntries(entries) };
  };
}
