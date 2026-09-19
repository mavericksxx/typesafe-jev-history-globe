// Single source of truth for the six galaxy themes. Ported from reel.html,
// where the same data was split between CSS `:root[data-galaxy]` blocks (UI
// tokens) and a JS `GALAXY_THEMES` object (canvas-only tokens) — here it's
// one table, and this module is what injects the CSS custom properties.
//
// The stylesheet still carries a `:root[data-galaxy="…"]` block per theme,
// generated from this same data, purely so the pre-paint script in
// index.html (which only picks *which* theme id to mark, per the
// `jev-galaxy-default` localStorage key) doesn't cause a flash before this
// module runs. At runtime this module's `applyGalaxy` always re-injects the
// same values as CSS custom properties, so it — not the stylesheet — is the
// thing anything actually reads from or changes.
import { ERA_THEMES } from "../data/types";
import type { EraTheme } from "../data/types";

export interface NebulaBlob {
  c: string;
  x: number;
  y: number;
  r: number;
}

export interface GalaxyTheme {
  id: string;
  name: string;
  swatches: string[];
  // UI tokens — also written out as CSS custom properties.
  void: string;
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string; // --ox
  rule: string;
  // Canvas-only tokens (galaxy backdrop + globe).
  accent2: string;
  starTint: string;
  shootRate: number;
  pixelScale: number;
  ditherLevels: number;
  nebula: NebulaBlob[];
  ocean: string;
  land: string;
  coast: string;
  bezel: string;
  graticule: string;
  rim: "glow" | "steps";
}

export const GALAXY_THEMES = {
  "deep-violet": {
    id: "deep-violet",
    name: "Deep Violet Drift",
    swatches: ["#0a0714", "#3a1d63", "#5a2f8c", "#9b7bd4", "#e8d9ff"],
    void: "#0a0714",
    paper: "#0d0a1a",
    ink: "#eee8fb",
    ink2: "#b4a9d6",
    ink3: "#7a6f9c",
    accent: "#9b7bd4",
    rule: "rgba(155,123,212,.28)",
    accent2: "#e8d9ff",
    starTint: "#cfc0ff",
    shootRate: 0.0016,
    pixelScale: 7,
    ditherLevels: 6,
    nebula: [
      { c: "#3a1d63", x: 0.28, y: 0.42, r: 0.55 },
      { c: "#5a2f8c", x: 0.68, y: 0.62, r: 0.46 },
      { c: "#241242", x: 0.5, y: 0.18, r: 0.4 },
    ],
    ocean: "#10132a",
    land: "#1d2550",
    coast: "#b9a9e8",
    bezel: "#6f5aa0",
    graticule: "rgba(155,123,212,.14)",
    rim: "glow",
  },
  "spiral-core": {
    id: "spiral-core",
    name: "Spiral Core",
    swatches: ["#05060f", "#274a86", "#c97a3d", "#f0c869", "#fff3d6"],
    void: "#05060f",
    paper: "#0d0c12",
    ink: "#f7f0de",
    ink2: "#cdbd94",
    ink3: "#8d8368",
    accent: "#f0c869",
    rule: "rgba(240,200,105,.25)",
    accent2: "#fff3d6",
    starTint: "#fff3d6",
    shootRate: 0.002,
    pixelScale: 7,
    ditherLevels: 6,
    nebula: [
      { c: "#f0c869", x: 0.5, y: 0.4, r: 0.2 },
      { c: "#c97a3d", x: 0.5, y: 0.4, r: 0.4 },
      { c: "#2c4f8c", x: 0.26, y: 0.24, r: 0.5 },
      { c: "#274a86", x: 0.76, y: 0.62, r: 0.46 },
    ],
    ocean: "#0b0e1c",
    land: "#16224a",
    coast: "#f0d9a0",
    bezel: "#c98f3d",
    graticule: "rgba(240,200,105,.1)",
    rim: "glow",
  },
  "observatory-mono": {
    id: "observatory-mono",
    name: "Observatory Mono",
    swatches: ["#060a0d", "#122426", "#3c5a5c", "#6fd8d1", "#dff7f4"],
    void: "#060a0d",
    paper: "#0a1213",
    ink: "#e7f3f1",
    ink2: "#9fc4bf",
    ink3: "#5f8783",
    accent: "#6fd8d1",
    rule: "rgba(111,216,209,.22)",
    accent2: "#dff7f4",
    starTint: "#9fd8d4",
    shootRate: 0.0007,
    pixelScale: 8,
    ditherLevels: 4,
    nebula: [{ c: "#122426", x: 0.5, y: 0.5, r: 0.6 }],
    ocean: "#0b1416",
    land: "#142224",
    coast: "#6fd8d1",
    bezel: "#3c5a5c",
    graticule: "rgba(111,216,209,.2)",
    rim: "steps",
  },
  "amber-dusk": {
    id: "amber-dusk",
    name: "Amber Dusk",
    swatches: ["#120a08", "#6b3421", "#8c4a2e", "#e8954a", "#ffd9a8"],
    void: "#120a08",
    paper: "#150d09",
    ink: "#fbe8d1",
    ink2: "#d9ac82",
    ink3: "#8f6a4c",
    accent: "#e8954a",
    rule: "rgba(232,149,74,.25)",
    accent2: "#ffd9a8",
    starTint: "#ffd9a8",
    shootRate: 0.0015,
    pixelScale: 8,
    ditherLevels: 5,
    nebula: [
      { c: "#6b3421", x: 0.3, y: 0.54, r: 0.55 },
      { c: "#b8556b", x: 0.64, y: 0.28, r: 0.42 },
      { c: "#8c4a2e", x: 0.72, y: 0.7, r: 0.4 },
    ],
    ocean: "#2a140f",
    land: "#4a2418",
    coast: "#e8b37a",
    bezel: "#c97a3d",
    graticule: "rgba(232,149,74,.1)",
    rim: "glow",
  },
  "phosphor-tide": {
    id: "phosphor-tide",
    name: "Phosphor Tide",
    swatches: ["#030a0c", "#0c2b2c", "#123a38", "#3fd8c7", "#bffff2"],
    void: "#030a0c",
    paper: "#04100f",
    ink: "#dffff7",
    ink2: "#8fd9cd",
    ink3: "#4f8f86",
    accent: "#3fd8c7",
    rule: "rgba(63,216,199,.22)",
    accent2: "#bffff2",
    starTint: "#bffff2",
    shootRate: 0.0013,
    pixelScale: 7,
    ditherLevels: 5,
    nebula: [
      { c: "#0c2b2c", x: 0.5, y: 0.5, r: 0.62 },
      { c: "#123a38", x: 0.3, y: 0.3, r: 0.4 },
    ],
    ocean: "#041615",
    land: "#0c2a26",
    coast: "#3fd8c7",
    bezel: "#1f5f57",
    graticule: "rgba(63,216,199,.16)",
    rim: "steps",
  },
  "magenta-vapor": {
    id: "magenta-vapor",
    name: "Magenta Vapor",
    swatches: ["#0a0512", "#401a5c", "#8c2f8c", "#d94fb0", "#7fe8f0"],
    void: "#0a0512",
    paper: "#140a1e",
    ink: "#fbe9fb",
    ink2: "#d9a8d9",
    ink3: "#8f6a91",
    accent: "#d94fb0",
    rule: "rgba(217,79,176,.25)",
    accent2: "#7fe8f0",
    starTint: "#ffb3ec",
    shootRate: 0.0018,
    pixelScale: 11,
    ditherLevels: 6,
    nebula: [
      { c: "#401a5c", x: 0.3, y: 0.4, r: 0.56 },
      { c: "#8c2f8c", x: 0.64, y: 0.58, r: 0.48 },
      { c: "#2a5c8c", x: 0.78, y: 0.26, r: 0.4 },
    ],
    ocean: "#240f38",
    land: "#401a5c",
    coast: "#e8a0e0",
    bezel: "#d94fb0",
    graticule: "rgba(217,79,176,.1)",
    rim: "glow",
  },
} as const satisfies Record<string, GalaxyTheme>;

export type GalaxyId = keyof typeof GALAXY_THEMES;
export const GALAXY_IDS = Object.keys(GALAXY_THEMES) as GalaxyId[];
export const DEFAULT_GALAXY_ID: GalaxyId = "spiral-core";

export function isGalaxyId(id: string | null | undefined): id is GalaxyId {
  return !!id && (GALAXY_IDS as string[]).includes(id);
}

export function getGalaxyTheme(id: GalaxyId): GalaxyTheme {
  return GALAXY_THEMES[id];
}

/** Fixed across every galaxy, so a dot colour always means the same theme. */
export const THEME_COLORS: Record<EraTheme, string> = {
  war: "#ff6b5c",
  politics: "#7c8cff",
  religion: "#e8b34d",
  economy: "#57c98a",
  science: "#4fd6c0",
  culture: "#c98fe0",
  disaster: "#ff9662",
  exploration: "#2fe0a0",
  revolution: "#e26fc4",
  empire: "#a7b4c9",
};

const CSS_VAR_FIELDS: [keyof GalaxyTheme, string][] = [
  ["void", "--void"],
  ["paper", "--paper"],
  ["ink", "--ink"],
  ["ink2", "--ink-2"],
  ["ink3", "--ink-3"],
  ["accent", "--ox"],
  ["rule", "--rule"],
];

export function injectThemeColorVars(root: HTMLElement = document.documentElement): void {
  for (const t of ERA_THEMES) root.style.setProperty(`--t-${t}`, THEME_COLORS[t]);
}

/** Writes a theme's UI tokens onto `root` as CSS custom properties. */
export function applyGalaxyCssVars(theme: GalaxyTheme, root: HTMLElement = document.documentElement): void {
  for (const [field, cssVar] of CSS_VAR_FIELDS) {
    root.style.setProperty(cssVar, String(theme[field]));
  }
  root.dataset.galaxy = theme.id;
}
