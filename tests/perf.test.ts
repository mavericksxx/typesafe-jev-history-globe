// Perf regression guard for the dense modern era. Times exactly the
// "globe update + draw prep" work loop.ts does every frame — era snapshot,
// bounded dot-window prep, and density-grid sync/prep — excluding all
// canvas/ctx calls (those need a real browser to mean anything). Run at
// pos=1 on the full 50k synthetic set, since that's where the modern-era
// event density makes per-frame cost matter.
import { describe, expect, it } from "vitest";
import { geoOrthographic } from "d3-geo";
import { generateSynthetic } from "../scripts/gen-synthetic";
import { eventIndex, boundToMostRecent } from "../src/data";
import { computeEraSnapshot, ERA_WINDOW } from "../src/data/aggregate";
import { T } from "../src/data/timescale";
import { THEMES, REGIONS } from "../src/data/types";
import type { HistoryEvent, RawEventRecord, Theme } from "../src/data/types";
import { deriveExtra, regionOf } from "../src/data/derive";
import { mulberry32 } from "../src/data/rng";
import { DOT_FADE_WINDOW, boundDotWindow, prepareDots, makeProjector } from "../src/globe/dots";
import { DensityGrid, prepareDensityCells } from "../src/globe/density";
import { findFocusEvent } from "../src/loop";

const N = 50_000;
// Generous but real: catches an accidental return to O(n)-per-frame (which
// would blow well past this at 50k), without being flaky on a slow CI box.
// A cold, unoptimized single Node run of this measures ~10ms; a real,
// JIT-warmed 60fps loop should do markedly better.
const BUDGET_MS = 25;
/** How many times to time the frame, keeping the FASTEST.
 *
 * A single sample measures how contended the machine was, not how fast the
 * code is: the same unchanged code measured 11-14ms when run alone and
 * 25-49ms inside a full `npm test`, failing five times in one day without a
 * single real regression behind it. Taking the minimum removes that noise —
 * a scheduler hiccup inflates some runs but never all of them, while a
 * genuine O(n)-per-frame regression is slow in every run and still fails.
 * Best-of-N is the usual way to benchmark on a noisy box. */
const RUNS = 5;

function toHistoryEvents(raw: RawEventRecord[]): HistoryEvent[] {
  const rng = mulberry32(42);
  return raw.map((r, idx) => {
    const ext = deriveExtra(r.text, r.th, rng);
    const top = THEMES.reduce((a, b) => (r.th[a] >= r.th[b] ? a : b)) as Theme;
    return {
      idx,
      year: r.year,
      t: T(r.year),
      text: r.text,
      lat: r.lat,
      lon: r.lon,
      locKind: r.locKind,
      th: r.th,
      ext,
      top,
      impact: r.impact,
      conf: 0.7,
      region: regionOf(r.lat, r.lon),
      real: r.real,
      minor: r.minor,
    };
  });
}

describe("per-frame globe update+draw-prep cost at pos=1 on 50k events", () => {
  const raw = generateSynthetic(N);
  const events = toHistoryEvents(raw);
  // findFocusEvent (src/loop.ts) reads the module-level `eventIndex`
  // singleton directly, so the bench has to populate that one, not a
  // throwaway instance.
  eventIndex.setEvents(events);
  const index = eventIndex;
  const all = index.all();
  const pos = 1; // T(2026) — the densest point in the modern-skewed distribution

  it("stays within budget for one frame's worth of prep work (best of several runs)", () => {
    const projection = geoOrthographic().clipAngle(90).precision(0.4).translate([300, 300]).scale(300 * 0.34);
    const rot: [number, number] = [-10, -25];
    projection.rotate(rot);
    const center: [number, number] = [-rot[0], -rot[1]];
    const project = makeProjector(projection, center);

    /** One frame's worth of work, timed. A fresh DensityGrid each run so
     * every sample does the same build rather than an incremental update. */
    function timeOneFrame() {
      const grid = new DensityGrid();
      const start = performance.now();

      const lo = pos - ERA_WINDOW;
      const [eraWindowStart, eraWindowEnd] = index.range(lo, pos);
      const [eraStart, eraEnd] = boundToMostRecent(eraWindowStart, eraWindowEnd, 4000);
      const snapshot = computeEraSnapshot(all, eraStart, eraEnd, pos, lo);

      const [windowStart, windowEnd] = index.range(pos - DOT_FADE_WINDOW, pos);
      const [dotStart, dotEnd] = boundDotWindow(windowStart, windowEnd);
      const dots = prepareDots(all, dotStart, dotEnd, pos, project);

      grid.syncTo(all, index.countUpTo(pos));
      const cells = prepareDensityCells(grid, project, 6);

      const focus = findFocusEvent(pos);

      const elapsed = performance.now() - start;
      return { elapsed, windowStart, windowEnd, dotStart, dotEnd, dots, eraWindowStart, eraWindowEnd, eraStart, eraEnd, snapshot, cells, focus };
    }

    const samples = Array.from({ length: RUNS }, timeOneFrame);
    const times = samples.map((s) => s.elapsed);
    const elapsed = Math.min(...times);
    const { windowStart, windowEnd, dotStart, dotEnd, dots, eraWindowStart, eraWindowEnd, eraStart, eraEnd, snapshot, cells, focus } =
      samples[0]!;

    // Sanity: this frame is actually exercising the dense era, and the
    // dot window is in fact the thing MAX_VISIBLE_DOTS bounds (without the
    // cap, the pre-bound window here is far larger than 3000).
    expect(windowEnd - windowStart).toBeGreaterThan(3000);
    expect(dotEnd - dotStart).toBeLessThanOrEqual(3000);
    expect(dots.length).toBeGreaterThan(0);
    expect(eraWindowEnd - eraWindowStart).toBeGreaterThan(4000);
    expect(eraEnd - eraStart).toBeLessThanOrEqual(4000);
    expect(snapshot.n).toBeGreaterThan(0);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(36 * 18);
    expect(focus).not.toBeNull();

    // eslint-disable-next-line no-console
    console.log(
      `[perf] globe update+draw-prep @ pos=1, n=${N}: best ${elapsed.toFixed(2)}ms ` +
        `of ${RUNS} [${times.map((t) => t.toFixed(1)).join(", ")}] ` +
        `(dot window ${dotEnd - dotStart}/${windowEnd - windowStart}, era n=${snapshot.n}, density cells=${cells.length})`
    );

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("region index coverage sanity (guards against a silent regionOf/REGIONS drift)", () => {
    for (const e of events.slice(0, 200)) {
      expect(REGIONS).toContain(e.region);
    }
  });
});
