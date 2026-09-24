#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook: projects the spec file after an Edit/Write and denies the
 * call if it would make the gate easier to pass. Everything else passes through.
 */
import { editTarget, guardEdit, plannedEdit } from "../src/editguard.ts";

/** Fails open: anything uncertain is allowed. */
function allow(): never {
  process.exit(0);
}

const raw = await new Response(Bun.stdin.stream()).text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  allow();
}

const edit = plannedEdit(String(input.tool_name ?? ""), input.tool_input);
const target = editTarget(input.tool_input);
if (!edit || !target) allow();

const reason = guardEdit(input.cwd ?? process.cwd(), target!, edit!);
if (!reason) allow();

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }),
);
process.exit(0);
