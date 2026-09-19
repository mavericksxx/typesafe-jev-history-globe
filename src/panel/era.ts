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

    this.els.range.textContent = `${fmtYear(Math.round(T.invert(Math.max(0, snapshot.lo))))} – ${fmtYear(Math.round(T.invert(pos)))}`;

    return topTheme;
  }
}
