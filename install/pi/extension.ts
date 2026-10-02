/**
 * Pi coding agent extension. Load it from .pi/extensions/ with a one-line shim:
 * `export { default } from "<orly>/install/pi/extension.ts";`, or as a package via the `pi`
 * field in package.json.
 * The gate is inert until the session arms it: nothing is injected and nothing is judged at
 * session start. `/orly` arms this session, `/orly off` disarms it, `/orly status` reports.
 * Once armed, `agent_end` gates the turn and, on a block, sends the reason as a follow-up user
 * message, and `tool_call` blocks spec edits that weaken the gate.
 * Everything fails open.
 */
import { armCommand, guardEdit, gateTurn, normalizeLastTurn, plannedEdit, sessionBrief, type Msg } from "../../orly.ts";

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

const cwdOf = (ctx: any): string => { try { return String(ctx?.cwd || process.cwd()); } catch { return process.cwd(); } };
const cwd = (): string => process.cwd();
const sessionId = (ctx: any): string => {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "pi"); } catch { return "pi"; }
};
const editTarget = (input: any) => (typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : undefined);

export default function orly(pi: any) {
  let armed = false;
  let briefSent = false;
  const note = (ctx: any, text: string, level: string) => { try { ctx?.ui?.notify?.(text, level); } catch { /* no UI: silence */ } };

  /** Send the brief once, the first time this session arms. */
  const brief = (ctx: any): boolean => {
    if (briefSent) return true;
    const text = sessionBrief(cwdOf(ctx), process.env.ORLY_CLI);
    if (!text) { note(ctx, "orly: no .orly/ tree here or above — nothing to gate", "warning"); return false; }
    pi.sendMessage({ customType: "orly-brief", content: text, display: false }, { triggerTurn: false });
    briefSent = true;
    return true;
  };

  pi.registerCommand("orly", {
    description: "Arm the completion gate for this session (/orly, /orly off, /orly status)",
    getArgumentCompletions: (prefix: string) => ["on", "off", "status"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: any) => {
      const action = armCommand(String(args ?? ""));
      if (!action) { note(ctx, "orly: unknown argument — use /orly, /orly off or /orly status", "warning"); return; }
      if (action === "status") {
        note(ctx, `orly: ${armed ? "armed" : "inert"} for this session — the gate runs at the end of every turn only while armed`, "info");
        return;
      }
      if (action === "off") { armed = false; note(ctx, "orly: disarmed for this session", "info"); return; }
      armed = true;
      const ok = brief(ctx);
      note(ctx, ok ? "orly: armed — the completion gate runs at the end of every turn" : "orly: armed, but there is no .orly/ tree to gate", ok ? "info" : "warning");
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (!armed) return;
    const tool = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    if (tool !== "write" && tool !== "edit") return;
    const edit = plannedEdit(tool, input);
    const target = editTarget(input);
    if (!edit || !target) return;
    const reason = guardEdit(cwd(), target, edit);
    if (reason) return { block: true, reason };
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    if (!armed) return;
    const messages = toAnthropic(event?.messages ?? []);
    if (!messages.length) return;
    const outcome = await gateTurn({ cwd: cwdOf(ctx), sessionId: sessionId(ctx), read: async () => normalizeLastTurn(messages), flush: false });
    if (outcome.note) console.error(`orly: ${outcome.note}`);
    if (!outcome.block) return;
    try { pi.sendUserMessage(outcome.reason, { deliverAs: "followUp" }); } catch (e: any) { console.error(`orly: could not follow up (${e?.message ?? e})`); }
  });
}
