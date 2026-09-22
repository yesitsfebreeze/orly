/**
 * The guard — orly protecting its own spec file from the agent it judges.
 *
 * Everything else here is advice. An instruction not to weaken your own examiner is exactly
 * the kind of thing an agent talks itself past at 2am with one spec left failing, and it
 * only has to succeed once: a cut nudged down, a spec marked optional, and the gate quietly
 * stops meaning anything while every session still reports green.
 *
 * So weakening is refused by the harness rather than discouraged in prose. Tightening and
 * adding are always allowed — an agent that makes its own examiner stricter is not the
 * failure mode anyone needs protecting from.
 */
import type { Spec } from "./specs.ts";

export type Violation = { id: string; problem: string };

type SpecSet = { specs?: Spec[]; goal?: string } | null;

const byId = (file: SpecSet): Map<string, Spec> => {
  const m = new Map<string, Spec>();
  for (const s of file?.specs ?? []) if (s?.id) m.set(s.id, s);
  return m;
};

const cutOf = (s: Spec | undefined, fallback: number) =>
  typeof s?.cut === "number" ? s.cut : fallback;

/**
 * What changed between two versions of a spec file, keeping only the changes that make the
 * gate easier to pass.
 *
 * `defaultCut` matters: dropping an explicit `cut` falls back to the default, which is a
 * loosening whenever the explicit value was higher. Removing a line can weaken a gate just
 * as effectively as editing one.
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
    // Rewording is how a spec is legitimately improved, but a rewrite invalidates the cut
    // that was fitted for the old wording — wording moves the number more than the cut does.
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
 * The backstop.
 *
 * The PreToolUse guard only sees edit tools; a spec file rewritten through a shell command
 * never reaches it. So the strictest version ever seen is remembered, and every judgment
 * compares the file against it. Whatever route an edit took, a weakened gate is caught
 * before the turn it was weakened for can end.
 */
export function checkBaseline(
  baseline: SpecSet,
  current: SpecSet,
  defaultCut = 0.7,
): { violations: Violation[]; nextBaseline: SpecSet } {
  if (!baseline?.specs?.length) return { violations: [], nextBaseline: current };
  // A new goal is a new spec set, and dropping the old goal's specs is not a weakening —
  // it is the point. Without this, the first goal a repo ever had could never be replaced,
  // because every later spec set would read as deletions of it.
  if ((baseline as any).goal !== (current as any).goal) return { violations: [], nextBaseline: current };
  const violations = weakenings(baseline, current, defaultCut);
  // Only record a new baseline when nothing was weakened, so a weakening can never be
  // laundered into the baseline by following it with an unrelated edit.
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
