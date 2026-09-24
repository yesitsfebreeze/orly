/**
 * OpenCode plugin (also Kilo Code). Load it from .opencode/plugins/ with a one-line shim:
 * `export { OrlyPlugin } from "<orly>/install/opencode/plugin.ts";`. `session.idle` gates the finished turn and, on a block,
 * prompts the session again with the reason; `session.created` sends the brief; `tool.execute.before`
 * refuses spec edits that weaken the gate. Everything fails open; the round cap ends the loop.
 */
import { guardEdit, gateTurn, normalizeLastTurn, plannedEdit, sessionBrief, textOf, type Msg } from "../../orly.ts";

/** Map OpenCode messages — SDK `{info, parts}` or export `{type, content}` — onto the Anthropic dialect. */
export const toAnthropic = (msgs: any[]): Msg[] => {
  const out: Msg[] = [];
  for (const m of msgs) {
    const role = m?.info?.role ?? m?.role ?? m?.type;
    const parts: any[] = m?.parts ?? m?.content ?? [];
    if (role === "user") {
      const text = typeof m.text === "string" ? m.text : parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
      out.push({ role: "user", content: [{ type: "text", text: String(text ?? "") }] });
    } else if (role === "assistant") {
      const blocks: any[] = [];
      const results: Array<[string, string, boolean]> = [];
      for (const b of parts) {
        if (b?.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b?.type === "tool") {
          const id = String(b.callID ?? b.id ?? "");
          blocks.push({ type: "tool_use", id, name: b.tool ?? b.name, input: b.state?.input });
          const body = b.state?.output ?? b.state?.error ?? b.state?.content;
          const text = typeof body === "string" ? body : textOf(body).trim();
          if (text) results.push([id, text, b.state?.status !== undefined && b.state.status !== "completed"]);
        }
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      for (const [id, text, isError] of results)
        out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] });
    }
  }
  return out;
};

const EDIT_TOOLS = new Set(["write", "edit"]);
const editTarget = (a: any) => (typeof a?.filePath === "string" ? a.filePath : typeof a?.path === "string" ? a.path : undefined);

export const OrlyPlugin = async ({ client, directory }: any) => {
  const cwd: string = directory ?? process.cwd();
  const judging = new Set<string>(); // a block re-prompts, and that turn ends idle too

  return {
    event: async ({ event }: any) => {
      if (event?.type === "session.created") {
        const id = event.properties?.info?.id ?? event.properties?.sessionID;
        const brief = sessionBrief(cwd, process.env.ORLY_CLI);
        if (!id || !brief) return;
        try { await client.session.prompt({ path: { id }, body: { noReply: true, parts: [{ type: "text", text: brief }] } }); } catch { /* older server: gate still runs */ }
        return;
      }
      if (event?.type !== "session.idle") return;
      const id: string | undefined = event.properties?.sessionID ?? event.properties?.id;
      if (!id || judging.has(id)) return;
      judging.add(id);
      try {
        const list = (await client.session.messages({ path: { id } }))?.data ?? [];
        if (!Array.isArray(list) || !list.length) return;
        const outcome = await gateTurn({ cwd, sessionId: id, read: async () => normalizeLastTurn(toAnthropic(list)), flush: false });
        if (outcome.note) console.error(`orly: ${outcome.note}`);
        if (!outcome.block) return;
        client.session.prompt({ path: { id }, body: { parts: [{ type: "text", text: outcome.reason }] } })
          .catch((e: any) => console.error(`orly: could not re-prompt (${e?.message ?? e})`));
      } catch (e: any) {
        console.error(`orly: ${e?.message ?? e}`);
      } finally {
        judging.delete(id);
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      if (!EDIT_TOOLS.has(String(input?.tool))) return;
      const args = output?.args ?? {};
      const edit = plannedEdit(String(input.tool), args);
      const target = editTarget(args);
      if (!edit || !target) return;
      const reason = guardEdit(cwd, target, edit);
      if (reason) throw new Error(reason);
    },
  };
};

export default OrlyPlugin;