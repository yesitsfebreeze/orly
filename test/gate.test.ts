import { expect, test } from "bun:test";
import { compose, DEFAULTS, judge, QUESTIONS } from "../src/gate.ts";
import { MAX_RESULTS, normalize, normalizeLastTurn, selectResults, type Msg } from "../src/normalize.ts";

// ---------------------------------------------------------------- normalize

const anthropic: Msg[] = [
  { role: "user", content: "add a retry and run the tests" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "on it" },
      { type: "tool_use", name: "Edit", input: { file_path: "src/http.ts" } },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", content: "1 fail: retry.test.ts" }] },
  { role: "assistant", content: [{ type: "text", text: "All tests pass." }] },
];

const openai: Msg[] = [
  { role: "user", content: "add a retry and run the tests" },
  {
    role: "assistant",
    content: "on it",
    tool_calls: [
      { function: { name: "edit_file", arguments: '{"file_path":"src/http.ts"}' } },
      { function: { name: "bash", arguments: '{"command":"bun test"}' } },
    ],
  },
  { role: "tool", name: "bash", content: "1 fail: retry.test.ts" },
  { role: "assistant", content: "All tests pass." },
];

test("normalizes the Anthropic dialect", () => {
  const t = normalize(anthropic);
  expect(t.user_request).toBe("add a retry and run the tests");
  expect(t.actions_taken).toEqual(["Edit: src/http.ts", "Bash: bun test"]);
  expect(t.command_results).toEqual(["1 fail: retry.test.ts"]);
  expect(t.assistant_final_message).toBe("All tests pass.");
  expect(t.conclusive).toBe(true);
});

test("normalizes the OpenAI dialect to the same turn", () => {
  const t = normalize(openai);
  expect(t.actions_taken).toEqual(["edit_file: src/http.ts", "bash: bun test"]);
  expect(t.command_results).toEqual(["1 fail: retry.test.ts"]);
  expect(t.assistant_final_message).toBe("All tests pass.");
});

test("assistant_said keeps a skip declared mid-turn, which the closing line drops", () => {
  // An agent declares a blocker when it hits one — mid-turn — while the closing line is
  // often just "done". Judging the declaration against the closing line alone scores it
  // as never declared.
  const t = normalize([
    { role: "user", content: "add a --json flag, wire it into CI, update the README table" },
    { role: "assistant", content: [{ type: "text", text: "Skipping the README table: it is generated from a schema I cannot reach." }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "cli.ts" } }] },
    { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "Done — the flag is in and CI runs it." }] },
  ]);
  expect(t.assistant_final_message).toBe("Done — the flag is in and CI runs it.");
  expect(t.assistant_said).toContain("Skipping the README table");
  expect(t.assistant_said).toContain("Done — the flag is in");
});

test("a turn is not conclusive until the agent speaks after its last action", () => {
  const midFlush = anthropic.slice(0, 3); // preamble + tools + result, no closing message
  expect(normalize(midFlush).conclusive).toBe(false);
  // The preamble alone must not be mistaken for the conclusion.
  expect(normalize(midFlush).assistant_final_message).toBe("on it");
  expect(normalize(anthropic).conclusive).toBe(true);
});

test("normalizeLastTurn starts at the last genuine human message", () => {
  const t = normalizeLastTurn([{ role: "user", content: "old request" }, ...anthropic]);
  expect(t.user_request).toBe("add a retry and run the tests");
  expect(t.actions_taken).toHaveLength(2);
});

test("selectResults keeps failures that a blind tail would drop", () => {
  const results = ["npm ERR! build failed", ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)];
  const kept = selectResults(results);
  expect(kept).toHaveLength(MAX_RESULTS);
  expect(kept[0]).toBe("npm ERR! build failed");
  expect(kept.at(-1)).toBe("ok 19"); // the tail is still there
  expect(results.slice(-MAX_RESULTS)).not.toContain("npm ERR! build failed"); // what we fixed
});

test("selectResults leaves a short list alone", () => {
  expect(selectResults(["a", "b"])).toEqual(["a", "b"]);
});

// ---------------------------------------------------------------- policy

const quiet = {
  unverified_claim: { noul: 0.1 },
  placeholder_left: { noul: 0.1 },
  unaddressed_part: { noul: 0.1 },
  silent_failure: { noul: 0.1 },
};

test("compose passes a clean turn", () => {
  const v = compose({ ...quiet, coverage: { score: 2.9, confidence: 0.9 } });
  expect(v.block).toBe(false);
  expect(v.line).toContain("✓ pass");
});

test("compose blocks on a hazard and names it", () => {
  const v = compose({
    ...quiet,
    unverified_claim: { noul: 0.91 },
    silent_failure: { noul: 0.88 },
    coverage: { score: 2.4, confidence: 0.8 },
  });
  expect(v.block).toBe(true);
  expect(v.reason).toContain("without running anything");
  expect(v.reason).toContain("failed and the turn ends");
});

test("low coverage blocks only when the Score is confident", () => {
  expect(compose({ ...quiet, coverage: { score: 0.6, confidence: 0.85 } }).block).toBe(true);
  expect(compose({ ...quiet, coverage: { score: 0.6, confidence: 0.2 } }).block).toBe(false);
});

test("the Choice supplies the block's lead instruction", () => {
  const answers = {
    ...quiet,
    unaddressed_part: { noul: 0.95 },
    coverage: { score: 2.0, confidence: 0.9 },
    next_action: { choice: "report_the_blocker", probabilities: { report_the_blocker: 0.81 } },
  };
  expect(compose(answers).reason).toContain("You are blocked.");
});

test("a coin-flip Choice falls back to the generic instruction", () => {
  // Gate on the winner's probability, not on confidence: a genuine tie is not an error.
  const answers = {
    ...quiet,
    unaddressed_part: { noul: 0.95 },
    coverage: { score: 2.0, confidence: 0.9 },
    next_action: { choice: "report_the_blocker", probabilities: { report_the_blocker: 0.34 } },
  };
  expect(compose(answers).reason).toContain("Finish the outstanding work now.");
});

test("a missing or malformed answer never blocks by itself", () => {
  expect(compose({}).block).toBe(false);
  expect(compose({ coverage: { score: null, confidence: 1 } }).block).toBe(false);
});

test("thresholds are overridable without touching the questions", () => {
  const answers = { ...quiet, unaddressed_part: { noul: 0.6 }, coverage: { score: 2.5, confidence: 0.9 } };
  expect(compose(answers).block).toBe(false);
  expect(compose(answers, { ...DEFAULTS, hazard: 0.5 }).block).toBe(true);
});

test("questions stay inside the API's stated limits", () => {
  expect(QUESTIONS.coverage.criteria.length).toBeGreaterThanOrEqual(2);
  expect(QUESTIONS.coverage.criteria.length).toBeLessThanOrEqual(10);
  expect(Object.keys(QUESTIONS.next_action.criteria).length).toBeGreaterThanOrEqual(2);
  for (const q of Object.values(QUESTIONS)) expect(["noul", "score", "choice"]).toContain(q.type);
});

// ---------------------------------------------------------------- the verdict carries its own results

test("compose carries the spec results it was composed from", () => {
  // The adapter logs which specs went unmet and counts how many were met. Re-scoring for
  // that meant passing the evidence a second time, and the caller that did not got every
  // `require` spec evaluated against nothing — recorded as failing on turns where it had
  // passed, into the log that `orly fit` tunes on.
  const specs = [
    { id: "tests", instructions: "n/a", require: { path: "checks.tests.exit", op: "equals", value: 0 } },
  ] as any;
  const v = compose({ ...quiet, coverage: { score: 2.9, confidence: 0.9 } }, DEFAULTS, specs, {
    checks: { tests: { exit: 0 } },
  });
  expect(v.block).toBe(false);
  expect(v.results.map((r) => [r.spec.id, r.met])).toEqual([["tests", true]]);
});

// ---------------------------------------------------------------- transport

/** Answer every judge request with `body`, without going near the network. */
function withTransport<T>(body: unknown, status: number, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as any;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

const turnStub = {
  user_request: "do the thing",
  assistant_final_message: "done",
  assistant_said: "done",
  actions_taken: ["Bash: bun test"],
  command_results: ["ok"],
  conclusive: true,
};

test("a 200 that is not the judge is an outage, not evidence about the turn", async () => {
  // A stray local service on the mock's port answered {"ok":true} with HTTP 200 and the
  // hook crashed. A 200 in the wrong shape means we reached something that is not the
  // judge; it must never be read as a verdict.
  await withTransport({ ok: true }, 200, async () => {
    await expect(judge(turnStub, { apiKey: "k" })).rejects.toThrow("no answers");
  });
});

test("enrichment that throws never takes the judgment down", async () => {
  // Gathered evidence is a bonus. A judge that cannot run because a file read failed is
  // a wall in front of the agent for a reason that has nothing to do with the turn.
  await withTransport({ answers: { ...quiet, coverage: { score: 2.9, confidence: 0.9 } } }, 200, async () => {
    const { verdict } = await judge(turnStub, {
      apiKey: "k",
      enrich: async () => {
        throw new Error("kern is down");
      },
    });
    expect(verdict.block).toBe(false);
  });
});
