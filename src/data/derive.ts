// Region + extended-theme derivation. Ported from reel.html's `regionOf` /
// `deriveExtra` — a mock keyword + heuristic stand-in for a real geocoder /
// Jev call, not hand-authored per row.
import type { ExtTheme, Region, Theme } from "./types";
import type { Rng } from "./rng";

export function regionOf(lat: number, lon: number): Region {
  if (lon <= -30) return "americas";
  if (lat < -8 && lon >= 110) return "oceania";
  if (lon >= 92) return "east asia";
  if (lon >= 60 && lon < 92 && lat >= 5 && lat < 40) return "south asia";
  // Egypt/Nile sits at the same latitude as the Middle East box below but
  // west of the Red Sea (lon < 34ish); check it first so Giza etc. land in
  // Africa instead of Middle East.
  if (lon >= -20 && lon < 34 && lat < 31) return "africa";
  if (lon >= 25 && lon < 63 && lat >= 12 && lat < 42) return "middle east";
  if (lat < 20 && lon < 60) return "africa";
  return "europe";
}

const EXT_KW: Record<ExtTheme, RegExp> = {
  disaster:
    /plague|black death|earthquake|tsunami|flood|famine|crash|crisis|pandemic|drought|volcan|vesuvius|hiroshima|bomb/i,
  exploration:
    /\bvoyage\b|expedition|first flight|lands on|circumnavigat|discover|columbus|zheng he|apollo|sputnik|treasure/i,
  revolution: /revolution|independence|bastille|uprising|revolt|ninety-five theses|magna carta/i,
  empire:
    /empire|unifies|unite[sd]?|conquer|conqueror|dynasty|shogunate|partitions|sack(s|ed)?|khan|caesar|colonial|restoration|reich/i,
};

export function deriveExtra(text: string, th: Record<Theme, number>, rng: Rng): Record<ExtTheme, number> {
  const hit = (k: ExtTheme): number => (EXT_KW[k].test(text) ? 1 : 0);
  const noisy = (v: number): number => Math.max(0.02, Math.min(0.99, v + (rng() - 0.5) * 0.14));
  return {
    disaster: noisy(0.04 + hit("disaster") * 0.85 + th.war * 0.06),
    exploration: noisy(0.04 + hit("exploration") * 0.85 + th.science * 0.15),
    revolution: noisy(0.04 + hit("revolution") * 0.85 + th.politics * 0.08),
    empire: noisy(0.04 + hit("empire") * 0.8 + th.politics * 0.15),
  };
}
