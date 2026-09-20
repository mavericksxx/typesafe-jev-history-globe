import { describe, expect, it } from "vitest";
import { THEMES } from "../src/data/types";
import type { HistoryEvent, LocKind, Theme } from "../src/data/types";
import { prepareDots, sparseSizeScale, sparseAlphaFloor } from "../src/globe/dots";
import type { Project } from "../src/globe/dots";

function zeroTheme(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}

function makeEvent(idx: number, t: number, locKind: LocKind = "point"): HistoryEvent {
  return {
    idx,
    year: idx,
    t,
    text: "",
    lat: 0,
    lon: 0,
    locKind,
    th: zeroTheme(),
    ext: { disaster: 0, exploration: 0, revolution: 0, empire: 0 },
    top: "politics",
    impact: 0,
    conf: 1,
    region: "europe",
    real: true,
    minor: false,
  };
}

const identityProject: Project = (lon, lat) => [lon, lat];

describe("prepareDots / locKind-based styling", () => {
  it("flags country-centroid events as approximate, points as not", () => {
    const events = [makeEvent(0, 0, "point"), makeEvent(1, 0, "country")];
    const dots = prepareDots(events, 0, 2, 0, identityProject);
    expect(dots.find((d) => d.x === events[0]!.lon)).toBeTruthy();
    const byIdx = dots;
    expect(byIdx[0]!.approximate).toBe(false);
    expect(byIdx[1]!.approximate).toBe(true);
  });

  it("skips locKind 'none' entirely", () => {
    const events = [makeEvent(0, 0, "none")];
    const dots = prepareDots(events, 0, 1, 0, identityProject);
    expect(dots.length).toBe(0);
  });
});

describe("sparseSizeScale", () => {
  it("is 1 (unchanged) once the window is no longer sparse", () => {
    expect(sparseSizeScale(80)).toBe(1);
    expect(sparseSizeScale(5000)).toBe(1);
  });

  it("grows as the window count shrinks toward 0", () => {
    const at40 = sparseSizeScale(40);
    const at5 = sparseSizeScale(5);
    expect(at40).toBeGreaterThan(1);
    expect(at5).toBeGreaterThan(at40);
    expect(sparseSizeScale(0)).toBeGreaterThan(at5);
  });
});

describe("sparseAlphaFloor", () => {
  it("is 0 once the window is no longer sparse", () => {
    expect(sparseAlphaFloor(80)).toBe(0);
    expect(sparseAlphaFloor(5000)).toBe(0);
  });

  it("rises as the window count shrinks toward 0", () => {
    const at40 = sparseAlphaFloor(40);
    const at5 = sparseAlphaFloor(5);
    expect(at40).toBeGreaterThan(0);
    expect(at5).toBeGreaterThan(at40);
  });
});

describe("prepareDots applies the sparse size scale to radius", () => {
  it("a sparse window yields a larger radius than a dense one for the same event", () => {
    const sparseEvents = [makeEvent(0, 0, "point")];
    const denseEvents = Array.from({ length: 200 }, (_, i) => makeEvent(i, 0, "point"));
    const sparseDots = prepareDots(sparseEvents, 0, 1, 0, identityProject);
    const denseDots = prepareDots(denseEvents, 0, 200, 0, identityProject);
    expect(sparseDots[0]!.r).toBeGreaterThan(denseDots[0]!.r);
  });
});
