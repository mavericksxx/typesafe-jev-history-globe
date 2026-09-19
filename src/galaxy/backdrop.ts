// The fixed full-page pixel galaxy backdrop: a low-res nebula + starfield
// painted onto a small canvas, then upscaled without smoothing for the
// pixel-art look. Ported from reel.html's buildGalaxyNebula / initGalaxyStars
// / sizeGalaxyBg / drawGalaxyBg. Redrawn at ~12fps by loop.ts, not every frame.
import { mulberry32 } from "../data/rng";
import type { GalaxyTheme } from "../themes";

interface Star {
  x: number;
  y: number;
  speed: number;
  size: number;
  cross: boolean;
  phase: number;
  twSpeed: number;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

const STAR_LAYERS = [
  { n: 70, speed: 0.006, size: 1, cross: false },
  { n: 30, speed: 0.014, size: 1.5, cross: false },
  { n: 9, speed: 0.024, size: 2.1, cross: true },
];

export class GalaxyBackdrop {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private low: HTMLCanvasElement | null = null;
  private lowCtx: CanvasRenderingContext2D | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private stars: Star[] = [];
  private shooting: ShootingStar | null = null;
  private needsRedraw = true;
  private theme: GalaxyTheme;

  constructor(canvas: HTMLCanvasElement, initialTheme: GalaxyTheme) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("GalaxyBackdrop: 2d context unavailable");
    this.ctx = ctx;
    this.theme = initialTheme;
  }

  private buildNebula(): void {
    if (!this.low || !this.lowCtx) return;
    const w = this.low.width;
    const h = this.low.height;
    const ctx = this.lowCtx;
    ctx.fillStyle = this.theme.void;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.theme.nebula) {
      const g = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, b.r * w);
      g.addColorStop(0, b.c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const levels = this.theme.ditherLevels;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const t = BAYER4[y % 4]![x % 4]!;
        for (let c = 0; c < 3; c++) {
          const v = data[i + c]! / 255;
          const scaled = v * (levels - 1);
          const base = Math.floor(scaled);
          const frac = scaled - base;
          data[i + c] = Math.round(((frac > t ? base + 1 : base) / (levels - 1)) * 255);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private initStars(): void {
    if (!this.low) return;
    const seed = this.theme.id.length * 97 + this.low.width * 7 + this.low.height * 13;
    const rng = mulberry32(seed);
    this.stars = [];
    for (const L of STAR_LAYERS) {
      for (let k = 0; k < L.n; k++) {
        this.stars.push({
          x: rng(),
          y: rng(),
          speed: L.speed,
          size: L.size,
          cross: L.cross,
          phase: rng() * Math.PI * 2,
          twSpeed: 0.35 + rng() * 1.1,
        });
      }
    }
  }

  setTheme(theme: GalaxyTheme, viewportW: number, viewportH: number): void {
    this.theme = theme;
    this.resize(viewportW, viewportH);
  }

  resize(viewportW: number, viewportH: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(viewportW * dpr);
    this.canvas.height = Math.round(viewportH * dpr);
    const scale = this.theme.pixelScale || 8;
    const lw = Math.max(60, Math.round(viewportW / scale));
    const lh = Math.max(44, Math.round(viewportH / scale));
    if (!this.low) {
      this.low = document.createElement("canvas");
      this.lowCtx = this.low.getContext("2d");
    }
    this.low.width = lw;
    this.low.height = lh;
    if (!this.scratch) {
      this.scratch = document.createElement("canvas");
      this.scratchCtx = this.scratch.getContext("2d");
    }
    this.scratch.width = lw;
    this.scratch.height = lh;
    this.buildNebula();
    this.initStars();
    this.shooting = null;
    this.needsRedraw = true;
  }

  draw(now: number, reducedMotion: boolean, scrollY: number): void {
    if (reducedMotion && !this.needsRedraw) return;
    if (!this.low || !this.scratch || !this.scratchCtx) return;
    const w = this.low.width;
    const h = this.low.height;
    const sctx = this.scratchCtx;
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.low, 0, 0);
    const t = now / 1000;
    const scrollShift = reducedMotion ? 0 : scrollY * 0.00028;
    for (const s of this.stars) {
      const drift = reducedMotion ? 0 : (t * s.speed) % 1;
      const x = ((s.x + drift) % 1) * w;
      const y = ((((s.y + scrollShift * (0.4 + s.speed * 10)) % 1) + 1) % 1) * h;
      const tw = reducedMotion ? 0.85 : 0.55 + 0.45 * Math.sin(t * s.twSpeed + s.phase);
      sctx.globalAlpha = Math.max(0.15, tw);
      sctx.fillStyle = this.theme.starTint;
      if (s.cross) {
        sctx.fillRect(x - s.size * 1.6, y - 0.5, s.size * 3.2, 1);
        sctx.fillRect(x - 0.5, y - s.size * 1.6, 1, s.size * 3.2);
      } else {
        const sz = Math.max(1, Math.round(s.size));
        sctx.fillRect(Math.round(x), Math.round(y), sz, sz);
      }
    }
    sctx.globalAlpha = 1;
    if (!reducedMotion) {
      if (!this.shooting && Math.random() < this.theme.shootRate) {
        this.shooting = {
          x: Math.random() * 0.6,
          y: Math.random() * 0.3,
          vx: 0.8 + Math.random() * 0.4,
          vy: 0.3 + Math.random() * 0.2,
          born: now,
          life: 600,
        };
      }
      if (this.shooting) {
        const age = now - this.shooting.born;
        const k = age / this.shooting.life;
        if (k >= 1) {
          this.shooting = null;
        } else {
          const sx = (this.shooting.x + this.shooting.vx * k) * w;
          const sy = (this.shooting.y + this.shooting.vy * k) * h;
          sctx.strokeStyle = this.theme.accent2;
          sctx.globalAlpha = 1 - k;
          sctx.lineWidth = 1;
          sctx.beginPath();
          sctx.moveTo(sx, sy);
          sctx.lineTo(sx - this.shooting.vx * 7, sy - this.shooting.vy * 7);
          sctx.stroke();
          sctx.globalAlpha = 1;
        }
      }
    }
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.scratch, 0, 0, w, h, 0, 0, this.canvas.width, this.canvas.height);
    this.needsRedraw = false;
  }
}
