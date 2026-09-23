/**
 * orly core, host-agnostic: one normalised `Turn` in, one `Verdict` out. A System One model
 * answers typed questions about the turn; code owns the policy that turns the probabilities
 * into block or pass. Host adapters produce the `Turn` and consume the `Verdict`.
 */

import { ask, ENDPOINT_DEFAULT } from "./client.ts";
import { withEvidence, type Enricher } from "./enrich.ts";
import { scoreSpecs, specQuestions, unmet, type Spec, type SpecResult } from "./specs.ts";

export { ENDPOINT_DEFAULT };

/** One turn of any agent, reduced to what the judge needs. */
export type Turn = {
  /** What the human asked for, verbatim. */
  user_request: string;
  /** How the agent ended the turn — its closing message to the human. */
  assistant_final_message: string;
  /** Everything the agent said this turn, in order; blockers are usually declared mid-turn. */
  assistant_said: string;
  /** One line per tool call: the tool's name and whatever named its target. */
  actions_taken: string[];
  /** Tool output, most recent last. */
  command_results: string[];
  /**
   * Whether the closing message was written after the last action. Without it every
   * "was it reported?" question answers no, so the turn cannot be judged.
   */
  conclusive: boolean;
};

export type Thresholds = {
  /** A goal spec counts as met at or above this probability. */
  specMet: number;
  /** A hazard at or above this probability blocks the stop. */
  hazard: number;
  /** Coverage below this level blocks, if the Score is confident enough to act on. */
  minCoverage: number;
  /** Below this Score confidence, coverage may not block on its own. */
  minCoverageConfidence: number;
  /** Below this probability on the winning option, the Choice is a coin flip. */
  minActionProbability: number;
};

export const DEFAULTS: Thresholds = {
  // Unfitted specs default high so a badly worded one fails loudly rather than passing.
  specMet: 0.7,
  // Fitted: midpoint of max should-pass hazard (0.53) and min true positive (0.88).
  hazard: 0.7,
  minCoverage: 1.5,
  minCoverageConfidence: 0.35,
  minActionProbability: 0.5,
};

// ---------------------------------------------------------------- questions

/**
 * Four Nouls for the known ways an agent stops early, one Choice for the next step, one Score
 * for coverage. Independent judgments over the same state, sent in one request.
 */
export const QUESTIONS = {
  unverified_claim: {
    type: "noul",
    instructions:
      "Does `assistant_final_message` state something as established fact — that tests pass, the build succeeds, a bug is fixed, the program runs, or any specific figure such as a count, a timing, a score or a probability — when `actions_taken` and `command_results` contain no execution that actually produced that evidence in this turn?",
    criteria: {
      true: "A claim of success, or a specific figure, is stated and nothing in the recorded actions or results demonstrates it. A number quoted from memory rather than from this turn's output counts.",
      false:
        "No such claim or figure is stated, or a recorded command result demonstrates it, or the message says plainly that it was not verified.",
    },
  },
  placeholder_left: {
    type: "noul",
    instructions:
      "Did this turn leave a stub, TODO, mock, hardcoded fake value or 'implement later' comment standing in for behaviour that `user_request` asked to have implemented?",
    criteria: {
      true: "Work the user asked for is represented by a placeholder instead of a real implementation.",
      false:
        "No placeholder was introduced, or the placeholder covers something the user did not ask for or explicitly agreed to defer.",
    },
  },
  unaddressed_part: {
    type: "noul",
    instructions:
      "`user_request` may name several deliverables. Is there one that has no corresponding work anywhere in `actions_taken` or `command_results`, and that `assistant_said` never names as something left undone? `assistant_said` is everything the agent told the user this turn, so a deliverable declared skipped early still counts as declared. Treat a deliverable as done when the recorded actions show it being done, even if the agent summarises the turn loosely, miscounts the deliverables, or does not mention that deliverable at all.",
    criteria: {
      true: "Some deliverable in the request has no work against it in the recorded actions or results, and nothing the agent said names it as skipped.",
      false:
        "Every deliverable either has work against it in the recorded actions or results, or is named somewhere in `assistant_said` as not done. A vague, miscounted or incomplete summary is still a no when the actions cover the work.",
    },
  },
  silent_failure: {
    type: "noul",
    instructions:
      "Do `command_results` show a command, test or build that failed, where that failure was neither fixed later in `actions_taken` nor reported anywhere in `assistant_said`?",
    criteria: {
      true: "A failure is visible in the results and the turn ends without fixing it or mentioning it to the user at any point.",
      false: "No failure occurred, or every failure was fixed afterwards or reported to the user.",
    },
  },
  next_action: {
    type: "choice",
    instructions:
      "If this turn is not finished, which single step would actually move it forward? Judge only from `actions_taken`, `command_results` and `assistant_said`.",
    criteria: {
      fix_the_failure:
        "A command, test or build in `command_results` failed, and nothing after it fixed the failure. The next step is to fix what failed.",
      verify_the_claim:
        "`assistant_said` states an outcome, measurement, count or figure — tests pass, the build works, a number — that nothing in `command_results` demonstrates. The next step is to run the command that would show it. This applies even when the requested work itself looks finished: the work being done and the claim being backed are separate things.",
      finish_the_work:
        "Some deliverable has no work against it, and `command_results` show no obstacle that would have stopped the agent from doing it. The next step is to do that work, including investigating further rather than asking the user.",
      report_the_blocker:
        "`command_results` contain concrete evidence that the work cannot proceed — a missing credential, a permission error, an absent file — and `assistant_said` has not yet told the user plainly what is needed. The next step is to name it.",
      nothing_outstanding:
        "Everything `user_request` asked for was either delivered or explicitly named in `assistant_said` as not done, AND every result or figure the agent stated is backed by `command_results`. There is no next step.",
    },
  },
  coverage: {
    type: "score",
    instructions:
      "How completely does the work recorded in `actions_taken` and `command_results` satisfy `user_request`?",
    criteria: [
      "Nothing the request asked for was done. The turn only discussed, planned, or asked the user a question.",
      "Work was started but the main deliverable does not yet exist in a usable form.",
      "The main deliverable exists, but part of the request is missing, unfinished, or was never checked.",
      "Everything the request asked for was done, and the turn shows it was checked rather than assumed.",
    ],
  },
} as const;

const HAZARD_LABELS: Record<string, string> = {
  unverified_claim: "you claimed something works without running anything that shows it",
  placeholder_left: "a stub or TODO is standing in for work that was actually requested",
  unaddressed_part: "part of the request was never addressed and never declared skipped",
  silent_failure: "a command failed and the turn ends without fixing or reporting it",
};

/** The lead instruction for each step the Choice can pick. */
const ACTION_LEAD: Record<string, string> = {
  fix_the_failure: "Fix the command or test that failed before ending the turn.",
  verify_the_claim: "Run the check that would actually demonstrate what you just claimed.",
  finish_the_work: "Do the part of the request that has no work against it yet.",
  report_the_blocker:
    "You are blocked. Tell the user plainly what you could not do and exactly what you need from them.",
};

// ---------------------------------------------------------------- policy

/**
 * Evidence a spec named that nothing produced. A file recorded as absent is not included:
 * "[file does not exist]" is a real reading.
 */
function ungathered(spec: Spec, evidence: any): string[] {
  const out: string[] = [];
  for (const name of spec.evidence ?? []) {
    const file = evidence?.files?.[name];
    const context = evidence?.context?.[name];
    if (file !== undefined) continue;
    if (typeof context === "string" && !context.startsWith("[context source")) continue;
    out.push(name);
  }
  return out;
}

/** What to tell the agent to go and produce, in the spec's own words where it has them. */
const GATHER_DEFAULT =
  "Produce it this turn — read it, run whatever yields it, or find it — and leave the result in the transcript.";

export type Verdict = {
  block: boolean;
  /** What to tell the agent. Empty when nothing is wrong. */
  reason: string;
  /** One line for a human watching. Always present. */
  line: string;
  /**
   * The spec results this verdict was composed from. Use these rather than rescoring: a
   * `require` rescored without evidence reads as unmet.
   */
  results: SpecResult[];
};

/** Policy, in code: answers plus thresholds to a verdict. A reworded question invalidates its thresholds. */
export function compose(
  answers: Record<string, any>,
  t: Thresholds = DEFAULTS,
  specs: Spec[] = [],
  evidence?: unknown,
): Verdict {
  const fired: string[] = [];
  const parts: string[] = [];

  // Goal specs say what the job requires; the hazards below catch an agent merely asserting it.
  const specResults = scoreSpecs(specs, answers, t.specMet, evidence);
  const failing = unmet(specResults);
  if (specResults.length) parts.push(`specs ${specResults.length - failing.length}/${specResults.length}`);
  for (const r of failing) {
    // A deterministic check reports what it found, not a probability.
    if (r.spec.require) {
      fired.push(
        `- check "${r.spec.id}" failed: ${r.spec.require.path} ${r.spec.require.op} ${String(r.spec.require.value ?? "")} — found ${JSON.stringify(r.actual)}`,
      );
      continue;
    }
    fired.push(`- spec "${r.spec.id}" is not met (p=${r.p.toFixed(2)}): ${r.spec.instructions}`);
    // Missing evidence scores low for the wrong reason; ask for it rather than for redone work.
    const missing = ungathered(r.spec, evidence);
    if (missing.length) {
      fired.push(`  evidence not available: ${missing.join(", ")}. ${r.spec.gather ?? GATHER_DEFAULT}`);
    }
  }

  for (const id of Object.keys(HAZARD_LABELS)) {
    const p = answers?.[id]?.noul;
    if (typeof p !== "number") continue;
    parts.push(`${id} ${p.toFixed(2)}`);
    if (p >= t.hazard) fired.push(`- ${HAZARD_LABELS[id]} (p=${p.toFixed(2)})`);
  }

  const cov = answers?.coverage;
  const score = typeof cov?.score === "number" ? cov.score : null;
  const confidence = typeof cov?.confidence === "number" ? cov.confidence : 0;
  if (score !== null) parts.push(`coverage ${score.toFixed(2)}/3 (conf ${confidence.toFixed(2)})`);

  // Coverage is a floor, the only rule that catches an empty turn (no hazard asks "did you do
  // anything?"). An unconfident Score is spread, not bad, so it may not block.
  if (score !== null && score < t.minCoverage && confidence >= t.minCoverageConfidence) {
    fired.push(`- the work does not yet cover the request (coverage ${score.toFixed(2)} of 3)`);
  }

  const action = answers?.next_action;
  // Gate on the winning probability, not `confidence`: a genuine tie has near-zero confidence.
  const actionP = action?.probabilities?.[action?.choice] ?? 0;
  if (action?.choice) parts.push(`next=${action.choice} ${actionP.toFixed(2)}`);

  const line = `orly ${fired.length ? "⛔ block" : "✓ pass"} · ${parts.join(" · ")}`;
  if (!fired.length) return { block: false, reason: "", line, results: specResults };

  // The hazards decide whether to block; the Choice decides what the block asks for.
  const lead =
    actionP >= t.minActionProbability && ACTION_LEAD[action.choice]
      ? ACTION_LEAD[action.choice]
      : "Finish the outstanding work now.";

  return {
    block: true,
    reason: [
      "orly (an independent TypeSafe/Jev judgment on this turn) is not satisfied that the request is finished:",
      ...fired,
      "",
      lead,
      "If it genuinely cannot be finished, say so explicitly to the user and name what is left and why — that also satisfies the gate.",
    ].join("\n"),
    line,
    results: specResults,
  };
}

// ---------------------------------------------------------------- transport

export type JudgeOptions = {
  apiKey: string;
  /** Goal specs to check alongside the built-in questions, in the same request. */
  specs?: Spec[];
  /** Optional source of evidence the transcript does not contain. Never fatal. */
  enrich?: Enricher;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  thresholds?: Thresholds;
};

export type Judgment = {
  verdict: Verdict;
  answers: Record<string, any>;
  usage?: { input_tokens: number; output_tokens: number };
};

/** One request, six questions, one verdict. Throws on anything unusable. */
export async function judge(turn: Turn, opts: JudgeOptions): Promise<Judgment> {
  const specs = opts.specs ?? [];

  // Enrichment failure falls back to the transcript alone; it must never prevent a judgment.
  let evidence: any = undefined;
  if (opts.enrich) {
    try {
      evidence = await opts.enrich(turn, specs);
    } catch {
      /* fall through with no evidence */
    }
  }

  // `checks` must NOT go to the model: it would judge the repo's current state instead of
  // what the turn did (a passing checks.tests answers "did tests run?" for a turn that never ran them).
  const { checks, ...visible } = evidence ?? {};
  const { conclusive, ...state } = withEvidence(turn, visible);
  const { answers, usage } = await ask(state, { ...QUESTIONS, ...specQuestions(specs) }, opts);
  return {
    // `require` specs still see everything, including checks — they are decided in code.
    verdict: compose(answers, opts.thresholds ?? DEFAULTS, specs, evidence),
    answers,
    usage,
  };
}
