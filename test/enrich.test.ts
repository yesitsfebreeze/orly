import { expect, test } from "bun:test";
import { ask, excerpt, projectEvidence } from "../orly.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(r, "big.ts"), "x".repeat(120_000));
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
  const names = Array.from({ length: 42 }, (_, i) => `f${i}.ts`);
  const e: any = await projectEvidence({ cwd: "/nope" })(turn, [{ id: "a", instructions: "n/a", evidence: names }]);
  expect(Object.keys(e.files)).toEqual(names);
  expect(e.files["f41.ts"]).toContain("not read");
  expect(e.files["f39.ts"]).toBe("[file does not exist]");
  expect(e.files["f0.ts"]).toBe("[file does not exist]");
});

test("a check past its timeout is killed with its children, and the gate does not wait for them", async () => {
  const t0 = Date.now();
  const e: any = await projectEvidence({ cwd: "/tmp", checks: { slow: { command: "sleep 30; echo done", timeoutMs: 200 } } })(turn, [
    { id: "a", instructions: "n/a", require: { path: "checks.slow.exit", op: "equals", value: 0 } },
  ]);
  expect(e.checks.slow.exit).toBeNull();
  expect(Date.now() - t0).toBeLessThan(15_000); // half the sleep: it was killed, not waited out, at any load
});

test("a check reruns only when the git tree moved, or always when live", async () => {
  const r = fresh(), runs = join(mkdtempSync(join(tmpdir(), "orly-runs-")), "n");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: r });
  try {
    git("init", "-q"); git("add", "."); git("commit", "-qm", "i");
    const checks = { c: { command: `cat thing.ts; echo . >> ${runs}` }, l: { command: `echo . >> ${runs}.l`, live: true } };
    const specs: any = ["c", "l"].map((n) => ({ id: n, instructions: "n/a", require: { path: `checks.${n}.exit`, op: "equals", value: 0 } }));
    const count = (p: string) => readFileSync(p, "utf8").length / 2;
    const e: any = await projectEvidence({ cwd: r, checks })(turn, specs);
    await projectEvidence({ cwd: r, checks })(turn, specs);
    expect(e.checks.c.out).toContain("done = true");
    expect([count(runs), count(`${runs}.l`)]).toEqual([1, 2]);
    writeFileSync(join(r, "note.txt"), "same"); await projectEvidence({ cwd: r, checks })(turn, specs);
    await Bun.sleep(5); writeFileSync(join(r, "note.txt"), "same"); await projectEvidence({ cwd: r, checks })(turn, specs);
    expect(count(runs)).toBe(2); // a new untracked file reran it once; rewriting it unchanged did not
    writeFileSync(join(r, "thing.ts"), "export const done = false;\n");
    const e2: any = await projectEvidence({ cwd: r, checks })(turn, specs);
    expect(count(runs)).toBe(3);
    expect(e2.checks.c.out).toContain("done = false");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a check past the budget is pending, keeps running, and the next stop reads it; timeoutMs still kills", async () => {
  const r = fresh(), runs = join(mkdtempSync(join(tmpdir(), "orly-runs-")), "n");
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "init", "-q"], { cwd: r });
  Bun.spawnSync(["sh", "-c", "git add . && git -c user.name=t -c user.email=t@t commit -qm i"], { cwd: r });
  try {
    // s waits for a go file, so it cannot finish inside the first stop at any load; h's timeout is 60x the budget.
    const go = `${runs}.go`;
    const checks = { s: { command: `echo . >> ${runs}; until [ -e ${go} ]; do sleep 0.05; done; exit 3` }, h: { command: "sleep 60", timeoutMs: 3000 } };
    const specs: any = ["s", "h"].map((n) => ({ id: n, instructions: "n/a", require: { path: `checks.${n}.exit`, op: "equals", value: 0 } }));
    const e: any = await projectEvidence({ cwd: r, checks, budgetMs: 50 })(turn, specs);
    expect([e.checks.s.pending, e.checks.h.pending]).toEqual([true, true]);
    writeFileSync(go, "");
    const e2: any = await projectEvidence({ cwd: r, checks, budgetMs: 20_000 })(turn, specs); // waits for s, then h's timeout
    expect([e2.checks.s.exit, e2.checks.h.exit, e2.checks.h.out]).toEqual([3, null, "[check killed: timeout]"]);
    expect(readFileSync(runs, "utf8")).toBe(".\n"); // ran once, finished after the first stop stopped waiting
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("evidence names a folder, a glob or a tree, and reads what the project holds", async () => {
  const r = mkdtempSync(join(tmpdir(), "orly-glob-"));
  try {
    mkdirSync(join(r, "src/deep"), { recursive: true });
    writeFileSync(join(r, "src/a.rs"), "fn a() {}");
    writeFileSync(join(r, "src/deep/b.rs"), "fn b() {}");
    writeFileSync(join(r, "src/deep/c.txt"), "text");
    writeFileSync(join(r, "bin.dat"), "x\0y");
    const ask = (evidence: string[]) => projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "n/a", evidence }]) as Promise<any>;
    expect(Object.keys((await ask(["src"])).files)).toEqual(["src/a.rs", "src/deep/b.rs", "src/deep/c.txt"]);
    const globbed = await ask(["src/**/*.rs", "bin.dat", "nothing/*.rs"]);
    expect(globbed.files["src/a.rs"]).toBe("fn a() {}");
    expect(globbed.files["src/deep/b.rs"]).toBe("fn b() {}");
    expect(globbed.files["src/deep/c.txt"]).toBeUndefined();
    expect(globbed.files["bin.dat"]).toBe("[binary file: not read]");
    expect(globbed.files["nothing/*.rs"]).toBe("[no file matches]");
    expect((await ask(["tree:**"])).files["tree:**"]).toBe("bin.dat\nsrc/a.rs\nsrc/deep/b.rs\nsrc/deep/c.txt");
    expect((await ask(["tree:src/config/**"])).files["tree:src/config/**"]).toBe("[no file matches]");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("matched files past the budget are counted in one line, never silently dropped", async () => {
  const r = mkdtempSync(join(tmpdir(), "orly-budget-"));
  const before = process.env.ORLY_EVIDENCE_FILES;
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(r, `f${i}.ts`), "x");
    process.env.ORLY_EVIDENCE_FILES = "3";
    const e: any = await projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "n/a", evidence: ["*.ts"] }]);
    expect(Object.keys(e.files)).toEqual(["f0.ts", "f1.ts", "f2.ts", "[not read]"]);
    expect(e.files["[not read]"]).toContain("2 more matching files");
  } finally {
    if (before === undefined) delete process.env.ORLY_EVIDENCE_FILES; else process.env.ORLY_EVIDENCE_FILES = before;
    rmSync(r, { recursive: true, force: true });
  }
});

test("one budget is shared: small files go whole, a large one keeps the lines the question asks about", async () => {
  const r = fresh();
  try {
    const filler = Array.from({ length: 6000 }, (_, i) => `const filler${i} = ${i};`);
    filler[5000] = "export function settleInvoice() { return 42; }";
    writeFileSync(join(r, "big.ts"), filler.join("\n"));
    const e: any = await projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "Does big.ts define settleInvoice?", evidence: ["big.ts", "thing.ts"] }]);
    expect(e.files["thing.ts"]).toBe("export const done = true;\n");
    expect(e.files["big.ts"]).toContain("export function settleInvoice()");
    expect(e.files["big.ts"]).toContain("const filler4999 = 4999;"); // context around the hit
    expect(e.files["big.ts"]).toMatch(/…\[lines \d+-4998 not shown\]/);
    expect(e.files["big.ts"].length).toBeLessThanOrEqual(80_000);
    expect(excerpt("short", 100, [])).toBe("short");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("more matches than the file limit: the files carrying the question's words are read first", async () => {
  const r = fresh(), before = process.env.ORLY_EVIDENCE_FILES;
  try {
    for (let i = 0; i < 6; i++) writeFileSync(join(r, `m${i}.ts`), i === 5 ? "export const settleInvoice = 1;\n" : "export const other = 1;\n");
    process.env.ORLY_EVIDENCE_FILES = "2";
    const e: any = await projectEvidence({ cwd: r })(turn, [{ id: "a", instructions: "Is settleInvoice exported anywhere?", evidence: ["m*.ts"] }]);
    expect(Object.keys(e.files)).toEqual(["m5.ts", "m0.ts", "[not read]"]);
  } finally {
    if (before === undefined) delete process.env.ORLY_EVIDENCE_FILES; else process.env.ORLY_EVIDENCE_FILES = before;
    rmSync(r, { recursive: true, force: true });
  }
});

test("a request the judge calls too large is cut around the question and sent again", async () => {
  const sizes: number[] = [];
  const server = Bun.serve({ port: 0, fetch: async (req) => { // a local stand-in, never the live API
    const body: any = await req.json(), size = body.state.project.files["big.ts"].length;
    sizes.push(size);
    return size > 50_000 ? Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 }) : Response.json({ answers: { a: { type: "noul", noul: 0.9 } } });
  } });
  try {
    const big = Array.from({ length: 6000 }, (_, i) => `const filler${i} = ${i};`).join("\n");
    const { answers } = await ask({ project: { files: { "big.ts": big } } }, { a: { type: "noul", instructions: "Is filler5000 defined?" } }, { apiKey: "k", endpoint: server.url.href });
    expect(answers.a.noul).toBe(0.9);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(50_000);
  } finally {
    server.stop(true);
  }
});
