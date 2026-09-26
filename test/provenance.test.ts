import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const ORLY = join(import.meta.dir, "..", "orly.ts");
const dirs: string[] = [];
const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}`, RUSTUP_TOOLCHAIN: "stable", RUSTC_WRAPPER: "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ORLY_GATE_SLOTS: "2" };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const run = (root: string, ...args: string[]) => {
  const p = Bun.spawnSync(args, { cwd: root, env: { ...env, CARGO_TARGET_DIR: join(root, "target") } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const git = (root: string, ...args: string[]) => run(root, "git", ...args).out.trim();
const orly = (root: string, ...args: string[]) => run(root, "bun", ORLY, ...args);
function repo(command = 'cargo test -q --lib -- --list > actual && grep -Fx "$(cat expected): test" actual') {
  const root = mkdtempSync(join(tmpdir(), "orly-provenance-")); dirs.push(root);
  mkdirSync(join(root, ".orly/swarm"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), "target/\n.orly/swarm/data/\n");
  writeFileSync(join(root, ".orly/swarm/swarm.md"), "---\nmain: main\ngate: [test]\n---\n");
  writeFileSync(join(root, ".orly/config.json"), JSON.stringify({ checks: { test: { command } } }));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname="orly_provenance_probe"\nversion="0.1.0"\nedition="2021"\n');
  writeFileSync(join(root, "src/lib.rs"), "#[test]\nfn lane_a() {}\n");
  writeFileSync(join(root, "expected"), "lane_a\n");
  git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "commit", "-qm", "A");
  const a = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/lib.rs"), "#[test]\nfn lane_b() {}\n");
  writeFileSync(join(root, "expected"), "lane_b\n");
  git(root, "commit", "-qam", "B");
  return { root, a, b: git(root, "rev-parse", "HEAD") };
}

test("Rust gates rebuild a previously used export after another export overwrites its shared artifact", () => {
  const { root, a, b } = repo();
  expect(orly(root, "lane", "gate", a).code).toBe(0);
  const lock = join(root, ".orly/swarm/data/build.lock");
  writeFileSync(lock, String(process.pid));
  try { expect(orly(root, "lane", "gate", b).code).toBe(0); }
  finally { rmSync(lock); }
  const again = orly(root, "lane", "gate", a);
  expect(again.out + again.err).toContain("test=0");
  expect(again.code).toBe(0);
  expect(readFileSync(join(root, ".orly/swarm/data/export/actual"), "utf8")).toContain("lane_a: test");
}, 120000);

test("Rust gate serialization spans compilation and test execution across export slots", async () => {
  const command = 'guard="$CARGO_TARGET_DIR/gate-running"; mkdir -p "$CARGO_TARGET_DIR"; mkdir "$guard" || exit 91; trap \'rmdir "$guard"\' EXIT; cargo test -q --lib -- --list > actual && sleep 0.5 && grep -Fx "$(cat expected): test" actual';
  const { root, a, b } = repo(command);
  const gates = [a, b].map((rev) => Bun.spawn(["bun", ORLY, "lane", "gate", rev], { cwd: root, env: { ...env, CARGO_TARGET_DIR: join(root, "target") } }));
  expect(await Promise.all(gates.map((gate) => gate.exited))).toEqual([0, 0]);
}, 120000);

test("legacy tree-only green records cannot bypass the repaired gate", () => {
  const { root } = repo("false");
  const work = orly(root, "lane", "open", "doctor-1").out.trim();
  writeFileSync(join(work, "note.md"), "change\n");
  expect(orly(root, "lane", "put", "doctor-1", "-m", "note", "note.md").code).toBe(0);
  writeFileSync(join(root, ".orly/swarm/data/green"), git(root, "rev-parse", "lane/doctor-1^{tree}") + "\n");
  const landed = orly(root, "lane", "land", "doctor-1", "legacy");
  expect(landed.code).toBe(1);
  expect(landed.out).toContain("test=1");
  expect(landed.out).not.toContain("already green");
}, 120000);
