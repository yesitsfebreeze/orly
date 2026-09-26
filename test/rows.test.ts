import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"; import { basename, dirname, join } from "node:path"; import { tmpdir } from "node:os";
import { gateTurn, parseSpec, sessionBrief } from "../orly.ts";
import { frontmatter, MAX_ROWS, runRows } from "../orly.ts";

const MEMO = `---
kind: seam
status: "claimed"
owner: 'pi-3'
targets: [src/a.rs, "src/b.rs"]
files:
  - src/c.rs
  - src/d.rs
lines: 883 → 900
row: 44
description: \`kern list\` builds each row
---
body text
`;

/** A project with `.orly/tables` over `n` generated memos plus the fixture. */
function project(n = 0): string {
  const root = mkdtempSync(join(tmpdir(), "rows-")), memos = join(root, "memos", "seam");
  mkdirSync(join(root, ".orly"), { recursive: true }); mkdirSync(memos, { recursive: true });
  writeFileSync(join(root, ".orly", "tables"), "memo: memos/*/*.md\nbus: bus.jsonl\n");
  writeFileSync(join(memos, "fixture.md"), MEMO);
  for (let i = 0; i < n; i++) writeFileSync(join(memos, `m${i}.md`), `---\nstatus: done\nasked_by: [human]\nasked-at: abc\n---\nm${i}\n`);
  writeFileSync(join(root, "bus.jsonl"), '{"seq":1,"from":"a","text":"land x"}\n{"seq":2,"from":"b","kind":"note"}\n');
  return join(root, ".orly");
}
const spec = (head: string, q = "Does `row.body` say the unit is still blocked?") => parseSpec("s", `${head}\n\n${q}`);
const never = async () => { throw new Error("no network in tests"); };

test("frontmatter reads scalars, quoted strings, inline and block lists, arrows and aliases", () => {
  const { fm, body } = frontmatter(MEMO);
  expect(fm).toMatchObject({ kind: "seam", status: "claimed", owner: "pi-3", target: ["src/a.rs", "src/b.rs"], files: ["src/c.rs", "src/d.rs"], lines: "883 → 900", lines_before: 883, lines_after: 900, row: 44, description: "`kern list` builds each row" });
  expect(fm.targets).toBeUndefined();
  expect(body).toBe("body text\n");
  expect(frontmatter("no frontmatter").fm).toEqual({});
});

test("aliases and jsonl rows are queryable by one name", async () => {
  const dir = project(2);
  const r = await runRows(spec("select: SELECT fm->>'askers' AS a, fm->>'asked_at' AS t FROM memo WHERE fm->>'status' = 'done'\nrequire: rows equals 2"), dir, never);
  expect(r.met).toBe(true);
  expect(r.rows[0].row).toEqual({ a: '["human"]', t: "abc" });
  const bus = await runRows(spec("select: SELECT kind FROM bus ORDER BY fm->>'seq'\nrequire: rows equals 2"), dir, never);
  expect(bus.rows.map((x) => x.row.kind)).toEqual([basename(dirname(dir)), "note"]); // kind: fm.kind, else the parent folder
});

test("select must be one read-only statement", async () => {
  const dir = project();
  for (const bad of ["select: DELETE FROM memo", "select: SELECT 1; DROP TABLE memo", "select: SELECT path FROM memo\nrequire: checks.tests.exit equals 0"]) {
    const r = await runRows(spec(bad), dir, never);
    expect(r.met).toBe(false);
    expect(r.reason).toContain("select must be");
  }
});

test("select: a `;` in a literal or comment, or a trailing one, is still one statement", async () => {
  const dir = project();
  for (const ok of ["SELECT path FROM memo WHERE body LIKE '%a;b%' AND 'it''s;' <> \"x;y\"", "SELECT path FROM memo;  ", "SELECT path FROM memo /* a; b */ -- c; d"]) {
    const r = await runRows(spec(`select: ${ok}\nrequire: rows equals 0`), dir, never);
    expect(r.reason ?? "").not.toContain("select must be");
  }
  for (const bad of ["SELECT 1; SELECT 2", "SELECT 1; DROP TABLE x", "SELECT ';'; DROP TABLE x"]) {
    expect((await runRows(spec(`select: ${bad}`), dir, never)).reason).toContain("select must be");
  }
});

test("require: rows decides by count alone, without the judge", async () => {
  const dir = project();
  expect((await runRows(spec("select: SELECT path FROM memo WHERE fm->>'status' = 'claimed'\nrequire: rows equals 0"), dir, never)).met).toBe(false);
  expect((await runRows(spec("select: SELECT path FROM memo WHERE fm->>'status' = 'stuck'\nrequire: rows equals 0"), dir, never)).met).toBe(true);
});

test("more than 50 rows fail as too broad before any judge call", async () => {
  const r = await runRows(spec("select: SELECT path FROM memo"), project(MAX_ROWS), never);
  expect(r.met).toBe(false);
  expect(r.reason).toContain("too broad");
});

test("judged rows: one request, one noul per row, fail above the cut", async () => {
  const calls: any[] = [];
  const stub = async (state: any, questions: Record<string, any>) => {
    calls.push({ state, questions });
    return { answers: Object.fromEntries(Object.keys(questions).map((id, i) => [id, { noul: i === 1 ? 0.9 : 0.1 }])) };
  };
  const r = await runRows(spec("select: SELECT path, body FROM memo ORDER BY path\ncut: 0.7"), project(2), stub);
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0].questions)).toEqual(["row:0", "row:1", "row:2"]);
  expect(calls[0].state.rows).toHaveLength(3);
  expect(r.rows.map((x) => x.failed)).toEqual([false, true, false]);
  expect(r.met).toBe(false);
});

test("select is a known header", () => {
  expect(spec("select: SELECT 1\nrequire: rows equals 0")).toMatchObject({ select: "SELECT 1", require: { path: "rows", op: "equals", value: 0 } });
});

test("a failing row spec never blocks the Stop gate nor shows in the brief", async () => {
  const dir = project(), root = dirname(dir);
  mkdirSync(join(dir, "specs", "g"), { recursive: true });
  writeFileSync(join(dir, "goal"), "- g: keep claims moving\n");
  writeFileSync(join(dir, "specs", "g", "stuck.spec"), "select: SELECT path FROM memo WHERE fm->>'status' = 'claimed'\nrequire: rows equals 0\n\nAre claimed units left without a sitter?\n");
  const env = { k: process.env.TYPESAFE_API_KEY, c: process.env.ORLY_KEY_COMMAND };
  delete process.env.TYPESAFE_API_KEY; delete process.env.ORLY_KEY_COMMAND;
  try {
    const turn = { user_request: "do it", assistant_final_message: "done", assistant_said: "done", actions_taken: ["Bash: true"], command_results: ["ok"], conclusive: true };
    const out = await gateTurn({ cwd: root, sessionId: `rows-${Math.random()}`, read: async () => turn, flush: false });
    expect(out.block).toBe(false);
    expect(sessionBrief(root)).not.toContain("stuck");
    expect((await runRows(parseSpec("stuck", "select: SELECT path FROM memo WHERE fm->>'status' = 'claimed'\nrequire: rows equals 0\n\nAre claimed units left without a sitter?"), dir, never)).met).toBe(false);
  } finally {
    if (env.k) process.env.TYPESAFE_API_KEY = env.k;
    if (env.c) process.env.ORLY_KEY_COMMAND = env.c;
  }
});
