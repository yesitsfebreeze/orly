#!/usr/bin/env bun
/**
 * Claude Code adapter — the only file in this plugin that knows what Claude Code is.
 *
 * It maps Claude Code's Stop hook to the portable gate: read the hook payload, turn the
 * session transcript into a `Turn`, ask the judge, and translate the verdict back into
 * the hook's own JSON. Porting the gate to another agent means writing a file this size.
 *
 * Everything here that is not translation is defence: every failure path ends in "let
 * the agent stop", because a judge that is down must not become a wall.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkBaseline, refusal } from "../src/guard.ts";
import { messagesFrom } from "./claude-transcript.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, judge, type Turn } from "../src/gate.ts";
import { normalizeLastTurn } from "../src/normalize.ts";
import { combine, fileEnricher } from "../src/enrich.ts";
import { append as logVerdict } from "../src/log.ts";
import { kernMemoryEnricher } from "../src/enrich-kern.ts";
import { checkEnricher } from "../src/enrich-checks.ts";
import {
  advance,
  DEFAULT_MAX_ROUNDS,
  findOrlyDir,
  loadConfig,
  loadSpecFile,
  projectRoot,
  readRounds,
  writeRounds,
} from "../src/session.ts";
import { unmet } from "../src/specs.ts";

/** Stop can fire before the turn's closing message reaches the transcript. */
const FLUSH_TRIES = Number(process.env.ORLY_FLUSH_TRIES ?? 12);
const FLUSH_WAIT_MS = Number(process.env.ORLY_FLUSH_WAIT_MS ?? 150);

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Every error path lands here. */
function allow(note?: string): never {
  if (note) console.error(`orly: ${note}`);
  process.exit(0);
}


const raw = await new Response(Bun.stdin.stream()).text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  allow("could not parse hook input");
}

const specFile = loadSpecFile(input.cwd ?? process.cwd());
const specs = specFile?.specs ?? [];

// Before judging anything, check the gate itself has not been filed down this turn.
// A spec file rewritten through a shell command never passes the PreToolUse guard.
const guardDir = findOrlyDir(input.cwd ?? process.cwd());
if (guardDir && specs.length) {
  const basePath = join(guardDir, "baseline.json");
  let baseline: any = null;
  try {
    baseline = JSON.parse(readFileSync(basePath, "utf8"));
  } catch {
    /* first run here: whatever is on disk now becomes the baseline */
  }
  const { violations, nextBaseline } = checkBaseline(
    baseline,
    { goal: specFile?.goal, specs },
    DEFAULTS.specMet,
  );
  if (violations.length) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: refusal(violations),
        systemMessage: `orly ⛔ the spec file was weakened (${violations.map((v) => v.id).join(", ")})`,
      }),
    );
    process.exit(0);
  }
  try {
    writeFileSync(basePath, JSON.stringify(nextBaseline, null, 2));
  } catch {
    /* an unwritable .orly only costs the backstop, not the judgment */
  }
}

// Without goal specs the gate has only the built-in hazards, and those are a one-shot
// sanity check: block once, let the agent answer, done. Claude Code sets stop_hook_active
// while the agent is already working off a previous block, so this caps the chain at one.
//
// With specs there is something concrete to converge on, so the loop is allowed to run —
// but bounded by the round cap and stall detection in session.ts, never by the model.
if (input.stop_hook_active && !specs.length) allow();

/**
 * Key resolution, host-side.
 *
 * The library reads `TYPESAFE_API_KEY` and nothing else on purpose — a component that
 * decides *which* credential to authenticate as is a component that will silently pick the
 * wrong one. But a hook does not inherit an interactive shell's environment, so the host
 * needs some way to supply it without a plaintext key sitting in a settings file.
 *
 * `.orly/config.json` may name one command to produce it. The command is configuration the
 * user wrote, not a search the plugin performs, and the secret stays wherever it already
 * lives.
 */
function resolveKey(cwd: string): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const command = (() => {
    if (process.env.ORLY_KEY_COMMAND) return process.env.ORLY_KEY_COMMAND;
    try {
      const orlyDir = findOrlyDir(cwd);
      if (!orlyDir) return undefined;
      return JSON.parse(readFileSync(join(orlyDir, "config.json"), "utf8"))?.keyCommand;
    } catch {
      return undefined;
    }
  })();
  if (typeof command !== "string" || !command.trim()) return undefined;
  try {
    const out = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", stderr: "ignore" });
    const value = out.stdout.toString().trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

const key = resolveKey(input.cwd ?? process.cwd());
if (!key) {
  // Say this once per session. A gate that disables itself quietly looks installed and
  // never fires, and nobody goes looking for a hook that never errors.
  const marker = join(tmpdir(), `orly-nokey-${input.session_id ?? "unknown"}`);
  if (!existsSync(marker)) {
    try {
      writeFileSync(marker, "");
    } catch {
      /* an unwritable tmpdir only costs us the once-per-session part */
    }
    console.log(
      JSON.stringify({
        systemMessage:
          "orly? is disabled: no TypeSafe key. Set TYPESAFE_API_KEY, or put {\"keyCommand\": \"…\"} in .orly/config.json.",
      }),
    );
  }
  process.exit(0);
}

const read = async (): Promise<Turn | null> => {
  try {
    return normalizeLastTurn(messagesFrom(await Bun.file(input.transcript_path).text()));
  } catch {
    return null;
  }
};

let turn = await read();
if (!turn) allow("transcript unreadable");

// Stop fires before Claude Code has flushed the turn's closing message. Judged then, a
// finished turn scores "nothing was reported" — because nothing has been, yet. Wait for
// the agent to have spoken after its last action.
let waited = 0;
for (let i = 0; i < FLUSH_TRIES && !turn!.conclusive && turn!.actions_taken.length; i++) {
  await Bun.sleep(FLUSH_WAIT_MS);
  waited += FLUSH_WAIT_MS;
  turn = (await read()) ?? turn;
}

if (!turn!.user_request) allow();
if (!turn!.actions_taken.length && !turn!.assistant_said) allow();
// A turn whose conclusion never arrived is a turn we have no business judging.
if (!turn!.conclusive) allow("closing message never reached the transcript");

let result;
try {
  result = await judge(turn!, {
    apiKey: key,
    specs,
    // Independent evidence: the files the specs point at, read now rather than taken from
    // what the agent printed, plus whatever this project's own kern knows about the goal.
    // Both are optional and both fail quietly.
    enrich: combine(
      fileEnricher(projectRoot(input.cwd ?? process.cwd()) ?? input.cwd ?? process.cwd(), (path) =>
        Bun.file(path).text(),
      ),
      kernMemoryEnricher(specFile?.goal ?? "", input.cwd),
      // Facts from the project's own tooling. Anything a command can decide belongs here
      // and is asserted in code, never handed to the model.
      // From the project root, never cwd: a check command is written relative to the
      // project, and an agent's cwd moves. Run from a subdirectory, `cd orly && …` fails
      // and the shell's error message — which contains a newline — gets counted by
      // countPattern as a real violation. A broken check that reports a plausible number
      // is worse than one that errors.
      checkEnricher(
        loadConfig(input.cwd ?? process.cwd()).checks ?? {},
        projectRoot(input.cwd ?? process.cwd()) ?? input.cwd ?? process.cwd(),
      ),
    ),
    endpoint: process.env.TYPESAFE_BASE_URL,
    model: process.env.ORLY_MODEL,
    timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
    thresholds: {
      hazard: num("ORLY_HAZARD", DEFAULTS.hazard),
      specMet: num("ORLY_SPEC_MET", DEFAULTS.specMet),
      minCoverage: num("ORLY_MIN_COVERAGE", DEFAULTS.minCoverage),
      minCoverageConfidence: num("ORLY_MIN_CONFIDENCE", DEFAULTS.minCoverageConfidence),
      minActionProbability: num("ORLY_MIN_ACTION_P", DEFAULTS.minActionProbability),
    },
  });
} catch (e: any) {
  allow(`judge unavailable (${e?.message ?? e})`);
}

const { verdict, answers, usage } = result!;

// Record the judgment before acting on it. Without a log there is nothing to fit a cut
// against but fixtures somebody imagined, and the gate can never get better than the day
// it was written.
const orlyDir = findOrlyDir(input.cwd ?? process.cwd());
if (orlyDir) {
  const scores: Record<string, number> = {};
  for (const [id, a] of Object.entries<any>(answers)) {
    const v = typeof a?.noul === "number" ? a.noul : typeof a?.score === "number" ? a.score : undefined;
    if (typeof v === "number") scores[id] = Number(v.toFixed(3));
  }
  // The results the verdict used, evidence and all. Re-scoring here would drop it and
  // log every deterministic check as unmet.
  const scored = verdict.results;
  logVerdict(orlyDir, {
    at: new Date().toISOString(),
    session: String(input.session_id ?? "unknown"),
    goal: specFile?.goal,
    blocked: verdict.block,
    scores,
    unmet: scored.filter((r) => !r.met && !r.spec.optional).map((r) => `spec:${r.spec.id}`),
    hazards: ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"].filter(
      (h) => (scores[h] ?? 0) >= num("ORLY_HAZARD", DEFAULTS.hazard),
    ),
    actions: turn!.actions_taken.length,
    results: turn!.command_results.length,
  });
}

// Loop control: only ever loosens the verdict, never tightens it.
let loopNote: string | undefined;
if (verdict.block && specs.length) {
  const met = verdict.results.filter((r) => r.met).length;
  const decision = advance(
    readRounds(tmpdir(), input.session_id ?? "unknown"),
    specFile!.goal ?? "",
    met,
    specFile!.maxRounds ?? DEFAULT_MAX_ROUNDS,
  );
  writeRounds(tmpdir(), input.session_id ?? "unknown", decision.next);
  if (!decision.mayBlock) {
    console.log(
      JSON.stringify({
        systemMessage: `${verdict.line} · ${decision.note} · ${unmet(verdict.results).length} spec(s) still unmet`,
      }),
    );
    process.exit(0);
  }
  loopNote = ` · round ${decision.next.rounds}`;
}

const line =
  verdict.line +
  (usage ? ` · ${usage.input_tokens}+${usage.output_tokens} tok` : "") +
  (waited ? ` · waited ${waited}ms for flush` : "") +
  (loopNote ?? "");

console.log(
  JSON.stringify(
    verdict.block
      ? { decision: "block", reason: verdict.reason, systemMessage: line }
      : { systemMessage: line },
  ),
);
process.exit(0);
