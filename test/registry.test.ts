import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidatesFor, compileIndex, lspconfigCmd, lspconfigFiletypes, rememberChoice } from "../src/registry.ts";

const LANGUAGES = {
  Rust: { extensions: [".rs", ".rs.in"] },
  XML: { extensions: [".xml", ".rs"] }, // Linguist really does let XML claim .rs
  Shell: { extensions: [".sh"], aliases: ["bash", "sh"] },
};
const pkg = (name: string, languages: string[], source: string, extra: object = {}) =>
  ({ name, languages, categories: ["LSP"], source: { id: source }, bin: { [name]: `x:${name}` }, ...extra });
const REGISTRY = [
  pkg("lemminx", ["XML"], "pkg:github/eclipse/lemminx@1"),
  pkg("harper-ls", ["Rust", "XML", "Bash", "Markdown", "Go"], "pkg:cargo/harper-ls@1"),
  pkg("bacon-ls", ["Rust"], "pkg:cargo/bacon-ls@1", { categories: ["LSP", "Linter"] }),
  pkg("rust-analyzer", ["Rust"], "pkg:github/rust-lang/rust-analyzer@2026", { neovim: { lspconfig: "rust_analyzer" } }),
  pkg("bash-language-server", ["Bash"], "pkg:npm/bash-language-server@5", { neovim: { lspconfig: "bashls" } }),
  { ...pkg("shfmt", ["Bash"], "pkg:golang/mvdan.cc/sh@3"), categories: ["Formatter"] },
];
const LSPCONFIG = {
  rust_analyzer: "return {\n  cmd = { 'rust-analyzer' },\n  filetypes = { 'rust' },\n}",
  bashls: "return {\n  cmd = { 'bash-language-server', 'start' },\n  filetypes = { 'bash', 'sh' },\n}",
};

test("lspconfig's command is read only when it is all string literals", () => {
  expect(lspconfigCmd("return {\n  cmd = { 'pyright-langserver', '--stdio' },\n}")).toEqual(["pyright-langserver", "--stdio"]);
  expect(lspconfigCmd("return {\n  cmd = { 'go', 'env', custom_args.envvar_id },\n}")).toBeUndefined();
  expect(lspconfigCmd("return { cmd = function() end }")).toBeUndefined();
  expect(lspconfigFiletypes(LSPCONFIG.bashls)).toEqual(["bash", "sh"]);
});

test("the joined index ranks the extension's own dedicated server first", () => {
  const { byExt } = compileIndex(LANGUAGES, REGISTRY as any, LSPCONFIG);
  // Rust's own servers before XML's; then pure servers before a linter that also speaks LSP
  // (that outranks breadth); among pure ones, one language before five.
  expect(byExt[".rs"].map((c) => c.package)).toEqual(["rust-analyzer", "harper-ls", "bacon-ls", "lemminx"]);
  expect(byExt[".rs"][0]).toMatchObject({ languageId: "rust", cmd: ["rust-analyzer"] });
  // Mason's "Bash" reaches .sh through Linguist's alias; a formatter is not a language server.
  expect(byExt[".sh"].map((c) => c.package)).toEqual(["bash-language-server", "harper-ls"]);
  expect(byExt[".sh"][0].cmd).toEqual(["bash-language-server", "start"]);
  // No lspconfig entry: fall back to the package's first binary.
  expect(byExt[".xml"][0]).toMatchObject({ package: "lemminx", cmd: ["lemminx"], languageId: "xml" });
});

test("the server that worked last time is tried first", () => {
  const prev = process.env.ORLY_SERVER_DIR;
  process.env.ORLY_SERVER_DIR = join(mkdtempSync(join(tmpdir(), "orly-reg-")), "bin");
  try {
    const index = compileIndex(LANGUAGES, REGISTRY as any, LSPCONFIG);
    expect(candidatesFor(index, "a.rs")[0].package).toBe("rust-analyzer");
    rememberChoice(".rs", "harper-ls");
    expect(candidatesFor(index, "src/a.rs").map((c) => c.package)).toEqual(["harper-ls", "rust-analyzer", "bacon-ls", "lemminx"]);
    expect(candidatesFor(index, "a.unknown")).toEqual([]);
  } finally {
    process.env.ORLY_SERVER_DIR = prev;
  }
});
