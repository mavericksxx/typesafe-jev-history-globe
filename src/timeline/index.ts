// The pixel/dot-matrix equalizer timeline. Ported from reel.html's
// TICKS/layoutTicks/drawTimeline/renderTimeline, with one structural change:
// the per-column event count is a histogram precomputed once from the full
// dataset (see src/data/aggregate.ts#computeHistogram), not recomputed on
// every draw call.
import { T, fmtYear } from "../data/timescale";
import { hexToRgba } from "../util/color";

const TICKS = [-3000, -2000, -1000, 0, 500, 1000, 1500, 1800, 1900, 2026];
export const TL_COLS = 120;
const TL_ROWS = 5;

export interface TimelineEls {
  canvas: HTMLCanvasElement;
  ticks: HTMLElement;
  handle: HTMLElement;
  label: HTMLElement;
}

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ticksEl: HTMLElement;
  private readonly handleEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private histogram: number[] = new Array(TL_COLS).fill(0);
  private dpr = 1;

  constructor(els: TimelineEls) {
    this.canvas = els.canvas;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Timeline: 2d context unavailable");
    this.ctx = ctx;
    this.ticksEl = els.ticks;
    this.handleEl = els.handle;
    this.labelEl = els.label;
    this.renderTickLabels();
  }

  private renderTickLabels(): void {
    this.ticksEl.innerHTML = "";
    for (const y of TICKS) {
      const span = document.createElement("span");
      span.style.left = `${T(y) * 100}%`;
      span.textContent = y < 0 ? `${-y}BC` : String(y);
      this.ticksEl.appendChild(span);
    }
    const spans = [...this.ticksEl.querySelectorAll<HTMLElement>("span")];
    spans.forEach((s, i, a) => {
      if (i === 0) s.style.transform = "none";
      if (i === a.length - 1) s.style.transform = "translateX(-100%)";
    });
  }

  layoutTicks(): void {
    const spans = [...this.ticksEl.querySelectorAll<HTMLElement>("span")];
    const wrapWidth = this.ticksEl.clientWidth || 1;
    let lastRight = -Infinity;
    spans.forEach((s, i) => {
      s.style.visibility = "visible";
      const leftPx = (parseFloat(s.style.left) / 100) * wrapWidth;
      const wpx = s.offsetWidth;
      let boxLeft: number;
      let boxRight: number;
      if (i === 0) {
        boxLeft = leftPx;
        boxRight = leftPx + wpx;
      } else if (i === spans.length - 1) {
        boxLeft = leftPx - wpx;
        boxRight = leftPx;
      } else {
        boxLeft = leftPx - wpx / 2;
        boxRight = leftPx + wpx / 2;
      }
      if (i !== 0 && i !== spans.length - 1 && boxLeft < lastRight + 10) {
        s.style.visibility = "hidden";
      } else {
        lastRight = boxRight;
      }
    });
  }

  resize(dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.layoutTicks();
  }

  /** Set once from the full dataset at load time (see computeHistogram). */
  setHistogram(histogram: readonly number[]): void {
    this.histogram = histogram.length === TL_COLS ? [...histogram] : new Array(TL_COLS).fill(0);
  }

  private drawStrip(pos: number, accent: string): void {
    const { ctx, canvas: cv, histogram: cnt } = this;
    const w = cv.width;
    const h = cv.height;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    const gap = Math.max(1, Math.round(this.dpr));
    const cellH = Math.max(2, Math.floor((h - gap * (TL_ROWS - 1)) / TL_ROWS));
    const m = Math.max(1, ...cnt);
    for (let i = 0; i < TL_COLS; i++) {
      const lit = Math.max(1, Math.round((cnt[i]! / m) * TL_ROWS));
      const played = i / TL_COLS <= pos;
      const xCell = Math.round((i * w) / TL_COLS);
      const xNext = Math.round(((i + 1) * w) / TL_COLS);
      const cw = Math.max(1, xNext - xCell - gap);
      for (let r = 0; r < TL_ROWS; r++) {
        const yCell = Math.round(h - (r + 1) * cellH - r * gap);
        const on = r < lit;
        if (played) {
          ctx.fillStyle = on ? accent : "rgba(255,255,255,.08)";
          ctx.fillRect(xCell, yCell, cw, cellH);
        } else if (on) {
          ctx.strokeStyle = hexToRgba(accent, 0.45);
          ctx.lineWidth = Math.max(1, Math.round(this.dpr));
          ctx.strokeRect(xCell + 0.5, yCell + 0.5, Math.max(1, cw - 1), Math.max(1, cellH - 1));
        } else {
          ctx.fillStyle = "rgba(255,255,255,.045)";
          ctx.fillRect(xCell, yCell, cw, cellH);
        }
      }
    }
  }

  render(pos: number, accent: string): void {
    this.drawStrip(pos, accent);
    const year = Math.round(T.invert(pos));
    this.handleEl.style.left = `${pos * 100}%`;
    this.handleEl.setAttribute("aria-valuenow", String(year));
    this.handleEl.setAttribute("aria-valuetext", fmtYear(year));
    this.labelEl.textContent = fmtYear(year);
  }
}
