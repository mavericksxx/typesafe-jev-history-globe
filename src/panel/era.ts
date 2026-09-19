// The era snapshot panel: theme/region/mood bars that ease toward the
// current EraSnapshot every frame, plus impact, confidence and range text.
// Ported from reel.html's per-frame era-bar block inside `frame()`.
import { ERA_THEMES, REGIONS, MOODS } from "../data/types";
import type { EraSnapshot, EraTheme, Region, Mood } from "../data/types";
import { eraThemeValue } from "../data/aggregate";
import { fmtYear, T } from "../data/timescale";
import { THEME_COLORS } from "../themes";
import { makeBars, setBars, setBarsRanked, makeImpact, setImpact } from "./bars";
import type { BarRow } from "./bars";

export interface EraPanelEls {
  themeBars: HTMLElement;
  regionBars: HTMLElement;
  moodBars: HTMLElement;
  impact: HTMLElement;
  conf: HTMLElement;
  n: HTMLElement;
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
  private readonly regionRows: BarRow<Region>[];
  private readonly moodRows: BarRow<Mood>[];
  private readonly impactCells: HTMLElement[];
  private cur = zero(ERA_THEMES);
  private regionCur = zero(REGIONS);
  private moodCur = zero(MOODS);
  private impactCur = 0;

  constructor(els: EraPanelEls) {
    this.els = els;
    this.themeRows = makeBars(els.themeBars, ERA_THEMES, THEME_COLORS);
    this.regionRows = makeBars(els.regionBars, REGIONS);
    this.moodRows = makeBars(els.moodBars, MOODS);
    this.impactCells = makeImpact(els.impact);
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

    for (const r of REGIONS) {
      this.regionCur[r] = Math.max(0, Math.min(1, this.regionCur[r] + (snapshot.region[r] - this.regionCur[r]) * k));
    }
    setBarsRanked(this.els.regionBars, this.regionRows, this.regionCur);

    for (const m of MOODS) {
      this.moodCur[m] = Math.max(0, Math.min(1, this.moodCur[m] + (snapshot.mood[m] - this.moodCur[m]) * k));
    }
    setBarsRanked(this.els.moodBars, this.moodRows, this.moodCur);

    this.impactCur += (snapshot.impact - this.impactCur) * k;
    setImpact(this.impactCells, this.impactCur);

    const spread = ERA_THEMES.map((t) => this.cur[t]).sort((a, b) => b - a);
    const conf = Math.max(0, Math.min(1, (spread[0]! - spread[2]!) * 1.6));
    this.els.conf.textContent = `conf ${conf.toFixed(2)}`;
    this.els.n.textContent = `${snapshot.n} events`;
    this.els.range.textContent = `${fmtYear(Math.round(T.invert(Math.max(0, snapshot.lo))))} – ${fmtYear(Math.round(T.invert(pos)))}`;

    return topTheme;
  }
}
