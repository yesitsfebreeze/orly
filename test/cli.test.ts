import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeLastTurn } from "../src/normalize.ts";

const CLI = join(import.meta.dir, "..", "bin", "orly.ts");
// No key and a cwd with no .orly: a well-shaped input gets as far as the key check.
const run = (args: string[], stdin = "") =>
  Bun.spawnSync(["bun", CLI, ...args], {
    cwd: tmpdir(),
    stdin: new TextEncoder().encode(stdin),
    env: { PATH: process.env.PATH! },
    stdout: "pipe",
    stderr: "pipe",
  });

test("both schema examples are accepted as they are printed", () => {
  const schema = JSON.parse(run(["schema"]).stdout.toString());
  for (const shape of ["messages", "turn"]) {
    const r = run(["judge"], JSON.stringify(schema[shape].example));
    expect(r.stderr.toString()).toContain("no API key");
  }
  const turn = normalizeLastTurn(schema.messages.example.messages);
  expect(turn.user_request).toBe("add a test for parse()");
  expect(turn.command_results.join()).toContain("0 fail");
});

test("a bad shape is named and points at `orly schema`, before any key is needed", () => {
  for (const [stdin, says] of [
    ["not json", "not JSON"],
    ['{"transcript":"x"}', "expected"],
    ['{"messages":[{"role":"assistant","content":"done"}]}', "no role"],
    ['{"turn":{}}', "turn.user_request"],
    ['{"turn":{"user_request":"a","assistant_final_message":"b","assistant_said":"b","actions_taken":[1],"command_results":[],"conclusive":true}}', "turn.actions_taken"],
  ]) {
    const r = run(["judge"], stdin);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(says);
    expect(r.stderr.toString()).toContain("orly schema");
  }
});
