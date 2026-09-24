/**
 * Pi coding agent extension. Loaded from .pi/extensions/ or ~/.pi/agent/extensions/
 * through a one-line shim that `orly install pi` writes, or as a package
 * (`pi install git:github.com/yesitsfebreeze/orly`, via the `pi` field in package.json).
 *
 *   agent_end      the turn is over: judge its messages; on a block, send the reason as a
 *                  follow-up user message so the agent keeps working
 *   session_start  the brief, as a message the model sees
 *   tool_call      an edit to a spec file (write / edit), blocked if it weakens the gate
 *
 * Everything fails open.
 */
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit, type PlannedEdit } from "../src/editguard.ts";
import { normalizeLastTurn, type Msg } from "../src/normalize.ts";
import { gateTurn } from "../src/turnend.ts";

/** Pi's message shape (pi-ai): user, assistant with text/toolCall blocks, toolResult messages. */
export const toAnthropic = (msgs: any[]): Msg[] => {
  const out: Msg[] = [];
  for (const m of msgs) {
    if (m?.role === "user") {
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      out.push({ role: "user", content: [{ type: "text", text }] });
    } else if (m?.role === "assistant") {
      const blocks: any[] = [];
      for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
        if (b?.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b?.type === "toolCall") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m?.role === "toolResult") {
      const text = (m.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      if (text.trim())
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: [{ type: "text", text }], is_error: !!m.isError }],
        });
    }
  }
  return out;
};

const sessionIdOf = (ctx: any): string => {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "pi");
  } catch {
    return "pi";
  }
};

export default function orly(pi: any) {
  const cwd = () => process.cwd();

  pi.on("session_start", async (_event: any, ctx: any) => {
    const brief = sessionBrief(cwd(), { cli: process.env.ORLY_CLI, goalCommand: "/orly" });
    if (!brief) return;
    try {
      pi.sendMessage({ customType: "orly-brief", content: brief, display: false }, { triggerTurn: false });
    } catch {
      ctx?.ui?.notify?.("orly? is active", "info");
    }
  });

  pi.on("tool_call", async (event: any) => {
    const tool = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    let edit: PlannedEdit | null = null;
    if (tool === "write") edit = plannedEdit("Write", input);
    else if (tool === "edit") edit = { kind: "edit", edits: [{ old_string: input.oldText, new_string: input.newText }] };
    else return;
    const target = editTarget(input);
    if (!edit || !target) return;
    const reason = guardEdit(cwd(), target, edit);
    if (reason) return { block: true, reason };
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const messages = toAnthropic(event?.messages ?? []);
    if (!messages.length) return;
    const outcome = await gateTurn({
      cwd: cwd(),
      sessionId: sessionIdOf(ctx),
      read: async () => normalizeLastTurn(messages),
      flush: false,
    });
    if (outcome.note) console.error(`orly: ${outcome.note}`);
    if (outcome.banner) ctx?.ui?.notify?.(outcome.banner, outcome.block ? "warning" : "info");
    if (!outcome.block) return;
    try {
      pi.sendUserMessage(outcome.reason, { deliverAs: "followUp" });
    } catch (e: any) {
      console.error(`orly: could not follow up (${e?.message ?? e})`);
    }
  });
}
