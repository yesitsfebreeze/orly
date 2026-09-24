/**
 * Idempotent file edits an installer needs: merge one entry into a JSON settings file
 * without disturbing the rest, write a generated file, and render the goal command from
 * its one source into a host's format. Nothing here knows which hosts exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Planned = { path: string; action: "create" | "update" | "unchanged"; preview: string };

/** Parse a JSON file, tolerating an empty or missing one. Throws on a file that is there and not JSON. */
export function readJson(path: string): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/** Walk `keys` into `doc`, creating objects on the way, and return the array at the end. */
export function arrayAt(doc: any, keys: string[]): any[] {
  let node = doc;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] === null || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  const last = keys[keys.length - 1];
  if (!Array.isArray(node[last])) node[last] = [];
  return node[last];
}

/**
 * Ensure exactly one of our entries is in the array at `keys`: replace the one `isOurs`
 * recognises, else append. Returns whether the document changed.
 */
export function upsertEntry(doc: any, keys: string[], entry: unknown, isOurs: (e: any) => boolean): boolean {
  const list = arrayAt(doc, keys);
  const i = list.findIndex(isOurs);
  const same = i >= 0 && JSON.stringify(list[i]) === JSON.stringify(entry);
  if (same) return false;
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  return true;
}

/** Plan a JSON edit: what the file would become. `edit` returns whether it changed anything. */
export function planJson(path: string, edit: (doc: any) => boolean, extra?: Record<string, unknown>): Planned {
  const existed = existsSync(path);
  const doc = readJson(path);
  let changed = edit(doc);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (doc[k] === undefined) {
      doc[k] = v;
      changed = true;
    }
  }
  const preview = JSON.stringify(doc, null, 2) + "\n";
  return { path, action: !existed ? "create" : changed ? "update" : "unchanged", preview };
}

/** Plan a generated text file: ours to overwrite, so only "unchanged" needs a comparison. */
export function planText(path: string, content: string): Planned {
  const existed = existsSync(path);
  const same = existed && readFileSync(path, "utf8") === content;
  return { path, action: !existed ? "create" : same ? "unchanged" : "update", preview: content };
}

export function apply(plans: Planned[]): void {
  for (const p of plans) {
    if (p.action === "unchanged") continue;
    mkdirSync(dirname(p.path), { recursive: true });
    writeFileSync(p.path, p.preview);
  }
}

/** The body of a markdown command file: its frontmatter, if any, is dropped. */
export function bodyOf(markdown: string): { description: string; body: string } {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { description: "", body: markdown };
  const description = m[1].match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? "";
  return { description, body: markdown.slice(m[0].length).replace(/^\n+/, "") };
}

export type Rendering = {
  /** The host's argument placeholder, e.g. `$ARGUMENTS` or `{{args}}`. */
  args: string;
  /** How the source spells the CLI (with its plugin-root variable). */
  from: string;
  /** What replaces it for this host, e.g. `bun "/abs/bin/orly.ts"`. */
  cli: string;
};

/** Render the one command source for a host: its placeholder and its CLI spelling. */
export function renderCommand(source: string, r: Rendering): { description: string; body: string } {
  const { description, body } = bodyOf(source);
  return { description, body: body.replaceAll(r.from, r.cli).replaceAll("$ARGUMENTS", r.args) };
}

/** TOML for a Gemini-style command file, the prompt in a literal multi-line string. */
export function toml(description: string, body: string): string {
  const safe = body.replaceAll('"""', '\\"\\"\\"');
  return `description = ${JSON.stringify(description)}\nprompt = """\n${safe}\n"""\n`;
}

/** Markdown with a frontmatter block. */
export function withFrontmatter(fields: Record<string, string>, body: string): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}`;
}
