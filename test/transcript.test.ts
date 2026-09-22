import { expect, test } from "bun:test";
import { messagesFrom } from "../adapters/claude-transcript.ts";
import { normalizeLastTurn } from "../src/normalize.ts";

const line = (o: unknown) => JSON.stringify(o);

const transcript = [
  line({ type: "user", message: { content: "implement the parser and run the tests" } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "p.ts" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
  // What Claude Code injects after a Stop hook blocks — a USER message carrying orly's
  // own complaint.
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
  // Slicing at the injected message would shrink the turn to whatever came after it,
  // hiding everything the block was complaining about.
  const t = normalizeLastTurn(messagesFrom(transcript));
  expect(t.actions_taken).toEqual(["Edit: p.ts", "Bash: bun test"]);
  expect(t.command_results).toEqual(["ok", "3 pass"]);
});

test("subagent and unparseable lines are still dropped", () => {
  const noisy = [transcript, "{not json", line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } })].join("\n");
  expect(normalizeLastTurn(messagesFrom(noisy)).assistant_final_message).toBe("fixed");
});
