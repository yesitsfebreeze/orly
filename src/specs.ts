/**
 * Goal specs: acceptance criteria for one goal, checked every turn alongside the built-in
 * questions in gate.ts. A `require` spec is decided in code; any other becomes one Noul,
 * phrased positively ("is this satisfied?").
 */

/** One acceptance criterion, checkable against a turn's own evidence. */
export type Spec = {
  /** Stable id. Used by code and shown to the agent; never sent to the model. */
  id: string;
  /** The criterion, as a yes/no question about the turn. */
  instructions: string;
  /** What satisfied and unsatisfied concretely look like. */
  criteria?: { true?: string; false?: string };
  /**
   * Probability at or above which the spec is met. Per-spec because the scale depends on the
   * wording; fit it with test/spec-calibrate.ts.
   */
  cut?: number;
  /** A deterministic check over gathered evidence, evaluated in code instead of by the model. */
  require?: Require;
  /** A spec the agent is allowed to leave unmet if it says why. Default: false. */
  optional?: boolean;
  /**
   * Evidence gathered at judging time, not taken from the agent's narration. Each entry is a
   * file path, a `context` source from `.orly/config.json`, or a name nothing produces (see `gather`).
   */
  evidence?: string[];
  /**
   * Instruction to the agent for evidence nothing can gather (a screenshot, a search result).
   * The gate asks in these words and judges the next turn on what came back.
   */
  gather?: string;
};

export type SpecFile = {
  /** The goal these specs were derived from, so a changed goal invalidates them. */
  goal: string;
  specs: Spec[];
  /** How many blocked rounds this goal may spend before the gate gives up. */
  maxRounds?: number;
};

export const SPEC_PREFIX = "spec:";

/** A declarative assertion over the evidence in `project`. No expressions, no eval. */
export type Require = {
  /** Dotted path into the enriched evidence, e.g. "checks.typecheck.exit". */
  path: string;
  op: "equals" | "lte" | "gte" | "present" | "absent" | "contains";
  value?: unknown;
};

const at = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);

/** Evaluate a `require` against gathered evidence. Undecidable means unmet, never met. */
export function evaluate(req: Require, evidence: unknown): { met: boolean; actual: unknown } {
  // Hand-written specs carry any JSON; throwing would fail open, so return unmet.
  if (typeof req?.path !== "string") return { met: false, actual: undefined };
  const actual = at(evidence, req.path);
  switch (req.op) {
    case "present":
      return { met: actual !== undefined && actual !== null, actual };
    case "absent":
      return { met: actual === undefined || actual === null, actual };
    case "equals":
      return { met: actual === req.value, actual };
    case "lte":
      return { met: typeof actual === "number" && actual <= Number(req.value), actual };
    case "gte":
      return { met: typeof actual === "number" && actual >= Number(req.value), actual };
    case "contains":
      return { met: typeof actual === "string" && actual.includes(String(req.value)), actual };
    default:
      return { met: false, actual };
  }
}

/** Words of taste that signal a spec with nothing in the recorded evidence to check against. */
const UNCHECKABLE = /\b(clean|elegant|readable|maintainable|idiomatic|well[- ](structured|designed|written)|good|nice|proper|appropriate|robust|scalable|performant|secure enough|best practice)\b/i;

export type SpecProblem = { id: string; problem: string };

const OPS = ["equals", "lte", "gte", "present", "absent", "contains"];

/** Reject specs that cannot be judged before they start returning numbers. */
export function validateSpecs(specs: Spec[]): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    if (!s?.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(s.id)) {
      problems.push({ id: String(s?.id ?? "?"), problem: "id must be a short slug" });
      continue;
    }
    if (seen.has(s.id)) problems.push({ id: s.id, problem: "duplicate id" });
    seen.add(s.id);
    if (s.require !== undefined) {
      const r = s.require as any;
      if (r?.op === "malformed") {
        // A spec-tree file that did not parse: its instructions carry what was wrong.
        problems.push({ id: s.id, problem: s.instructions });
      } else if (typeof r?.path !== "string" || !OPS.includes(r?.op)) {
        problems.push({ id: s.id, problem: `require must be {path, op} with op one of ${OPS.join(", ")}` });
      }
    }
    // Code spans are stripped first, so a quoted command like `git clean` is not taste.
    const text = (s.instructions ?? "").replace(/`[^`]*`/g, " ");
    if ((s.instructions ?? "").trim().length < 15) {
      problems.push({ id: s.id, problem: "instructions too short to judge" });
    }
    // Code decides a `require`; its wording is a label, never a question to the model.
    const vague = s.require ? null : text.match(UNCHECKABLE);
    if (vague) {
      problems.push({
        id: s.id,
        problem: `"${vague[0]}" is a judgement about taste, not about recorded evidence — say what would be visible in the actions or output instead`,
      });
    }
  }
  return problems;
}

/** Specs become Nouls in the same request as the built-in questions. */
export function specQuestions(specs: Spec[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const s of specs) {
    if (s.require) continue; // decided in code; asking the model would only add noise
    out[SPEC_PREFIX + s.id] = {
      type: "noul",
      instructions: `Judging only from the recorded state — \`user_request\`, \`actions_taken\`, \`command_results\`, \`assistant_said\`, and \`project\` where present (independently gathered evidence, not something the agent produced): ${s.instructions}`,
      criteria: {
        true: s.criteria?.true ?? "The recorded actions or output show this is satisfied.",
        false:
          s.criteria?.false ??
          "Nothing in the recorded actions or output shows this is satisfied, or they show it is not.",
      },
    };
  }
  return out;
}

export type SpecResult = { spec: Spec; p: number; met: boolean; actual?: unknown };

/**
 * Score every spec: met at or above its own `cut`, else `threshold`. Cuts are fitted to the
 * wording (Jev ranks well, scales badly), so refit when the wording changes.
 */
export function scoreSpecs(
  specs: Spec[],
  answers: Record<string, any>,
  threshold: number,
  evidence?: unknown,
): SpecResult[] {
  const out: SpecResult[] = [];
  for (const spec of specs) {
    if (spec.require) {
      const { met, actual } = evaluate(spec.require, evidence);
      out.push({ spec, p: met ? 1 : 0, met, actual });
      continue;
    }
    const p = answers?.[SPEC_PREFIX + spec.id]?.noul;
    if (typeof p !== "number") continue; // a spec we got no answer for cannot fail the turn
    const cut = typeof spec.cut === "number" ? spec.cut : threshold;
    out.push({ spec, p, met: p >= cut });
  }
  return out;
}

export function unmet(results: SpecResult[]): SpecResult[] {
  return results.filter((r) => !r.met && !r.spec.optional);
}
