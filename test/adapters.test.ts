/** The hooks under install/, driven through a fake host over stdin. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGuard, loadSession, normalizeLastTurn, saveSession } from "../orly.ts";
import { codexMessages } from "../install/codex/adapter.ts";

const root = join(import.meta.dir, "..");
const hook = (adapter: string, input: unknown) => {
  const r = Bun.spawnSync(["bun", join(root, "install", adapter, "adapter.ts")], { stdin: Buffer.from(JSON.stringify(input)), env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test("Codex rollout items map onto the core's dialect", () => {
  const jsonl = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do it" }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "c", name: "shell", arguments: '{"command":"ls"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: JSON.stringify({ output: "a b", metadata: { exit_code: 0 } }) } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "listed" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const t = normalizeLastTurn(codexMessages(jsonl));
  expect(t.user_request).toBe("do it");
  expect(t.actions_taken).toEqual(["#1 shell: ls"]);
  expect(t.command_results).toEqual(["#1 → a b"]);
  expect(t.assistant_final_message).toBe("listed");
});

for (const adapter of ["claude", "codex"]) {
  test(`${adapter}: the prompt hook briefs the guards with the session id, a stop with no guards passes silently`, () => {
    const session = `hook-${adapter}-${Math.random().toString(36).slice(2)}`;
    const brief = hook(adapter, { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt: "add retries" });
    expect(brief.code).toBe(0);
    const ctx = JSON.parse(brief.out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(`guard --session ${session}`);
    expect(ctx).toContain("no guards yet");
    const stop = hook(adapter, { hook_event_name: "Stop", session_id: session, cwd: root, transcript_path: "/nonexistent" });
    expect(stop.code).toBe(0);
    expect(stop.out.trim()).toBe("");
  });
}

test("claude: a failing check refuses the stop with the guard named, and the next stop is not judged", () => {
  const dir = mkdtempSync(join(tmpdir(), "orly-hook-"));
  const session = `hook-block-${Math.random().toString(36).slice(2)}`;
  try {
    const s = loadSession(session);
    addGuard(s, "Does the build pass?", { check: "exit 1" });
    saveSession(s);
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, [JSON.stringify({ type: "user", message: { content: "build it" } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "built" }] } })].join("\n"));
    const first = hook("claude", { hook_event_name: "Stop", session_id: session, cwd: dir, transcript_path: transcript });
    expect(first.code).toBe(2);
    expect(first.err).toContain("guards not upheld after your last turn (build-pass)");
    const second = hook("claude", { hook_event_name: "Stop", session_id: session, cwd: dir, transcript_path: transcript });
    expect(second.code).toBe(0);
    const third = hook("claude", { hook_event_name: "Stop", session_id: session, cwd: dir, transcript_path: transcript });
    expect(third.code).toBe(2);
    hook("claude", { hook_event_name: "SessionEnd", session_id: session, cwd: dir });
    expect(loadSession(session).guards).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: a failing check answers the stop with a block decision", () => {
  const session = `hook-codex-${Math.random().toString(36).slice(2)}`;
  const dir = mkdtempSync(join(tmpdir(), "orly-codex-"));
  try {
    const s = loadSession(session);
    addGuard(s, "Does the build pass?", { check: "exit 1" });
    saveSession(s);
    const transcript = join(dir, "r.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "build it" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "built" }] } }),
    ].join("\n"));
    const r = hook("codex", { hook_event_name: "Stop", session_id: session, cwd: dir, transcript_path: transcript });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("build-pass");
    hook("codex", { hook_event_name: "SessionEnd", session_id: session, cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
