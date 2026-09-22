#!/usr/bin/env bun
/**
 * PreToolUse adapter — refuses edits that would weaken the gate.
 *
 * Works out what the spec file would look like after the tool call, compares it with what
 * is there now, and denies the call if the difference makes the gate easier to pass.
 * Everything else passes straight through.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { refusal, weakenings } from "../src/guard.ts";
import { DEFAULTS } from "../src/gate.ts";
import { findOrlyDir } from "../src/session.ts";
import { EXT, GOAL, loadTree, TREE } from "../src/spectree.ts";
import { existsSync } from "node:fs";

/** Anything the hook cannot work out for certain is allowed: this must not block real work. */
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

const tool = input.tool_name;
if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) allow();

const cwd = input.cwd ?? process.cwd();
const orlyDir = findOrlyDir(cwd);
if (!orlyDir) allow();

const target = input.tool_input?.file_path ?? input.tool_input?.path;
if (!target) allow();
const specPath = resolve(cwd, String(target));
const treeDir = resolve(orlyDir!, TREE);
// Either one file in the spec tree (or the goal beside it), or the single specs.json.
const inTree =
  existsSync(treeDir) &&
  ((specPath.startsWith(treeDir + "/") && specPath.endsWith(EXT)) || specPath === resolve(orlyDir!, GOAL));
if (!inTree && specPath !== resolve(orlyDir!, "specs.json")) allow();

let before: unknown;
let current = "";
try {
  if (inTree) {
    before = loadTree(orlyDir!);
    current = existsSync(specPath) ? readFileSync(specPath, "utf8") : "";
  } else {
    current = readFileSync(specPath, "utf8");
    before = JSON.parse(current);
  }
} catch {
  allow(); // no readable spec file yet: nothing to protect
}

/** Reconstruct the file the tool call would produce. */
function projected(): string | null {
  const ti = input.tool_input ?? {};
  if (tool === "Write") return typeof ti.content === "string" ? ti.content : null;
  const edits = tool === "MultiEdit" ? ti.edits : [{ old_string: ti.old_string, new_string: ti.new_string }];
  if (!Array.isArray(edits)) return null;
  let text = current;
  for (const e of edits) {
    if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string") return null;
    if (!text.includes(e.old_string)) return null; // the edit would fail anyway
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, e.new_string);
  }
  return text;
}

const next = projected();
if (next === null) allow();

let after: unknown;
try {
  after = inTree ? loadTree(orlyDir!, { path: specPath, text: next! }) : JSON.parse(next!);
} catch {
  allow(); // not valid JSON: the edit is broken in a way this hook should not adjudicate
}

const violations = weakenings(before as any, after as any, DEFAULTS.specMet);
if (!violations.length) allow();

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: refusal(violations),
    },
  }),
);
process.exit(0);
