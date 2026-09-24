/**
 * The host-neutral core every adapter wraps: the gate fails open, the brief knows when a
 * project uses the gate, and the edit guard reduces every host's edit tool to one shape.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { gateTurn, NO_KEY_MESSAGE } from "../src/turnend.ts";

const sandbox = () => mkdtempSync(join(tmpdir(), "orly-core-"));
const noKey = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, ORLY_KEY_COMMAND: process.env.ORLY_KEY_COMMAND };
const withoutKey = <T>(f: () => T): T => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ORLY_KEY_COMMAND;
  try {
    return f();
  } finally {
    if (noKey.TYPESAFE_API_KEY) process.env.TYPESAFE_API_KEY = noKey.TYPESAFE_API_KEY;
    if (noKey.ORLY_KEY_COMMAND) process.env.ORLY_KEY_COMMAND = noKey.ORLY_KEY_COMMAND;
  }
};

test("without a key the gate allows, and says so once per session", async () => {
  const dir = sandbox();
  try {
    const session = `test-${Date.now()}-${Math.random()}`;
    const run = () => gateTurn({ cwd: dir, sessionId: session, read: async () => null });
    const first = await withoutKey(run);
    expect(first.block).toBe(false);
    expect(first.message).toBe(NO_KEY_MESSAGE);
    const second = await withoutKey(run);
    expect(second.block).toBe(false);
    expect(second.message).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable turn allows with a note, never a block", async () => {
  const dir = sandbox();
  try {
    const had = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-key-never-used";
    try {
      const out = await gateTurn({ cwd: dir, sessionId: "t", read: async () => null, flush: false });
      expect(out.block).toBe(false);
      expect(out.note).toContain("unreadable");
    } finally {
      if (had === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = had;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a weakened spec set blocks before any key is needed", async () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly"));
    writeFileSync(
      join(dir, ".orly", "baseline.json"),
      JSON.stringify({ goal: "g", specs: [{ id: "one", instructions: "is it done?", cut: 0.9 }] }),
    );
    writeFileSync(
      join(dir, ".orly", "specs.json"),
      JSON.stringify({ goal: "g", specs: [{ id: "one", instructions: "is it done?", cut: 0.3 }] }),
    );
    const out = await withoutKey(() => gateTurn({ cwd: dir, sessionId: "t", read: async () => null }));
    expect(out.block).toBe(true);
    expect(out.reason).toContain("its cut was lowered");
    expect(out.banner).toContain("[X]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the brief is null outside a project and names the host's goal command inside one", () => {
  const dir = sandbox();
  try {
    expect(sessionBrief(dir)).toBeNull();
    mkdirSync(join(dir, ".orly"));
    const brief = sessionBrief(dir, { goalCommand: "/orly", cli: "bun /x/bin/orly.ts" })!;
    expect(brief).toContain("`/orly <goal>` writes a set");
    expect(brief).toContain("`orly` below means `bun /x/bin/orly.ts`");
    expect(brief).toContain("The one rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every host's edit tool reduces to one planned edit", () => {
  expect(plannedEdit("Write", { file_path: "a", content: "x" })).toEqual({ kind: "write", content: "x" });
  expect(plannedEdit("write", { filePath: "a", content: "x" })).toEqual({ kind: "write", content: "x" });
  expect(plannedEdit("Edit", { old_string: "a", new_string: "b" })).toEqual({
    kind: "edit",
    edits: [{ old_string: "a", new_string: "b", replace_all: undefined }],
  });
  expect(plannedEdit("edit", { oldString: "a", newString: "b", replaceAll: true })).toEqual({
    kind: "edit",
    edits: [{ old_string: "a", new_string: "b", replace_all: true }],
  });
  expect(plannedEdit("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] })!.kind).toBe("edit");
  expect(plannedEdit("Bash", { command: "rm" })).toBeNull();
  expect(editTarget({ file_path: "a" })).toBe("a");
  expect(editTarget({ filePath: "b" })).toBe("b");
  expect(editTarget({ path: "c" })).toBe("c");
  expect(editTarget({ command: "x" })).toBeUndefined();
});

test("the guard refuses a lowered cut through the tree and lets a raised one through", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly", "specs", "g"), { recursive: true });
    const path = join(dir, ".orly", "specs", "g", "one.spec");
    writeFileSync(path, "cut: 0.7\n\nDoes `command_results` show the tests passing?\n");
    const lower = guardEdit(dir, path, { kind: "edit", edits: [{ old_string: "cut: 0.7", new_string: "cut: 0.4" }] });
    expect(lower).toContain("its cut was lowered");
    expect(guardEdit(dir, path, { kind: "edit", edits: [{ old_string: "cut: 0.7", new_string: "cut: 0.9" }] })).toBeNull();
    expect(guardEdit(dir, join(dir, "src.ts"), { kind: "write", content: "anything" })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
