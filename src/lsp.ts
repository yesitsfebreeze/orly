/**
 * Symbols for any language, from whatever language server speaks it.
 *
 * A claim is anchored to a definition, and every language has a server that already knows
 * where its definitions are: `textDocument/documentSymbol` answers with the same tree —
 * name, kind, range, children — for TypeScript, Rust, Python, Go and C alike. So this is a
 * minimal LSP client and nothing else knows a language.
 *
 * Servers arrive the way Mason brings them to nvim: when a file first needs one. npm
 * servers run through `bunx …@latest` and stay current by themselves. A binary server is
 * downloaded from its own release page, or built with its toolchain, into ~/.orly/servers,
 * and fetched again once it is a week old. One already on PATH is used as it is.
 * `.orly/config.json` adds or overrides any extension:
 * `"lsp": { ".kt": { "command": ["kotlin-language-server"], "languageId": "kotlin" } }`.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** How to get a server that is not on PATH. */
export type Install =
  | { github: string; asset: Record<string, string> } // `${process.platform}-${process.arch}` → gzipped binary
  | { go: string };

export type Server = { command: string[]; languageId: string; init?: Record<string, unknown>; install?: Install; hint?: string };

export const SERVER_DIR = () => process.env.ORLY_SERVER_DIR ?? join(homedir(), ".orly", "servers", "bin");
// ponytail: fixed weekly refresh; add `orly servers update` if someone needs it sooner.
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export type Definition = { anchor: string; kind: string; from: number; to: number; text: string };

// typescript-language-server needs a tsserver; orly's own `typescript` dependency is one.
const tsserver = (() => {
  try {
    return { tsserver: { path: Bun.resolveSync("typescript/lib/tsserver.js", import.meta.dir) } };
  } catch {
    return undefined;
  }
})();
const ts = { command: ["bunx", "--bun", "typescript-language-server@latest", "--stdio"], init: tsserver };
const py = { command: ["bunx", "--package", "pyright@latest", "pyright-langserver", "--stdio"], languageId: "python" };
const c = { command: ["clangd"], hint: "install clangd (LLVM) or Xcode command line tools" };
const ra = (triple: string) => `rust-analyzer-${triple}.gz`;

export const SERVERS: Record<string, Server> = {
  ".ts": { ...ts, languageId: "typescript" }, ".mts": { ...ts, languageId: "typescript" }, ".cts": { ...ts, languageId: "typescript" },
  ".tsx": { ...ts, languageId: "typescriptreact" },
  ".js": { ...ts, languageId: "javascript" }, ".mjs": { ...ts, languageId: "javascript" }, ".cjs": { ...ts, languageId: "javascript" },
  ".jsx": { ...ts, languageId: "javascriptreact" },
  ".py": py,
  ".rs": {
    command: ["rust-analyzer"],
    languageId: "rust",
    install: {
      github: "rust-lang/rust-analyzer",
      asset: {
        "darwin-arm64": ra("aarch64-apple-darwin"), "darwin-x64": ra("x86_64-apple-darwin"),
        "linux-x64": ra("x86_64-unknown-linux-gnu"), "linux-arm64": ra("aarch64-unknown-linux-gnu"),
      },
    },
  },
  ".go": { command: ["gopls"], languageId: "go", install: { go: "golang.org/x/tools/gopls@latest" }, hint: "install Go" },
  ".c": { ...c, languageId: "c" }, ".h": { ...c, languageId: "c" },
  ".cc": { ...c, languageId: "cpp" }, ".cpp": { ...c, languageId: "cpp" }, ".hpp": { ...c, languageId: "cpp" },
};

export const serverFor = (path: string, config: Record<string, Server> = {}): Server | undefined =>
  config[extname(path)] ?? SERVERS[extname(path)];

// LSP SymbolKind numbers, the ones a claim is anchored to.
const KIND: Record<number, string> = {
  2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor",
  10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "member", 23: "struct", 26: "type",
};
// A local inside a body is not something a claim should be pinned to.
const BODY = new Set([6, 9, 12]);

type Sym = { name: string; kind: number; range: { start: { line: number }; end: { line: number } }; children?: Sym[] };

/** documentSymbol's tree as `Name` / `Owner.member` anchors, each with its whole lines. */
export function flatten(symbols: Sym[], text: string): Definition[] {
  const lines = text.split("\n");
  const out: Definition[] = [];
  const walk = (list: Sym[], owner: string) => {
    for (const s of list) {
      const anchor = owner ? `${owner}.${s.name}` : s.name;
      const { start, end } = s.range;
      out.push({ anchor, kind: KIND[s.kind] ?? "symbol", from: start.line + 1, to: end.line + 1, text: lines.slice(start.line, end.line + 1).join("\n") });
      if (s.children && !BODY.has(s.kind)) walk(s.children, anchor);
    }
  };
  walk(symbols, "");
  return out;
}

/**
 * The command to run, installing the server first if it has to be. Throws with what to
 * install when nothing can provide one — the caller fails the claims, never skips them.
 */
export async function ensureServer(server: Server, ext: string): Promise<string[]> {
  const [bin, ...args] = server.command;
  if (bin === "bunx") return server.command;
  // A PATH entry can be a shim with nothing behind it (rustup's proxy without the
  // component): trust it only if it answers --version.
  const onPath = Bun.which(bin);
  if (onPath && Bun.spawnSync([onPath, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return server.command;
  const local = join(SERVER_DIR(), bin);
  const fresh = existsSync(local) && Date.now() - statSync(local).mtimeMs < MAX_AGE_MS;
  if (fresh) return [local, ...args];
  const i = server.install;
  try {
    if (i) mkdirSync(SERVER_DIR(), { recursive: true });
    if (i && "github" in i) {
      const asset = i.asset[`${process.platform}-${process.arch}`];
      if (!asset) throw new Error(`no ${bin} build for ${process.platform}-${process.arch}`);
      const res = await fetch(`https://github.com/${i.github}/releases/latest/download/${asset}`);
      if (!res.ok) throw new Error(`downloading ${asset}: ${res.status}`);
      writeFileSync(local, Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
      chmodSync(local, 0o755);
      return [local, ...args];
    }
    if (i && "go" in i && Bun.which("go")) {
      const r = Bun.spawnSync(["go", "install", i.go], { env: { ...process.env, GOBIN: SERVER_DIR() }, stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`go install ${i.go}: ${r.stderr.toString().trim().split("\n").at(-1)}`);
      return [local, ...args];
    }
  } catch (e: any) {
    // A stale copy beats none when the refresh fails offline.
    if (existsSync(local)) return [local, ...args];
    throw new Error(`no language server for ${ext}: ${e.message}`);
  }
  if (existsSync(local)) return [local, ...args];
  throw new Error(`no language server for ${ext}: put ${bin} on PATH${server.hint ? ` (${server.hint})` : ""}, or set "lsp" in .orly/config.json`);
}

/** One running server: JSON-RPC over stdio, Content-Length framed. */
export async function startServer(server: Server, root: string, command = server.command) {
  const proc = Bun.spawn(command, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const pending = new Map<number, (m: any) => void>();
  let id = 0;
  const send = (m: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...m });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    proc.stdin.flush();
  };
  const request = (method: string, params: unknown, timeoutMs = 30_000) =>
    new Promise<any>((ok, bad) => {
      const n = ++id;
      const timer = setTimeout(() => (pending.delete(n), bad(new Error(`${method} timed out`))), timeoutMs);
      pending.set(n, (m) => (clearTimeout(timer), m.error ? bad(new Error(m.error.message)) : ok(m.result)));
      send({ id: n, method, params });
    });
  (async () => {
    let buf = Buffer.alloc(0);
    for await (const chunk of proc.stdout) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const head = buf.indexOf("\r\n\r\n");
        if (head < 0) break;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1]);
        if (buf.length < head + 4 + len) break;
        const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
        buf = buf.subarray(head + 4 + len);
        if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)!(msg), pending.delete(msg.id);
        // A server asking us something (configuration, progress tokens) gets an empty yes.
        else if (msg.id !== undefined && msg.method) send({ id: msg.id, result: msg.method === "workspace/configuration" ? [] : null });
      }
    }
    for (const done of pending.values()) done({ error: { message: "language server exited" } });
  })();

  const rootUri = pathToFileURL(root).href;
  await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "root" }],
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: server.init ?? {},
  }, 120_000); // the first bunx run installs the server
  send({ method: "initialized", params: {} });

  return {
    async symbols(path: string, text: string): Promise<Definition[]> {
      const uri = pathToFileURL(resolve(root, path)).href;
      send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: server.languageId, version: 1, text } } });
      // Some servers answer "content modified" or nothing until they have indexed; retry briefly.
      for (let i = 0; ; i++) {
        try {
          const r = await request("textDocument/documentSymbol", { textDocument: { uri } });
          if ((r?.length || i >= 10) && r) return flatten(r[0]?.location ? r.map(fromFlat) : r, text);
        } catch (e) {
          if (i >= 10) throw e;
        }
        await Bun.sleep(300);
      }
    },
    async stop() {
      await request("shutdown", null, 5_000).catch(() => {});
      send({ method: "exit" });
      setTimeout(() => proc.kill(), 1_000).unref?.();
    },
  };
}

/** The older flat SymbolInformation shape, as a tree node keyed by containerName. */
const fromFlat = (s: any): Sym => ({
  name: s.containerName ? `${s.containerName}.${s.name}` : s.name,
  kind: s.kind,
  range: s.location.range,
});

/**
 * Index many files at once: one server per language, all languages in parallel, every
 * file's symbols requested together. A file whose server cannot start gets that Error.
 */
export async function indexFiles(
  root: string,
  files: Array<{ path: string; text: string }>,
  config: Record<string, Server> = {},
): Promise<Map<string, Definition[] | Error>> {
  const out = new Map<string, Definition[] | Error>();
  const groups = new Map<Server, typeof files>();
  for (const f of files) {
    const s = serverFor(f.path, config);
    if (!s) out.set(f.path, new Error(`no language server known for ${extname(f.path) || f.path} — set "lsp" in .orly/config.json`));
    else groups.set(s, [...(groups.get(s) ?? []), f]);
  }
  await Promise.all(
    [...groups].map(async ([server, group]) => {
      let running: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        running = await startServer(server, root, await ensureServer(server, extname(group[0].path)));
        await Promise.all(
          group.map(async (f) => out.set(f.path, await running!.symbols(f.path, f.text).catch((e: Error) => e))),
        );
      } catch (e: any) {
        for (const f of group) out.set(f.path, e instanceof Error ? e : new Error(String(e)));
      } finally {
        await running?.stop();
      }
    }),
  );
  return out;
}
