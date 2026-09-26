/** The swarm on a scratch repo (the equivalent of kern2's `just doctor`): seating, leases, bus and lanes. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path"; import { tmpdir } from "node:os";

const ORLY = join(import.meta.dir, "..", "orly.ts");
const GIT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, cmd: string[], pid?: number) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...GIT, ...(pid ? { ORLY_PID: String(pid) } : {}) } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const orly = (cwd: string, args: string[], pid = process.pid) => sh(cwd, ["bun", ORLY, ...args], pid);
const git = (cwd: string, ...a: string[]) => sh(cwd, ["git", ...a]).out;
/** A pid that is gone: a process that already exited. */
const deadPid = () => { const p = Bun.spawnSync(["true"]); return p.pid; };
/** Another live session: a process that outlives the test. */
const livePid = () => { const p = Bun.spawn(["sleep", "60"]); sleepers.push(p); return p.pid; };
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
const scratch: string[] = [];
afterAll(() => {
  for (const p of sleepers) p.kill();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-"));
  scratch.push(root);
  const w = (p: string, t: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), t); };
  w(".orly/config.json", JSON.stringify({ checks: { nobad: { command: "test ! -f bad.txt" } } }));
  w(".orly/swarm/swarm.md", "---\nmain: main\ngate: [nobad]\n---\nThe brief.\n");
  w(".orly/swarm/seats/director.md", "---\nfilled: always\n---\nLand lanes.\n");
  w(".orly/swarm/seats/work.md", "---\nfilled: SELECT path FROM memo WHERE fm->>'status' = 'open'\nspecs: work\n---\nDo the work.\n");
  w(".orly/swarm/seats/idle.md", "---\nfilled: SELECT path FROM memo WHERE fm->>'status' = 'nothing'\n---\nNever seated.\n");
  w(".orly/tables", "memo: memos/*.md\n");
  w("memos/a.md", "---\nstatus: open\n---\n");
  w("a.txt", "one\n");
  sh(root, ["git", "init", "-q", "-b", "main"]); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  return root;
}
const names = (root: string, pid: number) => orly(root, ["swarm"], pid).out.split("\n").filter(Boolean).map((l) => JSON.parse(l).name);

test("seating: the director once, one <seat>-<n> per session for each filled seat, the same plan on rejoin", () => {
  const root = repo(), other = livePid();
  expect(names(root, process.pid)).toEqual(["director", "work-1"]);
  expect(names(root, other)).toEqual(["work-2"]);
  expect(names(root, process.pid)).toEqual(["director", "work-1"]);
  expect(JSON.parse(orly(root, ["swarm"]).out.split("\n")[1])).toMatchObject({ seat: "work", specs: "work", rows: 1 });
});

test("a dead pid frees the director lease and its sitter names", () => {
  const root = repo(), gone = deadPid();
  expect(names(root, gone)).toEqual(["director", "work-1"]);
  expect(names(root, process.pid)).toEqual(["director", "work-1"]);
});

test("a filled query that is not one SELECT fails the plan", () => {
  const root = repo();
  writeFileSync(join(root, ".orly/swarm/seats/idle.md"), "---\nfilled: DELETE FROM memo\n---\n");
  const r = orly(root, ["swarm"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("seat idle: filled must be");
});

test("bus: typed lines, a claim conflict, pending lands, and reaping a gone session's claims", () => {
  const root = repo(), gone = deadPid(), sha = git(root, "rev-parse", "--short", "HEAD");
  expect(orly(root, ["bus", "claim", "work-1", "s1", "a.txt"]).code).toBe(0);
  const taken = orly(root, ["bus", "claim", "work-2", "s2", "a.txt"]);
  expect(taken.code).toBe(1);
  expect(taken.err).toContain("a.txt is work-1's (s1)");
  expect(orly(root, ["bus", "claim", "work-3", "s3", "b.txt"], gone).code).toBe(0);
  orly(root, ["bus", "post", "work-1", "director", `land s1 ${sha}`]);
  orly(root, ["bus", "post", "director", "work-1", "re 3 looking"]);
  expect(orly(root, ["bus", "pending"]).out).toContain(`land s1 ${sha}`);
  orly(root, ["bus", "post", "director", "all", `landed s1 at ${sha}`]);
  expect(orly(root, ["bus", "pending"]).out).toBe("");
  expect(orly(root, ["bus", "reap"]).code).toBe(0);
  expect(orly(root, ["bus", "claims"]).out).toBe("work-1\ts1\ta.txt");
  const lines = readFileSync(join(root, ".orly/swarm/data/bus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ seq: 1, verb: "claimed", slug: "s1", text: "claimed s1: a.txt" });
  expect(lines.find((l) => l.text.startsWith("land "))).toMatchObject({ verb: "land", slug: "s1", sha });
  expect(lines.find((l) => l.text.startsWith("re "))).toMatchObject({ verb: null, reply_to: 3 });
  expect(lines.at(-1)).toMatchObject({ from: "work-3", verb: "released", slug: "s3" });
});

test("bus: a post reads back with its typed fields, once, and never to its sender", () => {
  const root = repo(), sha = git(root, "rev-parse", "--short", "HEAD");
  orly(root, ["bus", "post", "work-1", "director", `land s1 ${sha}`]);
  orly(root, ["bus", "post", "director", "work", "re 1 landing it"]);
  const read = (me: string) => orly(root, ["bus", "read", me]).out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(read("director")).toMatchObject([{ seq: 1, from: "work-1", to: "director", verb: "land", slug: "s1", sha, reply_to: null, text: `land s1 ${sha}` }]);
  expect(read("director")).toEqual([]);
  expect(read("work-1")).toMatchObject([{ seq: 2, from: "director", to: "work", verb: null, reply_to: 1 }]);
  expect(orly(root, ["bus", "post", "Work 1", "all", "x"]).code).toBe(1);
});

test("lane: open, put, sync, a land through the gate, and a bounce on a red gate", () => {
  const root = repo(), lane = (...a: string[]) => orly(root, ["lane", ...a]);
  const w = lane("open", "work-1").out;
  expect(w).toEndWith(".orly/swarm/data/work/work-1");
  writeFileSync(join(w, "b.txt"), "two\n");
  expect(lane("put", "work-1", "-m", "add b", "b.txt").code).toBe(0);
  expect(git(root, "show", "lane/work-1:b.txt")).toBe("two");
  expect(existsIn(root, "b.txt")).toBe(false);
  writeFileSync(join(root, "c.txt"), "three\n"); git(root, "add", "c.txt"); git(root, "commit", "-qm", "c on main");
  expect(lane("sync", "work-1").out).toBe("2");
  expect(git(root, "show", "lane/work-1:c.txt")).toBe("three");
  const landed = lane("land", "work-1", "s1");
  expect(landed.out).toContain("landed s1 from work-1");
  expect(landed.out).toContain("nobad=0");
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("two\n");
  const w2 = lane("open", "work-2").out, before = git(root, "rev-parse", "main");
  writeFileSync(join(w2, "bad.txt"), "x\n");
  lane("put", "work-2", "-m", "add bad", "bad.txt");
  const bounced = lane("land", "work-2", "s2");
  expect(bounced.code).toBe(1);
  expect(bounced.out).toContain("nobad=1");
  expect(bounced.err).toContain("is red; not landed");
  expect(git(root, "rev-parse", "main")).toBe(before);
  expect(lane("check", "work-2").code).toBe(1);
  expect(lane("ls").out).toMatch(/work-2\s+ahead 1 behind 0/);
});

test("a gate name with no check in config.json is refused", () => {
  const root = repo();
  writeFileSync(join(root, ".orly/swarm/swarm.md"), "---\ngate: [nobad, missing]\n---\n");
  const r = orly(root, ["lane", "gate", "HEAD"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing");
});

function existsIn(root: string, p: string) { return Bun.file(join(root, p)).size > 0; }
