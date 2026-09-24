/**
 * The turn-end gate every host adapter runs. A host hands over where it stands, which
 * session this is and how to read the turn; this module does the rest — the weakening
 * backstop, the key, the flush wait, the judgment, the log, the round cap — and hands
 * back a host-neutral outcome the adapter renders in its own protocol.
 *
 * Fails open at every step: a judge that is down must not become a wall.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owlBlock, saveStatus, statusBar, statusFile } from "./banner.ts";
import { saveTurn } from "./cases.ts";
import { projectEvidence } from "./evidence.ts";
import { DEFAULTS, judge, type Thresholds, type Turn } from "./gate.ts";
import { checkBaseline, refusal } from "./guard.ts";
import { append as logVerdict } from "./log.ts";
import {
  advance,
  DEFAULT_MAX_ROUNDS,
  statePath,
  findOrlyDir,
  loadConfig,
  loadSpecFile,
  readRounds,
  resolveKey,
  writeRounds,
} from "./session.ts";
import { unmet } from "./specs.ts";

export const HAZARDS = ["unverified_claim", "placeholder_left", "unaddressed_part", "silent_failure"];

export const NO_KEY_MESSAGE =
  'orly? is disabled: no TypeSafe key. Set TYPESAFE_API_KEY, or put {"keyCommand": "…"} in .orly/config.json.';

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Every threshold from the environment, once, so hook and CLI cannot drift. */
export function thresholdsFromEnv(): Thresholds {
  return {
    hazard: num("ORLY_HAZARD", DEFAULTS.hazard),
    specMet: num("ORLY_SPEC_MET", DEFAULTS.specMet),
    minCoverage: num("ORLY_MIN_COVERAGE", DEFAULTS.minCoverage),
    minCoverageConfidence: num("ORLY_MIN_CONFIDENCE", DEFAULTS.minCoverageConfidence),
    minActionProbability: num("ORLY_MIN_ACTION_P", DEFAULTS.minActionProbability),
  };
}

export type GateInput = {
  /** Where the host is standing; `.orly` is found by walking up from here. */
  cwd: string;
  /** The host's session id: round counters and the once-per-session key warning key off it. */
  sessionId: string;
  /** Read the turn from wherever the host keeps it. Called again while waiting for the flush. */
  read: () => Promise<Turn | null>;
  /**
   * The host says this stop is already the answer to a previous block (Claude Code's
   * `stop_hook_active`). Without specs the gate then blocks at most once.
   */
  answeringBlock?: boolean;
  /** Poll `read` until the turn is conclusive. Off for hosts that hand over a finished turn. */
  flush?: boolean;
};

/**
 * What the adapter renders. `reason` goes back to the agent; `banner` and `message` are
 * for the human; `note` is a diagnostic the adapter may print to stderr.
 */
export type GateOutcome = {
  block: boolean;
  /** The gap, named, for the agent. Only when blocking. */
  reason?: string;
  /** The owl status bar, after a judgment. Starts on its own row. */
  banner?: string;
  /** A one-off notice for the human, e.g. the gate is disabled. */
  message?: string;
  /** Why the gate let the turn end without judging it. */
  note?: string;
};

const ALLOW = (note?: string): GateOutcome => (note ? { block: false, note } : { block: false });

/**
 * Delete this session's temp files when it ends; macOS does not reliably clean $TMPDIR,
 * so they would pile up one pair per session.
 */
export function endSession(sessionId: string): void {
  for (const f of [statePath(tmpdir(), sessionId), statusFile(tmpdir(), sessionId), join(tmpdir(), `orly-nokey-${sessionId}`)]) rmSync(f, { force: true });
}

/** Run the gate on one turn. Never throws. */
export async function gateTurn(input: GateInput): Promise<GateOutcome> {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.sessionId || "unknown";
  const specFile = loadSpecFile(cwd);
  const specs = specFile?.specs ?? [];
  const orlyDir = findOrlyDir(cwd);

  // Block if specs weakened since the baseline: catches shell edits the edit guard never sees.
  if (orlyDir && specs.length) {
    const basePath = join(orlyDir, "baseline.json");
    let baseline: any = null;
    try {
      baseline = JSON.parse(readFileSync(basePath, "utf8"));
    } catch {
      /* first run here: whatever is on disk now becomes the baseline */
    }
    const { violations, nextBaseline } = checkBaseline(
      baseline,
      { goal: specFile?.goal, specs, checks: loadConfig(cwd).checks },
      DEFAULTS.specMet,
    );
    if (violations.length) {
      const ids = violations.map((v) => v.id);
      saveStatus(tmpdir(), sessionId, { at: new Date().toISOString(), cwd, block: true, line: "orly ⛔ block · spec file weakened", unmet: ids.map((id) => ({ id, found: "weakened" })) });
      return {
        block: true,
        reason: refusal(violations),
        banner: "\n" + owlBlock([`[X] spec file weakened (${violations.map((v) => v.id).join(", ")})`]),
      };
    }
    try {
      writeFileSync(basePath, JSON.stringify(nextBaseline, null, 2));
    } catch {
      /* an unwritable .orly only costs the backstop, not the judgment */
    }
  }

  // Without specs, block at most once. With specs, rounds are bounded by the cap and stall detection.
  if (input.answeringBlock && !specs.length) return ALLOW();

  const key = resolveKey(cwd);
  if (!key) {
    // Warn once per session, so a disabled gate is not mistaken for a passing one.
    const marker = join(tmpdir(), `orly-nokey-${sessionId}`);
    if (existsSync(marker)) return ALLOW();
    try {
      writeFileSync(marker, "");
    } catch {
      /* an unwritable tmpdir only costs us the once-per-session part */
    }
    return { block: false, message: NO_KEY_MESSAGE };
  }

  let turn = await input.read();
  if (!turn) return ALLOW("transcript unreadable");

  // The host may fire before the closing message is flushed; wait until the agent spoke after its last action.
  let waited = 0;
  if (input.flush !== false) {
    const tries = num("ORLY_FLUSH_TRIES", 12);
    const waitMs = num("ORLY_FLUSH_WAIT_MS", 150);
    for (let i = 0; i < tries && !turn.conclusive && turn.actions_taken.length; i++) {
      await Bun.sleep(waitMs);
      waited += waitMs;
      turn = (await input.read()) ?? turn;
    }
  }

  if (!turn.user_request) return ALLOW();
  if (!turn.actions_taken.length && !turn.assistant_said) return ALLOW();
  if (!turn.conclusive) return ALLOW("closing message never reached the transcript");

  // The evidence the judge saw, kept with the turn so a replay judges exactly this state.
  const gather = projectEvidence({ cwd });
  let seen: Record<string, unknown> | undefined;
  const thresholds = thresholdsFromEnv();

  let result;
  try {
    result = await judge(turn, {
      apiKey: key,
      specs,
      // Evidence read from disk, not from what the agent printed.
      enrich: async (t, s) => (seen = await gather(t, s)),
      endpoint: process.env.TYPESAFE_BASE_URL,
      model: process.env.ORLY_MODEL,
      timeoutMs: num("ORLY_TIMEOUT_MS", 12_000),
      thresholds,
    });
  } catch (e: any) {
    return ALLOW(`judge unavailable (${e?.message ?? e})`);
  }

  const { verdict, answers, usage } = result;

  // Log the judgment before acting on it; `orly fit` fits cuts from this log.
  if (orlyDir) {
    const scores: Record<string, number> = {};
    for (const [id, a] of Object.entries<any>(answers)) {
      const v = typeof a?.noul === "number" ? a.noul : typeof a?.score === "number" ? a.score : undefined;
      if (typeof v === "number") scores[id] = Number(v.toFixed(3));
    }
    // Use the verdict's results: re-scoring without evidence would log every deterministic check as unmet.
    const unmetIds = verdict.results.filter((r) => !r.met && !r.spec.optional).map((r) => `spec:${r.spec.id}`);
    const at = new Date().toISOString();
    saveTurn(orlyDir, { at, session: sessionId, turn, evidence: seen, blocked: verdict.block, unmet: unmetIds });
    logVerdict(orlyDir, {
      at,
      session: sessionId,
      blocked: verdict.block,
      scores,
      unmet: unmetIds,
      hazards: HAZARDS.filter((h) => (scores[h] ?? 0) >= thresholds.hazard),
      actions: turn.actions_taken.length,
      results: turn.command_results.length,
      // Every threshold used, per-spec cuts included, so the record is self-explaining.
      thresholds: {
        hazard: thresholds.hazard,
        specMet: thresholds.specMet,
        minCoverage: thresholds.minCoverage,
        ...Object.fromEntries(
          specs.filter((s) => typeof s.cut === "number").map((s) => [`spec:${s.id}`, s.cut as number]),
        ),
      },
    });
  }

  // Leading newline so the owl starts on its own row.
  const banner = (l: string) => "\n" + owlBlock(statusBar({ block: verdict.block, line: l }));

  const status = (line: string, note?: string) =>
    saveStatus(tmpdir(), sessionId, {
      at: new Date().toISOString(),
      cwd,
      block: verdict.block && !note,
      line,
      note,
      unmet: unmet(verdict.results).map((r) => ({
        id: r.spec.id,
        found: r.spec.require ? `${JSON.stringify(r.actual)}, needs ${r.spec.require.op} ${String(r.spec.require.value ?? "")}` : `p=${r.p.toFixed(2)}`,
      })),
    });

  // Loop control: only ever loosens the verdict, never tightens it.
  let loopNote: string | undefined;
  if (verdict.block && specs.length) {
    const met = verdict.results.filter((r) => r.met).length;
    const decision = advance(
      readRounds(tmpdir(), sessionId),
      specFile!.goal ?? "",
      met,
      specFile!.maxRounds ?? DEFAULT_MAX_ROUNDS,
    );
    writeRounds(tmpdir(), sessionId, decision.next);
    if (!decision.mayBlock) {
      status(verdict.line, decision.note);
      return {
        block: false,
        banner: banner(`${verdict.line} · ${decision.note} · ${unmet(verdict.results).length} spec(s) still unmet`),
      };
    }
    loopNote = ` · round ${decision.next.rounds}`;
  }

  const line =
    verdict.line +
    (usage ? ` · ${usage.input_tokens}+${usage.output_tokens} tok` : "") +
    (waited ? ` · waited ${waited}ms for flush` : "") +
    (loopNote ?? "");

  status(line);
  return verdict.block
    ? { block: true, reason: verdict.reason, banner: banner(line) }
    : { block: false, banner: banner(line) };
}
