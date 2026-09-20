// The "history accumulating" density cue, as a fixed-size lat/lon cell grid
// instead of a screen-space canvas trail. A screen-space additive trail
// doesn't rotate with the globe and decays in under half a second regardless
// of playback speed; a grid keyed by geography is rotation-correct (it
// projects like everything else on the globe) and represents genuine
// accumulation — a cell's count only grows as `pos` passes more events in
// it, updated incrementally (only the delta since last sync is touched) for
// a normal advance or scrub, and rebuilt from scratch only when that delta
// walk would cost more than just recomputing the (smaller) target range —
// see syncTo.
import { THEMES } from "../data/types";
import type { HistoryEvent, Theme } from "../data/types";
import type { Project } from "./dots";

const LON_CELLS = 36; // 10° per cell
const LAT_CELLS = 18; // 10° per cell
const THEME_COUNT = THEMES.length;
const THEME_SLOT: Record<Theme, number> = Object.fromEntries(THEMES.map((t, i) => [t, i])) as Record<Theme, number>;

function cellIndex(lon: number, lat: number): number {
  const lonBucket = Math.min(LON_CELLS - 1, Math.max(0, Math.floor(((lon + 180) / 360) * LON_CELLS)));
  const latBucket = Math.min(LAT_CELLS - 1, Math.max(0, Math.floor(((90 - lat) / 180) * LAT_CELLS)));
  return latBucket * LON_CELLS + lonBucket;
}

function cellCenter(cell: number): [lon: number, lat: number] {
  const lonBucket = cell % LON_CELLS;
  const latBucket = Math.floor(cell / LON_CELLS);
  const lon = (lonBucket + 0.5) * (360 / LON_CELLS) - 180;
  const lat = 90 - (latBucket + 0.5) * (180 / LAT_CELLS);
  return [lon, lat];
}

/** Accumulated per-cell, per-theme counts of events with t <= the position
 * last synced to. Incrementally maintained: `syncTo` only touches the
 * events between the old and new position, in either direction. */
export class DensityGrid {
  private readonly counts = new Float32Array(LON_CELLS * LAT_CELLS * THEME_COUNT);
  private idx = 0;

  /** Number of events currently folded into the grid (i.e. `all[0..idx)`). */
  get syncedIndex(): number {
    return this.idx;
  }

  reset(): void {
    this.counts.fill(0);
    this.idx = 0;
  }

  private add(e: HistoryEvent, delta: number): void {
    if (e.locKind === "none") return;
    const cell = cellIndex(e.lon, e.lat);
    const i = cell * THEME_COUNT + THEME_SLOT[e.top];
    this.counts[i] = this.counts[i]! + delta;
  }

  /** Brings the grid to represent exactly `all[0..targetIdx)`. A large
   * backward jump (e.g. scrolling from the modern era back to antiquity)
   * would otherwise mean walking every event *removed* one at a time; if
   * that walk is bigger than just rebuilding the (much smaller) target
   * range from scratch, do that instead. */
  syncTo(all: readonly HistoryEvent[], targetIdx: number): void {
    const delta = Math.abs(targetIdx - this.idx);
    if (delta > targetIdx) {
      this.reset();
      for (let i = 0; i < targetIdx; i++) this.add(all[i]!, 1);
      this.idx = targetIdx;
      return;
    }
    if (targetIdx > this.idx) {
      for (let i = this.idx; i < targetIdx; i++) this.add(all[i]!, 1);
    } else if (targetIdx < this.idx) {
      for (let i = targetIdx; i < this.idx; i++) this.add(all[i]!, -1);
    }
    this.idx = targetIdx;
  }

  /** Read-only view of the raw per-cell, per-theme counts, for prepareDensityCells. */
  snapshotCounts(): Readonly<Float32Array> {
    return this.counts;
  }
}

export interface DensityCell {
  x: number;
  y: number;
  size: number;
  theme: Theme;
  alpha: number;
}

/** Pure prep pass over the fixed cell grid (LON_CELLS*LAT_CELLS = 648 cells
 * regardless of dataset size) — cheap enough to run every frame, and safe to
 * call from Node for the perf test. */
/** With the real (15.7k-event) dataset, ancient eras light up only a
 * handful of the 648 cells — the glow registers but reads as faint dust
 * rather than an accumulating trail. Below this many active cells, boost
 * both spread and intensity so the sparse glow stays legible. */
const SPARSE_ACTIVE_CELLS = 20;
const SPARSE_SIZE_BOOST = 1.6;
const SPARSE_ALPHA_BOOST = 1.5;

export function prepareDensityCells(grid: DensityGrid, project: Project, cellPixelSize: number): DensityCell[] {
  const out: DensityCell[] = [];
  const snapshot = grid.snapshotCounts();
  let max = 1;
  for (const v of snapshot) if (v > max) max = v;
  for (let cell = 0; cell < LON_CELLS * LAT_CELLS; cell++) {
    let cellMax = 0;
    let dominant: Theme = THEMES[0]!;
    for (const t of THEMES) {
      const v = snapshot[cell * THEME_COUNT + THEME_SLOT[t]]!;
      if (v > cellMax) {
        cellMax = v;
        dominant = t;
      }
    }
    if (cellMax <= 0) continue;
    const [lon, lat] = cellCenter(cell);
    const p = project(lon, lat);
    if (!p) continue;
    const alpha = Math.min(0.5, 0.06 + 0.44 * (cellMax / max));
    out.push({ x: p[0], y: p[1], size: cellPixelSize, theme: dominant, alpha });
  }
  // Sparse-era boost: only ever makes an already-sparse glow more visible,
  // never touches the dense modern eras this was originally tuned for.
  if (out.length > 0 && out.length <= SPARSE_ACTIVE_CELLS) {
    for (const c of out) {
      c.size *= SPARSE_SIZE_BOOST;
      c.alpha = Math.min(0.7, c.alpha * SPARSE_ALPHA_BOOST);
    }
  }
  return out;
}

export function paintDensityCells(ctx: CanvasRenderingContext2D, cells: readonly DensityCell[], colors: Record<Theme, string>): void {
  const groups = new Map<Theme, DensityCell[]>();
  for (const c of cells) {
    let arr = groups.get(c.theme);
    if (!arr) {
      arr = [];
      groups.set(c.theme, arr);
    }
    arr.push(c);
  }
  ctx.globalCompositeOperation = "lighter";
  for (const [theme, group] of groups) {
    ctx.fillStyle = colors[theme];
    for (const c of group) {
      ctx.globalAlpha = c.alpha;
      ctx.fillRect(c.x - c.size / 2, c.y - c.size / 2, c.size, c.size);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}
