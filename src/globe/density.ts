// A persistent, low-cost density layer: an offscreen canvas that never
// fully clears, only decays, so places/eras with lots of dots leave a soft
// additive glow behind — the "history accumulating" cue from PLAN.md, on
// top of the windowed dots in dots.ts.
import { THEMES } from "../data/types";
import type { HistoryEvent, Theme } from "../data/types";
import type { Project } from "./dots";

/** Per-frame multiplicative decay applied via a `destination-out` wash. */
export const DENSITY_DECAY = 0.03;
const STAMP_RADIUS = 1.1;
const STAMP_ALPHA = 0.05;

export class DensityLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("DensityLayer: 2d context unavailable");
    this.ctx = ctx;
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** `w`/`h` are device pixels; `dpr` lets `step` stamp using the same
   * CSS-unit projected coordinates the live dot layer uses. */
  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  private decay(): void {
    const { ctx, w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${DENSITY_DECAY})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Decays the buffer, then additively stamps the current windowed slice
   * (in the same CSS-unit coordinates `project` returns), one fill pass per
   * theme colour so it stays cheap at scale. */
  step(events: readonly HistoryEvent[], project: Project, colors: Record<Theme, string>): void {
    this.decay();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = STAMP_ALPHA;
    for (const theme of THEMES) {
      ctx.fillStyle = colors[theme];
      let started = false;
      for (const e of events) {
        if (e.top !== theme || e.locKind === "none") continue;
        const p = project(e.lon, e.lat);
        if (!p) continue;
        if (!started) {
          ctx.beginPath();
          started = true;
        }
        ctx.moveTo(p[0] + STAMP_RADIUS, p[1]);
        ctx.arc(p[0], p[1], STAMP_RADIUS, 0, Math.PI * 2);
      }
      if (started) ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
