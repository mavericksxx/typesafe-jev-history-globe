// The era snapshot panel: the THEMES bars ease toward the current
// EraSnapshot every frame, plus the header's range text. Ported from
// reel.html's per-frame era-bar block inside `frame()`; the region/mood
// blocks and the impact/conf/events footer it also had were removed
// (see src/data/aggregate.ts for the matching removal of their aggregation).
import { ERA_THEMES } from "../data/types";
import type { EraSnapshot, EraTheme } from "../data/types";
import { eraThemeValue } from "../data/aggregate";
import { fmtYear, T } from "../data/timescale";
import { THEME_COLORS } from "../themes";
import { makeBars, setBars } from "./bars";
import type { BarRow } from "./bars";

export interface EraPanelEls {
  themeBars: HTMLElement;
  range: HTMLElement;
}

export interface EraUpdateOpts {
  reducedMotion: boolean;
  playing: boolean;
  now: number;
}

/** Below this many events in the era window, the range line names the count
 * rather than leaving a thin bar chart to look like a rendering bug. */
const SPARSE_ERA_EVENTS = 30;

function zero<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export class EraPanel {
  private readonly els: EraPanelEls;
  private readonly themeRows: BarRow<EraTheme>[];
  private cur = zero(ERA_THEMES);

  constructor(els: EraPanelEls) {
    this.els = els;
    this.themeRows = makeBars(els.themeBars, ERA_THEMES, THEME_COLORS);
  }

  /** Eases the panel toward `snapshot` and re-renders it. Returns the winning top-level theme. */
  update(snapshot: EraSnapshot, pos: number, dt: number, opts: EraUpdateOpts): EraTheme {
    const k = opts.reducedMotion ? 1 : 1 - Math.pow(0.02, dt);

    for (const t of ERA_THEMES) {
      const target = eraThemeValue(snapshot, t);
      const jitter = !opts.reducedMotion && opts.playing ? Math.sin(opts.now / 300 + t.length) * 0.012 : 0;
      this.cur[t] = Math.max(0, Math.min(1, this.cur[t] + (target + jitter - this.cur[t]) * k));
    }
    const topTheme = setBars(this.themeRows, this.cur);

    const range = `${fmtYear(Math.round(T.invert(Math.max(0, snapshot.lo))))} – ${fmtYear(Math.round(T.invert(pos)))}`;
    // Ancient eras are genuinely sparse in the real (Wikidata-sourced) corpus
    // — not a bug. Below this, say so instead of leaving it to look broken.
    this.els.range.textContent =
      snapshot.n > 0 && snapshot.n < SPARSE_ERA_EVENTS ? `${range} · ${snapshot.n} events recorded` : range;

    return topTheme;
  }
}
