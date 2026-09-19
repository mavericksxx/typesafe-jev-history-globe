// Pure data types shared between the app (src/) and the build-time scripts
// (scripts/). No DOM, no browser APIs.

export const THEMES = [
  "war",
  "politics",
  "religion",
  "economy",
  "science",
  "culture",
] as const;
export type Theme = (typeof THEMES)[number];

export const EXT_THEMES = ["disaster", "exploration", "revolution", "empire"] as const;
export type ExtTheme = (typeof EXT_THEMES)[number];

export const ERA_THEMES = [...THEMES, ...EXT_THEMES] as const;
export type EraTheme = (typeof ERA_THEMES)[number];

export const REGIONS = [
  "europe",
  "middle east",
  "south asia",
  "east asia",
  "africa",
  "americas",
  "oceania",
] as const;
export type Region = (typeof REGIONS)[number];

export const MOODS = ["expansion", "stability", "upheaval", "collapse"] as const;
export type Mood = (typeof MOODS)[number];

export const IMPACT_LABELS = ["local", "regional", "generational", "world"] as const;

export type LocKind = "point" | "country" | "none";

/** A single historical event, fully resolved (numeric fields precomputed). */
export interface HistoryEvent {
  /** Stable index into the columnar dataset; also the id used by shard lookups. */
  idx: number;
  year: number;
  /** Precomputed T(year): position along the piecewise timescale, 0..1. */
  t: number;
  /** Event text. Empty string until its text shard has loaded. */
  text: string;
  lat: number;
  lon: number;
  locKind: LocKind;
  th: Record<Theme, number>;
  ext: Record<ExtTheme, number>;
  /** Highest-scoring base theme; drives dot colour. */
  top: Theme;
  /** Impact score, 0..3 (see IMPACT_LABELS). */
  impact: number;
  /** Jev confidence, 0..1. Drives dot opacity once text/answers are real. */
  conf: number;
  region: Region;
  /** Hand-authored ("real") vs synthetic filler event. */
  real: boolean;
  /** Minor/filler events render smaller and don't get their own card. */
  minor: boolean;
}

/**
 * A raw event as produced by data collection / synthesis, before the build
 * step derives `ext`, `top`, `region` and `conf` and assigns an index.
 * This is the shape written to `data/raw/events.ndjson` (one per line).
 */
export interface RawEventRecord {
  year: number;
  text: string;
  lat: number;
  lon: number;
  locKind: LocKind;
  th: Record<Theme, number>;
  impact: number;
  real: boolean;
  minor: boolean;
}

/**
 * A hand-curated landmark event shown as a small card in the narrative,
 * between eras — a Phase 0 stopgap for what will eventually be real,
 * Jev-scored events from the actual corpus. Deliberately a subset of
 * HistoryEvent's core fields (year, lat, lon, text, top theme) so it's a
 * drop-in match once that corpus exists.
 */
export interface LandmarkEvent {
  year: number;
  lat: number;
  lon: number;
  text: string;
  top: Theme;
}

/** The aggregated "what's happening right now" snapshot the era panel shows. */
export interface EraSnapshot {
  themes: Record<Theme, number>;
  ext: Record<ExtTheme, number>;
  region: Record<Region, number>;
  mood: Record<Mood, number>;
  impact: number;
  /** Number of events that fed the window. */
  n: number;
  /** Lower edge of the window, in T-space. */
  lo: number;
}
