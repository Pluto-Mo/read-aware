import { describe, expect, test } from "bun:test";
import { resolvePageTurnTap } from "./page-turn-tap";

const width = 1000;
const tap = (x: number, options: Partial<Parameters<typeof resolvePageTurnTap>[0]> = {}) =>
  resolvePageTurnTap({ x, width, zones: "sides", zoneWidth: "medium", rtl: false, ...options });

describe("resolvePageTurnTap", () => {
  test("zones off leave every tap to the chrome toggle", () => {
    for (const x of [0, 100, 500, 900, 1000]) expect(tap(x, { zones: "off" })).toBeNull();
  });

  test("sides: left goes back, right reads on, the center band toggles the chrome", () => {
    expect(tap(10)).toEqual({ step: -1, side: -1 });
    expect(tap(990)).toEqual({ step: 1, side: 1 });
    expect(tap(500)).toBeNull();
  });

  test("zone width sets each boundary on both sides of it", () => {
    // medium = 30%: 299 is in the left zone, 300 the first center pixel.
    expect(tap(299)?.step).toBe(-1);
    expect(tap(300)).toBeNull();
    expect(tap(700)).toBeNull();
    expect(tap(701)?.step).toBe(1);
    expect(tap(199, { zoneWidth: "narrow" })?.step).toBe(-1);
    expect(tap(200, { zoneWidth: "narrow" })).toBeNull();
    expect(tap(399, { zoneWidth: "wide" })?.step).toBe(-1);
    expect(tap(400, { zoneWidth: "wide" })).toBeNull();
  });

  test("right-to-left books advance from the left zone", () => {
    expect(tap(10, { rtl: true })).toEqual({ step: 1, side: -1 });
    expect(tap(990, { rtl: true })).toEqual({ step: -1, side: 1 });
  });

  test("forward: both zones read on and pan toward the next page", () => {
    expect(tap(10, { zones: "forward" })).toEqual({ step: 1, side: 1 });
    expect(tap(990, { zones: "forward" })).toEqual({ step: 1, side: 1 });
    expect(tap(10, { zones: "forward", rtl: true })).toEqual({ step: 1, side: -1 });
    expect(tap(500, { zones: "forward" })).toBeNull();
  });

  test("an unmeasured reader never turns", () => {
    expect(tap(10, { width: 0 })).toBeNull();
  });
});
