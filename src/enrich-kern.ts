/**
 * kern as an evidence source.
 *
 * kern is this project's own runtime: it answers recall, the entity graph and the
 * workspace, and its answers carry project state that reading the repo cannot see —
 * decisions, constraints, prior work. For a spec like "the migration stays reversible",
 * that context is the difference between a judgment and a guess.
 *
 * Optional in every direction. If kern is not installed, not running, or does not compose
 * the service asked for, the enricher returns nothing and the judgment proceeds on the
 * transcript alone.
 */
import type { Enricher, Evidence } from "./enrich.ts";
import type { Spec } from "./specs.ts";

const TIMEOUT_MS = Number(process.env.ORLY_KERN_TIMEOUT_MS ?? 4_000);
const MAX_CLAIMS = 6;
const MAX_CLAIM_CHARS = 300;

/** One `kern call <service> <json>`. Returns null for every failure mode. */
export async function kernCall(service: string, input: unknown, cwd?: string): Promise<any | null> {
  try {
    const proc = Bun.spawn(["kern", "call", service, JSON.stringify(input)], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    // A composition that lacks the service answers in prose, not JSON.
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Ask the project what it knows about this goal.
 *
 * Only the claims come back, not the scoring apparatus around them — the judge needs
 * project facts, and handing it a confidence vector from a different model would invite
 * it to reason about that instead of about the work.
 */
export function kernMemoryEnricher(goal: string, cwd?: string): Enricher {
  return async (): Promise<Evidence> => {
    if (!goal.trim()) return {};
    const out = await kernCall("memory", { op: "ask", text: goal }, cwd);
    const claims: string[] = [];
    for (const step of out?.plan ?? []) {
      const claim = typeof step?.claim === "string" ? step.claim.trim() : "";
      if (claim) claims.push(claim.slice(0, MAX_CLAIM_CHARS));
      if (claims.length >= MAX_CLAIMS) break;
    }
    return claims.length ? { project_knowledge: claims } : {};
  };
}

/** Read spec evidence through kern's workspace, so it sees the session's own branch. */
export function kernFsEnricher(cwd?: string): Enricher {
  return async (_turn, specs: Spec[]): Promise<Evidence> => {
    const paths = [...new Set(specs.flatMap((s) => s.evidence ?? []))].slice(0, 8);
    if (!paths.length) return {};
    const files: Record<string, string> = {};
    for (const path of paths) {
      const out = await kernCall("fs", { op: "read", path }, cwd);
      const body = typeof out?.content === "string" ? out.content : typeof out?.text === "string" ? out.text : null;
      if (body !== null) files[path] = body.slice(0, 2_000);
    }
    return Object.keys(files).length ? { files } : {};
  };
}
