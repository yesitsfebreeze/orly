/**
 * OpenCode plugin (also Kilo Code, which runs the same plugin API). Loaded from
 * .opencode/plugins/ or ~/.config/opencode/plugins/ through a one-line shim that
 * `orly install opencode` writes, or directly from this package.
 *
 *   session.idle           the turn is over: read the session's messages, run the gate,
 *                          and on a block prompt the session again with the reason
 *   session.created        the brief, as a message the model sees on its next turn
 *   tool.execute.before    an edit to a spec file, refused by throwing (OpenCode shows the
 *                          error to the model as the tool's result)
 *
 * OpenCode has no stop hook that blocks; the loop is closed by prompting again, and ended
 * by orly's round cap. Everything here fails open.
 */
import { sessionBrief } from "../src/brief.ts";
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";
import { normalizeLastTurn, textOf, type Msg } from "../src/normalize.ts";
import { gateTurn } from "../src/turnend.ts";

/** Map an OpenCode message list — SDK `{info, parts}` items or export `{type, content}` blocks — onto the Anthropic dialect. */
export const toAnthropic = (msgs: any[]): Msg[] => {
  const out: Msg[] = [];
  for (const m of msgs) {
    const role = m?.info?.role ?? m?.role ?? m?.type;
    const parts: any[] = m?.parts ?? m?.content ?? [];
    if (role === "user") {
      const text = typeof m.text === "string" ? m.text : parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
      out.push({ role: "user", content: [{ type: "text", text: String(text ?? "") }] });
      continue;
    }
    if (role !== "assistant") continue;

    const blocks: any[] = [];
    const results: Array<[string, string, boolean]> = [];
    for (const b of parts) {
      if (b?.type === "text") {
        blocks.push({ type: "text", text: b.text });
      } else if (b?.type === "tool") {
        const id = String(b.callID ?? b.id ?? "");
        blocks.push({ type: "tool_use", id, name: b.tool ?? b.name, input: b.state?.input });
        const body = b.state?.output ?? b.state?.error ?? b.state?.content;
        const text = typeof body === "string" ? body : textOf(body).trim();
        if (text) results.push([id, text, b.state?.status !== undefined && b.state.status !== "completed"]);
      }
      // reasoning and step markers are dropped: not evidence.
    }
    if (blocks.length) out.push({ role: "assistant", content: blocks });
    for (const [id, text, isError] of results) {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }],
      });
    }
  }
  return out;
};

/** OpenCode's own editing tools: write {filePath, content}, edit {filePath, oldString, newString, replaceAll}. */
const EDIT_TOOLS = new Set(["write", "edit"]);

export const OrlyPlugin = async ({ client, directory }: any) => {
  const cwd: string = directory ?? process.cwd();
  // A block prompts the session again; that turn ends in session.idle too. Guard re-entry.
  const judging = new Set<string>();

  return {
    event: async ({ event }: any) => {
      if (event?.type === "session.created") {
        const id = event.properties?.info?.id ?? event.properties?.sessionID;
        const brief = sessionBrief(cwd, { cli: process.env.ORLY_CLI, goalCommand: "/orly" });
        if (!id || !brief) return;
        try {
          await client.session.prompt({ path: { id }, body: { noReply: true, parts: [{ type: "text", text: brief }] } });
        } catch {
          /* an older server without noReply: the brief is lost, the gate still runs */
        }
        return;
      }
      if (event?.type !== "session.idle") return;
      const id: string | undefined = event.properties?.sessionID ?? event.properties?.id;
      if (!id || judging.has(id)) return;
      judging.add(id);
      try {
        const res = await client.session.messages({ path: { id } });
        const list = res?.data ?? res;
        if (!Array.isArray(list) || !list.length) return;
        const messages = toAnthropic(list);
        const outcome = await gateTurn({
          cwd,
          sessionId: id,
          read: async () => normalizeLastTurn(messages),
          flush: false,
        });
        if (outcome.note) console.error(`orly: ${outcome.note}`);
        if (outcome.banner) console.error(outcome.banner);
        if (!outcome.block) return;
        // Not awaited: the prompt runs the next turn, which ends in another session.idle.
        client.session
          .prompt({ path: { id }, body: { parts: [{ type: "text", text: outcome.reason }] } })
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
