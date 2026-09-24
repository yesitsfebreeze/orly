import { expect, test } from "bun:test";
import { projectEvidence } from "../orly.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Turn } from "../orly.ts";

const turn: Turn = {
  user_request: "r", assistant_final_message: "f", assistant_said: "f",
  actions_taken: [], command_results: [], conclusive: true,
};

const fresh = () => {
  const r = mkdtempSync(join(tmpdir(), "orly-ev-"));
  mkdirSync(join(r, ".orly"));
  writeFileSync(join(r, "thing.ts"), "export const done = true;\n");
  return r;
};

test("a missing file is recorded as evidence, not as an error", async () => {
  const e: any = await projectEvidence({ cwd: "/nope" })(turn, [{ id: "a", instructions: "n/a", evidence: ["duration.js"] }]);
  expect(e.files["duration.js"]).toBe("[file does not exist]");
});

test("a file under the limit is passed whole; a long one announces its truncation", async () => {
  const r = fresh();
  try {
    const e: any = await projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "n/a", evidence: ["thing.ts"] }]);
    expect(e.files["thing.ts"]).toBe("export const done = true;\n");
    writeFileSync(join(r, "big.ts"), "x".repeat(20_000));
    const e2: any = await projectEvidence({ cwd: r })(turn, [{ id: "b", instructions: "n/a", evidence: ["big.ts"] }]);
    expect(e2.files["big.ts"]).toContain("TRUNCATED");
    expect(e2.files["big.ts"]).toContain("do not treat anything below as absent");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a spec naming no evidence and no check gathers nothing", async () => {
  const r = mkdtempSync(join(tmpdir(), "orly-none-"));
  try {
    expect(await projectEvidence({ cwd: r })(turn, [{ id: "n", instructions: "n/a" }])).toEqual({});
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("checks run from the project root, and only when a spec names them", async () => {
  const r = fresh();
  try {
    mkdirSync(join(r, "sub"), { recursive: true });
    writeFileSync(
      join(r, ".orly", "config.json"),
      JSON.stringify({ checks: { here: { command: "cat thing.ts" }, unused: { command: "echo nope" } } }),
    );
    const specs: any = [{ id: "check", instructions: "n/a", require: { path: "checks.here.exit", op: "equals", value: 0 } }];
    for (const cwd of [r, join(r, "sub")]) {
      const e: any = await projectEvidence({ cwd })(turn, specs);
      expect(e.files).toBeUndefined();
      expect(e.checks.here.exit).toBe(0);
      expect(e.checks.here.out).toContain("export const done");
      expect(e.checks.unused).toBeUndefined();
    }
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a failed check is recorded, and a command that cannot run never passes", async () => {
  const r = fresh();
  try {
    writeFileSync(
      join(r, ".orly", "config.json"),
      JSON.stringify({ checks: { die: { command: "exit 4" } } }),
    );
    const specs: any = [{ id: "c", instructions: "n/a", require: { path: "checks.die.exit", op: "equals", value: 0 } }];
    const e: any = await projectEvidence({ cwd: r })(turn, specs);
    expect(e.checks.die.exit).toBe(4);
    const bad: any = await projectEvidence({ cwd: r, checks: { die: { command: "definitely-not-a-command-xyz" } } })(turn, specs);
    expect(bad.checks.die.exit).not.toBe(0);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
test("evidence never reads outside the project, by path or by symlink", async () => {
  const outer = mkdtempSync(join(tmpdir(), "orly-escape-"));
  const r = join(outer, "p");
  try {
    mkdirSync(join(r, ".orly"), { recursive: true });
    writeFileSync(join(outer, "secret"), "SECRET\n");
    symlinkSync(join(outer, "secret"), join(r, "link"));
    writeFileSync(join(r, "ok.ts"), "fine\n");
    const e: any = await projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "n/a", evidence: ["../secret", "link", join(outer, "secret"), "ok.ts"] }]);
    expect(JSON.stringify(e.files)).not.toContain("SECRET");
    expect(e.files["../secret"]).toBe("[outside the project: not read]");
    expect(e.files["link"]).toBe("[outside the project: not read]");
    expect(e.files["ok.ts"]).toBe("fine\n");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("evidence past the file limit is named as unread, never silently missing", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
  const e: any = await projectEvidence({ cwd: "/nope" })(turn, [{ id: "a", instructions: "n/a", evidence: names }]);
  expect(Object.keys(e.files)).toEqual(names);
  expect(e.files["f9.ts"]).toContain("not read");
  expect(e.files["f0.ts"]).toBe("[file does not exist]");
});

test("a check past its timeout is killed with its children, and the gate does not wait for them", async () => {
  const t0 = Date.now();
  const e: any = await projectEvidence({ cwd: "/tmp", checks: { slow: { command: "sleep 3; echo done", timeoutMs: 200 } } })(turn, [
    { id: "a", instructions: "n/a", require: { path: "checks.slow.exit", op: "equals", value: 0 } },
  ]);
  expect(e.checks.slow.exit).toBeNull();
  expect(Date.now() - t0).toBeLessThan(2000);
});
