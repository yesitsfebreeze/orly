/**
 * Row specs (orchi CONTRACT §9): `.orly/tables` maps a table name to a glob of markdown or JSONL files,
 * loaded read-only into an in-memory SQLite DB; a spec's `select:` picks rows, `require: rows <op> N`
 * decides by count alone, otherwise Jev answers one noul per row in one request. Never part of the Stop gate.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ask, evaluate, findOrlyDir, loadSpecFile, parseSpec, resolveKey, validateSpecs, EXT, type Spec } from "./orly.ts";

export const MAX_ROWS = 50;
/** One name per concept; the source files stay as they are. */
const ALIAS: Record<string, string> = { targets: "target", asked_by: "askers", "asked-at": "asked_at" };
const ARROW = /^\s*(-?\d+(?:\.\d+)?)\s*(?:→|->)\s*(-?\d+(?:\.\d+)?)\s*$/;

function scalar(v: string): unknown {
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean).map(scalar); // ponytail: commas inside quoted list items split
  if (/^".*"$/.test(v)) try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v === "true" ? true : v === "false" ? false : v;
}

/** The frontmatter these files use: `key: scalar`, quoted strings, `[a, b]`, and `- item` block lists.
 *  Not YAML: a third of kern2's memos start values with a backtick, which YAML refuses. Nested maps are skipped. */
export function frontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, any> = {};
  let last: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/), item = line.match(/^\s*-\s+(.*)$/);
    if (kv) fm[(last = kv[1])] = kv[2]?.trim() ? scalar(kv[2].trim()) : null;
    else if (item && last && (fm[last] === null || Array.isArray(fm[last]))) (fm[last] ??= []).push(scalar(item[1].trim()));
  }
  return { fm: normalizeKeys(fm), body: text.slice(m[0].length) };
}

export function normalizeKeys(fm: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fm)) {
    const key = ALIAS[k] ?? k;
    out[key] = v;
    const a = typeof v === "string" && v.match(ARROW);
    if (a) { out[`${key}_before`] = Number(a[1]); out[`${key}_after`] = Number(a[2]); }
  }
  return out;
}

/** `name: glob` per line, relative to the project or absolute (`~` allowed). */
export function parseTables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([A-Za-z_]\w*):\s*(\S.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Files a glob names; the part before the first wildcard is the scan root, so dot folders match. */
function files(glob: string, root: string): string[] {
  const abs = glob.startsWith("~/") ? join(homedir(), glob.slice(2)) : isAbsolute(glob) ? glob : join(root, glob);
  const parts = abs.split("/"), i = parts.findIndex((p) => /[*?[{]/.test(p));
  if (i < 0) return existsSync(abs) ? [abs] : [];
  const cwd = parts.slice(0, i).join("/") || "/";
  if (!existsSync(cwd)) return [];
  return [...new Bun.Glob(parts.slice(i).join("/")).scanSync({ cwd, absolute: true, dot: true })].sort();
}

/** Every table into one in-memory DB, read-only once loaded. */
export function loadTables(tables: Record<string, string>, root: string): Database {
  const db = new Database(":memory:");
  for (const [name, glob] of Object.entries(tables)) {
    db.run(`CREATE TABLE "${name}" (path TEXT, kind TEXT, fm TEXT, body TEXT, mtime REAL)`);
    const insert = db.prepare(`INSERT INTO "${name}" VALUES (?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const path of files(glob, root)) {
        const text = readFileSync(path, "utf8"), mtime = statSync(path).mtimeMs, dir = basename(dirname(path));
        const put = (fm: Record<string, any>, body: string | null) => insert.run(path, typeof fm.kind === "string" ? fm.kind : dir, JSON.stringify(fm), body, mtime);
        if (path.endsWith(".jsonl")) {
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try { const o = JSON.parse(line); if (o && typeof o === "object") put(normalizeKeys(o), null); } catch { /* a torn line is skipped */ }
          }
        } else { const { fm, body } = frontmatter(text); put(fm, body); }
      }
    })();
  }
  db.run("PRAGMA query_only = ON");
  return db;
}

export type RowAnswer = { row: Record<string, unknown>; p?: number; failed: boolean };
export type RowsResult = { met: boolean; reason: string; rows: RowAnswer[] };
type Ask = (state: unknown, questions: Record<string, unknown>) => Promise<{ answers: Record<string, any> }>;

/** Run one row spec against a project whose `.orly` sits in `orlyDir`. */
export async function runRows(spec: Spec, orlyDir: string, askFn?: Ask): Promise<RowsResult> {
  const fail = (reason: string): RowsResult => ({ met: false, reason, rows: [] });
  if (!spec.select) return fail("not a row spec: no select header");
  const bad = validateSpecs([spec]);
  if (bad.length) return fail(bad.map((b) => b.problem).join("; "));
  const tablesPath = join(orlyDir, "tables");
  if (!existsSync(tablesPath)) return fail(`no ${tablesPath}`);
  let found: Record<string, unknown>[];
  try { found = loadTables(parseTables(readFileSync(tablesPath, "utf8")), dirname(orlyDir)).query(spec.select).all() as any[]; } catch (e: any) { return fail(`select failed: ${e?.message ?? e}`); }
  const rows = found.map((r) => { try { return typeof r.fm === "string" ? { ...r, fm: JSON.parse(r.fm) } : r; } catch { return r; } });
  if (spec.require) {
    const { met } = evaluate(spec.require, { rows: rows.length });
    return { met, reason: `rows ${rows.length}, require rows ${spec.require.op} ${spec.require.value ?? ""}`.trim(), rows: rows.slice(0, MAX_ROWS).map((row) => ({ row, failed: false })) };
  }
  if (rows.length > MAX_ROWS) return fail(`too broad: ${rows.length} rows, the cap is ${MAX_ROWS}; narrow the select`);
  if (!rows.length) return { met: true, reason: "no rows", rows: [] };
  const questions: Record<string, unknown> = {};
  rows.forEach((row, n) => {
    questions[`row:${n}`] = {
      type: "noul",
      instructions: `Judge only \`rows[${n}]\`${typeof row.path === "string" ? ` (path ${row.path})` : ""}; call it \`row\`. ${spec.instructions}`,
      criteria: { true: spec.criteria?.true ?? "The row shows this is so.", false: spec.criteria?.false ?? "The row does not show this, or shows the opposite." },
    };
  });
  const { answers } = await (askFn ?? (await defaultAsk(orlyDir)))({ rows }, questions);
  const cut = spec.cut ?? 0.7;
  const out = rows.map((row, n) => { const p = answers?.[`row:${n}`]?.noul; return { row, p, failed: typeof p === "number" && p > cut }; });
  const failed = out.filter((r) => r.failed).length;
  return { met: !failed, reason: `${failed} of ${rows.length} rows above cut ${cut}`, rows: out };
}

async function defaultAsk(orlyDir: string): Promise<Ask> {
  const apiKey = await resolveKey(dirname(orlyDir));
  if (!apiKey) throw new Error("no API key: set TYPESAFE_API_KEY, or a keyCommand in .orly/config.json or ~/.orly/config.json");
  return (state, questions) => ask(state, questions, { apiKey, endpoint: process.env.TYPESAFE_BASE_URL, model: process.env.ORLY_MODEL, timeoutMs: Number(process.env.ORLY_TIMEOUT_MS) || 30_000 });
}

/** `orly rows <spec-path-or-id>`: rows and answers, never a gate. Exit 1 only when it could not run. */
export async function rowsCommand(arg: string | undefined, cwd: string): Promise<number> {
  if (!arg) { console.error("orly: usage: orly rows <spec-path-or-id>"); return 1; }
  const path = resolve(cwd, arg);
  const orlyDir = findOrlyDir(existsSync(path) ? dirname(path) : cwd);
  if (!orlyDir) { console.error("orly: no .orly here or above"); return 1; }
  const spec = existsSync(path) ? parseSpec(basename(path, EXT), readFileSync(path, "utf8")) : loadSpecFile(cwd)?.specs.find((s) => s.id === arg);
  if (!spec) { console.error(`orly: no spec "${arg}"`); return 1; }
  const t0 = performance.now();
  let result: RowsResult;
  try { result = await runRows(spec, orlyDir); } catch (e: any) { console.error(`orly: ${e?.message ?? e}`); return 1; }
  const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 160 ? `${x.slice(0, 160)}…` : x));
  for (const r of result.rows) console.log(`${r.p === undefined ? "" : `${r.failed ? "✗" : "✓"} ${r.p.toFixed(2)}  `}${show(r.row)}`);
  console.log(`${result.met ? "met" : "unmet"} · ${spec.id}: ${result.reason} · ${Math.round(performance.now() - t0)} ms`);
  return 0;
}
