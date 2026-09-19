// Era-bars math (ported from reel.html's `eraTarget`), operating over an
// already-bisected slice of the index rather than filtering all events.
import { THEMES, EXT_THEMES, REGIONS } from "./types";
import type { EraSnapshot, HistoryEvent, Theme, ExtTheme, Region, EraTheme } from "./types";

const THEME_SET: ReadonlySet<string> = new Set(THEMES);

/** Reads a snapshot value for any ERA_THEMES key, whether it's a base theme or an extended one. */
export function eraThemeValue(snapshot: EraSnapshot, t: EraTheme): number {
  return THEME_SET.has(t) ? snapshot.themes[t as Theme] : snapshot.ext[t as ExtTheme];
}

/** How far back (in T-space) the era window looks, matching the mockup. */
export const ERA_WINDOW = 0.05;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function zeroThemeRecord(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}
function zeroExtRecord(): Record<ExtTheme, number> {
  return Object.fromEntries(EXT_THEMES.map((t) => [t, 0])) as Record<ExtTheme, number>;
}
function zeroRegionRecord(): Record<Region, number> {
  return Object.fromEntries(REGIONS.map((r) => [r, 0])) as Record<Region, number>;
}

/**
 * Aggregate a window of events into the era snapshot the panel bars show.
 * `windowEvents` should be `eventIndex.range(pos - ERA_WINDOW, pos)` — this
 * function does no filtering or index lookups of its own.
 */
export function computeEraSnapshot(
  windowEvents: readonly HistoryEvent[],
  pos: number,
  lo: number
): EraSnapshot {
  const themes = zeroThemeRecord();
  const ext = zeroExtRecord();
  const region = zeroRegionRecord();
  let wsum = 0;
  let imp = 0;

  for (const e of windowEvents) {
    const w = (e.minor ? 0.4 : 1) * (1 - ((pos - e.t) / ERA_WINDOW) * 0.6);
    wsum += w;
    imp += e.impact * w;
    for (const t of THEMES) themes[t] += e.th[t] * w;
    for (const t of EXT_THEMES) ext[t] += e.ext[t] * w;
    region[e.region] += w;
  }
  if (wsum) {
    for (const t of THEMES) themes[t] /= wsum;
    for (const t of EXT_THEMES) ext[t] /= wsum;
  }
  // Share of the window's total weight (not share of the top region), so an
  // empty region reads as 0 instead of every region racing toward the max.
  const regionRel = zeroRegionRecord();
  for (const r of REGIONS) regionRel[r] = wsum ? region[r] / wsum : 0;

  const mood = {
    expansion: clamp01(0.5 * ext.empire + 0.3 * ext.exploration + 0.2 * themes.economy),
    stability: clamp01(0.55 * themes.politics + 0.3 * (1 - themes.war) + 0.15 * (1 - ext.revolution)),
    upheaval: clamp01(0.5 * themes.war + 0.35 * ext.revolution + 0.15 * ext.disaster),
    collapse: clamp01(0.55 * ext.disaster + 0.3 * themes.war - 0.15 * themes.economy),
  };

  return {
    themes,
    ext,
    region: regionRel,
    mood,
    impact: wsum ? imp / wsum : 0,
    n: windowEvents.length,
    lo,
  };
}

/** Fixed-bucket histogram of event density over T-space, for the timeline. */
export function computeHistogram(events: readonly HistoryEvent[], bucketCount: number): number[] {
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const e of events) {
    const i = Math.min(bucketCount - 1, Math.max(0, Math.floor(e.t * bucketCount)));
    buckets[i]!++;
  }
  return buckets;
}
