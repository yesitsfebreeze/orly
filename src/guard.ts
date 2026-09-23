/**
 * The guard: refuses edits that make the gate easier to pass (a spec deleted, a cut lowered,
 * a spec marked optional, a check disarmed). Tightening and adding are always allowed.
 */
import type { Spec } from "./specs.ts";

export type Violation = { id: string; problem: string };

/**
 * Weakenings of the declared commands. A `require` spec asserts on a command's result, so the
 * command is the criterion: deleting it or replacing it with one that cannot fail disarms the
 * spec. Adding or changing a command is allowed.
 */
type Commanded = Record<string, { command?: string; maxChars?: number }>;
type Configured = { checks?: Commanded; context?: Commanded } | null;

/** A command that cannot fail is not a check — the shapes one is filed down into. */
const CANNOT_FAIL = /^\s*(true|:|exit 0|echo\b[^|]*)\s*$/;

export function checkWeakenings(before: Configured, after: Configured): Violation[] {
  const out: Violation[] = [];
  // A `context` source is evidence a spec reads, so narrowing it weakens the gate too.
  for (const kind of ["checks", "context"] as const) {
    const was = before?.[kind] ?? {};
    const now = after?.[kind] ?? {};
    for (const [name, spec] of Object.entries(was)) {
      const label = kind === "checks" ? "check" : "context source";
      if (!(name in now)) {
        out.push({ id: name, problem: `the ${label} was deleted, which disarms every spec that reads it` });
        continue;
      }
      const then = spec?.command ?? "";
      const nowCommand = now[name]?.command ?? "";
      if (then !== nowCommand && CANNOT_FAIL.test(nowCommand)) {
        out.push({ id: name, problem: `its command was replaced with one that cannot fail: ${JSON.stringify(nowCommand)}` });
      }
      // Clipped evidence hides what the judge needs to see.
      const wasMax = spec?.maxChars;
      const nowMax = now[name]?.maxChars;
      if (typeof wasMax === "number" && typeof nowMax === "number" && nowMax < wasMax) {
        out.push({ id: name, problem: `its evidence was clipped shorter, ${wasMax} → ${nowMax} characters` });
      }
    }
  }
  return out;
}

type SpecSet = { specs?: Spec[]; goal?: string; checks?: Record<string, { command?: string }> } | null;

const byId = (file: SpecSet): Map<string, Spec> => {
  const m = new Map<string, Spec>();
  for (const s of file?.specs ?? []) if (s?.id) m.set(s.id, s);
  return m;
};

const cutOf = (s: Spec | undefined, fallback: number) =>
  typeof s?.cut === "number" ? s.cut : fallback;

/**
 * The changes between two spec files that make the gate easier to pass. `defaultCut` is
 * needed because dropping an explicit `cut` falls back to it, a loosening if the cut was higher.
 */
export function weakenings(before: SpecSet, after: SpecSet, defaultCut = 0.7): Violation[] {
  const a = byId(before);
  const b = byId(after);
  const out: Violation[] = [];

  for (const [id, was] of a) {
    const now = b.get(id);
    if (!now) {
      out.push({ id, problem: "the spec was deleted" });
      continue;
    }
    const wasCut = cutOf(was, defaultCut);
    const nowCut = cutOf(now, defaultCut);
    if (nowCut < wasCut - 1e-9) {
      out.push({ id, problem: `its cut was lowered, ${wasCut.toFixed(2)} → ${nowCut.toFixed(2)}` });
    }
    if (!was.optional && now.optional) {
      out.push({ id, problem: "it was marked optional, which lets the turn end without meeting it" });
    }
    // A rewording invalidates the cut fitted for the old wording.
    if (was.instructions !== now.instructions && nowCut === wasCut && typeof now.cut === "number") {
      out.push({
        id,
        problem: "its wording changed while its fitted cut stayed — refit it, or drop the cut so it is marked unfitted",
      });
    }
  }
  return out;
}

/** A single line explaining what to do instead, appended to every refusal. */
export const GUARD_ADVICE =
  "Tightening a cut, adding a spec, or rewording one and refitting it are all allowed. " +
  "If a spec is genuinely wrong, say so to the user and leave it alone — you are the thing " +
  "it judges, so this is not your call to make alone. `orly fit` shows what the log supports.";

/**
 * Backstop for edits the PreToolUse guard never sees (e.g. through a shell): every judgment
 * compares the spec file against the strictest version seen so far.
 */
export function checkBaseline(
  baseline: SpecSet,
  current: SpecSet,
  defaultCut = 0.7,
): { violations: Violation[]; nextBaseline: SpecSet } {
  if (!baseline?.specs?.length) return { violations: [], nextBaseline: current };
  // A dropped or reworded goal replaces the spec set; dropping its specs is not a weakening.
  // An appended goal keeps every old line, so the old specs still stand.
  const lines = (g: unknown) => String(g ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const was = lines((baseline as any).goal);
  const now = lines((current as any).goal);
  if (!was.every((l) => now.includes(l))) return { violations: [], nextBaseline: current };
  const violations = [...weakenings(baseline, current, defaultCut), ...checkWeakenings(baseline, current)];
  // Keep the old baseline on any weakening, so a later edit cannot launder it in.
  return { violations, nextBaseline: violations.length ? baseline : current };
}

export function refusal(violations: Violation[]): string {
  return [
    "orly? refuses this edit: it would make the gate easier to pass.",
    ...violations.map((v) => `- \`${v.id}\`: ${v.problem}`),
    "",
    GUARD_ADVICE,
  ].join("\n");
}
