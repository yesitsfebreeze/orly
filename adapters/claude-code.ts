#!/usr/bin/env bun
/**
 * Claude Code Stop hook: reads the hook payload on stdin, turns the transcript into a
 * `Turn`, judges it and prints the verdict as hook JSON. Fails open: every error lets
 * the agent stop.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkBaseline, refusal } from "../src/guard.ts";
import { messagesFrom } from "./claude-transcript.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, judge, type Turn } from "../src/gate.ts";
import { normalizeLastTurn } from "../src/normalize.ts";
import { projectEvidence } from "../src/evidence.ts";
import { append as logVerdict } from "../src/log.ts";
import { saveTurn } from "../src/cases.ts";
import {
  advance,
  DEFAULT_MAX_ROUNDS,
  findOrlyDir,
  loadConfig,
  loadSpecFile,
  readRounds,
  resolveKey,
  writeRounds,
} from "../src/session.ts";
import { unmet } from "../src/specs.ts";
import { owlBlock, statusBar } from "../src/banner.ts";

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

// Block if specs weakened since the baseline: catches shell edits the PreToolUse guard never sees.
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
    { goal: specFile?.goal, specs, checks: loadConfig(input.cwd ?? process.cwd()).checks },
    DEFAULTS.specMet,
  );
  if (violations.length) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: refusal(violations),
        systemMessage: "\n" + owlBlock([`[X] spec file weakened (${violations.map((v) => v.id).join(", ")})`]),
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

// Without specs, block at most once (stop_hook_active = already answering a block).
// With specs, rounds are bounded by the cap and stall detection in session.ts.
if (input.stop_hook_active && !specs.length) allow();

const key = resolveKey(input.cwd ?? process.cwd());
if (!key) {
  // Warn once per session, so a disabled gate is not mistaken for a passing one.
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

// Stop can fire before the closing message is flushed; wait until the agent spoke after its last action.
let waited = 0;
for (let i = 0; i < FLUSH_TRIES && !turn!.conclusive && turn!.actions_taken.length; i++) {
  await Bun.sleep(FLUSH_WAIT_MS);
  waited += FLUSH_WAIT_MS;
  turn = (await read()) ?? turn;
}

if (!turn!.user_request) allow();
if (!turn!.actions_taken.length && !turn!.assistant_said) allow();
if (!turn!.conclusive) allow("closing message never reached the transcript");

// The evidence the judge saw, kept with the turn so a replay judges exactly this state.
const gather = projectEvidence({ cwd: input.cwd });
let seen: Record<string, unknown> | undefined;

let result;
try {
  result = await judge(turn!, {
    apiKey: key,
    specs,
    // Evidence read from disk, not from what the agent printed.
    enrich: async (t, s) => (seen = await gather(t, s)),
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

// Log the judgment before acting on it; `orly fit` fits cuts from this log.
const orlyDir = findOrlyDir(input.cwd ?? process.cwd());
if (orlyDir) {
  const scores: Record<string, number> = {};
  for (const [id, a] of Object.entries<any>(answers)) {
    const v = typeof a?.noul === "number" ? a.noul : typeof a?.score === "number" ? a.score : undefined;
    if (typeof v === "number") scores[id] = Number(v.toFixed(3));
  }
  // Use the verdict's results: re-scoring without evidence would log every deterministic check as unmet.
  const scored = verdict.results;
  const unmetIds = scored.filter((r) => !r.met && !r.spec.optional).map((r) => `spec:${r.spec.id}`);
  saveTurn(orlyDir, {
    at: new Date().toISOString(),
    session: String(input.session_id ?? "unknown"),
    turn: turn!,
    evidence: seen,
    blocked: verdict.block,
    unmet: unmetIds,
  });
  logVerdict(orlyDir, {
    at: new Date().toISOString(),
    session: String(input.session_id ?? "unknown"),
    goal: specFile?.goal,
    blocked: verdict.block,
    scores,
    unmet: unmetIds,
    hazards: ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"].filter(
      (h) => (scores[h] ?? 0) >= num("ORLY_HAZARD", DEFAULTS.hazard),
    ),
    actions: turn!.actions_taken.length,
    results: turn!.command_results.length,
    // Every threshold used, per-spec cuts included, so the record is self-explaining.
    thresholds: {
      hazard: num("ORLY_HAZARD", DEFAULTS.hazard),
      specMet: num("ORLY_SPEC_MET", DEFAULTS.specMet),
      minCoverage: num("ORLY_MIN_COVERAGE", DEFAULTS.minCoverage),
      ...Object.fromEntries(
        specs.filter((s) => typeof s.cut === "number").map((s) => [`spec:${s.id}`, s.cut as number]),
      ),
    },
  });
}

// Leading newline so the owl starts on its own row.
const banner = (l: string) => "\n" + owlBlock(statusBar({ block: verdict.block, line: l }));

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
        systemMessage: banner(`${verdict.line} · ${decision.note} · ${unmet(verdict.results).length} spec(s) still unmet`),
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
      ? { decision: "block", reason: verdict.reason, systemMessage: banner(line) }
      : { systemMessage: banner(line) },
  ),
);
process.exit(0);
