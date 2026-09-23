/**
 * A cheap working-tree fingerprint, so cached check results are reused only while the tree
 * is unchanged: HEAD plus size and mtime of each modified or untracked file, no content
 * hashing. `git status --porcelain` alone is not enough: a file edited twice stays "M path".
 */
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Files orly writes itself, excluded so writing the cache does not invalidate it. Inputs
 * such as `specs.json` and `config.json` stay in: a check may read them.
 */
const OWN_STATE = /^\.orly\/(checks\.json|log\.jsonl|baseline\.json|replay\.jsonl|turns\/.*)$/;

/** A short string that changes whenever anything a command could read has changed. */
export function treeFingerprint(root: string): string | null {
  try {
    const run = (args: string[]) => {
      const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString() : null;
    };
    const dirty = run(["ls-files", "-m", "-o", "--exclude-standard"]);
    const staged = run(["diff", "--cached", "--name-only"]);
    // Not a repository: no fingerprint, so no caching. No HEAD (nothing committed yet)
    // is still cacheable. Staged files count too: an edit then `git add`ed is not "modified".
    if (dirty === null || staged === null) return null;
    const parts = [run(["rev-parse", "HEAD"])?.trim() ?? "no-commit-yet"];
    for (const rel of [...new Set(`${dirty}\n${staged}`.split("\n"))].filter(Boolean).filter((f) => !OWN_STATE.test(f)).sort()) {
      try {
        const st = statSync(join(root, rel));
        parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
      } catch {
        parts.push(`${rel}:gone`);
      }
    }
    return Bun.hash(parts.join("\n")).toString(16);
  } catch {
    return null;
  }
}
