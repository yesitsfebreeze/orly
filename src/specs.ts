/**
 * Requirements: one `.spec` file each under `.orly/specs/`, `key: value` headers, a blank line, one
 * yes/no question. `require:` is decided by a check in code; `evidence:` names the source locations
 * the judge reads; a question with neither is about the turn, not the code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

export type Require = { path: string; op: string; value?: unknown };
/** `broken` is set when the file did not parse: the requirement then blocks until it is fixed. */
export type Spec = { id: string; question: string; cut?: number; require?: Require; evidence?: string[]; broken?: string };
export type SpecTree = { goal: string; rounds: number; specs: Spec[]; paths: Record<string, string> };

const KEYS = ["cut", "require", "evidence", "fitted", "rounds"];
const OPS = ["equals", "lte", "gte", "present", "absent", "contains"];
const TASTE = /\b(clean|elegant|readable|maintainable|idiomatic|well[- ](structured|designed|written)|good|nice|proper|appropriate|robust|scalable|performant|secure enough|best practice)\b/i;

/** `key: value` header lines, a blank line, then the body. No headers when the first line is not one. */
export function sections(text: string): { head: Record<string, string>; body: string; bad?: string } {
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

export function parseSpec(id: string, text: string): Spec {
  const { head, body, bad } = sections(text);
  const broken = (why: string): Spec => ({ id, question: `malformed spec file: ${why}`, broken: why });
  if (bad) return broken(bad);
  if (!body) return broken("no question after the headers");
  const s: Spec = { id, question: body };
  if (head.cut !== undefined && !((s.cut = Number(head.cut)) > 0 && s.cut < 1)) return broken(`cut must be between 0 and 1, got "${head.cut}"`);
  if (head.require !== undefined) {
    const [path, op, ...rest] = head.require.split(/\s+/);
    if (!path || !OPS.includes(op)) return broken(`require must be <path> <op> [value], op one of ${OPS.join(", ")}`);
    let value: unknown = rest.join(" ") || undefined;
    try { if (value) value = JSON.parse(value as string); } catch { /* a bare word is a string */ }
    s.require = { path, op, ...(value !== undefined ? { value } : {}) };
  }
  if (head.evidence) s.evidence = head.evidence.split(",").map((x) => x.trim()).filter(Boolean);
  return s;
}

/** `.orly` found by walking up from `start`, as git finds `.git`. */
export function findOrlyDir(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".orly"))) return join(dir, ".orly");
    if (dir === parse(dir).root) return null;
  }
}

export function loadConfig(orlyDir: string): Record<string, any> {
  try { return JSON.parse(readFileSync(join(orlyDir, "config.json"), "utf8")) ?? {}; } catch { return {}; }
}

/** Every `.spec` under `.orly/specs/` (the file name is the id, folders only group), plus the goal. */
export function loadTree(orlyDir: string): SpecTree {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const files: string[] = [];
  const walk = (d: string) => existsSync(d) && readdirSync(d).sort().forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith(".spec") && files.push(join(d, n))));
  walk(join(orlyDir, "specs"));
  const specs = files.map((f) => parseSpec(basename(f, ".spec"), read(f)));
  const paths = Object.fromEntries(files.map((f) => [basename(f, ".spec"), relative(join(orlyDir, "specs"), f)]));
  const goal = sections(read(join(orlyDir, "goal")));
  return { goal: goal.body, rounds: Number(goal.head.rounds) > 0 ? Number(goal.head.rounds) : 6, specs, paths };
}

/** What makes a spec unjudgeable, decided in code before any request: taste words, bad ids, broken files. */
export function validate(specs: Spec[]): { id: string; problem: string }[] {
  const out: { id: string; problem: string }[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    if (s.broken) out.push({ id: s.id, problem: s.broken });
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(s.id)) out.push({ id: s.id, problem: "id must be a short slug" });
    if (seen.has(s.id)) out.push({ id: s.id, problem: "duplicate id" });
    seen.add(s.id);
    if (!s.broken && !s.require && s.question.length < 15) out.push({ id: s.id, problem: "question too short to judge" });
    const taste = s.require || s.broken ? null : s.question.replace(/`[^`]*`/g, " ").match(TASTE);
    if (taste) out.push({ id: s.id, problem: `"${taste[0]}" is a judgement of taste, not of recorded evidence` });
  }
  return out;
}

/** The changes from `before` to `after` that make the gate easier to pass. Requirements are never weakened to pass. */
export function weakenings(before: Spec[], after: Spec[]): string[] {
  const out: string[] = [];
  for (const was of before) {
    const now = after.find((s) => s.id === was.id);
    if (!now) out.push(`\`${was.id}\`: the spec was deleted`);
    else if ((now.cut ?? 0.7) < (was.cut ?? 0.7) - 1e-9) out.push(`\`${was.id}\`: its cut was lowered`);
    else if (was.require && !now.require) out.push(`\`${was.id}\`: its check was removed`);
  }
  return out;
}

export const REFUSAL = "orly? refuses this edit: it would make the gate easier to pass.";
export const ADVICE = "Tightening a cut, adding a spec or rewording one is allowed. You are the thing being judged: if a spec is wrong, say so to the user and leave it alone.";
