#!/usr/bin/env bun
/**
 * orly — a guard check for coding agents. The agent turns the user's request into guards: one
 * yes/no question each about the finished work, decided by a shell command where one can. At
 * every stop the open guards are judged against the recorded turn; an unmet guard refuses the
 * stop and the agent keeps working until every guard is upheld. Guards live per session under
 * ~/.orly/sessions and die with it. Everything fails open.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------- the turn, reduced
export const MAX_RESULTS = 12;
export const MAX_ACTIONS = 40;

export type Turn = {
  user_request: string;
  assistant_final_message: string;
  assistant_said: string;
  actions_taken: string[];
  command_results: string[];
  conclusive: boolean;
};

export type Msg = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; name?: string }> };

const FAILURE = /\b(fail(?:ed|ure|s|ing)?|errors?|err!|exit (?:code|status) [1-9]|traceback|panic(?:ked)?|not found|cannot find|denied|refused|timed out|assertion)\b/i;
const EVIDENCE = /\b(pass(?:e[sd]|ing)?|ok|green|succe\w+|exit|done|\d+ (?:tests?|specs?))\b|✓|✗/i;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…[${s.length - n} more chars]`);

export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
      : "";

const hasToolResult = (content: unknown) => Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");

/** One readable line per tool call: the name plus whatever field names its target. */
export function describeCall(name: string, input: any): string {
  let p = input;
  if (typeof input === "string") {
    try { p = JSON.parse(input); } catch { p = { value: input }; }
  }
  const t = p?.command ?? p?.file_path ?? p?.path ?? p?.pattern ?? p?.url ?? p?.query ?? p?.description ?? p?.value ?? (p === undefined ? "" : JSON.stringify(p));
  return clip(`${name}: ${String(t).replace(/\s+/g, " ")}`, 300);
}

/** Failures first (up to half the budget), the rest from the tail: a blind tail drops early failures. */
export function selectResults(results: string[], max = MAX_RESULTS): string[] {
  if (results.length <= max) return results;
  const keep = new Set<number>();
  for (let i = 0; i < results.length && keep.size < Math.floor(max / 2); i++) if (FAILURE.test(results[i])) keep.add(i);
  for (let i = results.length - 1; i >= 0 && keep.size < max; i--) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => results[i]);
}

/** Results share one budget: short ones whole, each long one its head, its tail, and the lines between that carry evidence. */
export function fitResults(results: string[], budget = MAX_RESULTS * 600): string[] {
  let left = budget;
  let n = results.length;
  let cap = Infinity;
  for (const len of results.map((r) => r.length).sort((a, b) => a - b)) {
    if (len * n > left) { cap = Math.floor(left / n); break; }
    left -= len;
    n--;
  }
  return results.map((r) => {
    if (r.length <= cap) return r;
    const hits: [number, string][] = [];
    let at = cap >> 2;
    let used = 0;
    for (const l of r.slice(at, -at).split("\n")) {
      const c = clip(l.trim(), 200);
      if (used < cap / 2 && (FAILURE.test(l) || EVIDENCE.test(l))) {
        hits.push([at, c]);
        used += c.length + 1;
      }
      at += l.length + 1;
    }
    const q = Math.floor((cap - used) / 2);
    const kept = hits.filter(([i]) => i >= q && i < r.length - q).map(([, c]) => c);
    return `${r.slice(0, q)}…[cut: only lines carrying evidence kept]\n${kept.join("\n")}\n…${r.slice(-q)}`;
  });
}

/** Reduce one turn's messages, starting at the human request, to a `Turn`. */
export function normalize(messages: Msg[]): Turn {
  const said: string[] = [];
  const actions: string[] = [];
  const results: string[] = [];
  const ids = new Map<string, number>();
  const answered = new Set<number>();
  let lastActionAt = -1;
  let lastTextAt = -1;
  const act = (d: string, id: unknown, step: number) => {
    actions.push(`#${actions.length + 1} ${d}`);
    lastActionAt = step;
    if (id) ids.set(String(id), actions.length);
  };
  const result = (body: string, id: unknown, step: number) => {
    let n = ids.get(String(id)) ?? 1;
    while (!ids.has(String(id)) && answered.has(n)) n++;
    answered.add(n);
    lastActionAt = step;
    results.push(`#${n} → ${body.trim().replace(/\n{3,}/g, "\n\n") || "(no output)"}`);
  };
  messages.slice(1).forEach((m, step) => {
    if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) (said.push(text), (lastTextAt = step));
      for (const b of Array.isArray(m.content) ? (m.content as any[]) : []) if (b?.type === "tool_use") act(describeCall(b.name, b.input), b.id, step);
      for (const c of m.tool_calls ?? []) act(describeCall(c.function?.name ?? c.name ?? "tool", c.function?.arguments), c.id, step);
    } else if (m.role === "tool") result(textOf(m.content), m.tool_call_id, step);
    else if (hasToolResult(m.content))
      for (const b of m.content as any[]) if (b?.type === "tool_result") result(typeof b.content === "string" ? b.content : textOf(b.content), b.tool_use_id, step);
  });
  return {
    user_request: clip(textOf(messages[0]?.content).trim(), 4000),
    assistant_final_message: clip(said.at(-1) ?? "", 4000),
    assistant_said: clip(said.join("\n\n"), 8000),
    actions_taken: actions.slice(-MAX_ACTIONS),
    command_results: fitResults(selectResults(results)),
    conclusive: lastTextAt > lastActionAt,
  };
}

/** The gate's own block message, which a host may feed back as a user message; never the request. */
export const isInjectedReason = (text: string) => /^(Stop hook feedback:\s*)?orly: guards? not upheld/.test(text);
const human = (m: Msg) => m.role === "user" && !hasToolResult(m.content);

/** Split at the last genuine human message and normalise that turn; `closing` stands in for a closing
 *  message the transcript lags (a host passes the final assistant text with the stop event). */
export function normalizeLastTurn(messages: Msg[], closing?: string): Turn {
  const lag = closing?.trim() ? normalizeLastTurn(messages) : null;
  if (lag && (!lag.conclusive || lag.assistant_final_message !== clip(closing!.trim(), 4000))) messages = [...messages, { role: "assistant", content: closing }];
  const start = messages.findLastIndex((m) => human(m) && textOf(m.content).trim() && !isInjectedReason(textOf(m.content).trim()));
  return normalize(messages.slice(Math.max(0, start)).filter((m) => !human(m) || !isInjectedReason(textOf(m.content).trim())));
}

/** A Claude Code JSONL transcript as messages: sidechain and meta events dropped. */
export function messagesFrom(jsonl: string): Msg[] {
  const out: Msg[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (!e?.isSidechain && !e?.isMeta && (e?.type === "user" || e?.type === "assistant")) out.push({ role: e.type, content: e.message?.content });
    } catch { /* blank or half-written line */ }
  }
  return out;
}

// ---------------------------------------------------------------- guards, per session
export type Guard = {
  id: string;
  question: string;
  /** A shell command that decides the guard: exit 0 is upheld. Never retired, so a regression reopens it. */
  check?: string;
  /** Files whose current content the judge sees, relative to the project. */
  files?: string[];
  /** The stop at which a judged guard was first upheld; a judged guard is then retired. */
  met?: number;
  /** The last check's exit code and output tail, for the brief. */
  last?: { exit: number | null; out: string };
};
export type Session = { id: string; stops: number; guards: Guard[]; round: number; bestMet: number; stalled: number; nokeyTold?: boolean };

export const DEFAULT_MAX_ROUNDS = 6;
export const STALL_ROUNDS = 2;
export const GUARD_MET = 0.7;
export const NO_KEY_MESSAGE =
  "orly runs only guards with a --check: no TypeSafe key for the judge. Set TYPESAFE_API_KEY, or put {\"keyCommand\": \"…\"} in ~/.orly/config.json.";

const home = () => process.env.HOME || homedir();
export const sessionsDir = () => join(home(), ".orly", "sessions");
export const sessionPath = (id: string) => join(sessionsDir(), `${id.replace(/[^\w.-]/g, "_")}.json`);

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? NaN);
  return Number.isFinite(n) ? n : fallback;
};

/** Write through a temp file and a rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function loadSession(id: string): Session {
  try {
    const s = JSON.parse(readFileSync(sessionPath(id), "utf8"));
    if (Array.isArray(s?.guards)) return { id, stops: 0, round: 0, bestMet: 0, stalled: 0, ...s };
  } catch { /* new session */ }
  return { id, stops: 0, guards: [], round: 0, bestMet: 0, stalled: 0 };
}
export const saveSession = (s: Session) => { try { writeAtomic(sessionPath(s.id), JSON.stringify(s)); } catch { /* temp state is a convenience */ } };
export function endSession(id: string): void { rmSync(sessionPath(id), { force: true }); }

const STOP = new Set("the and are for its any all not was has had did can does this that with from have into only when what which where there their then than them they were been will would should could about every each also file files project code line lines true false shown current real show shows after before still".split(" "));
/** An id from the question's first three telling words, unique within the session. */
export function guardId(question: string, taken: string[] = [], wanted?: string): string {
  const base = (wanted ?? (question.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).slice(0, 3).join("-")) || "guard";
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "guard";
  let id = slug;
  for (let n = 2; taken.includes(id); n++) id = `${slug}-${n}`;
  return id;
}

export const UNCHECKABLE = /\b(clean|elegant|readable|maintainable|idiomatic|well[- ](structured|designed|written)|good|nice|proper|appropriate|robust|scalable|performant|secure enough|best practice)\b/i;

/** Add one guard. Rejects a question the judge cannot decide; returns the guard. */
export function addGuard(s: Session, question: string, opts: { check?: string; files?: string[]; id?: string } = {}): Guard {
  const q = question.trim().replace(/\s+/g, " ");
  if (q.length < 15) throw new Error("a guard is one yes/no question of at least 15 characters");
  if (!opts.check && UNCHECKABLE.test(q.replace(/`[^`]*`/g, ""))) throw new Error(`taste words cannot be judged: ${q.replace(/`[^`]*`/g, "").match(UNCHECKABLE)![0]}`);
  if (opts.check !== undefined && !opts.check.trim()) throw new Error("--check needs a command");
  const g: Guard = { id: guardId(q, s.guards.map((x) => x.id), opts.id), question: q };
  if (opts.check?.trim()) g.check = opts.check.trim();
  if (opts.files?.length) g.files = opts.files;
  s.guards.push(g);
  return g;
}

export function dropGuard(s: Session, id: string): boolean {
  const n = s.guards.length;
  s.guards = s.guards.filter((g) => g.id !== id);
  return s.guards.length < n;
}

/** Guards the next stop has to decide: every check, and every judged guard not yet upheld. */
export const openGuards = (s: Session) => s.guards.filter((g) => g.check || g.met === undefined);

// ---------------------------------------------------------------- evidence
export type CheckResult = { exit: number | null; out: string };

/** One command through `sh -c`, captured, killed past `timeoutMs` (exit null). Never throws. */
export function runCheck(command: string, cwd: string, timeoutMs = num("ORLY_CHECK_TIMEOUT_MS", 60_000)): CheckResult {
  try {
    const r = Bun.spawnSync(["sh", "-c", command], { cwd, env: process.env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
    const out = (Buffer.from(r.stdout ?? []).toString() + Buffer.from(r.stderr ?? []).toString()).trim();
    const timedOut = r.exitCode === null || r.exitCode === undefined;
    return { exit: timedOut ? null : r.exitCode, out: (timedOut ? `[check killed after ${timeoutMs} ms]\n` : "") + out.slice(-600) };
  } catch (e: any) {
    return { exit: null, out: `[check could not run: ${e?.message ?? e}]` };
  }
}

/** Current content of the files guards name; a missing file says so, so a cut is never read as absence. */
export function readFiles(paths: string[], cwd: string, maxChars = num("ORLY_FILE_CHARS", 12_000)): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [...new Set(paths)]) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    try {
      const body = readFileSync(abs, "utf8");
      out[p] = body.length <= maxChars ? body : `${body.slice(0, maxChars / 2)}\n…[${body.length - maxChars} chars not shown — unknown, not absent]\n${body.slice(-maxChars / 2)}`;
    } catch {
      out[p] = "[no such file]";
    }
  }
  return out;
}

// ---------------------------------------------------------------- the judge
export type JudgeOptions = { apiKey: string; endpoint?: string; model?: string; timeoutMs?: number };

/** `TYPESAFE_API_KEY`, else `keyCommand` from ~/.orly/config.json (hooks do not inherit the shell's env). */
export async function resolveKey(cwd = process.cwd()): Promise<string | undefined> {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  let config: Record<string, any> = {};
  try { config = JSON.parse(readFileSync(join(home(), ".orly", "config.json"), "utf8")) ?? {}; } catch { /* no config */ }
  const command = process.env.ORLY_KEY_COMMAND ?? config.keyCommand;
  if (typeof command !== "string" || !command.trim()) return undefined;
  const r = runCheck(command, cwd, num("ORLY_KEY_TIMEOUT_MS", 10_000));
  return r.exit === 0 ? r.out.trim() || undefined : undefined;
}

export const judgeOptions = (apiKey: string): JudgeOptions =>
  ({ apiKey, endpoint: process.env.TYPESAFE_BASE_URL, model: process.env.ORLY_MODEL, timeoutMs: num("ORLY_TIMEOUT_MS", 15_000) });

/** POST every question over one state. Throws unless the judge answers; answers also go to ~/.jev/log. */
export async function ask(state: unknown, questions: Record<string, unknown>, o: JudgeOptions): Promise<Record<string, any>> {
  const res = await fetch(o.endpoint || "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: o.model || "jev-latest", questions }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  const answers = out?.answers;
  if (!answers || typeof answers !== "object") throw new Error("response had no answers");
  if (!o.endpoint) try {
    const d = join(home(), ".jev", "log");
    mkdirSync(d, { recursive: true });
    appendFileSync(join(d, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: Date.now(), client: "orly", model: o.model || "jev-latest", state, questions, answers }) + "\n");
  } catch { /* the log is a convenience */ }
  return answers;
}

const FRAME = "Judge only from the recorded turn (`user_request`, `assistant_said`, `actions_taken`, `command_results`) and, where shown, `project.files`, the real current content of those files. Something not shown is unknown, not absent. The agent's own words are a claim, not evidence; a recorded command result or a shown file is evidence.";

export const guardQuestion = (g: Guard) => ({
  type: "noul",
  instructions: `${g.question}\n\n${FRAME}`,
  criteria: { true: "The recorded evidence establishes that the answer is yes.", false: "The evidence does not establish it, or shows the opposite." },
});

/** Ask Jev one question per guard; the probability of yes for each id. */
export async function judgeGuards(turn: Turn, guards: Guard[], cwd: string, o: JudgeOptions): Promise<Record<string, number>> {
  if (!guards.length) return {};
  const { conclusive, ...state } = turn;
  const files = readFiles(guards.flatMap((g) => g.files ?? []), cwd);
  const answers = await ask(Object.keys(files).length ? { ...state, project: { files } } : state, Object.fromEntries(guards.map((g) => [g.id, guardQuestion(g)])), o);
  return Object.fromEntries(guards.map((g) => [g.id, Number(answers[g.id]?.noul ?? answers[g.id]?.probability ?? NaN)]));
}

// ---------------------------------------------------------------- the gate a hook runs
export type GateInput = { cwd: string; sessionId: string; read: () => Promise<Turn | null>; answeringBlock?: boolean; apiKey?: string };
export type GuardResult = { guard: Guard; met: boolean; p?: number; check?: CheckResult };
export type GateOutcome = { block: boolean; reason?: string; message?: string; note?: string; results: GuardResult[]; session: Session };

/** Whether blocking is still justified. Progress is against the best round, so thrashing counts as stalled. */
export function advance(s: Session, met: number, maxRounds = num("ORLY_MAX_ROUNDS", DEFAULT_MAX_ROUNDS)): string | undefined {
  s.round += 1;
  s.stalled = met > s.bestMet ? 0 : s.stalled + 1;
  s.bestMet = Math.max(s.bestMet, met);
  if (s.round > maxRounds) return `round cap reached (${maxRounds}) — letting the turn end so the user can decide`;
  if (s.stalled > STALL_ROUNDS) return `no guard newly upheld in ${s.stalled} rounds — letting the turn end rather than looping`;
  return undefined;
}

export function blockReason(results: GuardResult[], s: Session): string {
  const open = results.filter((r) => !r.met);
  const lines = open.map((r) => {
    const how = r.check ? `check \`${r.guard.check}\` ${r.check.exit === null ? "did not finish" : `exited ${r.check.exit}`}` : `p=${(r.p ?? 0).toFixed(2)}`;
    const tail = r.check?.out ? `\n    ${r.check.out.split("\n").slice(-4).join("\n    ")}` : "";
    return `- ${r.guard.id} (${how}): ${r.guard.question}${tail}`;
  });
  const held = s.guards.filter((g) => !open.some((r) => r.guard.id === g.id)).map((g) => g.id);
  return [
    `orly: ${open.length === 1 ? "guard" : "guards"} not upheld this turn (${open.length} of ${s.guards.length}):`,
    ...lines,
    ...(held.length ? [`Upheld: ${held.join(", ")}.`] : []),
    "",
    "Finish the work these guards name, then stop again. A guard that cannot be met: say so to the user and name why; only the user drops a guard (`orly drop <id>`).",
  ].join("\n");
}

/** Run the gate on one stop. Never throws. No guards: nothing is judged. */
export async function gateTurn(input: GateInput): Promise<GateOutcome> {
  const { cwd, sessionId } = input;
  const s = loadSession(sessionId);
  const open = openGuards(s);
  const done = (o: Omit<GateOutcome, "session" | "results"> & { results?: GuardResult[] }): GateOutcome => { saveSession(s); return { results: [], ...o, session: s }; };
  if (!open.length) return done({ block: false });
  if (input.answeringBlock) return done({ block: false, note: "the turn answering a block is not judged again" });
  s.stops += 1;
  let turn: Turn | null = null;
  try { turn = await input.read(); } catch { /* no transcript */ }
  if (!turn) return done({ block: false, note: "no transcript to judge" });

  const results: GuardResult[] = [];
  for (const g of open.filter((g) => g.check)) {
    const check = runCheck(g.check!, cwd);
    g.last = check;
    results.push({ guard: g, met: check.exit === 0, check });
  }
  const judged = open.filter((g) => !g.check);
  if (judged.length) {
    const key = input.apiKey ?? (await resolveKey(cwd));
    if (!key) {
      const message = s.nokeyTold ? undefined : NO_KEY_MESSAGE;
      s.nokeyTold = true;
      return results.some((r) => !r.met)
        ? done({ block: true, reason: blockReason(results, s), message, results })
        : done({ block: false, message, results });
    }
    let ps: Record<string, number>;
    try { ps = await judgeGuards(turn, judged, cwd, judgeOptions(key)); } catch (e: any) {
      return done({ block: false, note: `judge unavailable (${e?.message ?? e})`, results });
    }
    for (const g of judged) {
      const p = ps[g.id];
      const met = Number.isFinite(p) && p >= num("ORLY_GUARD_MET", GUARD_MET);
      if (met) g.met = s.stops;
      results.push({ guard: g, met, p: Number.isFinite(p) ? p : 0 });
    }
  }
  const unmet = results.filter((r) => !r.met);
  if (!unmet.length) { s.round = 0; s.stalled = 0; return done({ block: false, results }); }
  const note = advance(s, s.guards.length - unmet.length);
  if (note) return done({ block: false, note: `${note} · ${unmet.length} guard(s) still open`, results });
  return done({ block: true, reason: blockReason(results, s), results });
}

export const guardState = (g: Guard) => (g.check ? (g.last ? (g.last.exit === 0 ? "upheld" : "FAILING") : "check") : g.met !== undefined ? "upheld" : "open");

/** What the agent is told on each prompt: the guards so far, and how to add one. */
export function promptBrief(s: Session, cli: string): string {
  const add = `${cli} guard --session ${s.id} "<one yes/no question about the finished work>" [--check "<shell command, exit 0 = upheld>"] [--file <path>]`;
  if (!s.guards.length)
    return [`orly: no guards yet. For a request that asks for work, add one guard per thing it must deliver before you start; a question or a one-line answer needs none:`, `  ${add}`].join("\n");
  return [
    `orly: guards for this session, every stop is checked against the open ones:`,
    ...s.guards.map((g) => `- ${g.id} [${guardState(g)}]: ${g.question}${g.check ? ` (\`${g.check}\`)` : ""}`),
    `Add one per new deliverable: ${add}`,
  ].join("\n");
}

// ---------------------------------------------------------------- the CLI
const HELP = `orly guard "<question>" [--check "<cmd>"] [--file <path>]…  add one guard to the session
orly guards                                                  list the session's guards
orly drop <id>                                               remove a guard (on the user's word only)
orly check                                                   {messages:[…]} or {turn:{…}} on stdin, judged against the session's guards; exit 2 = blocked
orly end                                                     forget the session

the session is --session <id>, else ORLY_SESSION, else CLAUDE_CODE_SESSION_ID
env: TYPESAFE_API_KEY or keyCommand in ~/.orly/config.json, TYPESAFE_BASE_URL, ORLY_MODEL, ORLY_TIMEOUT_MS,
     ORLY_CHECK_TIMEOUT_MS, ORLY_FILE_CHARS, ORLY_GUARD_MET, ORLY_MAX_ROUNDS`;

if (import.meta.main) {
  const argv = process.argv.slice(3);
  const command = process.argv[2] ?? "help";
  const fail = (msg: string): never => { console.error(`orly: ${msg}`); process.exit(1); };
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) (flags[argv[i].slice(2)] ??= []).push(argv[++i] ?? "");
    else positional.push(argv[i]);
  }
  if (command === "help" || command === "--help" || command === "-h") { console.log(HELP); process.exit(0); }
  const sessionId = flags.session?.[0] ?? process.env.ORLY_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID ?? fail("no session: pass --session <id> or set ORLY_SESSION");
  const s = loadSession(sessionId);
  const show = (g: Guard) => console.log(`${g.id.padEnd(28)} ${guardState(g).padEnd(7)} ${g.question}${g.check ? `  [${g.check}]` : ""}${g.files ? `  files: ${g.files.join(", ")}` : ""}`);

  if (command === "guard") {
    const question = positional.join(" ");
    if (!question.trim()) fail('usage: orly guard "<yes/no question>" [--check "<cmd>"] [--file <path>]');
    try {
      const g = addGuard(s, question, { check: flags.check?.[0], files: flags.file, id: flags.id?.[0] });
      saveSession(s);
      show(g);
      process.exit(0);
    } catch (e: any) { fail(e.message); }
  }
  if (command === "guards") {
    if (!s.guards.length) console.log("no guards in this session");
    s.guards.forEach(show);
    process.exit(0);
  }
  if (command === "drop") {
    const id = positional[0] ?? fail("usage: orly drop <id>");
    if (!dropGuard(s, id)) fail(`no guard "${id}"`);
    saveSession(s);
    console.log(`dropped ${id} · ${s.guards.length} left`);
    process.exit(0);
  }
  if (command === "end") { endSession(sessionId); process.exit(0); }
  if (command !== "check") fail(`unknown command "${command}" — try: orly help`);

  let input: { messages?: Msg[]; turn?: Turn };
  try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch { fail('stdin was not JSON: expected {"messages":[…]} or {"turn":{…}}'); }
  const t = input!.turn;
  if (t && (typeof t.user_request !== "string" || !Array.isArray(t.actions_taken) || !Array.isArray(t.command_results))) fail("turn needs user_request, assistant_final_message, assistant_said, actions_taken, command_results");
  if (!t && !input!.messages?.some((m) => m?.role === "user")) fail('expected {"messages":[…]} with a role:"user" entry, or {"turn":{…}}');
  const turn = t ?? normalizeLastTurn(input!.messages!);
  const outcome = await gateTurn({ cwd: process.cwd(), sessionId, read: async () => turn, answeringBlock: flags["answering-block"] !== undefined });
  if (outcome.note) console.error(`orly: ${outcome.note}`);
  if (outcome.message) console.error(outcome.message);
  const { session, ...rest } = outcome;
  console.log(JSON.stringify({ ...rest, results: rest.results.map((r) => ({ id: r.guard.id, met: r.met, p: r.p, exit: r.check?.exit })) }));
  process.exit(outcome.block ? 2 : 0);
}
