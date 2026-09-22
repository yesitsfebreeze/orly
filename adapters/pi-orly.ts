import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkBaseline, refusal } from "../src/guard.ts";
import { findOrlyDir, loadSpecFile, resolveKey } from "../src/session.ts";

const FLUSH_TRIES = Number(process.env.PI_FLUSH_TRIES ?? 12);
const FLUSH_WAIT_MS = Number(process.env.PI_FLUSH_WAIT_MS ?? 150);

const OWL_PREFF_01 = ` , .`  // first line [rints here up ro padding
const OWL_PREFF_02 = `{@,@}` // second line [rints here up to padding
const OWL_PREFF_03 = `/) )`  // ... and so on, rest ussed padding
const OWL_PREFF_04 = ` '"`;  // first line [rints here
const OWL_PAD = 7; // indent where the text starts
const OWL_MARGIN = 3; // left margin for the complete status bar

const BLOCKED = "[X]";
const PASSED = "[O]";

/**
 * One verdict, four status-bar lines.
 *
 * The CLI already joins every judgment into one `line` — verdict, specs met, coverage,
 * the next step and any hazard that fired — separated by " · ". Spreading that across
 * four rows puts an overview on the screen instead of a wall of text after every turn,
 * while the owl prefix stays on the left of each row exactly as it was drawn.
 */
function statusBar(verdict: { block: boolean; line: string }): string[] {
  const parts = verdict.line.split(" · ");
  const label = verdict.block ? "BLOCK" : "PASS";
  const info = parts.slice(1);
  let specs = "";
  let coverage = "";
  let next = "";
  const hazards: string[] = [];
  for (const p of info) {
    if (p.startsWith("specs ")) specs = p;
    else if (p.startsWith("coverage ")) coverage = p;
    else if (p.startsWith("next=")) next = p;
    else hazards.push(p);
  }
  return [`${label} · ${specs}`, coverage, next, hazards.join(" · ")];
}

function owlBlock(lines: string[]): string {
  const margin = " ".repeat(OWL_MARGIN);
  return [
    margin + OWL_PREFF_01.padEnd(OWL_PAD) + lines[0],
    margin + OWL_PREFF_02.padEnd(OWL_PAD) + lines[1],
    margin + OWL_PREFF_03.padEnd(OWL_PAD) + lines[2],
    margin + OWL_PREFF_04.padEnd(OWL_PAD) + lines[3],
  ].join("\n");
}

function allow(note?: string): never {
  if (note) console.error(`pi-orly: ${note}`);
  throw new Error(note ?? "");
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", async (event, ctx) => {
    // Simple baseline check
    const specFile = loadSpecFile(ctx.cwd);
    const specs = specFile?.specs ?? [];
    const guardDir = findOrlyDir(ctx.cwd);
    if (guardDir && specs.length) {
      const basePath = join(guardDir, "baseline.json");
      let baseline: any = null;
      try {
        baseline = JSON.parse(readFileSync(basePath, "utf8"));
      } catch {
        /* first run: current state becomes baseline */
      }
      const { violations, nextBaseline } = checkBaseline(
        baseline,
        { goal: specFile?.goal ?? "", specs },
        { specMet: 0.8 },
      );
      if (violations.length) {
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "orly-verdict",
              content: owlBlock([
            `${BLOCKED} spec file weakened (${violations.map((v) => v.id).join(", ")})`,
            "",
            "",
            "",
          ]),
              display: true,
            },
          ],
          continue: true,
        };
      }
      try {
        writeFileSync(basePath, JSON.stringify(nextBaseline, null, 2));
      } catch {
        /* non-writable .orly only costs backstop */
      }
    }

    // No API key? skip
    const key = resolveKey(ctx.cwd);
    if (!key) {
      const marker = join(tmpdir(), `pi-orly-nokey-${ctx.sessionManager.getSessionId() ?? "unknown"}`);
      if (!existsSync(marker)) {
        try {
          writeFileSync(marker, "");
        } catch {
          /* unwritable tmpdir only costs once-per-session part */
        }
        ctx.ui.notify("orly? is disabled: no TypeSafe key.", "info");
      }
      return {};
    }

    // Build Pi's turn from entries
    const userMsg = event.message?.content ?? "";
    const toolResults = event.toolResults?.map((tr) => tr.content).join("\n") ?? "";
    const turnText = `user: ${userMsg}\ntool results: ${toolResults}`;

    // Call the orly CLI
    const orlyCli = join(__dirname, "../../bin/orly");
    const result = await Bun.spawn([orlyCli, "judge"], {
      cwd: ctx.cwd,
      input: JSON.stringify({ transcript: turnText, cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId() ?? "unknown" }),
      env: { ...process.env, TYPESAFE_API_KEY: key },
      stdout: "pipe",
      stderr: "pipe",
    }).finished;

    let verdict;
    try {
      verdict = JSON.parse(await result.stdout.text());
    } catch {
      return {};
    }

    // Return verdict as an owl status bar, not a per-message verdict.
    const content = owlBlock(statusBar(verdict));

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "orly-verdict",
          content,
          display: true,
        },
      ],
      continue: verdict.block ?? false,
    };
  });
}