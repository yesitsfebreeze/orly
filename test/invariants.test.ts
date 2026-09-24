/**
 * Cross-cutting invariants no single module owns: the suite's own hygiene, the hooks end to
 * end through the real Claude Code adapter, the core's host neutrality and the docs.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------- the suite itself

/** Every file `bun test` collects, whatever it is named or wherever it sits. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) testFiles(path, out);
    else if (/\.(test|spec)\.ts$|_(test|spec)\.ts$/.test(e.name)) out.push(path);
  }
  return out;
}

test("nothing bun test collects reaches the live API", () => {
  // Any *_test.ts anywhere is collected, so scan by name pattern, not folder.
  const NETWORK = /\bfetch\s*\(|api\.typesafe\.ai|TYPESAFE_BASE_URL/;
  const offenders = testFiles(ROOT)
    .filter((f) => f !== import.meta.path)
    .filter((f) => NETWORK.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});

// ---------------------------------------------------------------- the hooks, end to end

const sandbox = () => mkdtempSync(join(tmpdir(), "orly-inv-"));

const hook = (script: string, payload: unknown, cwd: string) =>
  Bun.spawnSync(["bun", join(ROOT, "install", script)], {
    cwd,
    stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });

test("the Stop hook lets the agent stop when it cannot do its job", () => {
  // Fail open: bad payload, unreadable transcript or a down judge all allow.
  const dir = sandbox();
  try {
    for (const payload of [
      "not json at all",
      { cwd: dir, session_id: "t", transcript_path: join(dir, "nope.jsonl") },
    ]) {
      const r = hook("claude/adapter.ts", payload, dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).not.toContain('"block"');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A spec tree on disk, and the payload a tool call would send to hit it. */
function specTree(cut: number) {
  const dir = sandbox();
  mkdirSync(join(dir, ".orly", "specs", "g"), { recursive: true });
  writeFileSync(join(dir, ".orly", "goal"), "g\n");
  const path = join(dir, ".orly", "specs", "g", "one.spec");
  writeFileSync(path, `cut: ${cut}\n\nDoes \`command_results\` show the parser passing its tests?\n`);
  return { dir, path };
}

const edit = (dir: string, path: string, from: string, to: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  cwd: dir,
  tool_input: { file_path: path, old_string: from, new_string: to },
});

test("the edit guard reconstructs the file and refuses a weakening", () => {
  const { dir, path } = specTree(0.7);
  try {
    const r = hook("claude/adapter.ts", edit(dir, path, "cut: 0.7", "cut: 0.3"), dir);
    expect(r.stdout.toString()).toContain("deny");
    expect(r.stdout.toString()).toContain("its cut was lowered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edit guard takes `$` patterns in the new text literally", () => {
  // String.replace would expand `$&` into the old text, projecting a different file.
  // The guard must refuse the edit as unparseable, never let a `$`-laundered version through.
  const { dir, path } = specTree(0.7);
  try {
    const r = hook("claude/adapter.ts", edit(dir, path, "cut: 0.7", 'cut: 0.3, "note": "$&"'), dir);
    expect(r.stdout.toString()).toContain('"deny"');
    expect(r.stdout.toString()).toContain("unparseable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edit guard stays out of the way of tightening and of other files", () => {
  const { dir, path } = specTree(0.7);
  try {
    expect(hook("claude/adapter.ts", edit(dir, path, "cut: 0.7", "cut: 0.9"), dir).stdout.toString()).toBe("");
    const elsewhere = edit(dir, join(dir, "src.ts"), "a", "b");
    expect(hook("claude/adapter.ts", elsewhere, dir).stdout.toString()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart sends the brief as additionalContext inside a project", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly", "specs", "g"), { recursive: true });
    writeFileSync(join(dir, ".orly", "goal"), "g\n");
    writeFileSync(join(dir, ".orly", "specs", "g", "one.spec"), "cut: 0.7\n\nDoes `command_results` show the parser passing its tests?\n");
    const r = hook("claude/adapter.ts", { hook_event_name: "SessionStart", cwd: dir }, dir);
    const ctx = JSON.parse(r.stdout.toString()).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("completion gate is active");
    expect(ctx).toContain("`one`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd deletes the Stop hook's per-session temp files", () => {
  const id = `inv-end-${process.pid}`;
  const files = [join(tmpdir(), `orly-rounds-${id}.json`), join(tmpdir(), `orly-nokey-${id}`)];
  for (const f of files) writeFileSync(f, "{}");
  const r = hook("claude/adapter.ts", { hook_event_name: "SessionEnd", session_id: id }, tmpdir());
  expect(r.exitCode).toBe(0);
  expect(files.filter((f) => existsSync(f))).toEqual([]);
});

test("the core names no vendor, no host and no harness", () => {
  // Host knowledge lives in adapters and declared commands, never in the core file.
  const VENDOR = /\bkern\b|claude|anthropic|openai|cursor|opencode/i;
  // Comments are stripped: only a vendor in code (import, binary, path) counts.
  const code = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const shipped = [join(ROOT, "orly.ts")];
  const offenders = shipped.filter((f) => VENDOR.test(code(f)));
  expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});
// ---------------------------------------------------------------- the docs say what the code does

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("every environment variable the core and the adapters read is documented", () => {
  const adapters = readdirSync(join(ROOT, "install"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const core = [read("orly.ts"), ...adapters.map((f) => read(join("install", f)))].join("\n");
  const names = new Set([...core.matchAll(/process\.env\.([A-Z_]+)|num\("([A-Z_]+)"/g)].map((m) => m[1] ?? m[2]));
  for (const n of ["HOME", "CLAUDE_PLUGIN_ROOT"]) names.delete(n); // set by the OS and by Claude Code
  const docs = read("docs/install.txt");
  expect([...names].filter((n) => !docs.includes(n))).toEqual([]);
});

test("every CLI command is in the README and every spec header in docs/specs.txt", () => {
  const core = read("orly.ts");
  const commands = [...core.matchAll(/command === "([a-z]+)"/g)].map((m) => m[1]);
  expect(commands.length).toBeGreaterThan(4);
  expect(commands.filter((c) => !read("README.md").includes(`orly ${c}`))).toEqual([]);
  const keys = JSON.parse(core.match(/const KEYS = (\[[^\]]*\])/)![1]) as string[];
  const specs = read("docs/specs.txt");
  expect(keys.filter((k) => !new RegExp(`^\\s*(- )?\\S*\\b${k}\\b`, "m").test(specs) && !specs.includes(`\`${k}\``))).toEqual([]);
});

test("every relative link in the README and llms.txt points at a file that exists", () => {
  const links = ["README.md", "llms.txt"].flatMap((f) => [...read(f).matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]));
  expect(links.filter((l) => !/^https?:/.test(l) && !existsSync(join(ROOT, l)))).toEqual([]);
});
