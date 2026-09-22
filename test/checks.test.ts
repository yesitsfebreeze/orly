import { expect, test } from "bun:test";
import { checkEnricher } from "../src/enrich-checks.ts";
import { evaluate } from "../src/specs.ts";
import type { Turn } from "../src/gate.ts";
import type { Spec } from "../src/specs.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as j } from "node:path";

const turn = {} as Turn;

/** A check only runs when some `require` spec reads it, so every test names one. */
const reads = (...names: string[]): Spec[] =>
  names.map((n) => ({ id: n, instructions: "n/a", require: { path: `checks.${n}.exit`, op: "equals", value: 0 } }));

test("a check's exit code and output become assertable evidence", async () => {
  const e = await checkEnricher({ ok: { command: "echo hello; exit 0" } }, "/tmp")(turn, reads("ok"));
  const c = (e.checks as any).ok;
  expect(c.exit).toBe(0);
  expect(c.out).toContain("hello");
  expect(evaluate({ path: "checks.ok.exit", op: "equals", value: 0 }, e).met).toBe(true);
});

test("a failing check is decided in code with no threshold", async () => {
  const e = await checkEnricher({ bad: { command: "exit 3" } }, "/tmp")(turn, reads("bad"));
  expect((e.checks as any).bad.exit).toBe(3);
  expect(evaluate({ path: "checks.bad.exit", op: "equals", value: 0 }, e).met).toBe(false);
});

test("countPattern turns diagnostics into a number to assert on", async () => {
  const e = await checkEnricher(
    { tsc: { command: "printf 'a.ts(1,1): error TS1\\nb.ts(2,2): error TS2\\n'", countPattern: "error TS" } },
    "/tmp",
  )(turn, reads("tsc"));
  expect((e.checks as any).tsc.matches).toBe(2);
  expect(evaluate({ path: "checks.tsc.matches", op: "lte", value: 0 }, e).met).toBe(false);
});

test("a check that cannot run never reads as passing", async () => {
  // An enricher that failed must not satisfy the gate by accident.
  const e = await checkEnricher({ nope: { command: "exit 127" } }, "/definitely/not/here")(turn, reads("nope"));
  const c = (e.checks as any).nope;
  expect(c.exit === null || c.exit !== 0).toBe(true);
  expect(evaluate({ path: "checks.nope.exit", op: "equals", value: 0 }, e).met).toBe(false);
});

test("no configured checks means no evidence key at all", async () => {
  expect(await checkEnricher({}, "/tmp")(turn, reads("anything"))).toEqual({});
});

test("checks run where the command expects, not where the agent stands", async () => {
  // Every check command is written relative to the project root. Run from a subdirectory,
  // `cd sub && ...` fails and the shell's error text — which has a newline in it — is
  // counted by countPattern as a violation. Four checks reported false failures this way.
  const root = j(tmpdir(), `orly-checks-${Date.now()}`);
  mkdirSync(j(root, ".orly"), { recursive: true });
  mkdirSync(j(root, "sub"), { recursive: true });
  writeFileSync(j(root, "marker.txt"), "ok\n");
  try {
    const spec = { cat: { command: "cat marker.txt", countPattern: "\\n" } };
    const fromRoot: any = await checkEnricher(spec, root)({} as Turn, reads("cat"));
    expect(fromRoot.checks.cat.exit).toBe(0);
    expect(fromRoot.checks.cat.matches).toBe(1);

    const fromSub: any = await checkEnricher(spec, j(root, "sub"))({} as Turn, reads("cat"));
    expect(fromSub.checks.cat.exit).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check nothing reads is never run", async () => {
  // Evidence nothing consumes is not free: it is text in every state competing with the
  // questions that matter. Carrying all nine checks collapsed one spec's separation from
  // 0.34 to 0.07 purely by being present.
  const e = await checkEnricher({ unused: { command: "echo noise" } }, "/tmp")(turn, reads("other"));
  expect(e).toEqual({});
});
