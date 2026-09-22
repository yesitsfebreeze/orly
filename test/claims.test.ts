import { expect, test } from "bun:test";
import { claimProblem, definitions, judgeSidecar, parseSidecar, pool } from "../src/claims.ts";

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

test("definitions are anchored by name, members by Owner.member, locals skipped", () => {
  const d = definitions("http.ts", SRC);
  expect(d.map((x) => x.anchor)).toEqual(["PACKAGE", "RetryPolicy", "RetryPolicy.max", "RetryPolicy.delay", "Opts", "Opts.timeout", "fetchWithRetry"]);
  expect(d.find((x) => x.anchor === "PACKAGE")!.text).toBe('export const PACKAGE = "xyz";');
  expect(d.find((x) => x.anchor === "fetchWithRetry")).toMatchObject({ kind: "function", from: 7, to: 10 });
});

test("a sidecar line is `anchor: claim`; line numbers and junk are problems, not claims", () => {
  const { claims, problems } = parseSidecar("# header\n\n@file: names package xyz\nRetryPolicy.max: is set to 3\n100: must export module\nnonsense\n");
  expect(claims.map((c) => [c.anchor, c.line])).toEqual([["@file", 3], ["RetryPolicy.max", 4]]);
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
  const r = await judgeSidecar("http.ts", SRC, sidecar, ask, 0.7);
  expect(r.map((x) => [x.anchor, x.ok])).toEqual([["RetryPolicy.max", true], ["fetchWithRetry", false], ["renamedAway", false], ["PACKAGE", false]]);
  expect(r[2].problem).toContain("renamed or deleted");
  expect(r[3].problem).toContain("behaviour");
  expect(Object.keys(seen.state.symbols)).toEqual(["RetryPolicy.max", "fetchWithRetry"]);
  expect(seen.state.symbols["RetryPolicy.max"]).toBe("max = 3;");
  // A deleted source file fails every claim in its sidecar.
  expect((await judgeSidecar("gone.ts", null, "x: is exported\n", ask, 0.7))[0].problem).toContain("does not exist");
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
