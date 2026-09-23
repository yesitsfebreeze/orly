import { expect, test } from "bun:test";
import { projectEvidence } from "../src/evidence.ts";
import { contextEnricher } from "../src/enrich-context.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const bad = async () => { throw new Error("that source is not running"); };
  expect(await combine(bad, good)(turn, specs)).toEqual({ ok: 1 });
});

test("no evidence means no project key at all", async () => {
  expect(withEvidence(turn, {})).toBe(turn);
  expect(await fileEnricher("/x", async () => "")(turn, [{ id: "n", instructions: "no evidence listed" }])).toEqual({});
});

test("truncation announces itself instead of silently hiding the tail", () => {
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

test("projectEvidence gathers files and checks from the project root, called from anywhere", async () => {
  // Hook and CLI share this, so they cannot disagree about one repository.
  const root = mkdtempSync(join(tmpdir(), "orly-ev-"));
  try {
    mkdirSync(join(root, ".orly"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "thing.ts"), "export const done = true;\n");
    writeFileSync(join(root, ".orly", "config.json"), JSON.stringify({ checks: { here: { command: "cat thing.ts" } } }));
    const specs: any = [
      { id: "file", instructions: "n/a", evidence: ["thing.ts"] },
      { id: "check", instructions: "n/a", require: { path: "checks.here.exit", op: "equals", value: 0 } },
    ];
    for (const cwd of [root, join(root, "sub")]) {
      const e: any = await projectEvidence({ cwd })({} as any, specs);
      expect(e.files["thing.ts"]).toContain("export const done");
      expect(e.checks.here.exit).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- declared context

test("a declared context source reaches the judge as text, unlike a check", async () => {
  const specs: any = [{ id: "ticket", instructions: "n/a", evidence: ["ticket"] }];
  const e: any = await contextEnricher({ ticket: { command: "echo 'PROJ-12: status Done'" } }, "/tmp")(
    {} as any,
    specs,
  );
  expect(e.context.ticket).toContain("status Done");
});

test("a context source that cannot run says unknown, never nothing", async () => {
  // Empty text would read as "the ticket says nothing", a wrong answer.
  const specs: any = [{ id: "t", instructions: "n/a", evidence: ["ticket"] }];
  const e: any = await contextEnricher({ ticket: { command: "exit 4" } }, "/tmp")({} as any, specs);
  expect(e.context.ticket).toContain("could not be read");
  expect(e.context.ticket).toContain("not as absent");
});

test("a source nothing names is never run", async () => {
  const specs: any = [{ id: "t", instructions: "n/a", evidence: ["somefile.ts"] }];
  expect(await contextEnricher({ ticket: { command: "echo hi" } }, "/tmp")({} as any, specs)).toEqual({});
});

test("a context name is not read as a missing file", async () => {
  // "[file does not exist]" is a valid answer to an existence spec, so it must not be faked.
  const specs: any = [{ id: "t", instructions: "n/a", evidence: ["ticket", "real.ts"] }];
  expect(evidencePaths(specs, ["ticket"])).toEqual(["real.ts"]);
  const e: any = await fileEnricher("/tmp", async () => "x", { skip: ["ticket"] })({} as any, specs);
  expect(Object.keys(e.files)).toEqual(["real.ts"]);
});

test("projectEvidence carries a declared source end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "orly-ctx-"));
  try {
    mkdirSync(join(root, ".orly"));
    writeFileSync(
      join(root, ".orly", "config.json"),
      JSON.stringify({ context: { ticket: { command: "echo 'acceptance: rollback documented'" } } }),
    );
    const specs: any = [{ id: "t", instructions: "n/a", evidence: ["ticket"] }];
    const e: any = await projectEvidence({ cwd: root })({} as any, specs);
    expect(e.context.ticket).toContain("rollback documented");
    expect(e.files).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
