/**
 * The invariants in docs/state.txt that no single module owns.
 *
 * Each of these cost a wrong number, a silent bill or a session-long wall while this was
 * being built, and each was fixed in a place where nothing else would notice it breaking
 * again. The suite's own hygiene is in here too: the one bug that hid best was a probe
 * script `bun test` was quietly running against the live API on every run.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  // A salvaged probe named crit_test.ts matched bun's test pattern, so every `bun test`
  // hit the endpoint: 3.5s instead of 31ms, money on every run, and passing throughout —
  // so nothing ever drew attention to it. The name is the whole hazard, not the folder.
  const NETWORK = /\bfetch\s*\(|api\.typesafe\.ai|TYPESAFE_BASE_URL/;
  const offenders = testFiles(ROOT)
    // This file names those strings in order to look for them; it is the one exemption.
    .filter((f) => f !== import.meta.path)
    .filter((f) => NETWORK.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});

test("every fixture is labelled, because an unlabelled one defaults to should-pass", () => {
  // z_readme_unmeasured was added to the directory and not to the label map. It silently
  // counted as a turn that should pass and collapsed a margin — the model was right and
  // the harness was lying.
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
  // Every failure path in the adapter ends in "allow". A judge that is down, a payload it
  // cannot parse or a transcript it cannot read must never become a wall in front of work
  // that has nothing to do with it.
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
  // src/guard.ts is tested on two parsed spec sets. This is the part in between: the hook
  // has only the tool call, and has to work out what the file would say afterwards.
  const { dir, path } = specSandbox(0.7);
  try {
    const r = hook("claude-code-guard.ts", edit(dir, path, '"cut": 0.7', '"cut": 0.3'), dir);
    expect(r.stdout.toString()).toContain("deny");
    expect(r.stdout.toString()).toContain("its cut was lowered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edit guard stays out of the way of tightening and of other files", () => {
  const { dir, path } = specSandbox(0.7);
  try {
    expect(hook("claude-code-guard.ts", edit(dir, path, '"cut": 0.7', '"cut": 0.9'), dir).stdout.toString()).toBe("");
    const elsewhere = edit(dir, join(dir, "src.ts"), "a", "b");
    expect(hook("claude-code-guard.ts", elsewhere, dir).stdout.toString()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the CLI

test("orly fit reads the log and proposes from it", () => {
  // `fit` read a module-level const declared further down the file, so the one command
  // that turns logged turns into better cuts crashed in the temporal dead zone before
  // printing a line. Nothing imports it, so nothing else would have caught it.
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
