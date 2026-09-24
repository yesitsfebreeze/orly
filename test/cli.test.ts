import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLastTurn } from "../orly.ts";

const CLI = join(import.meta.dir, "..", "orly.ts");
// No key and a cwd with no .orly: a well-shaped input gets as far as the key check.
const run = (args: string[], stdin = "", cwd: string = tmpdir()) =>
  Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    env: { PATH: process.env.PATH! },
    stdout: "pipe",
    stderr: "pipe",
  });

const TURN = JSON.stringify({
  turn: {
    user_request: "add a test for parse()",
    assistant_final_message: "Done.",
    assistant_said: "Done.",
    actions_taken: [],
    command_results: ["0 fail"],
    conclusive: true,
  },
});

test("a well-shaped turn gets as far as the key check", () => {
  const r = run(["judge"], TURN);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no API key");
});

test("a messages log reaches the same turn the hook would judge", () => {
  const messages = [
    { role: "user", content: "add a test for parse()" },
    { role: "assistant", content: "Done." },
  ];
  const r = run(["judge"], JSON.stringify({ messages }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no API key");
  expect(normalizeLastTurn(messages).user_request).toBe("add a test for parse()");
});

test("a bad shape is named, before any key is needed", () => {
  for (const [stdin, says] of [
    ["not json", "not JSON"],
    ['{"transcript":"x"}', 'expected {"messages"'],
    ['{"messages":[{"role":"assistant","content":"done"}]}', 'role:"user"'],
    ['{"turn":{}}', "turn needs user_request"],
  ]) {
    const r = run(["judge"], stdin);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(says);
  }
});

test("an unknown command names itself and points at help", () => {
  for (const cmd of ["schema", "case", "fit", "replay"]) {
    const r = run([cmd]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`unknown command "${cmd}" — try: orly help`);
  }
});

test("orly help lists the commands that exist", () => {
  const out = run(["help"]).stdout.toString();
  for (const cmd of ["judge", "gate", "goal", "tasks", "specs"]) expect(out).toContain(cmd);
});

test("orly gate runs the turn-end gate and allows without a key", () => {
  const r = run(["gate", "--session", `cli-${Date.now()}`], TURN);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.block).toBe(false);
  expect(out.message).toContain("no TypeSafe key");
});

test("orly goal appends in a fresh directory and tasks lists the open specs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orly-cli-"));
  try {
    const a = run(["goal", "tests", "cover parse() with a regression test"], "", dir);
    expect(a.exitCode).toBe(0);
    expect(run(["goal", "a second goal"], "", dir).exitCode).toBe(0);
    const goal = await Bun.file(join(dir, ".orly", "goal")).text();
    expect(goal).toContain("- tests: cover parse() with a regression test");
    expect(goal).toContain("- a second goal");

    mkdirSync(join(dir, ".orly", "specs", "tests"), { recursive: true });
    writeFileSync(join(dir, ".orly", "specs", "tests", "covered.spec"), "require: x equals 1\n\nA one.\n");
    const tasks = run(["tasks"], "", dir);
    expect(tasks.exitCode).toBe(0);
    expect(tasks.stdout.toString()).toContain("covered.spec");
    expect(tasks.stdout.toString()).toContain("not judged yet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});