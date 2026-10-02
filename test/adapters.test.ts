/**
 * The host adapters under install/, driven through a fake host: messages map onto the core's
 * dialect, a block goes back to the session, and a weakening edit is refused. No judge call:
 * a weakened baseline blocks before the key is read.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { endSession, gateTurn, normalizeLastTurn, setOff } from "../orly.ts";
import OrlyPlugin, { toAnthropic as opencodeMessages } from "../install/opencode/plugin.ts";
import piExtension, { toAnthropic as piMessages } from "../install/pi/extension.ts";
import { codexMessages } from "../install/codex/adapter.ts";

test("OpenCode SDK messages and Pi messages map onto the same dialect", () => {
  const t1 = normalizeLastTurn(opencodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "c", state: { status: "completed", input: { command: "ls" }, output: "a b" } }, { type: "text", text: "listed" }] },
  ]));
  expect(t1.actions_taken).toEqual(["#1 bash: ls"]);
  expect(t1.command_results).toEqual(["#1 → a b"]);
  expect(t1.assistant_final_message).toBe("listed");

  const t2 = normalizeLastTurn(piMessages([
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "listed" }] },
  ]));
  expect(t2.actions_taken).toEqual(["#1 bash: ls"]);
  expect(t2.command_results).toEqual(["#1 → a b"]);
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

test("Pi: a weakening edit is blocked and a blocked turn sends a follow-up once the session is armed", async () => {
  const p = await project();
  const was = process.cwd();
  try {
    process.chdir(p.dir);
    const on: Record<string, Function> = {};
    const sent: string[] = [];
    const commands: Record<string, any> = {};
    piExtension({ on: (name: string, f: Function) => { on[name] = f; }, registerCommand: (name: string, c: any) => { commands[name] = c; }, sendUserMessage: (t: string) => sent.push(t), sendMessage: () => {} });
    const ctx = { ui: { notify: () => {} } };

    // Inert until /orly: no brief at session start, nothing judged, no edit blocked.
    expect(on.session_start).toBeUndefined();
    expect(await on.tool_call({ toolName: "edit", input: { path: p.spec, edits: [{ oldText: "cut: 0.9", newText: "cut: 0.3" }] } })).toBeUndefined();
    p.weaken();
    await on.agent_end({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "done" }] }] }, ctx);
    expect(sent.join("")).toBe("");

    // `/orly` arms it: the real Pi edit shape (path + edits[].oldText/newText) is refused, and the
    // blocked turn follows up. A tightening edit of the same spec is allowed through.
    expect(commands.orly).toBeDefined();
    await commands.orly.handler("", ctx);
    const blocked = await on.tool_call({ toolName: "edit", input: { path: p.spec, edits: [{ oldText: "cut: 0.3", newText: "cut: 0.2" }] } });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("refuses this edit");
    expect(await on.tool_call({ toolName: "edit", input: { path: p.spec, edits: [{ oldText: "cut: 0.3", newText: "cut: 0.95" }] } })).toBeUndefined();
    await on.agent_end({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "done" }] }] }, ctx);
    expect(sent.join("")).toContain("refuses this edit");
    await commands.orly.handler("off", ctx);
    expect(await on.tool_call({ toolName: "edit", input: { path: p.spec, edits: [{ oldText: "cut: 0.3", newText: "cut: 0.2" }] } })).toBeUndefined();
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
  expect(t.actions_taken).toEqual(["#1 exec: bun test", "#2 shell: make"]);
  expect(t.command_results).toEqual(["#1 → Script completed\n3 pass", "#2 → make: *** [all] Error 2\n[exit code 2]"]);
  expect(t.assistant_final_message).toBe("tests pass, make fails");
  expect(t.conclusive).toBe(true);
});

test("a closing message the transcript has not caught up with makes the turn conclusive", () => {
  const lagging = [
    { role: "user", content: "fix add" },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "bun test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "1 pass" }] },
  ];
  expect(normalizeLastTurn(lagging).conclusive).toBe(false);
  const t = normalizeLastTurn(lagging, "Fixed; bun test passes.");
  expect(t.conclusive).toBe(true);
  expect(t.assistant_final_message).toBe("Fixed; bun test passes.");
  expect(t.command_results).toEqual(["#1 → 1 pass"]);
  // A transcript that already has it is left alone, and a blank one changes nothing.
  const flushed = [...lagging, { role: "assistant", content: "done" }];
  expect(normalizeLastTurn(flushed, "done").assistant_final_message).toBe("done");
  expect(normalizeLastTurn(lagging, "  ").conclusive).toBe(false);
});

test("a reply to block feedback the transcript has not caught up with is what gets judged", () => {
  const answered = [
    { role: "user", content: "fix add" },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "bun test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "1 pass" }] },
    { role: "assistant", content: "Fixed." },
    { role: "user", content: "Stop hook feedback:\norly (an independent TypeSafe/Jev judgment on this turn) is not satisfied" },
  ];
  const t = normalizeLastTurn(answered, "Done: fixed, 1 pass. Open: nothing.");
  expect(t.assistant_final_message).toBe("Done: fixed, 1 pass. Open: nothing.");
  expect(t.assistant_said).toBe("Fixed.\n\nDone: fixed, 1 pass. Open: nothing.");
  expect(t.user_request).toBe("fix add");
});

test("Codex: the hook fails open, and blocks a weakened gate with the transcript found by session id", async () => {
  const p = await project();
  try {
    const hook = (payload: unknown) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "codex", "adapter.ts")], {
      cwd: p.dir, stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
      env: { ...process.env, CODEX_HOME: join(p.dir, "codex"), TYPESAFE_API_KEY: "test-key-never-used" }, stdout: "pipe", stderr: "pipe",
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

test("Claude Code: a pass prints nothing; a failed turn exits 2 with a message for the model on stderr", async () => {
  const p = await project(), sid = `claude-${Math.random()}`;
  try {
    const hook = () => Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "claude", "adapter.ts")], {
      cwd: p.dir, stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: p.dir, session_id: sid, transcript_path: join(p.dir, "none.jsonl") })),
      env: { ...process.env, TYPESAFE_API_KEY: "test-key-never-used" }, stdout: "pipe", stderr: "pipe",
    });
    const pass = hook();
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout.toString()).toBe("");
    p.weaken();
    const r = hook();
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toContain("does not think it is finished");
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "install", "claude", "hooks.json"), "utf8")).hooks;
    expect(hooks.Stop[0].hooks[0]).toMatchObject({ asyncRewake: true });
    expect(JSON.stringify(hooks)).not.toContain("statusMessage");
  } finally {
    for (const ext of ["json", "verdict.md", "flagged"]) rmSync(join(homedir(), ".orly", "status", `${sid}.${ext}`), { force: true });
    p.done();
  }
});

test("Claude Code: a session turned off passes every hook, a weakened gate included", async () => {
  const p = await project(), sid = `claude-off-${Math.random()}`;
  try {
    const hook = (payload: object) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "claude", "adapter.ts")], {
      cwd: p.dir, stdin: Buffer.from(JSON.stringify({ cwd: p.dir, session_id: sid, transcript_path: join(p.dir, "none.jsonl"), ...payload })),
      env: { ...process.env, TYPESAFE_API_KEY: "test-key-never-used" }, stdout: "pipe", stderr: "pipe",
    });
    setOff(sid, true);
    p.weaken();
    const stop = hook({ hook_event_name: "Stop" });
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout.toString()).toBe("");
    expect(stop.stderr.toString()).toBe("");
    const edit = hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(p.dir, ".orly", "specs", "g", "one.spec"), content: "cut: 0.1\n\nis it done?\n" } });
    expect(edit.stdout.toString()).toBe("");
    expect(hook({ hook_event_name: "SessionStart" }).stdout.toString()).toBe("");
    setOff(sid, false);
    expect(hook({ hook_event_name: "Stop" }).exitCode).toBe(2);
  } finally {
    endSession(sid);
    for (const ext of ["json", "verdict.md", "flagged"]) rmSync(join(homedir(), ".orly", "status", `${sid}.${ext}`), { force: true });
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

test("Codex loads the plugin's own hooks file: only the keys it parses, the Codex adapter, versions in step", async () => {
  const root = join(import.meta.dir, "..");
  const codex = await Bun.file(join(root, ".codex-plugin/plugin.json")).json();
  const claude = await Bun.file(join(root, ".claude-plugin/plugin.json")).json();
  // Codex appends its documented cachebuster without changing the release version.
  expect(codex.version.replace(/\+codex\.[0-9A-Za-z.-]+$/, "")).toBe(claude.version);
  const hooks = await Bun.file(join(root, codex.hooks)).json();
  expect(Object.keys(hooks).every(k => k === "hooks" || k === "description")).toBe(true); // `modules` broke Codex
  for (const groups of Object.values<any[]>(hooks.hooks))
    for (const h of groups.flatMap(g => g.hooks)) {
      expect(h.command).toContain("${PLUGIN_ROOT}/install/codex/adapter.ts");
      expect(h.timeout).toBeLessThanOrEqual(35);
    }
});

test("Codex: wrapped Orly stop feedback preserves the human request and failed command evidence", () => {
  for (const prefix of ['', 'Warning: truncated output (original token count: 2756)\nTotal output lines: 20\n\n']) {
    const lines = [
      item({type:'message',role:'user',content:[{type:'input_text',text:'Fix the checks that are open'}]}),
      item({type:'function_call',call_id:'failed-check',name:'shell',arguments:JSON.stringify({command:'bun test'})}),
      item({type:'function_call_output',call_id:'failed-check',output:'1 fail; exit code 1'}),
      item({type:'message',role:'user',content:[{type:'input_text',text:`<hook_prompt hook_run_id="stop:3:/plugins/orly/install/codex/hooks.json">${prefix}orly (an independent TypeSafe/Jev judgment on this turn) is not satisfied\nRun the check.</hook_prompt>`}]}),
      item({type:'message',role:'assistant',content:[{type:'output_text',text:'The failing check remains unresolved.'}]}),
    ];
    const turn=normalizeLastTurn(codexMessages(lines.join('\n')));
    expect(turn.user_request).toBe('Fix the checks that are open');
    expect(turn.actions_taken).toEqual(['#1 shell: bun test']);
    expect(turn.command_results).toEqual(['#1 → 1 fail; exit code 1']);
    const steered=normalizeLastTurn(codexMessages([...lines,item({type:'message',role:'user',content:[{type:'input_text',text:'Now check the editor instead'}]})].join('\n')));
    expect(steered.user_request).toBe('Now check the editor instead');
  }
});

test("Codex: quoted hook text and unrelated hook messages are not discarded", () => {
  for(const body of ['Please explain <hook_prompt>orly (an independent judge)</hook_prompt>', '<hook_prompt hook_run_id="stop:3:other">Another checker requests verification.</hook_prompt>']){
    const turn=normalizeLastTurn(codexMessages(item({type:'message',role:'user',content:[{type:'input_text',text:body}]})));
    expect(turn.user_request).toBe(body);
  }
});
