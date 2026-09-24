/**
 * Pi coding agent extension. Load it from .pi/extensions/ with a one-line shim:
 * `export { default } from "<orly>/install/pi/extension.ts";`, or as a package via the `pi`
 * field in package.json.
 * `agent_end` gates the turn and, on a block, sends the reason as a follow-up user message;
 * `session_start` sends the brief; `tool_call` blocks spec edits that weaken the gate.
 * Everything fails open.
 */
import { guardEdit, gateTurn, normalizeLastTurn, plannedEdit, sessionBrief, type Msg } from "../../orly.ts";

/** Pi's message shape: user, assistant with text/toolCall blocks, toolResult messages. */
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
      if (text.trim()) out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: [{ type: "text", text }], is_error: !!m.isError }] });
    }
  }
  return out;
};

const cwd = () => process.cwd();
const sessionId = (ctx: any): string => {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "pi"); } catch { return "pi"; }
};
const editTarget = (input: any) => (typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : undefined);

export default function orly(pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const brief = sessionBrief(cwd(), process.env.ORLY_CLI);
    if (!brief) return;
    try { pi.sendMessage({ customType: "orly-brief", content: brief, display: false }, { triggerTurn: false }); } catch { ctx?.ui?.notify?.("orly? is active", "info"); }
  });

  pi.on("tool_call", async (event: any) => {
    const tool = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    if (tool !== "write" && tool !== "edit") return;
    const edit = tool === "write" ? plannedEdit("Write", input) : { kind: "edit", edits: [{ old_string: input.oldText, new_string: input.newText }] };
    const target = editTarget(input);
    if (!edit || !target) return;
    const reason = guardEdit(cwd(), target, edit);
    if (reason) return { block: true, reason };
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const messages = toAnthropic(event?.messages ?? []);
    if (!messages.length) return;
    const outcome = await gateTurn({ cwd: cwd(), sessionId: sessionId(ctx), read: async () => normalizeLastTurn(messages), flush: false });
    if (outcome.note) console.error(`orly: ${outcome.note}`);
    if (!outcome.block) return;
    try { pi.sendUserMessage(outcome.reason, { deliverAs: "followUp" }); } catch (e: any) { console.error(`orly: could not follow up (${e?.message ?? e})`); }
  });
}