import { describe, expect, it, beforeEach } from "vitest";
import { EventIndex } from "../src/data";
import { T } from "../src/data/timescale";
import { THEMES, EXT_THEMES } from "../src/data/types";
import type { HistoryEvent, Theme, ExtTheme } from "../src/data/types";

function zeroTheme(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}
function zeroExt(): Record<ExtTheme, number> {
  return Object.fromEntries(EXT_THEMES.map((t) => [t, 0])) as Record<ExtTheme, number>;
}

function makeEvent(year: number, idx: number, overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    idx,
    year,
    t: T(year),
    text: `event ${idx}`,
    lat: 0,
    lon: 0,
    locKind: "point",
    th: zeroTheme(),
    ext: zeroExt(),
    top: "politics",
    impact: 1,
    conf: 0.8,
    region: "europe",
    real: false,
    minor: false,
    ...overrides,
  };
}

describe("EventIndex", () => {
  let index: EventIndex;
  const YEARS = [-2500, -1000, -500, 0, 500, 1000, 1500, 1750, 1900, 1950, 2000, 2020];

  beforeEach(() => {
    index = new EventIndex();
    // Insert out of order to prove setEvents sorts by t.
    const shuffled = [...YEARS].reverse();
    index.setEvents(shuffled.map((y, i) => makeEvent(y, i)));
  });

  it("sorts events by T(year), not insertion order", () => {
    const all = index.all();
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.t).toBeGreaterThanOrEqual(all[i - 1]!.t);
    }
    expect(all.map((e) => e.year)).toEqual(YEARS);
  });

  it("countUpTo counts events with t <= given t", () => {
    expect(index.countUpTo(T(-2500))).toBe(1);
    expect(index.countUpTo(T(0))).toBe(4);
    expect(index.countUpTo(T(2020))).toBe(YEARS.length);
    expect(index.countUpTo(-1)).toBe(0);
    expect(index.countUpTo(2)).toBe(YEARS.length);
  });

  it("range returns exactly the events within [lo, hi]", () => {
    const slice = index.range(T(500), T(1900));
    expect(slice.map((e) => e.year)).toEqual([500, 1000, 1500, 1750, 1900]);
  });

  it("range is empty when hi < lo", () => {
    expect(index.range(T(1900), T(500))).toEqual([]);
  });

  it("range with an out-of-domain window still clamps sensibly", () => {
    expect(index.range(-1, 2).length).toBe(YEARS.length);
    expect(index.range(1.5, 2)).toEqual([]);
  });

  it("upperBound/lowerBound agree with a manual scan (oracle check)", () => {
    const all = index.all();
    for (const probe of [T(-2500), T(-100), T(1000), T(2020), 0.5]) {
      const expectedLower = all.findIndex((e) => e.t >= probe);
      const expectedUpper = all.findIndex((e) => e.t > probe);
      expect(index.lowerBound(probe)).toBe(expectedLower === -1 ? all.length : expectedLower);
      expect(index.upperBound(probe)).toBe(expectedUpper === -1 ? all.length : expectedUpper);
    }
  });
});
