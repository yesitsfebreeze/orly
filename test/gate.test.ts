import { expect, test } from "bun:test";
import * as client from "../src/client.ts";
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
  // Gate on the winner's probability, not confidence: a tie is not an error.
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
  // Re-scoring without evidence would log every `require` spec as unmet.
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
  await withTransport({ ok: true }, 200, async () => {
    await expect(judge(turnStub, { apiKey: "k" })).rejects.toThrow("no answers");
  });
});

test("enrichment that throws never takes the judgment down", async () => {
  await withTransport({ answers: { ...quiet, coverage: { score: 2.9, confidence: 0.9 } } }, 200, async () => {
    const { verdict } = await judge(turnStub, {
      apiKey: "k",
      enrich: async () => {
        throw new Error("the evidence source is down");
      },
    });
    expect(verdict.block).toBe(false);
  });
});

test("the transport is one place: a non-2xx and a wrong-shaped 200 fail the same way", async () => {
  await withTransport("upstream on fire", 503, async () => {
    await expect(client.ask({}, {}, { apiKey: "k" })).rejects.toThrow("503");
  });
  await withTransport({ ok: true }, 200, async () => {
    await expect(client.ask({}, {}, { apiKey: "k" })).rejects.toThrow("no answers");
  });
  await withTransport({ answers: { q0: { noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }, 200, async () => {
    const out = await client.ask({}, { q0: { type: "noul" } }, { apiKey: "k" });
    expect(out.answers.q0.noul).toBe(0.9);
    expect(out.usage?.input_tokens).toBe(10);
  });
});

// ---------------------------------------------------------------- evidence that never arrived

const unmetSpec = (extra: object = {}) =>
  [{ id: "reviewed", instructions: "was it reviewed?", evidence: ["design_review"], ...extra }] as any;
const answersFor = (p: number) => ({ ...quiet, coverage: { score: 2.9, confidence: 0.9 }, "spec:reviewed": { noul: p } });

test("a spec judged on evidence that never arrived asks for it, in its own words", () => {
  // Evidence with no command behind it is requested from the working agent.
  const v = compose(answersFor(0.1), DEFAULTS, unmetSpec({ gather: "Paste the reviewer's verdict." }), {});
  expect(v.block).toBe(true);
  expect(v.reason).toContain("evidence not available: design_review");
  expect(v.reason).toContain("Paste the reviewer's verdict.");
});

test("a spec with no gather line still says what was missing", () => {
  expect(compose(answersFor(0.1), DEFAULTS, unmetSpec(), {}).reason).toContain("Produce it this turn");
});

test("a file recorded as absent is a reading, not a gathering failure", () => {
  // Asking for it would send the agent to recreate a file it deliberately deleted.
  const specs = [{ id: "gone", instructions: "is the stub gone?", evidence: ["stub.ts"] }] as any;
  const answers = { ...quiet, coverage: { score: 2.9, confidence: 0.9 }, "spec:gone": { noul: 0.1 } };
  const v = compose(answers, DEFAULTS, specs, { files: { "stub.ts": "[file does not exist]" } });
  expect(v.reason).toContain('spec "gone" is not met');
  expect(v.reason).not.toContain("evidence not available");
});

test("a context source that failed is a gathering failure", () => {
  const specs = [{ id: "t", instructions: "is the ticket done?", evidence: ["ticket"] }] as any;
  const answers = { ...quiet, coverage: { score: 2.9, confidence: 0.9 }, "spec:t": { noul: 0.1 } };
  const v = compose(answers, DEFAULTS, specs, { context: { ticket: '[context source "ticket" could not be read: exit 4]' } });
  expect(v.reason).toContain("evidence not available: ticket");
});

test("evidence that did arrive is never asked for again", () => {
  const specs = [{ id: "t", instructions: "is the ticket done?", evidence: ["ticket"] }] as any;
  const answers = { ...quiet, coverage: { score: 2.9, confidence: 0.9 }, "spec:t": { noul: 0.1 } };
  const v = compose(answers, DEFAULTS, specs, { context: { ticket: "PROJ-42 status: In Review" } });
  expect(v.reason).not.toContain("evidence not available");
});
