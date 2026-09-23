/**
 * The edit guard every host runs before a file edit lands: if the target is a spec file
 * (or the goal, or the single specs.json), the edit is projected against the whole spec
 * tree and refused when the result is weaker. Anything uncertain is allowed; the Stop-time
 * baseline is the backstop.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULTS } from "./gate.ts";
import { refusal, weakenings } from "./guard.ts";
import { findOrlyDir } from "./session.ts";
import { EXT, GOAL, loadTree, TREE } from "./spectree.ts";

/** A planned edit, in the shape every host's tool input reduces to. */
export type PlannedEdit =
  | { kind: "write"; content: string }
  | { kind: "edit"; edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> };

/**
 * Reduce a host's edit tool call to a PlannedEdit, or null when it is not one. Field names
 * follow Claude Code's tools; every host so far copies them.
 */
export function plannedEdit(tool: string, input: any): PlannedEdit | null {
  const ti = input ?? {};
  if (tool === "Write" || tool === "write") return typeof ti.content === "string" ? { kind: "write", content: ti.content } : null;
  if (tool === "MultiEdit") return Array.isArray(ti.edits) ? { kind: "edit", edits: ti.edits } : null;
  if (tool === "Edit" || tool === "NotebookEdit" || tool === "edit")
    return { kind: "edit", edits: [{ old_string: ti.old_string ?? ti.oldString, new_string: ti.new_string ?? ti.newString, replace_all: ti.replace_all ?? ti.replaceAll }] };
  return null;
}

/** The file path a host's edit tool input names, or undefined. */
export const editTarget = (input: any): string | undefined => {
  const t = input?.file_path ?? input?.filePath ?? input?.path;
  return typeof t === "string" && t ? t : undefined;
};

/** Reconstruct the file the edit would produce; null when it cannot be told. */
function projected(current: string, edit: PlannedEdit): string | null {
  if (edit.kind === "write") return edit.content;
  let text = current;
  for (const e of edit.edits) {
    if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string") return null;
    if (!text.includes(e.old_string)) return null; // the edit would fail anyway
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string); // a function: `$&` in the text is literal
  }
  return text;
}

/**
 * Why the edit must be refused, or null to let it through. `target` is the path the tool
 * names, resolved against `cwd`.
 */
export function guardEdit(cwd: string, target: string, edit: PlannedEdit): string | null {
  const orlyDir = findOrlyDir(cwd);
  if (!orlyDir) return null;

  const specPath = resolve(cwd, target);
  const treeDir = resolve(orlyDir, TREE);
  // Either one file in the spec tree (or the goal beside it), or the single specs.json.
  const inTree =
    existsSync(treeDir) &&
    ((specPath.startsWith(treeDir + "/") && specPath.endsWith(EXT)) || specPath === resolve(orlyDir, GOAL));
  if (!inTree && specPath !== resolve(orlyDir, "specs.json")) return null;

  let before: unknown;
  let current = "";
  try {
    if (inTree) {
      before = loadTree(orlyDir);
      current = existsSync(specPath) ? readFileSync(specPath, "utf8") : "";
    } else {
      current = readFileSync(specPath, "utf8");
      before = JSON.parse(current);
    }
  } catch {
    return null; // no readable spec file yet: nothing to protect
  }

  const next = projected(current, edit);
  if (next === null) return null;

  let after: unknown;
  try {
    after = inTree ? loadTree(orlyDir, { path: specPath, text: next }) : JSON.parse(next);
  } catch {
    return null; // unparseable result: not this guard's call
  }

  const violations = weakenings(before as any, after as any, DEFAULTS.specMet);
  return violations.length ? refusal(violations) : null;
}
