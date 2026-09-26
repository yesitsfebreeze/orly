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

test("filled: a `;` in a literal or comment, or a trailing one, is one SELECT; two statements are refused", () => {
  const root = repo(), seat = join(root, ".orly/swarm/seats/idle.md");
  for (const ok of ["SELECT path FROM memo WHERE path LIKE '%a;b%'", "SELECT path FROM memo WHERE 0;  ", "SELECT path FROM memo WHERE 0 /* a; b */ -- c; d"]) {
    writeFileSync(seat, `---\nfilled: ${ok}\n---\n`);
    expect(orly(root, ["swarm"]).code).toBe(0);
  }
  for (const bad of ["SELECT 1; SELECT 2", "SELECT 1; DROP TABLE x"]) {
    writeFileSync(seat, `---\nfilled: ${bad}\n---\n`);
    const r = orly(root, ["swarm"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("seat idle: filled must be");
  }
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

test("lane gate: a check with skipOnly is skipped when every changed path matches, run otherwise", () => {
  const root = repo(), lane = (...a: string[]) => orly(root, ["lane", ...a]);
  writeFileSync(join(root, ".orly/config.json"), JSON.stringify({ checks: { nobad: { command: "test ! -f bad.txt" }, build: { command: "false", skipOnly: "^memos/" } } }));
  writeFileSync(join(root, ".orly/swarm/swarm.md"), "---\nmain: main\ngate: [nobad, build]\n---\n");
  git(root, "commit", "-qam", "build check");
  const m = lane("open", "memo-1").out;
  mkdirSync(join(m, "memos"), { recursive: true });
  writeFileSync(join(m, "memos/b.md"), "---\nstatus: done\n---\n");
  lane("put", "memo-1", "-m", "memo only", "memos/b.md");
  const memo = lane("check", "memo-1");
  expect(memo.out).toContain("nobad=0 build=skip");
  expect(memo.code).toBe(0);
  writeFileSync(join(lane("open", "code-1").out, "a.txt"), "changed\n");
  lane("put", "code-1", "-m", "code", "a.txt");
  const code = lane("check", "code-1");
  expect(code.out).toContain("build=1");
  expect(code.code).toBe(1);
});

test("lane land refuses when main moved while the gate ran, and when main diverged from origin/main", () => {
  const root = repo(), lane = (...a: string[]) => orly(root, ["lane", ...a]);
  const sneak = "git update-ref refs/heads/main $(git commit-tree -p refs/heads/main -m sneak 'refs/heads/main^{tree}')";
  writeFileSync(join(root, ".orly/config.json"), JSON.stringify({ checks: { nobad: { command: sneak } } }));
  git(root, "commit", "-qam", "sneaky gate");
  writeFileSync(join(lane("open", "work-1").out, "b.txt"), "two\n");
  lane("put", "work-1", "-m", "add b", "b.txt");
  const before = git(root, "rev-parse", "--short", "main");
  const moved = lane("land", "work-1", "s1");
  expect(moved.code).toBe(1);
  expect(moved.err).toContain(`main moved from ${before}`);
  expect(git(root, "log", "-1", "--format=%s", "main")).toBe("sneak");
  git(root, "reset", "-q", "--hard", "main");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "commit-tree", "-p", "main~1", "-m", "elsewhere", "main^{tree}"));
  const split = lane("land", "work-1", "s1");
  expect(split.code).toBe(1);
  expect(split.err).toContain("main has diverged from origin/main");
});

test("a gate name with no check in config.json is refused", () => {
  const root = repo();
  writeFileSync(join(root, ".orly/swarm/swarm.md"), "---\ngate: [nobad, missing]\n---\n");
  const r = orly(root, ["lane", "gate", "HEAD"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing");
});

test("a lane gate yields the build lock to a waiting land, and takes it once that land is gone", async () => {
  const root = repo(), data = join(root, ".orly/swarm/data"), holder = livePid();
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "land.wanted"), String(holder));
  const gate = Bun.spawn(["bun", ORLY, "lane", "gate", "HEAD"], { cwd: root, env: { ...process.env, ...GIT } });
  await Bun.sleep(1500);
  expect(gate.exitCode).toBeNull();
  writeFileSync(join(data, "land.wanted"), String(deadPid()));
  expect(await gate.exited).toBe(0);
  expect(existsIn(root, ".orly/swarm/data/land.wanted")).toBe(false);
});

function existsIn(root: string, p: string) { return Bun.file(join(root, p)).size > 0; }

/** The claude adapter's PreToolUse on AskUserQuestion, as session `pid`; its JSON reply, or null for allow. */
function askGate(root: string, pid: number, transcript?: string) {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "install", "claude", "adapter.ts")], {
    cwd: root, env: { ...process.env, ORLY_PID: String(pid) },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", cwd: root, session_id: "t", transcript_path: transcript })),
  });
  const out = r.stdout.toString().trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("ask gate: every swarm seat is denied AskUserQuestion, the host and a session outside the swarm are not", () => {
  const root = repo(), host = livePid(), stranger = livePid();
  expect(names(root, host)).toEqual(["director", "work-1"]);
  // The host reserves its teammates' names under its own pid, but it is the one that asks the human.
  expect(askGate(root, host)).toBeNull();
  // A teammate is known by its transcript's agentName, whatever pid the hook resolves.
  const transcript = join(root, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", agentName: "work-1" }) + "\n");
  const denied = askGate(root, stranger, transcript);
  expect(denied.permissionDecision).toBe("deny");
  expect(denied.permissionDecisionReason).toContain("questions/<slug>.md");
  expect(denied.permissionDecisionReason).toStartWith("work-1: ");
  expect(askGate(root, stranger)).toBeNull();
  expect(askGate(tmpdir(), host)).toBeNull();
});

test("the questions table loads .orly/swarm/questions/*.md for row specs", async () => {
  const { loadTables, tablesFor } = await import("../orly.ts");
  const root = repo();
  mkdirSync(join(root, ".orly/swarm/questions"));
  writeFileSync(join(root, ".orly/swarm/questions/merge-cut.md"), "---\nstatus: open\noptions: [now, later]\n---\nCut over now?\n");
  const rows = loadTables(tablesFor(join(root, ".orly")), root)
    .query("SELECT fm->>'status' AS status, body FROM questions").all();
  expect(rows).toEqual([{ status: "open", body: "Cut over now?\n" }]);
});

test("gates run side by side in their own slots, each with its own export", async () => {
  const root = repo(), cfg = join(root, ".orly/config.json");
  writeFileSync(cfg, JSON.stringify({ checks: { nobad: { command: "sleep 2; test ! -f bad.txt" } } }));
  git(root, "commit", "-qam", "slow check");
  const t0 = Date.now();
  const gates = [0, 1].map(() => Bun.spawn(["bun", ORLY, "lane", "gate", "HEAD"], { cwd: root, env: { ...process.env, ...GIT, ORLY_GATE_SLOTS: "2" } }));
  expect(await Promise.all(gates.map((g) => g.exited))).toEqual([0, 0]);
  expect(Date.now() - t0).toBeLessThan(3900);
  expect(existsIn(root, ".orly/swarm/data/export/a.txt") && existsIn(root, ".orly/swarm/data/export-1/a.txt")).toBe(true);
});

test("a seated sitter answers to its own seat's specs only; the host and a seat without specs as said", async () => {
  const { seatSpecGroup } = await import("../orly.ts");
  const root = repo(), host = livePid();
  expect(names(root, host)).toEqual(["director", "work-1"]);
  const as = (name: string) => { const t = join(root, `${name}.jsonl`); writeFileSync(t, JSON.stringify({ type: "user", agentName: name }) + "\n"); return t; };
  expect(seatSpecGroup(root, as("work-1"))).toBe("work");
  expect(seatSpecGroup(root)).toBeUndefined();
});
