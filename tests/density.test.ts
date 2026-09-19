import { describe, expect, it } from "vitest";
import { DensityGrid } from "../src/globe/density";
import { THEMES } from "../src/data/types";
import type { HistoryEvent, Theme } from "../src/data/types";

function zeroTheme(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}

function makeEvent(idx: number, lon: number, lat: number, top: Theme = "politics"): HistoryEvent {
  return {
    idx,
    year: idx,
    t: idx / 1000,
    text: "",
    lat,
    lon,
    locKind: "point",
    th: zeroTheme(),
    ext: { disaster: 0, exploration: 0, revolution: 0, empire: 0 },
    top,
    impact: 1,
    conf: 1,
    region: "europe",
    real: false,
    minor: false,
  };
}

/** Sums every cell/theme slot — a cheap way to check "how many events are folded in". */
function totalCount(grid: DensityGrid): number {
  let sum = 0;
  for (const v of grid.snapshotCounts()) sum += v;
  return sum;
}

describe("DensityGrid.syncTo", () => {
  it("starts empty", () => {
    const grid = new DensityGrid();
    expect(totalCount(grid)).toBe(0);
    expect(grid.syncedIndex).toBe(0);
  });

  it("syncs forward incrementally", () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent(i, (i % 36) * 10 - 180, 0));
    const grid = new DensityGrid();
    grid.syncTo(events, 40);
    expect(grid.syncedIndex).toBe(40);
    expect(totalCount(grid)).toBe(40);
    grid.syncTo(events, 100);
    expect(totalCount(grid)).toBe(100);
  });

  it("syncs backward by decrementing when the delta is small relative to the target", () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent(i, (i % 36) * 10 - 180, 0));
    const grid = new DensityGrid();
    grid.syncTo(events, 90);
    grid.syncTo(events, 80); // delta 10, target 80 -> delta < target, incremental path
    expect(grid.syncedIndex).toBe(80);
    expect(totalCount(grid)).toBe(80);
  });

  it("rebuilds from scratch on a large backward jump and lands on the same result as a fresh grid", () => {
    const events = Array.from({ length: 50_000 }, (_, i) => makeEvent(i, (i % 36) * 10 - 180, ((i * 7) % 18) * 10 - 90));
    const grid = new DensityGrid();
    grid.syncTo(events, 45_000);
    // delta = 44_500, targetIdx = 500 -> delta > targetIdx, must take the rebuild path.
    grid.syncTo(events, 500);
    expect(grid.syncedIndex).toBe(500);
    expect(totalCount(grid)).toBe(500);

    const fresh = new DensityGrid();
    fresh.syncTo(events, 500);
    expect(Array.from(grid.snapshotCounts())).toEqual(Array.from(fresh.snapshotCounts()));
  });

  it("a forward jump larger than the current index still only adds the new range once", () => {
    const events = Array.from({ length: 50_000 }, (_, i) => makeEvent(i, (i % 36) * 10 - 180, 0));
    const grid = new DensityGrid();
    grid.syncTo(events, 500);
    grid.syncTo(events, 45_000); // delta 44_500, targetIdx 45_000 -> delta < targetIdx, incremental add
    expect(totalCount(grid)).toBe(45_000);
  });

  it("reset clears everything", () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i, 0, 0));
    const grid = new DensityGrid();
    grid.syncTo(events, 10);
    grid.reset();
    expect(grid.syncedIndex).toBe(0);
    expect(totalCount(grid)).toBe(0);
  });
});
