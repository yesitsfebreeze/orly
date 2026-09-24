import { expect, test } from "bun:test";
import { goalBanners, owlBlock, statusBar } from "../src/banner.ts";

test("the banner spreads one verdict line over four owl rows", () => {
  const out = owlBlock(statusBar({ block: true, line: "orly? BLOCK · specs 3/5 · coverage 0.8 · next=run tests · hazard 0.6" }));
  expect(out.split("\n")).toEqual([
    "   |  , .  BLOCK · specs 3/5",
    "   | {@,@} coverage 0.8",
    "   | /) )  next=run tests",
    "   |  '\"   hazard 0.6",
  ]);
});

test("each goal gets a stat block and a banner that scrolls a long text", () => {
  const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
  const goals = [{ text: "short", specs: ["a", "b"] }, { text: "0123456789abcdef", specs: ["c"] }];
  const status = { at: "", block: true, line: "", unmet: [{ id: "b", found: "p=0.1" }] };
  const [one, two] = goalBanners(goals, status, 8, 0, 1).map(plain);
  expect(one).toBe("▕1/2▏ 1. short");
  const loop = "0123456789abcdef   ·   ".repeat(2); // row 2 starts 17 columns in
  expect(two).toBe(`▕1/1▏ 2. ${loop.slice(17, 25)}`);
  // One step later the window has moved one column; before a judgment the block has no count.
  expect(plain(goalBanners(goals, status, 8, 1, 1)[1])).toBe(`▕1/1▏ 2. ${loop.slice(18, 26)}`);
  expect(plain(goalBanners(goals, null, 8, 0, 1)[0])).toBe("▕–/2▏ 1. short");
});
