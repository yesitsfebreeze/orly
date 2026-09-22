import { expect, test } from "bun:test";
import { claimProblem, judgeSidecar, parseSidecar, pool } from "../src/claims.ts";
import { ensureServer, flatten, serverFor } from "../src/lsp.ts";

const SRC = `export const PACKAGE = "xyz";
export class RetryPolicy {
  max = 3;
  delay(n: number) { return n * 100; }
}
export interface Opts { timeout: number }
export async function fetchWithRetry(url: string) {
  const inner = () => 1;
  return inner();
}
`;

// What a language server answers for SRC to textDocument/documentSymbol (0-based lines).
const r = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 1 } });
const LSP = [
  { name: "PACKAGE", kind: 14, range: r(0, 0) },
  { name: "RetryPolicy", kind: 5, range: r(1, 4), children: [
    { name: "max", kind: 7, range: r(2, 2) },
    { name: "delay", kind: 6, range: r(3, 3), children: [{ name: "n", kind: 13, range: r(3, 3) }] },
  ] },
  { name: "Opts", kind: 11, range: r(5, 5), children: [{ name: "timeout", kind: 7, range: r(5, 5) }] },
  { name: "fetchWithRetry", kind: 12, range: r(6, 9), children: [{ name: "inner", kind: 13, range: r(7, 7) }] },
  // An arrow function held in a constant: its locals are not members.
  { name: "PACKAGE_LOCAL", kind: 14, range: r(0, 0), children: [{ name: "tmp", kind: 13, range: r(0, 0) }] },
  // Callbacks some servers report as symbols: never an anchor.
  { name: "<function>", kind: 12, range: r(8, 8) },
  { name: "map() callback", kind: 12, range: r(8, 8) },
];
const DEFS = flatten(LSP as any, SRC);

test("a documentSymbol tree becomes Name / Owner.member anchors; locals in bodies are skipped", () => {
  expect(DEFS.map((x) => x.anchor)).toEqual(["PACKAGE", "RetryPolicy", "RetryPolicy.max", "RetryPolicy.delay", "Opts", "Opts.timeout", "fetchWithRetry", "PACKAGE_LOCAL"]);
  expect(DEFS.find((x) => x.anchor === "PACKAGE")!.text).toBe('export const PACKAGE = "xyz";');
  expect(DEFS.find((x) => x.anchor === "fetchWithRetry")).toMatchObject({ kind: "function", from: 7, to: 10 });
});

test("servers are picked by extension, config wins, and a missing one says what to install", async () => {
  expect(serverFor("a.rs")?.languageId).toBe("rust");
  expect(serverFor("a.py")?.command[0]).toBe("bunx");
  expect(serverFor("a.kt")).toBeUndefined();
  expect(serverFor("a.kt", { ".kt": { command: ["kls"], languageId: "kotlin" } })?.languageId).toBe("kotlin");
  const none = { command: ["orly-no-such-server"], languageId: "x", hint: "install it from example" };
  const prev = process.env.ORLY_SERVER_DIR;
  process.env.ORLY_SERVER_DIR = "/nonexistent-orly-servers";
  try {
    await expect(ensureServer(none, ".x")).rejects.toThrow("put orly-no-such-server on PATH (install it from example)");
  } finally {
    process.env.ORLY_SERVER_DIR = prev;
  }
});

test("a sidecar line is `anchor: claim`; line numbers and junk are problems, not claims", () => {
  const { claims, problems } = parseSidecar(
    "# header\n\n@file: names package xyz\nRetryPolicy.max: is set to 3\n100: must export module\nnonsense\nimpl RetryPolicy.new: sets max\n",
  );
  expect(claims.map((c) => [c.anchor, c.line])).toEqual([["@file", 3], ["RetryPolicy.max", 4], ["impl RetryPolicy.new", 7]]);
  expect(problems[0].claim).toContain("line number drifts");
  expect(problems[1].claim).toContain('expected "anchor: claim"');
});

test("behaviour and taste words are refused; what the code says is not", () => {
  expect(claimProblem("retries correctly on 503")).toContain("correctly");
  expect(claimProblem("handles every edge case")).toBeDefined();
  expect(claimProblem("is exported")).toBeUndefined();
  expect(claimProblem("calls `handles()` before returning")).toBeUndefined();
});

test("each claim sees only its definition; anything unjudgeable fails, never passes", async () => {
  let seen: any;
  const ask = async (state: any, qs: Record<string, any>) => {
    seen = { state, qs };
    return { answers: Object.fromEntries(Object.keys(qs).map((k, i) => [k, { noul: i === 0 ? 0.95 : 0.2 }])) };
  };
  const sidecar = "RetryPolicy.max: is set to 3\nfetchWithRetry: is exported\nrenamedAway: is exported\nPACKAGE: works correctly\n";
  const res = await judgeSidecar("http.ts", SRC, DEFS, sidecar, ask, 0.7);
  expect(res.map((x) => [x.anchor, x.ok])).toEqual([["RetryPolicy.max", true], ["fetchWithRetry", false], ["renamedAway", false], ["PACKAGE", false]]);
  expect(res[2].problem).toContain("renamed or deleted");
  expect(res[3].problem).toContain("behaviour");
  expect(Object.keys(seen.state.symbols)).toEqual(["RetryPolicy.max", "fetchWithRetry"]);
  expect(seen.state.symbols["RetryPolicy.max"]).toBe("  max = 3;");
  // The judge being down fails each asked claim on its own line, never the whole file as one.
  const down = await judgeSidecar("http.ts", SRC, DEFS, "PACKAGE: is xyz\nOpts: has timeout\n", async () => {
    throw new Error("520 <!DOCTYPE html>\n<html>…");
  }, 0.7);
  expect(down.map((x) => [x.anchor, x.problem])).toEqual([["PACKAGE", "judge unavailable (520 <!DOCTYPE html>)"], ["Opts", "judge unavailable (520 <!DOCTYPE html>)"]]);
  // A name defined twice is ambiguous, never a guess.
  const twice = [...DEFS, { ...DEFS[0], text: "const PACKAGE = 2;" }];
  expect((await judgeSidecar("http.ts", SRC, twice, "PACKAGE: is xyz\n", ask, 0.7))[0].problem).toContain("more than one definition");
  // A deleted source file fails every claim in its sidecar.
  expect((await judgeSidecar("gone.ts", null, [], "x: is exported\n", ask, 0.7))[0].problem).toContain("does not exist");
  // No language server: every symbol claim fails with why; @file claims are still judged.
  const noServer = await judgeSidecar("a.kt", SRC, new Error("no language server for .kt"), "@file: names xyz\nFoo: is exported\n", ask, 0.7);
  expect(noServer.map((x) => [x.anchor, x.ok, x.problem])).toEqual([["@file", true, undefined], ["Foo", false, "no language server for .kt"]]);
});

test("the pool keeps order and never exceeds its limit", async () => {
  let live = 0, peak = 0;
  const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
    peak = Math.max(peak, ++live);
    await Bun.sleep(n);
    live--;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30]);
  expect(peak).toBe(2);
});
