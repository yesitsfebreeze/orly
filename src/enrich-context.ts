/**
 * Named context sources for what no exit code expresses (e.g. a ticket's acceptance
 * criteria): one command each, output put before the judge under `project.context`.
 * A spec names the source in `evidence` and asks about it in words.
 *
 *   "context": { "ticket": { "command": "jira issue view $TICKET --plain" } }
 */
import type { Enricher, Evidence } from "./enrich.ts";

export type ContextSpec = {
  /** Shell command. Its output is the evidence. */
  command: string;
  /** Default 6 000. Generous: a source clipped where the answer was is worse than none. */
  maxChars?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX = Number(process.env.ORLY_MAX_CONTEXT_CHARS ?? 6_000);

/** Every context source some spec asks about, by name. */
export function wantedSources(sources: Record<string, ContextSpec>, specs: { evidence?: string[] }[]): string[] {
  const named = new Set((specs ?? []).flatMap((s) => s.evidence ?? []));
  return Object.keys(sources ?? {}).filter((n) => named.has(n));
}

/** Run only the declared sources some spec names; unused evidence dilutes judgments. */
export function contextEnricher(sources: Record<string, ContextSpec>, cwd: string): Enricher {
  return async (_turn, specs): Promise<Evidence> => {
    const names = wantedSources(sources, specs ?? []);
    if (!names.length) return {};
    // In parallel, like checks.
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
        // Failure must be said in words: empty text would read as "the source says nothing".
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
