/**
 * Cross-cutting invariants no single module owns: the suite's own hygiene, the hooks
 * end to end, the CLI, and the check cache.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_NAME, checkEnricher } from "../src/enrich-checks.ts";
import { treeFingerprint } from "../src/fingerprint.ts";

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
    // This file names the strings to find them.
    .filter((f) => f !== import.meta.path)
    .filter((f) => NETWORK.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});

test("every fixture is labelled, because an unlabelled one defaults to should-pass", () => {
  const calibrate = readFileSync(join(ROOT, "test", "calibrate.ts"), "utf8");
  const unlabelled = readdirSync(join(ROOT, "test", "fixtures"))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .filter((name) => !calibrate.includes(name));
  expect(unlabelled).toEqual([]);
});

// ---------------------------------------------------------------- the hooks, end to end

const sandbox = () => mkdtempSync(join(tmpdir(), "orly-inv-"));

const hook = (script: string, payload: unknown, cwd: string) =>
  Bun.spawnSync(["bun", join(ROOT, "adapters", script)], {
    cwd,
    stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    env: { ...process.env, ORLY_NO_LOG: "1" },
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
      const r = hook("claude-code.ts", payload, dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).not.toContain('"block"');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A spec file on disk, and the edit payload a tool call would send for it. */
function specSandbox(cut: number) {
  const dir = sandbox();
  mkdirSync(join(dir, ".orly"));
  const path = join(dir, ".orly", "specs.json");
  writeFileSync(
    path,
    JSON.stringify({ goal: "g", specs: [{ id: "one", instructions: "is it done?", cut }] }, null, 2),
  );
  return { dir, path };
}

const edit = (dir: string, path: string, from: string, to: string) => ({
  tool_name: "Edit",
  cwd: dir,
  tool_input: { file_path: path, old_string: from, new_string: to },
});

test("the edit guard reconstructs the file and refuses a weakening", () => {
  // The hook has only the tool call and must project the resulting file itself.
  const { dir, path } = specSandbox(0.7);
  try {
    const r = hook("claude-code.ts", edit(dir, path, '"cut": 0.7', '"cut": 0.3'), dir);
    expect(r.stdout.toString()).toContain("deny");
    expect(r.stdout.toString()).toContain("its cut was lowered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edit guard takes `$` patterns in the new text literally", () => {
  // String.replace would expand `$&` into the old text, project invalid JSON, and allow the edit.
  const { dir, path } = specSandbox(0.7);
  try {
    const r = hook("claude-code.ts", edit(dir, path, '"cut": 0.7', '"cut": 0.3, "note": "$&"'), dir);
    expect(r.stdout.toString()).toContain("its cut was lowered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edit guard stays out of the way of tightening and of other files", () => {
  const { dir, path } = specSandbox(0.7);
  try {
    expect(hook("claude-code.ts", edit(dir, path, '"cut": 0.7', '"cut": 0.9'), dir).stdout.toString()).toBe("");
    const elsewhere = edit(dir, join(dir, "src.ts"), "a", "b");
    expect(hook("claude-code.ts", elsewhere, dir).stdout.toString()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the CLI

test("orly fit reads the log and proposes from it", () => {
  // Guards a TDZ crash in bin/orly.ts that no import would surface.
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly"));
    const line = (blocked: boolean, actions: number) =>
      JSON.stringify({
        at: new Date().toISOString(),
        session: "s",
        blocked,
        scores: { "spec:one": 0.4 },
        unmet: blocked ? ["spec:one"] : [],
        hazards: [],
        actions,
        results: 0,
      });
    writeFileSync(join(dir, ".orly", "log.jsonl"), `${line(true, 3)}\n${line(false, 2)}\n`);
    const r = Bun.spawnSync(["bun", join(ROOT, "bin", "orly.ts"), "fit"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).not.toContain("ReferenceError");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("judged turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the session banner reports counts, and a check as a check", () => {
  // Nothing imports the banner, so only this catches a broken history line or a
  // `require` spec shown with a cut it does not have.
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly"));
    writeFileSync(
      join(dir, ".orly", "specs.json"),
      JSON.stringify({
        goal: "g",
        specs: [
          { id: "builds", instructions: "n/a", require: { path: "checks.build.exit", op: "equals", value: 0 } },
          { id: "honest", instructions: "is every claim backed?", cut: 0.28 },
        ],
      }),
    );
    const rec = (blocked: boolean) =>
      JSON.stringify({ at: "2026-01-01T00:00:00Z", session: "s", blocked, scores: {}, unmet: [], hazards: [], actions: 1, results: 1 });
    writeFileSync(join(dir, ".orly", "log.jsonl"), `${rec(true)}\n${rec(false)}\n`);

    const r = hook("claude-code.ts", { hook_event_name: "SessionStart", cwd: dir }, dir);
    const context = JSON.parse(r.stdout.toString()).hookSpecificOutput.additionalContext;
    expect(context).toContain("2 judged turns, 1 blocked");
    expect(context).toContain("`builds` (check: checks.build.exit equals 0)");
    expect(context).toContain("`honest` (cut 0.28)");
    expect(context).not.toContain("`builds` (cut");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionEnd deletes the Stop hook's per-session temp files", () => {
  // macOS does not reliably clean $TMPDIR, so without this they pile up one pair per session.
  const id = `inv-end-${process.pid}`;
  const files = [join(tmpdir(), `orly-rounds-${id}.json`), join(tmpdir(), `orly-status-${id}.json`), join(tmpdir(), `orly-nokey-${id}`)];
  for (const f of files) writeFileSync(f, "{}");
  const r = hook("claude-code.ts", { hook_event_name: "SessionEnd", session_id: id }, tmpdir());
  expect(r.exitCode).toBe(0);
  expect(files.filter((f) => existsSync(f))).toEqual([]);
});

test("the status line renders this session's last judgment beside the owl", () => {
  const id = `inv-status-${process.pid}`;
  const at = new Date(Date.now() - 120_000).toISOString();
  const line = "orly ⛔ block · specs 1/2 · unverified_claim 0.10 · coverage 2.50/3 (conf 0.90) · next=finish 0.80 · 900+40 tok";
  writeFileSync(join(tmpdir(), `orly-status-${id}.json`), JSON.stringify({ at, block: true, line, unmet: [{ id: "code_small", found: "4252, needs lte 2862" }] }));
  writeFileSync(join(tmpdir(), `orly-rounds-${id}.json`), JSON.stringify({ goal: "", rounds: 2, bestMet: 1, stalled: 0 }));
  try {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "orly.ts"), "statusline", "--then", "echo after"], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: id, workspace: { current_dir: join(import.meta.dir, "..") } })),
    });
    const out = r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("{@,@}");
    expect(out).toContain("│ ✗ BLOCK           2m ago │");
    expect(out).toContain("│ round 2/6    ███░░░░░░░  │");
    expect(out).toContain("2m ago");
    expect(out).toContain("└─ next finish 0.80 · 900+40 tok ─");
    expect(out).not.toContain("unverified_claim");
    expect(out.trimEnd().endsWith("after")).toBe(true);
    // Any other bar: no payload, one row, newest judgment for this project, no colour.
    const root = join(import.meta.dir, "..");
    writeFileSync(join(tmpdir(), `orly-status-${id}.json`), JSON.stringify({ at, cwd: root, block: false, line: "orly ✓ pass · specs 2/2", unmet: [] }));
    const one = Bun.spawnSync([join(root, "scripts", "orly-status"), "--oneline"], { cwd: root, env: { ...process.env, NO_COLOR: "1" } });
    expect(one.stdout.toString()).toBe("✓ PASS  2/2 specs · 2m ago\n");
    // Full terminal width by default; --width -n leaves n cells for the host's own margin.
    const wide = (args: string[]) =>
      Bun.spawnSync([join(root, "scripts", "orly-status"), ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1", COLUMNS: "132", ORLY_WIDTH: "" } })
        .stdout.toString().split("\n")[0];
    expect(Array.from(wide([])).length).toBe(132);
    expect(Array.from(wide(["--width", "-6"])).length).toBe(126);
    expect(Array.from(wide(["--width", "90"])).length).toBe(90);
  } finally {
    for (const f of ["status", "rounds"]) rmSync(join(tmpdir(), `orly-${f}-${id}.json`), { force: true });
  }
});

test("the core names no vendor, no host and no harness", () => {
  // Host knowledge lives in adapters and declared commands, never in src/.
  const VENDOR = /\bkern\b|claude|anthropic|openai|cursor|opencode/i;
  // Comments are stripped: only a vendor in code (import, binary, path) counts.
  const code = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const shipped = [join(ROOT, "src"), join(ROOT, "bin")].flatMap((dir) =>
    readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)),
  );
  const offenders = shipped.filter((f) => VENDOR.test(code(f)));
  expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});

test("a cached check is used only while the tree it was measured on is unchanged", async () => {
  // A stale cache could report a passing suite for a failing tree.
  const root = mkdtempSync(join(tmpdir(), "orly-cache-"));
  try {
    mkdirSync(join(root, ".orly"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "x"], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const spec: any = [{ id: "slow", instructions: "n/a", require: { path: "checks.slow.exit", op: "equals", value: 0 } }];
    // A command that reports 1, cached against the tree as it is now.
    const fingerprint = treeFingerprint(root);
    expect(fingerprint).not.toBeNull();
    writeFileSync(
      join(root, ".orly", CACHE_NAME),
      JSON.stringify({ slow: { fingerprint, at: "now", result: { exit: 1, out: "from the cache" } } }),
    );
    const hit: any = await checkEnricher({ slow: { command: "exit 0" } }, root)({} as any, spec);
    expect(hit.checks.slow.out).toBe("from the cache");

    // What orly writes about a judgment is not a change to the tree being judged.
    mkdirSync(join(root, ".orly", "turns"));
    writeFileSync(join(root, ".orly", "turns", "t.json"), "{}");
    writeFileSync(join(root, ".orly", "replay.jsonl"), "{}\n");
    expect(treeFingerprint(root)).toBe(fingerprint);

    // An edit that is staged is not "modified" against the index, but it is a change.
    writeFileSync(join(root, "staged.txt"), "staged\n");
    Bun.spawnSync(["git", "add", "staged.txt"], { cwd: root });
    expect(treeFingerprint(root)).not.toBe(fingerprint);

    // Touch the tree: the stamp no longer matches, so the command runs and wins.
    writeFileSync(join(root, "new.txt"), "changed\n");
    const miss: any = await checkEnricher({ slow: { command: "exit 0" } }, root)({} as any, spec);
    expect(miss.checks.slow.exit).toBe(0);
    expect(miss.checks.slow.out).not.toBe("from the cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no fingerprint means no cache, never a weak one", async () => {
  // Outside git nothing cheap proves "unchanged", so run the command.
  const root = mkdtempSync(join(tmpdir(), "orly-nogit-"));
  try {
    mkdirSync(join(root, ".orly"));
    expect(treeFingerprint(root)).toBeNull();
    const spec: any = [{ id: "c", instructions: "n/a", require: { path: "checks.c.exit", op: "equals", value: 0 } }];
    writeFileSync(join(root, ".orly", CACHE_NAME), JSON.stringify({ c: { fingerprint: null, result: { exit: 1, out: "stale" } } }));
    const e: any = await checkEnricher({ c: { command: "exit 0" } }, root)({} as any, spec);
    expect(e.checks.c.exit).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orly writing its own state is not the tree changing", () => {
  // The cache lives in .orly; counting it would invalidate every entry on write.
  const root = mkdtempSync(join(tmpdir(), "orly-fp-"));
  try {
    mkdirSync(join(root, ".orly"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    const before = treeFingerprint(root);
    writeFileSync(join(root, ".orly", CACHE_NAME), '{"a":1}');
    writeFileSync(join(root, ".orly", "log.jsonl"), "{}\n");
    expect(treeFingerprint(root)).toBe(before!);

    // Spec files are inputs a check may read, so they do count.
    writeFileSync(join(root, ".orly", "specs.json"), '{"specs":[]}');
    expect(treeFingerprint(root)).not.toBe(before!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project running spec-only is told so, rather than reading as compliant", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, ".orly"));
    writeFileSync(join(dir, ".orly", "config.json"), JSON.stringify({ keyCommand: "echo k" }));
    writeFileSync(
      join(dir, ".orly", "specs.json"),
      JSON.stringify({ goal: "g", specs: [{ id: "a", instructions: "is it done?", cut: 0.7 }] }),
    );
    const out = hook("claude-code.ts", { hook_event_name: "SessionStart", cwd: dir }, dir);
    expect(JSON.parse(out.stdout.toString()).hookSpecificOutput.additionalContext)
      .toContain("No deterministic checks are configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
