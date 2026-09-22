import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "bin", "orly.ts");

/** Convert Pi turn_end entries into the message shape orly's CLI expects. */
function messagesFromEntries(entries: any[]): any[] | null {
  const messages: any[] = [];
  for (const e of entries) {
    if (e.type === "user" && e.content) {
      const content = Array.isArray(e.content)
        ? e.content.map((c: any) => (c.type === "text" ? c.text : c)).filter(Boolean)
        : e.content;
      messages.push({ role: "user", content });
    } else if (e.type === "assistant" && e.content) {
      const content = Array.isArray(e.content)
        ? e.content
            .map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "tool_use") return { id: c.toolUseId, name: c.name, input: c.input };
              if (c.type === "tool_result") return { tool_use_id: c.toolUseId, content: c.content };
              return null;
            })
            .filter(Boolean)
        : e.content;
      messages.push({ role: "assistant", content });
    }
  }
  return messages.length ? messages : null;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("orly", {
    description: "Turn a goal into checkable specs (orly gate)",
    handler: async (args, ctx) => {
      const specFile = join(ctx.cwd ?? process.cwd(), ".orly", "specs.json");
      // Write specs when /orly <goal> given; here we just confirm load
      ctx.ui.notify("orly loaded — use /orly <goal> to write .orly/specs.json", "info");
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    const messages = messagesFromEntries(event.entries);
    if (!messages) return {};

    const input = JSON.stringify({ messages });
    const script = process.env.ORLY_SCRIPT ?? CLI;
    const result = spawnSync("bun", [script, "judge"], {
      input,
      cwd: ctx.cwd ?? process.cwd(),
      env: { ...process.env },
      maxBuffer: 64 * 1024,
    });

    const out = result.stdout?.toString() ?? "";
    const err = result.stderr?.toString() ?? "";

    if (result.exitCode === 1) {
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "orly-verdict",
            content: err || "orly? is disabled — check configuration",
            display: true,
          },
        ],
        continue: false,
      };
    }

    let verdict: any;
    try {
      verdict = JSON.parse(out);
    } catch {
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "orly-verdict",
            content: "orly? could not parse the judge output",
            display: true,
          },
        ],
        continue: false,
      };
    }

    if (!verdict) return {};

    const blocked = verdict.block === true;
    const line = verdict.line ?? (blocked ? verdict.reason : "orly passed");

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "orly-verdict",
          content: blocked ? `🦉 orly blocked · ${line}` : `🦉 orly passed · ${line}`,
          display: true,
        },
      ],
      continue: blocked,
    };
  });
}
