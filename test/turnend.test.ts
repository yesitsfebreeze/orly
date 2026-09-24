/**
 * The host-neutral core every adapter wraps: the gate fails open, the brief knows when a
 * project uses the gate, and the edit guard reduces every host's edit tool to one shape.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardEdit, plannedEdit } from "../orly.ts";
import { gateTurn, NO_KEY_MESSAGE, sessionBrief } from "../orly.ts";

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
    mkdirSync(join(dir, ".orly", "specs", "g"), { recursive: true });
    writeFileSync(join(dir, ".orly", "goal"), "g\n");
    writeFileSync(
      join(dir, ".orly", "baseline.json"),
      JSON.stringify({ goal: "g", specs: [{ id: "one", instructions: "is it done?", cut: 0.9 }] }),
    );
    writeFileSync(
      join(dir, ".orly", "specs", "g", "one.spec"),
      "cut: 0.3\n\nis it done?\n",
    );
    const out = await withoutKey(() => gateTurn({ cwd: dir, sessionId: "t", read: async () => null }));
    expect(out.block).toBe(true);
    expect(out.reason).toContain("its cut was lowered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the brief is null outside a project and names the host's goal command inside one", () => {
  const dir = sandbox();
  try {
    expect(sessionBrief(dir)).toBeNull();
    mkdirSync(join(dir, ".orly"));
    const brief = sessionBrief(dir, "bun /x/bin/orly.ts")!;
    expect(brief).toContain("`orly` means `bun /x/bin/orly.ts`");
    expect(brief).toContain("writes a set");
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

test("the edit guard sees through symlinks, in the target path and in the project path", () => {
  const real = realpathSync(sandbox());
  try {
    mkdirSync(join(real, ".orly", "specs", "g"), { recursive: true });
    const spec = join(real, ".orly", "specs", "g", "one.spec");
    writeFileSync(spec, "cut: 0.9\n\nDoes `command_results` show the parser passing its tests?\n");
    const weaken = { kind: "edit" as const, edits: [{ old_string: "cut: 0.9", new_string: "cut: 0.3" }] };
    const alias = `${real}-alias`;
    symlinkSync(real, alias);
    symlinkSync(spec, join(real, "shortcut.spec"));
    expect(guardEdit(real, join(alias, ".orly", "specs", "g", "one.spec"), weaken)).toContain("refuses");
    expect(guardEdit(alias, spec, weaken)).toContain("refuses");
    expect(guardEdit(real, "shortcut.spec", weaken)).toContain("refuses");
    rmSync(alias);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});
