/**
 * The host adapters under install/, driven through a fake host: messages map onto the core's
 * dialect, a block goes back to the session, and a weakening edit is refused. No judge call:
 * a weakened baseline blocks before the key is read.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateTurn, normalizeLastTurn } from "../orly.ts";
import OrlyPlugin, { toAnthropic as opencodeMessages } from "../install/opencode/plugin.ts";
import piExtension, { toAnthropic as piMessages } from "../install/pi/extension.ts";
import { codexMessages } from "../install/codex/adapter.ts";

test("OpenCode SDK messages and Pi messages map onto the same dialect", () => {
  const t1 = normalizeLastTurn(opencodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "c", state: { status: "completed", input: { command: "ls" }, output: "a b" } }, { type: "text", text: "listed" }] },
  ]));
  expect(t1.actions_taken).toEqual(["bash: ls"]);
  expect(t1.command_results).toEqual(["a b"]);
  expect(t1.assistant_final_message).toBe("listed");

  const t2 = normalizeLastTurn(piMessages([
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "listed" }] },
  ]));
  expect(t2.actions_taken).toEqual(["bash: ls"]);
  expect(t2.command_results).toEqual(["a b"]);
  expect(t2.conclusive).toBe(true);
});

/** A project whose spec has cut 0.9 in the baseline; `weaken()` lowers it on disk. */
async function project() {
  const dir = mkdtempSync(join(tmpdir(), "orly-host-"));
  const spec = join(dir, ".orly", "specs", "g", "one.spec");
  mkdirSync(join(dir, ".orly", "specs", "g"), { recursive: true });
  writeFileSync(spec, "cut: 0.9\n\nDoes `command_results` show the parser passing its tests?\n");
  await gateTurn({ cwd: dir, sessionId: `host-${Math.random()}`, read: async () => null }); // records the baseline
  return { dir, spec, weaken: () => writeFileSync(spec, "cut: 0.3\n\nDoes `command_results` show the parser passing its tests?\n"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("OpenCode: a weakening edit throws, and a blocked turn re-prompts the session", async () => {
  const p = await project();
  try {
    const prompts: any[] = [];
    const client = { session: {
      messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "go" }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }] }),
      prompt: async (x: any) => { prompts.push(x); },
    } };
    const plugin = await OrlyPlugin({ client, directory: p.dir });
    await expect(plugin["tool.execute.before"]({ tool: "edit" }, { args: { filePath: p.spec, oldString: "cut: 0.9", newString: "cut: 0.3" } })).rejects.toThrow("refuses");
    await plugin["tool.execute.before"]({ tool: "edit" }, { args: { filePath: p.spec, oldString: "cut: 0.9", newString: "cut: 0.95" } });
    p.weaken();
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await Bun.sleep(10);
    expect(prompts.map((x) => x.body.parts[0].text).join("")).toContain("refuses this edit");
  } finally {
    p.done();
  }
});

test("Pi: a weakening edit is blocked, and a blocked turn sends a follow-up", async () => {
  const p = await project();
  const was = process.cwd();
  try {
    process.chdir(p.dir);
    const on: Record<string, Function> = {};
    const sent: string[] = [];
    piExtension({ on: (name: string, f: Function) => { on[name] = f; }, sendUserMessage: (t: string) => sent.push(t), sendMessage: () => {} });
    expect(await on.tool_call({ toolName: "edit", input: { path: p.spec, oldText: "cut: 0.9", newText: "cut: 0.3" } })).toMatchObject({ block: true });
    expect(await on.tool_call({ toolName: "edit", input: { path: p.spec, oldText: "cut: 0.9", newText: "cut: 0.95" } })).toBeUndefined();
    p.weaken();
    await on.agent_end({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "done" }] }] }, {});
    expect(sent.join("")).toContain("refuses this edit");
  } finally {
    process.chdir(was);
    p.done();
  }
});

const item = (payload: unknown) => JSON.stringify({ type: "response_item", payload });
const rollout = [
  JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
  item({ type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>" }] }),
  item({ type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo" }] }),
  item({ type: "message", role: "user", content: [{ type: "input_text", text: "run the tests" }] }),
  item({ type: "message", role: "user", content: [{ type: "input_text", text: '<codex_internal_context source="goal">keep going' }] }),
  item({ type: "reasoning", encrypted_content: "…" }),
  item({ type: "custom_tool_call", call_id: "a", name: "exec", input: "bun test" }),
  item({ type: "custom_tool_call_output", call_id: "a", output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: "3 pass" }] }),
  item({ type: "function_call", call_id: "b", name: "shell", arguments: '{"command":["make"]}' }),
  item({ type: "function_call_output", call_id: "b", output: JSON.stringify({ output: "make: *** [all] Error 2", metadata: { exit_code: 2 } }) }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "tests pass, make fails" }] }),
  "{half a line",
].join("\n");

test("Codex: a rollout reads as one turn, with injected context, reasoning and events dropped", () => {
  const t = normalizeLastTurn(codexMessages(rollout));
  expect(t.user_request).toBe("run the tests");
  expect(t.actions_taken).toEqual(["exec: bun test", "shell: make"]);
  expect(t.command_results).toEqual(["Script completed\n3 pass", "make: *** [all] Error 2\n[exit code 2]"]);
  expect(t.assistant_final_message).toBe("tests pass, make fails");
  expect(t.conclusive).toBe(true);
});

test("Codex: the hook fails open, and blocks a weakened gate with the transcript found by session id", async () => {
  const p = await project();
  try {
    const hook = (payload: unknown) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "codex", "adapter.ts")], {
      cwd: p.dir, stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
      env: { ...process.env, CODEX_HOME: join(p.dir, "codex") }, stdout: "pipe", stderr: "pipe",
    });
    for (const bad of ["not json", { hook_event_name: "Stop", cwd: p.dir, session_id: "nope" }]) {
      const r = hook(bad);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe("");
    }
    mkdirSync(join(p.dir, "codex", "sessions", "2026", "09", "24"), { recursive: true });
    writeFileSync(join(p.dir, "codex", "sessions", "2026", "09", "24", "rollout-2026-09-24T10-00-00-sid1.jsonl"), rollout);
    p.weaken();
    const r = hook({ hook_event_name: "Stop", cwd: p.dir, session_id: "sid1", transcript_path: null });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ decision: "block" });
    expect(r.stdout.toString()).toContain("refuses this edit");
  } finally {
    p.done();
  }
});

test("Cursor: preToolUse denies a weakening edit, and stop blocks a weakened gate as a follow-up", async () => {
  const p = await project();
  try {
    const hook = (payload: unknown) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "cursor", "adapter.ts")], {
      cwd: p.dir, stdin: Buffer.from(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe",
    });
    const pre = (to: string) => JSON.parse(hook({ hook_event_name: "preToolUse", cwd: p.dir, tool_name: "Write",
      tool_input: { file_path: p.spec, content: `cut: ${to}\n\nDoes \`command_results\` show the parser passing its tests?\n` } }).stdout.toString());
    expect(pre("0.3").permission).toBe("deny");
    expect(pre("0.95").permission).toBe("allow");
    const aborted = hook({ hook_event_name: "stop", workspace_roots: [p.dir], status: "aborted", conversation_id: "c" });
    expect(aborted.stdout.toString()).toBe("");
    p.weaken();
    const r = hook({ hook_event_name: "stop", workspace_roots: [p.dir], status: "completed", conversation_id: "c", transcript_path: null });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).followup_message).toContain("refuses this edit");
  } finally {
    p.done();
  }
});
