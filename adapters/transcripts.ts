/**
 * Every host keeps its transcript differently. This reads whichever one it is handed and
 * returns the neutral message log `normalize` reads. Unknown formats come back empty, so
 * the adapter fails open rather than judging a half-read turn.
 *
 *   Claude Code / Droid / Continue    JSONL, {type: user|assistant, message: {content}}
 *   Codex CLI                         rollout JSONL, {type: response_item, payload: {…}}
 *   Gemini CLI / Qwen Code            {messages: [{type: user|gemini, content, toolCalls}]}
 *   Copilot CLI                       events JSONL, {type: user.message|assistant.message|tool.*}
 *   anything else                     JSONL or JSON of {role, content} messages
 */
import type { Msg } from "../src/normalize.ts";
import { messagesFrom as claudeMessages } from "./claude-transcript.ts";

/** Parse every JSON line, skipping the ones that are not (a half-written tail tells us nothing). */
export function lines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

const text = (t: unknown) => (typeof t === "string" ? t : "");

/** Codex's user turns include injected context wrapped in tags; those are not the request. */
const INJECTED = /^\s*<(environment_context|user_instructions|turn_aborted|permissions[^>]*|skill[^>]*|app-context)>/i;

/** Codex rollout: response_item payloads carry the conversation; event_msg lines are UI. */
export function codexMessages(items: any[]): Msg[] {
  const out: Msg[] = [];
  const names = new Map<string, string>();
  for (const e of items) {
    if (e?.type !== "response_item") continue;
    const p = e.payload ?? {};
    if (p.type === "message") {
      const body = Array.isArray(p.content)
        ? p.content.map((c: any) => text(c?.text)).filter(Boolean).join("\n")
        : text(p.content);
      if (p.role === "user") {
        if (INJECTED.test(body)) continue;
        out.push({ role: "user", content: [{ type: "text", text: body }] });
      } else if (p.role === "assistant") {
        out.push({ role: "assistant", content: [{ type: "text", text: body }] });
      }
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const id = String(p.call_id ?? p.id ?? "");
      const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : "tool"));
      names.set(id, name);
      const input = p.arguments ?? p.input ?? p.action;
      out.push({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      const id = String(p.call_id ?? "");
      let body = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      // The shell tool wraps its output in JSON with the exit code; unwrap it and keep the code.
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && typeof parsed.output === "string") {
          const code = parsed.metadata?.exit_code;
          body = parsed.output + (typeof code === "number" && code !== 0 ? `\n[exit code ${code}]` : "");
        }
      } catch {
        /* plain text */
      }
      const isError = /\[exit code [1-9]/.test(body);
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: body }], is_error: isError }],
      });
    }
  }
  return out;
}

/** Gemini CLI's chat file (Qwen Code shares it): one entry per message, tool calls nested under the model's. */
export function geminiMessages(messages: any[]): Msg[] {
  const out: Msg[] = [];
  for (const m of messages) {
    const type = m?.type ?? m?.role;
    if (type === "user") {
      out.push({ role: "user", content: [{ type: "text", text: text(m.content) }] });
      continue;
    }
    if (type !== "gemini" && type !== "assistant" && type !== "model") continue;
    const blocks: any[] = [];
    if (text(m.content)) blocks.push({ type: "text", text: m.content });
    const results: any[] = [];
    for (const c of m.toolCalls ?? []) {
      const id = String(c?.id ?? "");
      blocks.push({ type: "tool_use", id, name: String(c?.name ?? "tool"), input: c?.args });
      const body = resultText(c?.result ?? c?.resultDisplay);
      if (body) {
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: body }],
          is_error: c?.status === "error",
        });
      }
    }
    if (blocks.length) out.push({ role: "assistant", content: blocks });
    if (results.length) out.push({ role: "user", content: results });
  }
  return out;
}

/** Gemini stores a tool result as functionResponse parts; flatten whatever text is in there. */
function resultText(r: unknown): string {
  if (typeof r === "string") return r;
  if (!r) return "";
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join("\n");
  const o = r as any;
  if (o.functionResponse) return resultText(o.functionResponse.response ?? o.functionResponse);
  if (typeof o.output === "string") return o.output;
  if (typeof o.error === "string") return o.error;
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (o.content) return resultText(o.content);
  try {
    return JSON.stringify(o).slice(0, 2000);
  } catch {
    return "";
  }
}

/** Copilot CLI's event log: one event per line, the conversation among them. */
export function copilotMessages(events: any[]): Msg[] {
  const out: Msg[] = [];
  const pending = new Map<string, string>();
  for (const e of events) {
    const type = String(e?.type ?? "");
    const d = e?.data ?? e;
    if (type === "user.message") {
      out.push({ role: "user", content: [{ type: "text", text: text(d.content ?? d.text ?? d.message) }] });
    } else if (type === "assistant.message") {
      const blocks: any[] = [];
      const body = text(d.content ?? d.text ?? d.message);
      if (body) blocks.push({ type: "text", text: body });
      for (const c of d.toolRequests ?? d.tool_calls ?? d.toolCalls ?? []) {
        const id = String(c?.toolCallId ?? c?.id ?? "");
        pending.set(id, String(c?.name ?? c?.toolName ?? "tool"));
        blocks.push({ type: "tool_use", id, name: String(c?.name ?? c?.toolName ?? "tool"), input: c?.arguments ?? c?.input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (type === "tool.execution_start") {
      const id = String(d.toolCallId ?? d.id ?? "");
      if (!pending.has(id)) {
        pending.set(id, String(d.toolName ?? d.name ?? "tool"));
        out.push({ role: "assistant", content: [{ type: "tool_use", id, name: String(d.toolName ?? d.name ?? "tool"), input: d.arguments ?? d.input }] });
      }
    } else if (type === "tool.execution_complete") {
      const id = String(d.toolCallId ?? d.id ?? "");
      const body = resultText(d.result ?? d.output ?? d.content ?? d.error);
      if (body)
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: body }], is_error: d.success === false || !!d.error }],
        });
    }
  }
  return out;
}

/** Messages already in a dialect `normalize` reads: {role, content} with blocks or tool_calls. */
const plainMessages = (items: any[]): Msg[] =>
  items.filter((m) => m && typeof m.role === "string" && ("content" in m || "tool_calls" in m)) as Msg[];

/** Sniff the format and read it. Empty when nothing is recognised. */
export function messagesFromAny(raw: string): Msg[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // A single JSON document: Gemini/Qwen chat, an OpenCode export, or {messages: […]}.
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      const doc = JSON.parse(trimmed);
      const msgs = doc?.messages ?? doc?.data?.messages;
      if (Array.isArray(msgs)) {
        if (msgs.some((m: any) => m?.type === "gemini" || m?.type === "model")) return geminiMessages(msgs);
        return plainMessages(msgs);
      }
    } catch {
      /* fall through to JSONL */
    }
  }

  const items = lines(trimmed);
  if (!items.length) return [];
  if (items.some((e) => e?.type === "response_item" || e?.type === "session_meta")) return codexMessages(items);
  if (items.some((e) => (e?.type === "user" || e?.type === "assistant") && e?.message)) return claudeMessages(trimmed);
  if (items.some((e) => e?.type === "gemini" || e?.type === "model")) return geminiMessages(items);
  if (items.some((e) => /^(user|assistant)\.message$|^tool\.execution/.test(String(e?.type ?? "")))) return copilotMessages(items);
  return plainMessages(items);
}
