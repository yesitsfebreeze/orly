import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkBaseline, refusal } from "../src/guard.ts";
import { findOrlyDir, loadSpecFile, resolveKey } from "../src/session.ts";
import { BLOCKED, owlBlock, statusBar } from "../src/banner.ts";

const FLUSH_TRIES = Number(process.env.PI_FLUSH_TRIES ?? 12);
const FLUSH_WAIT_MS = Number(process.env.PI_FLUSH_WAIT_MS ?? 150);

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