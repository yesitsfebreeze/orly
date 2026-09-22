/**
 * Automatic language discovery — the index that says which server speaks which file.
 *
 * Nothing here is hand-maintained. Three public indexes are joined, the same ones nvim
 * users already depend on:
 *
 *   Linguist (languages.yml)   file extension  → language name
 *   Mason registry             language name   → LSP package, and how to install it
 *   nvim-lspconfig (lsp/*.lua) package         → the command line that starts it
 *
 * The joined index is cached in ~/.orly/servers/index.json and rebuilt once a week; an old
 * copy is used when the network is not there. `compileIndex` is pure, so the join is tested
 * without the network.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { Server } from "./lsp.ts";

const SOURCES = {
  linguist: "https://raw.githubusercontent.com/github-linguist/linguist/main/lib/linguist/languages.yml",
  mason: "https://github.com/mason-org/mason-registry/releases/latest/download/registry.json.zip",
  lspconfig: "https://codeload.github.com/neovim/nvim-lspconfig/tar.gz/refs/heads/master",
};
// ponytail: weekly rebuild, same as managed servers; `orly servers --refresh` forces one.
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export type Candidate = {
  package: string;
  language: string;
  languageId: string;
  /** The command line lspconfig starts it with, or just the binary when it states none. */
  cmd: string[];
  /** Mason's purl, e.g. pkg:npm/pyright@1.1.414. */
  source: string;
  bin: Record<string, string>;
  asset?: Array<{ target: string | string[]; file: string; bin?: string }>;
};
export type Index = { builtAt: string; byExt: Record<string, Candidate[]> };

/** `cmd = { 'a', '--b' }` when every element is a string literal; otherwise nothing. */
export function lspconfigCmd(lua: string): string[] | undefined {
  const m = lua.match(/^\s{0,2}cmd = \{([^}]*)\}/m);
  if (!m) return;
  const parts = m[1].split(",").map((p) => p.trim()).filter(Boolean);
  const strings = parts.map((p) => p.match(/^['"]([^'"]*)['"]$/)?.[1]);
  return strings.every((s) => s !== undefined) ? (strings as string[]) : undefined;
}

export const lspconfigFiletypes = (lua: string): string[] =>
  (lua.match(/filetypes = \{([^}]*)\}/)?.[1] ?? "").match(/['"]([^'"]+)['"]/g)?.map((s) => s.slice(1, -1)) ?? [];

// Installable without a language toolchain first; the order a tie is broken in.
const RANK = ["npm", "github", "golang", "pypi", "cargo", "gem"];
const kind = (purl: string) => purl.match(/^pkg:([a-z]+)\//)?.[1] ?? "";

/** Join the three indexes into extension → servers, best first. */
export function compileIndex(
  languages: Record<string, { extensions?: string[]; aliases?: string[] }>,
  registry: Array<{ name: string; languages?: string[]; categories?: string[]; source: { id: string; asset?: any }; bin?: Record<string, string>; neovim?: { lspconfig?: string } }>,
  lspconfig: Record<string, string>,
): Index {
  // Mason says "Bash" where Linguist says "Shell"; Linguist lists bash as an alias. An
  // extension is primary for a language when Linguist lists it first (.rs → Rust, while
  // XML merely also claims .rs).
  const extsOf = new Map<string, string[]>();
  const primary = new Map<string, string>();
  for (const [name, l] of Object.entries(languages))
    for (const n of [name, ...(l.aliases ?? [])]) {
      const k = n.toLowerCase();
      extsOf.set(k, [...new Set([...(extsOf.get(k) ?? []), ...(l.extensions ?? [])])]);
      if (l.extensions?.[0]) primary.set(k, l.extensions[0]);
    }
  const rank = (purl: string) => {
    const r = RANK.indexOf(kind(purl));
    return r < 0 ? RANK.length : r;
  };
  // Best first: the extension's own language; a pure language server over a linter or
  // formatter that also speaks LSP (those rarely list symbols); a server for one language over a tool that
  // touches forty (spell and grammar checkers, structural search rarely list symbols); a
  // start command lspconfig states; what installs without a toolchain; then the name.
  const scored: Record<string, Array<[number[], Candidate]>> = {};
  for (const p of registry) {
    if (!p.categories?.includes("LSP") || !p.bin) continue;
    const lua = p.neovim?.lspconfig ? lspconfig[p.neovim.lspconfig] : undefined;
    const stated = lua ? lspconfigCmd(lua) : undefined;
    const filetype = lua ? lspconfigFiletypes(lua)[0] : undefined;
    for (const language of p.languages ?? []) {
      const c: Candidate = {
        package: p.name,
        language,
        languageId: filetype ?? language.toLowerCase(),
        cmd: stated ?? [Object.keys(p.bin)[0]],
        source: p.source.id,
        bin: p.bin,
        ...(p.source.asset ? { asset: p.source.asset } : {}),
      };
      for (const ext of extsOf.get(language.toLowerCase()) ?? []) {
        const score = [primary.get(language.toLowerCase()) === ext ? 0 : 1, p.categories!.length > 1 ? 1 : 0, p.languages!.length, stated ? 0 : 1, rank(p.source.id)];
        (scored[ext] ??= []).push([score, c]);
      }
    }
  }
  const byExt: Record<string, Candidate[]> = {};
  for (const [ext, list] of Object.entries(scored)) {
    list.sort(([x, a], [y, b]) => x.findIndex((v, i) => v !== y[i]) >= 0 ? x[x.findIndex((v, i) => v !== y[i])] - y[x.findIndex((v, i) => v !== y[i])] : a.package.localeCompare(b.package));
    const seen = new Set<string>();
    byExt[ext] = list.map(([, c]) => c).filter((c) => !seen.has(c.package) && seen.add(c.package));
  }
  return { builtAt: new Date().toISOString(), byExt };
}

const dirOf = () => process.env.ORLY_SERVER_DIR ? dirname(process.env.ORLY_SERVER_DIR) : join(process.env.HOME ?? tmpdir(), ".orly", "servers");
export const indexPath = () => join(dirOf(), "index.json");

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Unpack an archive with the system's own tools; returns the directory it went into. */
export function unpack(bytes: Uint8Array, name: string, into: string): string {
  mkdirSync(into, { recursive: true });
  const file = join(into, name);
  writeFileSync(file, bytes);
  const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { cwd: into, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${cmd[0]}: ${r.stderr.toString().trim().split("\n").at(-1)}`);
  };
  if (/\.zip$|\.vsix$/.test(name)) run(["unzip", "-o", "-q", file]);
  else if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar)$/.test(name)) run(["tar", "-xf", file]);
  else if (/\.gz$/.test(name)) writeFileSync(file.slice(0, -3), Bun.gunzipSync(bytes));
  return into;
}

/** Fetch and join the three indexes. */
export async function buildIndex(): Promise<Index> {
  const scratch = mkdtempSync(join(tmpdir(), "orly-index-"));
  try {
    const [yml, zip, tgz] = await Promise.all([
      fetch(SOURCES.linguist).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`linguist: ${r.status}`)))),
      download(SOURCES.mason),
      download(SOURCES.lspconfig),
    ]);
    unpack(zip, "registry.json.zip", join(scratch, "mason"));
    unpack(tgz, "lspconfig.tgz", join(scratch, "lspconfig"));
    const top = readdirSync(join(scratch, "lspconfig")).find((d) => statSync(join(scratch, "lspconfig", d)).isDirectory())!;
    const luaDir = join(scratch, "lspconfig", top, "lsp");
    const lspconfig: Record<string, string> = {};
    for (const f of readdirSync(luaDir)) if (f.endsWith(".lua")) lspconfig[f.slice(0, -4)] = readFileSync(join(luaDir, f), "utf8");
    return compileIndex(
      Bun.YAML.parse(yml) as any,
      JSON.parse(readFileSync(join(scratch, "mason", "registry.json"), "utf8")),
      lspconfig,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The cached index, rebuilt when a week old or asked to; a stale one beats none offline. */
export async function loadIndex(refresh = false): Promise<Index> {
  const path = indexPath();
  const old = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Index) : undefined;
  if (old && !refresh && Date.now() - Date.parse(old.builtAt) < MAX_AGE_MS) return old;
  try {
    const fresh = await buildIndex();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(fresh));
    return fresh;
  } catch (e) {
    if (old) return old;
    throw e;
  }
}

const TARGET = () =>
  `${process.platform === "win32" ? "win" : process.platform}_${process.arch}${process.platform === "linux" ? "_gnu" : ""}`;

/** Mason's `{{version}}` and `{{ version | strip_prefix "v" }}` templates. */
const fill = (s: string, version: string) =>
  s.replace(/\{\{\s*version\s*\|\s*strip_prefix\s*"([^"]*)"\s*\}\}/g, (_, p) => (version.startsWith(p) ? version.slice(p.length) : version))
    .replace(/\{\{\s*version\s*\}\}/g, version);

/**
 * Turn an index candidate into a Server orly can start, installing it where that takes a
 * download. npm and PyPI servers run through bunx / uvx at @latest and so stay current;
 * GitHub releases unpack into ~/.orly/servers/<package>.
 */
export async function serverFromCandidate(c: Candidate, serversDir = dirOf()): Promise<Server> {
  const [bin, ...args] = c.cmd;
  const base = { languageId: c.languageId };
  const pathBin = Bun.which(bin);
  if (pathBin && Bun.spawnSync([pathBin, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0)
    return { ...base, command: c.cmd };
  const [, type, rest] = c.source.match(/^pkg:([a-z]+)\/([^?]+)/) ?? [];
  const at = rest?.lastIndexOf("@") ?? -1;
  const name = at > 0 ? rest.slice(0, at) : rest;
  const version = at > 0 ? rest.slice(at + 1) : "";
  switch (type) {
    case "npm":
      return { ...base, command: ["bunx", "--package", `${name}@latest`, bin, ...args] };
    case "pypi":
      if (!Bun.which("uvx")) break;
      return { ...base, command: ["uvx", "--from", `${name}@latest`, bin, ...args] };
    case "golang": {
      if (!Bun.which("go")) break;
      const gobin = join(serversDir, c.package);
      const exe = join(gobin, bin);
      if (!existsSync(exe)) {
        const r = Bun.spawnSync(["go", "install", `${name}@latest`], { env: { ...process.env, GOBIN: gobin }, stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`go install ${name}: ${r.stderr.toString().trim().split("\n").at(-1)}`);
      }
      return { ...base, command: [exe, ...args] };
    }
    case "github": {
      const asset = c.asset?.find((a) => [a.target].flat().includes(TARGET()));
      if (!asset) break;
      const dir = join(serversDir, c.package);
      const [file, sub = ""] = fill(asset.file, version).split(":");
      const where = asset.bin ? fill(asset.bin.replace(/^exec:/, ""), version) : (c.bin[bin] ?? bin);
      const exe = join(dir, where.includes("/") ? where : sub ? join(sub, where) : where);
      if (!existsSync(exe)) {
        const bytes = await download(`https://github.com/${name}/releases/download/${version}/${file}`);
        unpack(bytes, file.split("/").at(-1)!, sub ? join(dir, sub) : dir);
        const unpacked = file.endsWith(".gz") && !/\.tar\.gz$/.test(file) ? join(dir, file.slice(0, -3)) : exe;
        if (unpacked !== exe && existsSync(unpacked)) writeFileSync(exe, readFileSync(unpacked));
        if (!existsSync(exe)) throw new Error(`${c.package}: ${where} not found after unpacking ${file}`);
        Bun.spawnSync(["chmod", "+x", exe]);
      }
      return { ...base, command: [exe, ...args] };
    }
  }
  throw new Error(`${c.package} (${c.source}) cannot be installed here — put ${bin} on PATH, or set "lsp" in .orly/config.json`);
}

const chosenPath = () => join(dirOf(), "chosen.json");
const chosen = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(chosenPath(), "utf8"));
  } catch {
    return {};
  }
};

/** Remember which server worked for an extension, so the next run starts it first. */
export function rememberChoice(ext: string, pkg: string): void {
  try {
    mkdirSync(dirOf(), { recursive: true });
    writeFileSync(chosenPath(), JSON.stringify({ ...chosen(), [ext]: pkg }, null, 2));
  } catch {
    /* only costs the next run a few tries */
  }
}

/** Candidates for a file, best first, with the one that worked here last time on top. */
export const candidatesFor = (index: Index, path: string): Candidate[] => {
  const list = index.byExt[extname(path)] ?? [];
  const pick = chosen()[extname(path)];
  return [...list.filter((c) => c.package === pick), ...list.filter((c) => c.package !== pick)];
};
