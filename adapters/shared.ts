/**
 * What every adapter needs and none should re-implement: the hook payload from stdin, a
 * turn read from a transcript on disk, a transcript found by session id when the host
 * gives none, and the three outcomes rendered for the human.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Turn } from "../src/gate.ts";
import { normalizeLastTurn } from "../src/normalize.ts";
import { messagesFromAny } from "./transcripts.ts";

/** The hook payload, or {} when stdin is not JSON (the adapter then fails open). */
export async function readPayload(): Promise<any> {
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** The last turn in a transcript file, or null when it cannot be read or recognised. */
export async function turnFromFile(path: string | undefined | null): Promise<Turn | null> {
  if (!path) return null;
  try {
    const messages = messagesFromAny(await Bun.file(path).text());
    if (!messages.length) return null;
    return normalizeLastTurn(messages);
  } catch {
    return null;
  }
}

export const home = () => process.env.HOME || homedir();

/**
 * Find the newest file under `roots` whose name contains `sessionId`, for hosts that
 * write a transcript but do not hand its path to the hook.
 */
export function findTranscript(sessionId: string, roots: string[], depth = 4): string | null {
  if (!sessionId || sessionId === "unknown") return null;
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string, left: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(path, left - 1);
      } else if (e.name.includes(sessionId)) {
        try {
          const mtime = statSync(path).mtimeMs;
          if (!best || mtime > best.mtime) best = { path, mtime };
        } catch {
          /* vanished */
        }
      }
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root, depth);
  return best ? (best as { path: string }).path : null;
}

/** Print one JSON object and exit 0. Every adapter ends here. */
export function emit(json: unknown): never {
  console.log(JSON.stringify(json));
  process.exit(0);
}

/** Exit 0 with nothing on stdout: the host proceeds as if there were no hook. */
export function silent(note?: string): never {
  if (note) console.error(`orly: ${note}`);
  process.exit(0);
}
