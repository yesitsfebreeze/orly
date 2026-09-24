import { expect, test } from "bun:test";
import { owlBlock, statusBar } from "../src/banner.ts";

test("the banner spreads one verdict line over four owl rows", () => {
  const out = owlBlock(statusBar({ block: true, line: "orly? BLOCK · specs 3/5 · coverage 0.8 · next=run tests · hazard 0.6" }));
  expect(out.split("\n")).toEqual([
    "   |  , .  BLOCK · specs 3/5",
    "   | {@,@} coverage 0.8",
    "   | /) )  next=run tests",
    "   |  '\"   hazard 0.6",
  ]);
});
