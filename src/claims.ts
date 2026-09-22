/**
 * Claims — specs anchored to the code's own definitions.
 *
 * Next to a source file sits a sidecar, `src/http.ts.orly`, one claim per line:
 *
 *   @file:               the package is named "xyz"
 *   fetchWithRetry:      is exported
 *   RetryPolicy.max:     is set to 3
 *
 * The anchor is a name from the syntax tree, never a line number: a line number points at
 * different code after the first edit above it and keeps "passing" on the wrong lines. A
 * name that no longer resolves fails the claim, so a rename blocks instead of drifting.
 *
 * Definitions come from the language's own server (src/lsp.ts), so any language with one
 * works. Each claim is asked with only its definition's current source in front of the judge,
 * and about what the code SAYS. Asked what code does at runtime, the judge answers
 * confidently and wrongly (docs/specs.txt), so behaviour words are refused up front —
 * behaviour belongs to a test's output.
 */
import type { Definition } from "./lsp.ts";

export type { Definition };
export type Claim = { anchor: string; claim: string; line: number };
export type ClaimResult = Claim & { p?: number; ok: boolean; problem?: string };
export type Asker = (state: unknown, questions: Record<string, unknown>) => Promise<{ answers: Record<string, any> }>;

/** `anchor: claim` per line; blank lines and `#` comments skipped. */
export function parseSidecar(text: string): { claims: Claim[]; problems: Claim[] } {
  const claims: Claim[] = [];
  const problems: Claim[] = [];
  text.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith("#")) return;
    // The anchor runs to the first ": ", so `Foo::new` and `impl Foo.bar` are anchors too.
    const m = l.match(/^(@file|[^\s:][^:]*?(?:::[^:\s]+)*)\s*:\s+(.+)$/);
    if (/^\d+\s*:/.test(l)) problems.push({ anchor: l.split(":")[0], claim: "a line number drifts with every edit above it — anchor to a symbol name (`orly symbols <file>` lists them)", line: i + 1 });
    else if (m) claims.push({ anchor: m[1], claim: m[2].trim(), line: i + 1 });
    else problems.push({ anchor: "?", claim: `expected "anchor: claim", got ${JSON.stringify(l)}`, line: i + 1 });
  });
  return { claims, problems };
}

// Behaviour needs a run to settle; taste has nothing to settle it with.
const BEHAVIOUR = /\b(correct(ly)?|properly|works?|handles?|always|bug-?free|edge[- ]cases?|robust|efficient(ly)?|fast|safe(ly)?|clean|readable|elegant|idiomatic|good|nice)\b/i;

export const claimProblem = (claim: string): string | undefined => {
  const hit = claim.replace(/`[^`]*`/g, " ").match(BEHAVIOUR);
  return hit ? `"${hit[0]}" asks about behaviour or taste — claim what the code says, and leave behaviour to a test` : undefined;
};

const MAX_CHARS = 12_000;

/**
 * Judge one sidecar against its source file in a single request. Anything that cannot be
 * judged — a bad line, an unresolved anchor, a refused claim — fails, never passes.
 */
export async function judgeSidecar(
  sourcePath: string,
  source: string | null,
  defsOrError: Definition[] | Error,
  sidecar: string,
  ask: Asker,
  cut: number,
): Promise<ClaimResult[]> {
  const { claims, problems } = parseSidecar(sidecar);
  const out: ClaimResult[] = problems.map((p) => ({ ...p, ok: false, problem: p.claim }));
  if (source === null) return [...out, ...claims.map((c) => ({ ...c, ok: false, problem: `${sourcePath} does not exist` }))];
  if (defsOrError instanceof Error) {
    // No symbols means no anchor can be checked. @file claims still can.
    const needs = claims.filter((c) => c.anchor !== "@file");
    out.push(...needs.map((c) => ({ ...c, ok: false, problem: defsOrError.message })));
    claims.splice(0, claims.length, ...claims.filter((c) => c.anchor === "@file"));
  }
  const defs = new Map<string, Definition>();
  const twice = new Set<string>();
  for (const d of defsOrError instanceof Error ? [] : defsOrError) {
    if (defs.has(d.anchor)) twice.add(d.anchor);
    else defs.set(d.anchor, d);
  }
  const symbols: Record<string, string> = {};
  const questions: Record<string, unknown> = {};
  const asked: Array<[string, Claim]> = [];
  claims.forEach((c, i) => {
    const refused = claimProblem(c.claim);
    if (refused) return out.push({ ...c, ok: false, problem: refused });
    const def = c.anchor === "@file" ? { text: source } : defs.get(c.anchor);
    if (!def) return out.push({ ...c, ok: false, problem: `no definition named "${c.anchor}" in ${sourcePath} — renamed or deleted?` });
    // Two definitions with one name (script-level locals in separate blocks): judging either
    // would be a coin toss about which code the claim meant.
    if (twice.has(c.anchor)) return out.push({ ...c, ok: false, problem: `"${c.anchor}" names more than one definition in ${sourcePath} — anchor to something unique` });
    symbols[c.anchor] = def.text.slice(0, MAX_CHARS);
    const where = c.anchor === "@file" ? `the whole file under \`symbols["@file"]\`` : `\`symbols["${c.anchor}"]\`, the current source of that definition`;
    questions[`c${i}`] = {
      type: "noul",
      instructions: `Look at ${where}, read from ${sourcePath} just now. Judge only from what that text states, without simulating how it would run. Does it show that ${c.anchor === "@file" ? "the file" : `\`${c.anchor}\``} ${c.claim}?`,
    };
    asked.push([`c${i}`, c]);
  });
  if (!asked.length) return out;
  let answers: Record<string, any>;
  try {
    ({ answers } = await ask({ file: sourcePath, symbols }, questions));
  } catch (e: any) {
    // Every claim that was asked fails, each on its own line, with the first line of why.
    const why = `judge unavailable (${String(e?.message ?? e).split("\n")[0].slice(0, 120)})`;
    return [...out, ...asked.map(([, c]) => ({ ...c, ok: false, problem: why }))].sort((a, b) => a.line - b.line);
  }
  for (const [id, c] of asked) {
    const p = answers?.[id]?.noul;
    if (typeof p !== "number") out.push({ ...c, ok: false, problem: "no answer from the judge" });
    else out.push({ ...c, p, ok: p >= cut, ...(p >= cut ? {} : { problem: "not supported by the code" }) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Run `task` over `items` with at most `limit` in flight, results in input order. */
export async function pool<T, R>(items: T[], limit: number, task: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
