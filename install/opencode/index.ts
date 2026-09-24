/**
 * OpenCode v2 plugin (`Plugin.define` shape). Load it with `"plugins": [{"package": "<orly>/install/opencode"}]`
 * (v2 resolves a package dir to its index.ts; `main` is ignored).
 * `session.execution.succeeded` (v2 has no `session.idle` on the plugin stream) gates the finished turn and, on a block, prompts the session again with the reason;
 * `session.created` sends the brief as a non-replying synthetic message; `execute.before` refuses spec edits
 * that weaken the gate. Everything fails open; the round cap ends the loop. v1 hosts keep using plugin.ts.
 */
import { guardEdit, gateTurn, normalizeLastTurn, plannedEdit, sessionBrief } from "../../orly.ts";
import { toAnthropic } from "./plugin.ts"; // v2 messages are `{type, text | content}`, which it already reads

const EDIT_TOOLS = new Set(["write", "edit"]);
const editTarget = (a: any) => (typeof a?.filePath === "string" ? a.filePath : typeof a?.path === "string" ? a.path : undefined);

export default {
  id: "orly",
  async setup(ctx: any) {
    const cwd: string = ctx.location?.directory ?? process.cwd();
    const judging = new Set<string>(); // a block re-prompts, and that turn ends too

    const gate = async (id: string) => {
      if (judging.has(id)) return;
      judging.add(id);
      try {
        const list = await ctx.session.context({ sessionID: id });
        if (!Array.isArray(list) || !list.length) return;
        const outcome = await gateTurn({ cwd, sessionId: id, read: async () => normalizeLastTurn(toAnthropic(list)), flush: false });
        if (outcome.note) console.error(`orly: ${outcome.note}`);
        if (!outcome.block) return;
        await ctx.session.prompt({ sessionID: id, text: outcome.reason })
          .catch((e: any) => console.error(`orly: could not re-prompt (${e?.message ?? e})`));
      } catch (e: any) {
        console.error(`orly: ${e?.message ?? e}`);
      } finally {
        judging.delete(id);
      }
    };

    // The event stream outlives setup; read it in the background so loading never waits on it.
    (async () => {
      for await (const event of ctx.event.subscribe()) {
        const id: string | undefined = event?.data?.sessionID;
        if (!id) continue;
        if (event.type === "session.execution.succeeded") void gate(id);
        else if (event.type === "session.created") {
          const brief = sessionBrief(cwd, process.env.ORLY_CLI);
          if (brief) ctx.session.synthetic({ sessionID: id, text: brief, resume: false }).catch(() => { /* gate still runs */ });
        }
      }
    })().catch((e: any) => console.error(`orly: event stream ended (${e?.message ?? e})`));

    await ctx.tool.hook("execute.before", (input: any) => {
      if (!EDIT_TOOLS.has(String(input?.tool))) return;
      const args = input.input ?? {};
      const edit = plannedEdit(String(input.tool), args);
      const target = editTarget(args);
      if (!edit || !target) return;
      const reason = guardEdit(cwd, target, edit);
      if (reason) throw new Error(reason);
    });
  },
};
