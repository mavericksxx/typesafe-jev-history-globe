import { describe, expect, it } from "vitest";
import { computeEraSnapshot, computeHistogram, ERA_WINDOW, eraThemeValue } from "../src/data/aggregate";
import { THEMES, EXT_THEMES } from "../src/data/types";
import type { HistoryEvent, Theme, ExtTheme } from "../src/data/types";

function zeroTheme(overrides: Partial<Record<Theme, number>> = {}): Record<Theme, number> {
  return { ...(Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>), ...overrides };
}
function zeroExt(overrides: Partial<Record<ExtTheme, number>> = {}): Record<ExtTheme, number> {
  return { ...(Object.fromEntries(EXT_THEMES.map((t) => [t, 0])) as Record<ExtTheme, number>), ...overrides };
}

/** computeEraSnapshot takes index bounds into an array (never a slice) —
 * this helper keeps the existing tests terse by passing the whole array. */
function snapshotOf(events: readonly HistoryEvent[], pos: number, lo: number) {
  return computeEraSnapshot(events, 0, events.length, pos, lo);
}

function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    idx: 0,
    year: 1000,
    t: 0.5,
    text: "",
    lat: 0,
    lon: 0,
    locKind: "point",
    th: zeroTheme(),
    ext: zeroExt(),
    top: "politics",
    impact: 1,
    conf: 1,
    region: "europe",
    real: true,
    minor: false,
    ...overrides,
  };
}

describe("computeEraSnapshot", () => {
  it("returns all zeros and n=0 for an empty window", () => {
    const snap = snapshotOf([], 0.5, 0.5 - ERA_WINDOW);
    expect(snap.n).toBe(0);
    expect(snap.impact).toBe(0);
    for (const t of THEMES) expect(snap.themes[t]).toBe(0);
    for (const r of Object.values(snap.region)) expect(r).toBe(0);
  });

  it("a single event right at pos dominates its own theme fully", () => {
    const pos = 0.5;
    const e = makeEvent({ t: pos, th: zeroTheme({ war: 1 }), impact: 3, region: "africa" });
    const snap = snapshotOf([e], pos, pos - ERA_WINDOW);
    expect(snap.n).toBe(1);
    expect(snap.themes.war).toBeCloseTo(1);
    expect(snap.impact).toBeCloseTo(3);
    expect(snap.region.africa).toBeCloseTo(1);
    expect(snap.region.europe).toBe(0);
  });

  it("weights minor events less than major ones", () => {
    const pos = 0.5;
    const major = makeEvent({ t: pos, th: zeroTheme({ science: 1 }), minor: false });
    const minor = makeEvent({ t: pos, th: zeroTheme({ science: 0 }), minor: true });
    const snap = snapshotOf([major, minor], pos, pos - ERA_WINDOW);
    // major weight 1 vs minor weight 0.4 -> science should lean strongly toward 1, not 0.5.
    expect(snap.themes.science).toBeGreaterThan(0.6);
  });

  it("weights older events in the window less than events right at pos", () => {
    const pos = 0.5;
    const recent = makeEvent({ t: pos, th: zeroTheme({ culture: 1 }) });
    const older = makeEvent({ t: pos - ERA_WINDOW * 0.9, th: zeroTheme({ culture: 1 }) });
    const snapBoth = snapshotOf([older, recent], pos, pos - ERA_WINDOW);
    const snapRecentOnly = snapshotOf([recent], pos, pos - ERA_WINDOW);
    // Adding a heavily-decayed older event of the same theme barely moves the average.
    expect(snapBoth.themes.culture).toBeLessThanOrEqual(snapRecentOnly.themes.culture);
    expect(snapBoth.themes.culture).toBeGreaterThan(0.5);
  });

  it("keeps mood values within [0, 1]", () => {
    const pos = 0.5;
    const chaos = makeEvent({ t: pos, th: zeroTheme({ war: 1 }), ext: zeroExt({ disaster: 1, revolution: 1 }) });
    const snap = snapshotOf([chaos], pos, pos - ERA_WINDOW);
    for (const v of Object.values(snap.mood)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("only looks at events within [start, end), never outside it", () => {
    const pos = 0.5;
    const inWindow = makeEvent({ t: pos, th: zeroTheme({ war: 1 }) });
    const outOfWindow = makeEvent({ t: pos, th: zeroTheme({ religion: 1 }) });
    const all = [outOfWindow, inWindow, outOfWindow];
    const snap = computeEraSnapshot(all, 1, 2, pos, pos - ERA_WINDOW);
    expect(snap.n).toBe(1);
    expect(snap.themes.war).toBeCloseTo(1);
    expect(snap.themes.religion).toBe(0);
  });
});

describe("eraThemeValue", () => {
  it("reads base themes from .themes and extended themes from .ext", () => {
    const snap = snapshotOf(
      [makeEvent({ t: 0.5, th: zeroTheme({ war: 0.7 }), ext: zeroExt({ empire: 0.3 }) })],
      0.5,
      0.5 - ERA_WINDOW
    );
    expect(eraThemeValue(snap, "war")).toBeCloseTo(0.7);
    expect(eraThemeValue(snap, "empire")).toBeCloseTo(0.3);
  });
});

describe("computeHistogram", () => {
  it("buckets events by their T position", () => {
    const events = [makeEvent({ t: 0 }), makeEvent({ t: 0.5 }), makeEvent({ t: 0.5 }), makeEvent({ t: 0.999 })];
    const hist = computeHistogram(events, 10);
    expect(hist).toHaveLength(10);
    expect(hist[0]).toBe(1);
    expect(hist[5]).toBe(2);
    expect(hist[9]).toBe(1);
    expect(hist.reduce((a, b) => a + b, 0)).toBe(events.length);
  });

  it("clamps t=1 into the last bucket instead of overflowing", () => {
    const hist = computeHistogram([makeEvent({ t: 1 })], 4);
    expect(hist[3]).toBe(1);
  });
});
