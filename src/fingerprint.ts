/**
 * What the working tree looked like when something was computed.
 *
 * A check result is only reusable while the tree it was computed against is unchanged,
 * and "unchanged" has to be cheap to establish — a judgment that spends longer proving a
 * cached answer is still good than it would spend recomputing it has saved nothing.
 *
 * git already tracks this. HEAD fixes everything committed; the modified and untracked
 * files, with their size and mtime, fix everything that is not. Content is never hashed,
 * so the cost is one git invocation and a stat per dirty file.
 *
 * `git status --porcelain` alone is NOT enough, and the mistake is easy to make: a file
 * edited twice stays "M path" both times, so the output is identical across a real change.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * What orly writes about itself, which must not count as the tree changing.
 *
 * The cache lives inside `.orly`, so without this, writing an entry changes the very
 * fingerprint that entry was stamped with and no cached result is ever usable again.
 *
 * `specs.json` and `config.json` are deliberately NOT here: they are inputs, a check may
 * read them, and this repository has one that does. Only the files orly produces are
 * excluded, never the ones it is given.
 */
const OWN_STATE = /^\.orly\/(checks\.json|log\.jsonl|baseline\.json|orly-rounds-.*\.json|replay\.jsonl|turns\/.*)$/;

/** A short string that changes whenever anything a command could read has changed. */
export function treeFingerprint(root: string): string | null {
  try {
    const run = (args: string[]) => {
      const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString() : null;
    };
    const dirty = run(["ls-files", "-m", "-o", "--exclude-standard"]);
    // No git, no fingerprint, and no caching — never a fingerprint that is merely weak.
    // `ls-files` succeeding is what proves this is a repository; HEAD not resolving only
    // means nothing has been committed yet, which is a normal state and still cacheable,
    // because every file is then untracked and listed below.
    if (dirty === null) return null;
    const parts = [run(["rev-parse", "HEAD"])?.trim() ?? "no-commit-yet"];
    for (const rel of dirty.split("\n").filter(Boolean).filter((f) => !OWN_STATE.test(f)).sort()) {
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
