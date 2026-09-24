import { expect, test } from "bun:test";
import { messagesFrom } from "../orly.ts";
import { normalizeLastTurn } from "../orly.ts";

const line = (o: unknown) => JSON.stringify(o);

const transcript = [
  line({ type: "user", message: { content: "implement the parser and run the tests" } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "p.ts" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
  // Injected after a Stop hook block: a user message carrying orly's own complaint.
  line({ type: "user", isMeta: true, message: { content: "Stop hook feedback:\norly is not satisfied…" } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", content: "3 pass" }] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "fixed" }] } }),
].join("\n");

test("the hook's own block message never becomes the user's request", () => {
  const t = normalizeLastTurn(messagesFrom(transcript));
  expect(t.user_request).toBe("implement the parser and run the tests");
  expect(t.user_request).not.toContain("orly");
});

test("work done before a block stays in the turn being judged", () => {
  // Slicing at the injected message would hide the work the block was about.
  const t = normalizeLastTurn(messagesFrom(transcript));
  expect(t.actions_taken).toEqual(["#1 Edit: p.ts", "#2 Bash: bun test"]);
  expect(t.command_results).toEqual(["#1 → ok", "#2 → 3 pass"]);
});

test("subagent and unparseable lines are still dropped", () => {
  const noisy = [transcript, "{not json", line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } })].join("\n");
  expect(normalizeLastTurn(messagesFrom(noisy)).assistant_final_message).toBe("fixed");
});

test("a block message as Claude Code really writes it (no isMeta) stays out of the request", () => {
  // Real transcripts carry the feedback as a plain user entry prefixed "Stop hook feedback:".
  const real = transcript.replace('"isMeta":true,', "").replace("orly is not satisfied…", "orly (an independent TypeSafe/Jev judgment on this turn) is not satisfied…");
  expect(real).not.toContain("isMeta");
  const t = normalizeLastTurn(messagesFrom(real));
  expect(t.user_request).toBe("implement the parser and run the tests");
  expect(t.actions_taken).toEqual(["#1 Edit: p.ts", "#2 Bash: bun test"]);
});
