/**
 * The spec tree — one small file per spec, folders for grouping.
 *
 * Every mistake is meant to become a spec, so a spec set grows without bound. One JSON file
 * does not survive that: every addition is an edit in the middle of everything else, and a
 * single stray comma disables the whole gate. A file per spec makes adding one a new file,
 * and the folders are the index.
 *
 *   .orly/goal                      the goal, optionally headed by `rounds: 6`
 *   .orly/specs/readme/one_owl.spec
 *
 *     require: checks.readme_owls.matches equals 1
 *
 *     README.md draws the owl exactly once.
 *
 * Header lines (`key: value`) up to the first blank line, then the question. The file name
 * is the id; the folders are only for people. A file that does not parse still becomes a
 * spec — one that can never be met — so a typo blocks the turn instead of silently
 * removing a check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { Spec, SpecFile } from "./specs.ts";

export const TREE = "specs";
export const GOAL = "goal";
export const EXT = ".spec";

const KEYS = ["cut", "require", "evidence", "optional", "gather", "true", "false", "fitted", "rounds"];

/** Split `key: value` header lines from the body. No header block → all body. */
function sections(text: string): { head: Record<string, string>; body: string; bad?: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blank = lines.findIndex((l) => !l.trim());
  const top = lines.slice(0, blank < 0 ? lines.length : blank);
  if (!top.length || !top.every((l) => /^[a-z_]+:\s/.test(l))) return { head: {}, body: text.trim() };
  const head: Record<string, string> = {};
  for (const l of top) {
    const [, k, v] = l.match(/^([a-z_]+):\s*(.*)$/)!;
    if (!KEYS.includes(k)) return { head, body: "", bad: `unknown header "${k}"` };
    head[k] = v.trim();
  }
  return { head, body: lines.slice(top.length).join("\n").trim() };
}

/** A spec that cannot be met, named after what is wrong with its file. Fails closed. */
const broken = (id: string, problem: string): Spec =>
  ({ id, instructions: `malformed spec file: ${problem}`, require: { path: "", op: "malformed" } }) as unknown as Spec;

export function parseSpec(id: string, text: string): Spec {
  const { head, body, bad } = sections(text);
  if (bad) return broken(id, bad);
  const spec: Spec & { fitted?: string } = { id, instructions: body };
  if (head.cut !== undefined) {
    const cut = Number(head.cut);
    if (!(cut > 0 && cut < 1)) return broken(id, `cut must be a number between 0 and 1, got "${head.cut}"`);
    spec.cut = cut;
  }
  if (head.require !== undefined) {
    const [path, op, ...rest] = head.require.split(/\s+/);
    const raw = rest.join(" ");
    let value: unknown = raw || undefined;
    try {
      if (raw) value = JSON.parse(raw);
    } catch {
      /* a bare word is a string */
    }
    spec.require = { path, op: op as any, ...(value !== undefined ? { value } : {}) };
  }
  if (head.evidence) spec.evidence = head.evidence.split(",").map((s) => s.trim()).filter(Boolean);
  if (head.optional !== undefined) spec.optional = /^(yes|true)$/i.test(head.optional);
  if (head.gather) spec.gather = head.gather;
  if (head.true || head.false) spec.criteria = { ...(head.true ? { true: head.true } : {}), ...(head.false ? { false: head.false } : {}) };
  if (head.fitted) spec.fitted = head.fitted;
  return spec;
}

export function formatSpec(s: Spec & { fitted?: string }): string {
  const head: string[] = [];
  if (s.require) head.push(`require: ${[s.require.path, s.require.op, s.require.value === undefined ? "" : JSON.stringify(s.require.value)].join(" ").trim()}`);
  if (typeof s.cut === "number") head.push(`cut: ${s.cut}`);
  if (s.evidence?.length) head.push(`evidence: ${s.evidence.join(", ")}`);
  if (s.optional) head.push("optional: yes");
  if (s.gather) head.push(`gather: ${s.gather}`);
  if (s.criteria?.true) head.push(`true: ${s.criteria.true}`);
  if (s.criteria?.false) head.push(`false: ${s.criteria.false}`);
  if (s.fitted) head.push(`fitted: ${s.fitted}`);
  return `${head.length ? `${head.join("\n")}\n\n` : ""}${s.instructions}\n`;
}

/** Every `.spec` under the tree, as [path relative to the tree, absolute path], sorted. */
export function specPaths(treeDir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(EXT)) out.push([relative(treeDir, p).split(sep).join("/"), p]);
    }
  };
  walk(treeDir);
  return out;
}

/**
 * Load the tree under `orlyDir`, or null when there is none.
 *
 * `override` substitutes one file's text — how the edit guard sees the set an edit would
 * produce before the edit happens.
 */
export function loadTree(orlyDir: string, override?: { path: string; text: string }): (SpecFile & { paths: Record<string, string> }) | null {
  const treeDir = join(orlyDir, TREE);
  if (!existsSync(treeDir)) return null;
  const read = (p: string) => (override && p === override.path ? override.text : readFileSync(p, "utf8"));
  const files = specPaths(treeDir);
  if (override?.path.endsWith(EXT) && override.path.startsWith(treeDir) && !files.some(([, p]) => p === override.path))
    files.push([relative(treeDir, override.path).split(sep).join("/"), override.path]);
  const specs: Spec[] = [];
  const paths: Record<string, string> = {};
  for (const [rel, abs] of files) {
    const id = basename(rel, EXT);
    specs.push(parseSpec(id, read(abs)));
    paths[id] = rel;
  }
  const goalPath = join(orlyDir, GOAL);
  const goal = existsSync(goalPath) || override?.path === goalPath ? sections(read(goalPath)) : { head: {}, body: "" };
  const rounds = Number(goal.head.rounds);
  return { goal: goal.body, specs, paths, ...(Number.isInteger(rounds) && rounds > 0 ? { maxRounds: rounds } : {}) };
}

/** The tree as an indented index: folders, then each spec with how it is decided. */
export function renderTree(file: SpecFile & { paths: Record<string, string> }): string {
  const lines: string[] = [];
  let open: string[] = [];
  for (const s of [...file.specs].sort((a, b) => file.paths[a.id].localeCompare(file.paths[b.id]))) {
    const dirs = file.paths[s.id].split("/").slice(0, -1);
    let same = 0;
    while (same < dirs.length && dirs[same] === open[same]) same++;
    for (let i = same; i < dirs.length; i++) lines.push(`${"  ".repeat(i)}${dirs[i]}/`);
    open = dirs;
    const how = s.require
      ? `check ${s.require.path} ${s.require.op} ${s.require.value ?? ""}`.trim()
      : `cut ${typeof s.cut === "number" ? s.cut : "unfitted"}`;
    lines.push(`${"  ".repeat(dirs.length)}${s.id.padEnd(36 - 2 * dirs.length)} ${how}${s.optional ? " (optional)" : ""}`);
  }
  return lines.join("\n");
}
