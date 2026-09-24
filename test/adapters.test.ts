/**
 * The host adapters: every transcript format is read into the same Turn, every adapter
 * fails open on a payload it cannot use, the installer is idempotent for every host, and
 * every manifest points at files that exist.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/install.ts";
import { normalizeLastTurn } from "../src/normalize.ts";
import { HOSTS, plan, shippedToml, supportTable } from "../adapters/hosts.ts";
import { toAnthropic as opencodeMessages } from "../adapters/opencode.ts";
import { toAnthropic as piMessages } from "../adapters/pi.ts";
import { messagesFromAny } from "../adapters/transcripts.ts";

const ROOT = join(import.meta.dir, "..");
const line = (o: unknown) => JSON.stringify(o);
const sandbox = () => mkdtempSync(join(tmpdir(), "orly-adapters-"));

// ---------------------------------------------------------------- transcripts

test("a Codex rollout reads as the same turn a Claude transcript would", () => {
  const rollout = [
    line({ type: "session_meta", payload: { id: "s1", cwd: "/p" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd: /p</environment_context>" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a test for parse()" }] } }),
    line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":["bash","-lc","bun test"]}' } }),
    line({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: '{"output":"1 pass 1 fail","metadata":{"exit_code":1}}' } }),
    line({ type: "event_msg", payload: { type: "agent_message", message: "ignored: UI event" } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tests pass" }] } }),
  ].join("\n");
  const t = normalizeLastTurn(messagesFromAny(rollout));
  expect(t.user_request).toBe("add a test for parse()");
  expect(t.actions_taken).toEqual(["shell: bash,-lc,bun test"]);
  expect(t.command_results).toEqual(["1 pass 1 fail\n[exit code 1]"]);
  expect(t.assistant_final_message).toBe("tests pass");
  expect(t.conclusive).toBe(true);
});

test("a Gemini chat file reads with its nested tool calls", () => {
  const chat = line({
    sessionId: "g1",
    messages: [
      { id: "1", type: "user", content: "fix the build" },
      {
        id: "2",
        type: "gemini",
        content: "done",
        toolCalls: [
          { id: "t1", name: "run_shell_command", args: { command: "bun build" }, status: "success", result: [{ functionResponse: { response: { output: "built" } } }] },
        ],
      },
    ],
  });
  const t = normalizeLastTurn(messagesFromAny(chat));
  expect(t.user_request).toBe("fix the build");
  expect(t.actions_taken).toEqual(["run_shell_command: bun build"]);
  expect(t.command_results).toEqual(["built"]);
  // The model's text comes before its tool calls in one entry, so the turn is not conclusive.
  expect(t.conclusive).toBe(false);
});

test("a Copilot event log reads its tool executions", () => {
  const events = [
    line({ type: "user.message", data: { content: "run the linter" } }),
    line({ type: "tool.execution_start", data: { toolCallId: "x", toolName: "bash", arguments: { command: "bun lint" } } }),
    line({ type: "tool.execution_complete", data: { toolCallId: "x", result: "0 problems", success: true } }),
    line({ type: "assistant.message", data: { content: "lint is clean" } }),
  ].join("\n");
  const t = normalizeLastTurn(messagesFromAny(events));
  expect(t.actions_taken).toEqual(["bash: bun lint"]);
  expect(t.command_results).toEqual(["0 problems"]);
  expect(t.assistant_final_message).toBe("lint is clean");
});

test("plain {role, content} logs and unknown formats", () => {
  const plain = [line({ role: "user", content: "hi" }), line({ role: "assistant", content: "hello" })].join("\n");
  expect(normalizeLastTurn(messagesFromAny(plain)).assistant_final_message).toBe("hello");
  expect(messagesFromAny("")).toEqual([]);
  expect(messagesFromAny("nonsense\nmore nonsense")).toEqual([]);
  expect(messagesFromAny(line({ type: "something", else: true }))).toEqual([]);
});

test("a block reason echoed back as a user message is not the request, and the work before it stays", () => {
  const messages = [
    { role: "user", content: "implement it" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Edit", input: { file_path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
    { role: "assistant", content: "done" },
    { role: "user", content: "orly (an independent TypeSafe/Jev judgment on this turn) is not satisfied…" },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "Bash", input: { command: "bun test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "3 pass" }] },
    { role: "assistant", content: "fixed" },
  ];
  const t = normalizeLastTurn(messages);
  expect(t.user_request).toBe("implement it");
  expect(t.actions_taken).toEqual(["Edit: a.ts", "Bash: bun test"]);
  expect(t.assistant_final_message).toBe("fixed");
});

test("OpenCode SDK messages and Pi messages map onto the same dialect", () => {
  const oc = opencodeMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: "do it" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "c", state: { status: "completed", input: { command: "ls" }, output: "a b" } }, { type: "text", text: "listed" }] },
  ]);
  const t1 = normalizeLastTurn(oc);
  expect(t1.actions_taken).toEqual(["bash: ls"]);
  expect(t1.command_results).toEqual(["a b"]);
  expect(t1.assistant_final_message).toBe("listed");

  const pi = piMessages([
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false },
    { role: "assistant", content: [{ type: "text", text: "listed" }] },
  ]);
  const t2 = normalizeLastTurn(pi);
  expect(t2.actions_taken).toEqual(["bash: ls"]);
  expect(t2.command_results).toEqual(["a b"]);
  expect(t2.conclusive).toBe(true);
});

// ---------------------------------------------------------------- the hooks fail open

const run = (adapter: string, payload: unknown, cwd: string) =>
  Bun.spawnSync(["bun", join(ROOT, "adapters", adapter)], {
    cwd,
    stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    env: { ...process.env, ORLY_NO_LOG: "1", HOME: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });

test("every hook adapter lets the agent stop when it cannot do its job", () => {
  const dir = sandbox();
  try {
    const stops: Array<[string, Record<string, unknown>]> = [
      ["claude-code.ts", { hook_event_name: "Stop" }],
      ["codex.ts", { hook_event_name: "Stop", transcript_path: null }],
      ["gemini.ts", { hook_event_name: "AfterAgent" }],
      ["cursor.ts", { hook_event_name: "stop", status: "completed" }],
      ["copilot.ts", { hook_event_name: "agentStop" }],
      ["goose.ts", { event: "Stop" }],
    ];
    for (const [adapter, event] of stops) {
      for (const payload of ["not json", {}, { ...event, cwd: dir, session_id: "t", transcript_path: join(dir, "nope.jsonl") }]) {
        const r = run(adapter, payload, dir);
        expect([adapter, r.exitCode]).toEqual([adapter, 0]);
        const out = r.stdout.toString();
        expect(out).not.toContain('"block"');
        expect(out).not.toContain('"deny"');
        expect(out).not.toContain("followup_message");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every hook adapter answers the other events without touching the judge", () => {
  const dir = sandbox();
  try {
    // No .orly here: session start says nothing, and a guard on a plain file allows.
    const quiet: Array<[string, Record<string, unknown>]> = [
      ["claude-code.ts", { hook_event_name: "SessionStart", cwd: dir }],
      ["claude-code.ts", { hook_event_name: "PreToolUse", cwd: dir, tool_name: "Write", tool_input: { file_path: "x", content: "y" } }],
      ["codex.ts", { hook_event_name: "SessionStart", cwd: dir }],
      ["gemini.ts", { hook_event_name: "BeforeTool", cwd: dir, tool_name: "replace", tool_input: { file_path: "x", old_string: "a", new_string: "b" } }],
      ["cursor.ts", { hook_event_name: "sessionStart", cwd: dir }],
      ["copilot.ts", { hook_event_name: "preToolUse", cwd: dir, toolName: "edit", toolArgs: { path: "x", old_string: "a", new_string: "b" } }],
      ["goose.ts", { event: "SessionStart", cwd: dir }],
    ];
    for (const [adapter, payload] of quiet) {
      const r = run(adapter, payload, dir);
      expect([adapter, r.exitCode, r.stdout.toString()]).toEqual([adapter, 0, ""]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the installer

test("orly install is complete and idempotent for every host it knows", () => {
  const dir = sandbox();
  const home = join(dir, "home");
  try {
    for (const host of HOSTS.filter((h) => h.plan)) {
      expect(existsSync(join(ROOT, "adapters", host.adapter!))).toBe(true);
      const seen = new Set<string>();
      for (const global of [false, true]) {
        const first = plan(host, { cwd: dir, home, global });
        expect(first.length).toBeGreaterThan(0);
        for (const p of first) {
          // Nothing lands outside the sandbox, and every hook names an adapter that exists.
          expect(p.path.startsWith(dir)).toBe(true);
          // A host with only a user-level file plans the same path in both scopes.
          expect(p.action).toBe(seen.has(p.path) ? "unchanged" : "create");
          seen.add(p.path);
          for (const m of p.preview.matchAll(/adapters\/([\w-]+\.ts)/g)) expect(existsSync(join(ROOT, "adapters", m[1]))).toBe(true);
        }
        apply(first);
        const again = plan(host, { cwd: dir, home, global });
        expect(again.map((p) => p.action)).toEqual(again.map(() => "unchanged"));
      }
    }
    // A settings file shared with someone else's hooks keeps them.
    const shared = join(dir, ".claude", "settings.json");
    const doc = JSON.parse(readFileSync(shared, "utf8"));
    doc.hooks.Stop.push({ hooks: [{ type: "command", command: "echo theirs" }] });
    doc.permissions = { allow: ["Bash"] };
    writeFileSync(shared, JSON.stringify(doc));
    apply(plan(HOSTS.find((h) => h.id === "claude")!, { cwd: dir, home }));
    const after = JSON.parse(readFileSync(shared, "utf8"));
    expect(after.permissions).toEqual({ allow: ["Bash"] });
    expect(after.hooks.Stop.length).toBe(2);
    expect(after.hooks.Stop.filter((e: any) => JSON.stringify(e).includes("theirs")).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the support table names every host once", () => {
  const table = supportTable();
  for (const h of HOSTS) expect(table.split(`| ${h.name} |`).length).toBe(2);
});

// ---------------------------------------------------------------- manifests

test("every plugin manifest parses and points at files that exist", () => {
  const manifests = [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".cursor-plugin/plugin.json",
    ".github/plugin/marketplace.json",
    "plugin.json",
    "gemini-extension.json",
    "package.json",
    "hooks/hooks.json",
  ];
  const versions = new Set<string>();
  for (const m of manifests) {
    const doc = JSON.parse(readFileSync(join(ROOT, m), "utf8"));
    if (typeof doc.version === "string") versions.add(doc.version);
    if (doc.metadata?.version) versions.add(doc.metadata.version);
    for (const key of ["skills", "commands", "hooks", "main"]) {
      if (typeof doc[key] === "string") expect([m, key, existsSync(join(ROOT, doc[key]))]).toEqual([m, key, true]);
    }
    for (const p of doc.pi?.extensions ?? []) expect(existsSync(join(ROOT, p))).toBe(true);
    for (const [, v] of Object.entries<string>(doc.bin ?? {})) expect(existsSync(join(ROOT, v))).toBe(true);
  }
  // One version everywhere, bumped in lockstep.
  expect([...versions]).toEqual([JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version]);
  // The hooks every Claude-dialect host reads name the one dispatcher.
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["Stop", "SessionStart", "PreToolUse"]) {
    expect(JSON.stringify(hooks[event])).toContain("adapters/claude-code.ts");
  }
  // The Gemini command is generated from the one source and carries its placeholder.
  expect(readFileSync(join(ROOT, "commands", "orly.toml"), "utf8")).toBe(shippedToml());
  expect(readFileSync(join(ROOT, "skills", "orly", "SKILL.md"), "utf8")).toMatch(/^---\nname: orly\n/);
});
