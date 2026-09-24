import { expect, test } from "bun:test";
import { owlBlock, scroll, statusBar, statusLines } from "../src/banner.ts";

test("the banner spreads one verdict line over four owl rows", () => {
  const out = owlBlock(statusBar({ block: true, line: "orly? BLOCK · specs 3/5 · coverage 0.8 · next=run tests · hazard 0.6" }));
  expect(out.split("\n")).toEqual([
    "   |  , .  BLOCK · specs 3/5",
    "   | {@,@} coverage 0.8",
    "   | /) )  next=run tests",
    "   |  '\"   hazard 0.6",
  ]);
});

test("a long goal rests, scrolls to its end, rests, and marks the hidden side", () => {
  const text = "0123456789abcdef"; // 16 cells into a window of 8: 8 steps of travel
  expect(scroll(text, 8, 0, 2)).toBe("0123456…");
  expect(scroll(text, 8, 3, 2)).toBe("…234567…");
  expect(scroll(text, 8, 10, 2)).toBe("…9abcdef");
  expect(scroll(text, 8, 12, 2)).toBe("0123456…"); // back to the start
  expect(scroll("short", 8, 5, 2)).toBe("short");
});

test("each goal row carries its count and its first failing spec, inside the width", () => {
  const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
  const goals = [
    { group: "readme", text: "a README that says each thing once", specs: ["a", "b"] },
    { group: "other", text: "specs that serve no goal", specs: ["c"] },
  ];
  const status = { at: new Date(0).toISOString(), block: true, line: "orly ⛔ block · specs 1/3", unmet: [{ id: "b", found: "4431, needs ≤ 2862" }] };
  const out = statusLines(status, { specs: 3, goals, maxRounds: 6, now: 60_000, width: 64 }).map(plain);
  expect(out[0]).toStartWith("┌───────┬─ gate ");
  expect(out[1]).toContain("│ ✗ BLOCK           1m ago │");
  expect(out[2]).toContain("│ specs 1/3    ███░░░░░░░  │");
  expect(out[1]).toContain("readme ▕1/2▏ ✗ b 4431, n… │"); // cut at its panel edge, never spilled
  expect(out[2]).toContain("other  ▕1/1▏ specs that … │");
  // Every row is exactly the width, frame included; below 64 cells the owl panel goes first.
  for (const l of out) expect(Array.from(l).length).toBe(64);
  const narrow = statusLines(status, { specs: 3, goals, maxRounds: 6, now: 60_000, width: 50 }).map(plain);
  expect(narrow[1]).not.toContain("{@,@}");
  for (const l of narrow) expect(Array.from(l).length).toBe(50);
  expect(statusLines(status, { specs: 3, goals, maxRounds: 6, now: 60_000, oneline: true }).map(plain)).toEqual([
    "✗ BLOCK  1/3 specs · 1m ago · ✗ b 4431, needs ≤ 2862",
  ]);
});
