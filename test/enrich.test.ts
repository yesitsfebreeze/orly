import { expect, test } from "bun:test";
import { combine, evidencePaths, fileEnricher, withEvidence } from "../src/enrich.ts";
import type { Turn } from "../src/gate.ts";
import type { Spec } from "../src/specs.ts";

const turn: Turn = {
  user_request: "r", assistant_final_message: "f", assistant_said: "f",
  actions_taken: [], command_results: [], conclusive: true,
};
const specs: Spec[] = [
  { id: "a", instructions: "Is the stub gone from duration.js?", evidence: ["duration.js"] },
  { id: "b", instructions: "Does the README document usage?", evidence: ["duration.js", "README.md"] },
];

test("evidencePaths dedupes across specs", () => {
  expect(evidencePaths(specs)).toEqual(["duration.js", "README.md"]);
});

test("a missing file is recorded as evidence, not as an error", async () => {
  const e = await fileEnricher("/nope", () => Promise.reject(new Error("enoent")))(turn, specs);
  expect((e.files as any)["duration.js"]).toBe("[file does not exist]");
});

test("file contents reach the state under project", async () => {
  const e = await fileEnricher("/x", (p) => Promise.resolve(`body of ${p}`))(turn, specs);
  const enriched = withEvidence(turn, e);
  expect((enriched as any).project.files["README.md"]).toContain("body of /x/README.md");
});

test("one failing enricher does not take the others down", async () => {
  const good = async () => ({ ok: 1 });
  const bad = async () => { throw new Error("kern is not running"); };
  expect(await combine(bad, good)(turn, specs)).toEqual({ ok: 1 });
});

test("no evidence means no project key at all", async () => {
  expect(withEvidence(turn, {})).toBe(turn);
  expect(await fileEnricher("/x", async () => "")(turn, [{ id: "n", instructions: "no evidence listed" }])).toEqual({});
});

test("truncation announces itself instead of silently hiding the tail", () => {
  // A spec asking about a section that fell off the end otherwise gets a confident answer
  // about a file the judge never fully saw.
  const long = "x".repeat(20_000);
  return fileEnricher("/x", async () => long)(turn, specs).then((e) => {
    const body = (e.files as any)["duration.js"] as string;
    expect(body).toContain("TRUNCATED");
    expect(body).toContain("do not treat anything below as absent");
  });
});

test("a file under the limit is passed through whole", async () => {
  const e = await fileEnricher("/x", async () => "short file")(turn, specs);
  expect((e.files as any)["duration.js"]).toBe("short file");
});
