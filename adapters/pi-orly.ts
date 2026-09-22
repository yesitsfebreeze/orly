#!/usr/bin/env bun
/**
 * Pi extension adapter — the only file in this plugin that knows what Pi is.
 *
 * It wires Pi's turn_end event to the portable gate: read the hook payload,
 * turn the Pi session transcript into a `Turn`, ask the judge, and translate the
 * verdict back into the hook's own JSON. Same wiring as claude-code adapter.
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
import {
  advance,
  DEFAULT_MAX_ROUNDS,
  findOrlyDir,
  loadSpecFile,
  readRounds,
  resolveKey,
  writeRounds,
} from "../src/session.ts";
import { unmet } from "../src/specs.ts";

/** Pi turn_end fires after the assistant has completed its turn. */
const FLUSH_TRIES = Number(process.env.PI_FLUSH_TRIES ?? 12);
const FLUSH_WAIT_MS = Number(process.env.PI_FLUSH_WAIT_MS ?? 150);

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Every error path lands here. */
function allow(note?: string): never {
  if (note) console.error(`pi-orly: ${note}`);
  process.exit(0);
}

/**
 * Parse Pi's turn_end JSONL transcript.
 *
 * Pi sends a JSONL file (similar to Claude Code) with events per line.
 * We filter out sidechain notices and meta markers, then collect user/assistant
 * messages — the same filtering as claude-code.ts.
 */
export function messagesFrom(jsonl: string): Message[] {
  const out: Message[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // half-written line tells us nothing
    }
    // Skip sidechain notices (internal Pi diagnostics)
    if (e?.isSidechain === true) continue;
    // Skip meta markers (hook internal comments)
    if (e?.isMeta === true) continue;
    // Only user and assistant messages belong in the turn
    if (e?.type === "user" || e?.type === "assistant") {
      out.push({ role: e.type, content: e.message?.content });
    }
  }
  return out;
}

/**
 * Build a Pi turn from the transcript.
 * Mirrors claude-code.ts: read the last turn, ensure it has a user request,
 * then call judge with the same parameters.
 */
async function buildTurn(): Promise<Turn | null> {
  try {
    return normalizeLastTurn(messagesFrom(await Bun.file("/tmp/pi-transcript.jsonl").text()));
  } catch {
    return null;
  }
}

/**
 * Main entry point called by Pi's turn_end handler.
 * Wires Pi's turn_end -> gate judge -> verdict -> log.
 */
async function handleTurnEnd(): void {
  const turn = await buildTurn();
  if (!turn) {
    allow("turn could not be built");
    return;
  }

  // Stop fires before the turn's closing message reaches the transcript.
  // Judge then, a finished turn scores "nothing was reported" — because nothing has been, yet.
  let waited = 0;
  for (let i = 0; i < FLUSH_TRIES && !turn.conclusive && turn.actions_taken.length; i++) {
    await Bun.sleep(FLUSH_WAIT_MS);
    waited += FLUSH_WAIT_MS;
    turn = (await read()) ?? turn;
  }

  if (!turn.user_request) allow("closing message never reached the transcript");
  if (!turn.actions_taken.length && !turn.assistant_said) allow();
  if (!turn.conclusive) allow("closing message never reached the transcript");

  // Call the judge with the same parameters as claude-code adapter
  try {
    const result = await judge(
      turn,
      {
        apiKey: resolveKey(),
        specs: [], // specs come from .orly/specs.json if present
        enrich: projectEvidence({ cwd: "/"),
        endpoint: process.env.TIPService_BASE_URL,
        model: process.env.ORLY_MODEL,
        timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
        thresholds: {
          hazard: num("ORLY_HAZARD", DEFAULTS.hazard),
          specMet: num("ORLY_SPEC_MET", DEFAULTS.specMet),
          minCoverage: num("ORLY_MIN_COVERAGE", DEFAULTS.minCoverage),
          minCoverageConfidence: num("ORLY_MIN_CONFIDENCE", DEFAULTS.minCoverageConfidence),
          minActionProbability: num("ORLY_MIN_ACTION_P", DEFAULTS.minActionProbability),
        },
      },
    );
  } catch (e: any) {
    allow(`judge unavailable (${e?.message ?? e})`);
  }

  const { verdict, answers, usage } = result!;

  // Log verdict with owl marker (same format as claude-code adapter)
  const orlyDir = findOrlyDir();
  if (orlyDir) {
    const scores: Record<string, number> = {};
    for (const [id, a] of Object.entries(answers)) {
      const v = typeof a?.noul === "number" ? a.noul : typeof a?.score === "number" ? a.score : undefined;
      if (typeof v === "number") scores[id] = Number(v.toFixed(3));
    }
    logVerdict(orlyDir, {
      at: new Date().toISOString(),
      session: "/",
      goal: "",
      blocked: verdict.block,
      scores,
      unmet: scores.filter((r) => !r.met && !r.spec.optional).map((r) => `spec:${r.spec.id}`),
      hazards: ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"].filter(
        (h) => (scores[h] ?? 0) >= num("ORLY_HAZARD", DEFAULTS.hazard),
      ),
      actions: turn.actions_taken.length,
      results: turn.command_results.length,
    });
  }

  // Loop control: only ever loosens the verdict, never tightens it.
  if (verdict.block && specs.length) {
    const met = verdict.results.filter((r) => r.met).length;
    const decision = advance(
      readRounds(orlyDir, "/"),
      "",
      met,
      "",
    );
    writeRounds(orlyDir, "/", decision.next);
    if (!decision.mayBlock) {
      console.log(
        JSON.stringify({
          systemMessage: `${verdict.line} · ${decision.note} · ${unmet(verdict.results).length} spec(s) still unmet`,
        }),
      );
      process.exit(0);
    }
    // In Pi, we typically just finish the turn; no further rounds.
  }

  const line =
    verdict.line +
    (usage ? ` · ${usage.input_tokens}+${usage.output_tokens} tok` : "") +
    (waited ? ` · waited ${waited}ms for flush` : "") +
    (verdict.block && !decision.mayBlock ? " · block" : "");

  console.log(
    JSON.stringify(
      verdict.block
        ? { decision: "block", reason: verdict.reason, systemMessage: line }
        : { systemMessage: line },
    ),
  );
}
