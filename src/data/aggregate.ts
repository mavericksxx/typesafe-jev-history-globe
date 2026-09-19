// Era-bars math (ported from reel.html's `eraTarget`), operating over an
// already-bisected slice of the index rather than filtering all events.
import { THEMES, EXT_THEMES } from "./types";
import type { EraSnapshot, HistoryEvent, Theme, ExtTheme, EraTheme } from "./types";

const THEME_SET: ReadonlySet<string> = new Set(THEMES);

/** Reads a snapshot value for any ERA_THEMES key, whether it's a base theme or an extended one. */
export function eraThemeValue(snapshot: EraSnapshot, t: EraTheme): number {
  return THEME_SET.has(t) ? snapshot.themes[t as Theme] : snapshot.ext[t as ExtTheme];
}

/** How far back (in T-space) the era window looks, matching the mockup. */
export const ERA_WINDOW = 0.05;

function zeroThemeRecord(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}
function zeroExtRecord(): Record<ExtTheme, number> {
  return Object.fromEntries(EXT_THEMES.map((t) => [t, 0])) as Record<ExtTheme, number>;
}

/**
 * Aggregate a window of events into the era snapshot the panel bars show.
 * `start`/`end` should be `eventIndex.range(pos - ERA_WINDOW, pos)` — this
 * iterates `all` in place between them and does no filtering, index lookups,
 * or slicing of its own.
 */
export function computeEraSnapshot(
  all: readonly HistoryEvent[],
  start: number,
  end: number,
  pos: number,
  lo: number
): EraSnapshot {
  const themes = zeroThemeRecord();
  const ext = zeroExtRecord();
  let wsum = 0;
  let imp = 0;
  let n = 0;

  for (let i = start; i < end; i++) {
    const e = all[i]!;
    n++;
    const w = (e.minor ? 0.4 : 1) * (1 - ((pos - e.t) / ERA_WINDOW) * 0.6);
    wsum += w;
    imp += e.impact * w;
    for (const t of THEMES) themes[t] += e.th[t] * w;
    for (const t of EXT_THEMES) ext[t] += e.ext[t] * w;
  }
  if (wsum) {
    for (const t of THEMES) themes[t] /= wsum;
    for (const t of EXT_THEMES) ext[t] /= wsum;
  }

  return {
    themes,
    ext,
    impact: wsum ? imp / wsum : 0,
    n,
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
