/**
 * Goal specs — the part that makes the gate about *this* goal rather than about agents
 * in general.
 *
 * The built-in questions in gate.ts catch how agents stop early no matter what they were
 * asked. They cannot catch "the migration is reversible" or "the endpoint returns 429 on
 * the eleventh request", because those are properties of one goal. So an LLM turns the
 * goal into a list of specs once, and from then on every turn is checked against them by
 * a model that costs a fraction of a cent and answers in typed numbers.
 *
 * A spec becomes one Noul. Phrased positively — "is this satisfied?" — so a reader of
 * the list sees acceptance criteria rather than a list of accusations.
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
   * The probability at or above which this spec counts as met.
   *
   * Per-spec because a spec's natural scale depends on its wording, not on its truth.
   * Measured: "does the agent avoid claiming what the output doesn't show" tops out at
   * 0.77 on turns that plainly satisfy it, so a global 0.70 marks most correct turns as
   * failures. Fit each one with test/spec-calibrate.ts; the default is only a starting
   * point for a spec nobody has measured yet.
   */
  cut?: number;
  /**
   * A deterministic check over gathered evidence, instead of a judgment.
   *
   * If a fact can be decided — a diagnostic count, an exit code, whether a symbol exists —
   * it must not go to a probabilistic judge. A `require` is evaluated in code, costs
   * nothing, has no threshold, and cannot drift. Reserve the model for what genuinely
   * needs semantic understanding.
   */
  require?: Require;
  /** A spec the agent is allowed to leave unmet if it says why. Default: false. */
  optional?: boolean;
  /**
   * What the judge should be shown, gathered at judging time rather than taken from what
   * the agent chose to print. This is what stops a spec from being answerable only by the
   * agent's own narration.
   *
   * Each entry is a file path, or the name of a source declared under `context` in
   * `.orly/config.json`, or a name nothing produces — see `gather`.
   */
  evidence?: string[];
  /**
   * What the agent must do when this spec's evidence could not be gathered.
   *
   * Some evidence has no command behind it: a design review that lives in someone's head,
   * a screenshot, an answer only a search will find. Name it in `evidence` anyway and put
   * the instruction here. Nothing produces it, so the gate asks the agent to — in these
   * words — and judges the next turn on what it brought back.
   *
   * This is the third way to fill the state, after reading a file and running a command:
   * ask the model that is doing the work, and check the answer against the spec like any
   * other evidence.
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

/**
 * A spec is only useful if the answer is visible in what the turn recorded. "The code is
 * well structured" has nothing to check against and will return a confident number that
 * means nothing. These are the words that most often signal an uncheckable spec; the
 * generator prompt forbids them and this is the backstop.
 */
const UNCHECKABLE = /\b(clean|elegant|readable|maintainable|idiomatic|well[- ](structured|designed|written)|good|nice|proper|appropriate|robust|scalable|performant|secure enough|best practice)\b/i;

export type SpecProblem = { id: string; problem: string };

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
    // A spec quotes the commands it is about, and those commands have names. `git clean`
    // is not a judgement about taste; neither is `cargo build --release`. Code spans are
    // stripped before the filter runs, so quoting a command is how you say one — which is
    // how a spec should be written anyway.
    const text = (s.instructions ?? "").replace(/`[^`]*`/g, " ");
    if ((s.instructions ?? "").trim().length < 15) {
      problems.push({ id: s.id, problem: "instructions too short to judge" });
    }
    const vague = text.match(UNCHECKABLE);
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
 * Score every spec. A spec is met at or above `threshold`.
 *
 * The threshold is a fitted number, not a natural one: Jev ranks well and scales badly,
 * so a cut that works for one set of spec wordings is not transferable to another. Refit
 * whenever the spec prose changes materially.
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
