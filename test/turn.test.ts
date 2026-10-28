import { expect, test } from "bun:test";
import { isInjectedReason, MAX_RESULTS, messagesFrom, normalize, normalizeLastTurn, selectResults, type Msg } from "../orly.ts";

const anthropic: Msg[] = [
  { role: "user", content: "add a retry and run the tests" },
  { role: "assistant", content: [
    { type: "text", text: "on it" },
    { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "src/http.ts" } },
    { type: "tool_use", id: "tu2", name: "Bash", input: { command: "bun test" } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "1 fail: retry.test.ts" }] },
  { role: "assistant", content: [{ type: "text", text: "All tests pass." }] },
];

const openai: Msg[] = [
  { role: "user", content: "add a retry and run the tests" },
  { role: "assistant", content: "on it", tool_calls: [
    { function: { name: "edit_file", arguments: '{"file_path":"src/http.ts"}' } },
    { id: "c2", function: { name: "bash", arguments: '{"command":"bun test"}' } },
  ] },
  { role: "tool", tool_call_id: "c2", name: "bash", content: "1 fail: retry.test.ts" },
  { role: "assistant", content: "All tests pass." },
];

test("normalizes the Anthropic dialect", () => {
  const t = normalize(anthropic);
  expect(t.user_request).toBe("add a retry and run the tests");
  expect(t.actions_taken).toEqual(["#1 Edit: src/http.ts", "#2 Bash: bun test"]);
  expect(t.command_results).toEqual(["#2 → 1 fail: retry.test.ts"]);
  expect(t.assistant_final_message).toBe("All tests pass.");
  expect(t.conclusive).toBe(true);
});

test("normalizes the OpenAI dialect to the same turn, tool names aside", () => {
  const { actions_taken: a, ...rest } = normalize(openai);
  const { actions_taken: b, ...want } = normalize(anthropic);
  expect(rest).toEqual(want);
  expect(a).toEqual(["#1 edit_file: src/http.ts", "#2 bash: bun test"]);
});

test("failures survive the result budget", () => {
  const results = Array.from({ length: 30 }, (_, i) => (i === 2 ? "#3 → error: boom" : `#${i + 1} → ok`));
  const kept = selectResults(results);
  expect(kept.length).toBe(MAX_RESULTS);
  expect(kept[0]).toBe("#3 → error: boom");
});

test("the last turn starts at the last human message and skips the gate's own feedback", () => {
  const messages: Msg[] = [
    { role: "user", content: "first task" },
    { role: "assistant", content: "done one" },
    { role: "user", content: "second task" },
    { role: "assistant", content: "half" },
    { role: "user", content: "Stop hook feedback: orly: guards not upheld this turn (1 of 2):\n- x" },
    { role: "assistant", content: "finished two" },
  ];
  const t = normalizeLastTurn(messages);
  expect(t.user_request).toBe("second task");
  expect(t.assistant_final_message).toBe("finished two");
  expect(isInjectedReason("orly: guard not upheld this turn (1 of 1):")).toBe(true);
  expect(isInjectedReason("orly is a nice owl")).toBe(false);
});

test("a lagging transcript gets the closing message appended", () => {
  const t = normalizeLastTurn([{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }] }], "listed x");
  expect(t.assistant_final_message).toBe("listed x");
  expect(t.conclusive).toBe(true);
});

test("Claude Code JSONL: sidechain and meta lines are dropped", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { content: "sub" } }),
    JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    "not json",
  ].join("\n");
  expect(messagesFrom(jsonl).map((m) => m.role)).toEqual(["user", "assistant"]);
});
