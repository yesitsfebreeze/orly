/**
 * Claims — specs anchored to the code's own definitions.
 *
 * Next to a source file sits a sidecar, `src/http.ts.orly`, one claim per line:
 *
 *   @file:               the package is named "xyz"
 *   fetchWithRetry:      is exported
 *   RetryPolicy.max:     is set to 3
 *
 * The anchor is a name from the syntax tree, never a line number: a line number points at
 * different code after the first edit above it and keeps "passing" on the wrong lines. A
 * name that no longer resolves fails the claim, so a rename blocks instead of drifting.
 *
 * Each claim is asked with only its definition's current source in front of the judge,
 * and about what the code SAYS. Asked what code does at runtime, the judge answers
 * confidently and wrongly (docs/specs.txt), so behaviour words are refused up front —
 * behaviour belongs to a test's output.
 */
import ts from "typescript";
import { extname } from "node:path";

export type Definition = { anchor: string; kind: string; from: number; to: number; text: string };
export type Claim = { anchor: string; claim: string; line: number };
export type ClaimResult = Claim & { p?: number; ok: boolean; problem?: string };
export type Asker = (state: unknown, questions: Record<string, unknown>) => Promise<{ answers: Record<string, any> }>;

const KINDS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.FunctionDeclaration]: "function",
  [ts.SyntaxKind.ClassDeclaration]: "class",
  [ts.SyntaxKind.InterfaceDeclaration]: "interface",
  [ts.SyntaxKind.TypeAliasDeclaration]: "type",
  [ts.SyntaxKind.EnumDeclaration]: "enum",
  [ts.SyntaxKind.VariableDeclaration]: "variable",
  [ts.SyntaxKind.MethodDeclaration]: "method",
  [ts.SyntaxKind.PropertyDeclaration]: "property",
  [ts.SyntaxKind.Constructor]: "constructor",
  [ts.SyntaxKind.GetAccessor]: "getter",
  [ts.SyntaxKind.SetAccessor]: "setter",
  [ts.SyntaxKind.PropertySignature]: "property",
  [ts.SyntaxKind.MethodSignature]: "method",
  [ts.SyntaxKind.EnumMember]: "member",
};

const SCRIPT: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX,
};

export const supported = (path: string) => extname(path) in SCRIPT;

/**
 * Every named definition in a file: top-level declarations and the members of classes,
 * interfaces and enums, anchored as `Name` or `Owner.member`. Function bodies are not
 * descended into — a local is not something a claim should be pinned to.
 */
export function definitions(path: string, text: string): Definition[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, SCRIPT[extname(path)] ?? ts.ScriptKind.TS);
  const out: Definition[] = [];
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node, owner: string) => {
    const kind = KINDS[node.kind];
    const name = (node as any).name;
    const id = node.kind === ts.SyntaxKind.Constructor ? "constructor" : name && ts.isIdentifier(name) ? name.text : name?.getText?.(sf);
    if (kind && id) {
      // A `const x = …` statement is what a reader thinks of as the definition, export and all.
      const whole = ts.isVariableDeclaration(node) ? node.parent.parent : node;
      const anchor = owner ? `${owner}.${id}` : id;
      out.push({ anchor, kind, from: line(whole.getStart(sf)), to: line(whole.getEnd()), text: whole.getText(sf) });
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node))
        node.members.forEach((m: ts.Node) => visit(m, anchor));
      return;
    }
    if (ts.isSourceFile(node) || ts.isVariableStatement(node) || ts.isVariableDeclarationList(node) || ts.isModuleBlock(node))
      ts.forEachChild(node, (c) => visit(c, owner));
  };
  visit(sf, "");
  return out;
}

/** `anchor: claim` per line; blank lines and `#` comments skipped. */
export function parseSidecar(text: string): { claims: Claim[]; problems: Claim[] } {
  const claims: Claim[] = [];
  const problems: Claim[] = [];
  text.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith("#")) return;
    const m = l.match(/^(@file|[A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*:\s*(.+)$/);
    if (m) claims.push({ anchor: m[1], claim: m[2].trim(), line: i + 1 });
    else if (/^\d+\s*:/.test(l)) problems.push({ anchor: l.split(":")[0], claim: "a line number drifts with every edit above it — anchor to a symbol name (`orly symbols <file>` lists them)", line: i + 1 });
    else problems.push({ anchor: "?", claim: `expected "anchor: claim", got ${JSON.stringify(l)}`, line: i + 1 });
  });
  return { claims, problems };
}

// Behaviour needs a run to settle; taste has nothing to settle it with.
const BEHAVIOUR = /\b(correct(ly)?|properly|works?|handles?|always|bug-?free|edge[- ]cases?|robust|efficient(ly)?|fast|safe(ly)?|clean|readable|elegant|idiomatic|good|nice)\b/i;

export const claimProblem = (claim: string): string | undefined => {
  const hit = claim.replace(/`[^`]*`/g, " ").match(BEHAVIOUR);
  return hit ? `"${hit[0]}" asks about behaviour or taste — claim what the code says, and leave behaviour to a test` : undefined;
};

const MAX_CHARS = 12_000;

/**
 * Judge one sidecar against its source file in a single request. Anything that cannot be
 * judged — a bad line, an unresolved anchor, a refused claim — fails, never passes.
 */
export async function judgeSidecar(sourcePath: string, source: string | null, sidecar: string, ask: Asker, cut: number): Promise<ClaimResult[]> {
  const { claims, problems } = parseSidecar(sidecar);
  const out: ClaimResult[] = problems.map((p) => ({ ...p, ok: false, problem: p.claim }));
  if (source === null) return [...out, ...claims.map((c) => ({ ...c, ok: false, problem: `${sourcePath} does not exist` }))];
  const defs = new Map(definitions(sourcePath, source).map((d) => [d.anchor, d]));
  const symbols: Record<string, string> = {};
  const questions: Record<string, unknown> = {};
  const asked: Array<[string, Claim]> = [];
  claims.forEach((c, i) => {
    const refused = claimProblem(c.claim);
    if (refused) return out.push({ ...c, ok: false, problem: refused });
    const def = c.anchor === "@file" ? { text: source } : defs.get(c.anchor);
    if (!def) return out.push({ ...c, ok: false, problem: `no definition named "${c.anchor}" in ${sourcePath} — renamed or deleted?` });
    symbols[c.anchor] = def.text.slice(0, MAX_CHARS);
    const where = c.anchor === "@file" ? `the whole file under \`symbols["@file"]\`` : `\`symbols["${c.anchor}"]\`, the current source of that definition`;
    questions[`c${i}`] = {
      type: "noul",
      instructions: `Look at ${where}, read from ${sourcePath} just now. Judge only from what that text states, without simulating how it would run. Does it show that ${c.anchor === "@file" ? "the file" : `\`${c.anchor}\``} ${c.claim}?`,
    };
    asked.push([`c${i}`, c]);
  });
  if (!asked.length) return out;
  const { answers } = await ask({ file: sourcePath, symbols }, questions);
  for (const [id, c] of asked) {
    const p = answers?.[id]?.noul;
    if (typeof p !== "number") out.push({ ...c, ok: false, problem: "no answer from the judge" });
    else out.push({ ...c, p, ok: p >= cut, ...(p >= cut ? {} : { problem: "not supported by the code" }) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Run `task` over `items` with at most `limit` in flight, results in input order. */
export async function pool<T, R>(items: T[], limit: number, task: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
