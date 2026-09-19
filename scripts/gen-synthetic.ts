// Generates data/raw/events.ndjson: either the mockup's ~320-event mock
// dataset (--mock) or a 50k synthetic dataset whose year distribution skews
// heavily modern, the way real Wikipedia year-page density does. This lets
// the renderer be proven at scale before real Jev-tagged data exists.
//
// Usage:
//   tsx scripts/gen-synthetic.ts             # 50k synthetic events
//   tsx scripts/gen-synthetic.ts --count=5000 # smaller synthetic run
//   tsx scripts/gen-synthetic.ts --mock       # mockup's hand-written events
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/data/types";
import type { LocKind, RawEventRecord, Theme } from "../src/data/types";
import { mulberry32 } from "../src/data/rng";
import { generateMockEvents } from "../src/data/mockEvents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const useMock = args.includes("--mock");
const countArg = args.find((a) => a.startsWith("--count="));
const COUNT = countArg ? Number(countArg.split("=")[1]) : 50_000;
const OUT = path.join(REPO_ROOT, "data/raw/events.ndjson");

// A spread of real-world coordinates standing in for wherever a generic
// "border conflict" or "trade route opens" might land.
const PLACES: [number, number][] = [
  [41.9, 12.5], [30, 31], [34, 108], [28, 77], [48.8, 2.3], [51.5, -0.1], [40.7, -74], [35.7, 139.7],
  [-23.5, -46.6], [19.4, -99.1], [55.7, 37.6], [-33.9, 18.4], [6.5, 3.4], [33.3, 44.4], [37.9, 23.7],
  [39.9, 32.8], [13.7, 100.5], [-12, -77], [45.5, 9.2], [59.3, 18.1], [-33.87, 151.21], [1.35, 103.8],
  [52.5, 13.4], [41.0, 28.98], [25.3, 51.5], [-1.3, 36.8], [23.1, 113.3], [19.1, 72.9], [50.1, 14.4],
  [47.4, 8.5], [64.1, -21.9], [-34.6, -58.4], [10.5, -66.9], [4.7, -74.1], [24.7, 46.7], [31.2, 121.5],
  [37.6, 127.0], [14.6, 121.0], [-6.2, 106.8], [21.0, 105.8], [3.1, 101.7], [15.5, 32.6], [9.0, 38.7],
  [-1.9, 30.1], [5.6, -0.2], [12.6, -8.0], [33.5, 36.3], [15.3, 44.2], [34.5, 69.2], [30.0, 66.9],
];

const TEMPLATES: { theme: Theme; texts: string[] }[] = [
  { theme: "war", texts: ["A border conflict breaks out", "A siege ends in surrender", "Rebels clash with the garrison", "A naval skirmish is recorded", "A fortress changes hands"] },
  { theme: "politics", texts: ["A new charter is signed", "A regent is installed", "A council convenes", "An election is contested", "A treaty is ratified"] },
  { theme: "religion", texts: ["A shrine is consecrated", "A pilgrimage route opens", "A synod issues a decree", "A monastery is founded", "A relic is enshrined"] },
  { theme: "economy", texts: ["A trade route opens", "A currency is devalued", "A guild is chartered", "A harvest tax is levied", "A market hall is built"] },
  { theme: "science", texts: ["An instrument is refined", "A treatise is published", "An expedition returns with data", "A new method is demonstrated", "An observatory opens"] },
  { theme: "culture", texts: ["A festival is held", "A poem circulates widely", "A monument is dedicated", "A new style of music spreads", "A playhouse opens"] },
];

/** Heavily modern-skewed piecewise year distribution, echoing real history's
 * documentation density: sparse antiquity, exploding 20th/21st century. */
function sampleYear(rng: () => number): number {
  const u = rng();
  if (u < 0.05) return Math.round(-3000 + rng() * 2500); // -3000..-500, 5%
  if (u < 0.15) return Math.round(-500 + rng() * 1000); // -500..500, 10%
  if (u < 0.25) return Math.round(500 + rng() * 1000); // 500..1500, 10%
  if (u < 0.4) return Math.round(1500 + rng() * 400); // 1500..1900, 15%
  if (u < 0.65) return Math.round(1900 + rng() * 100); // 1900..2000, 25%
  return Math.round(2000 + rng() * 26); // 2000..2026, 35%
}

function sampleLocKind(rng: () => number): LocKind {
  const u = rng();
  if (u < 0.9) return "point";
  if (u < 0.98) return "country";
  return "none";
}

function themeVector(rng: () => number, lead: Theme): Record<Theme, number> {
  return Object.fromEntries(
    THEMES.map((t) => [t, t === lead ? 0.55 + rng() * 0.44 : rng() * 0.35])
  ) as Record<Theme, number>;
}

/** Exported so tests/perf.test.ts can bench against the exact same
 * distribution the real 50k dataset uses, deterministically (fixed seed). */
export function generateSynthetic(count: number): RawEventRecord[] {
  const rng = mulberry32(1_234_567);
  const out: RawEventRecord[] = [];
  for (let i = 0; i < count; i++) {
    const year = sampleYear(rng);
    const group = TEMPLATES[Math.floor(rng() * TEMPLATES.length)]!;
    const text = group.texts[Math.floor(rng() * group.texts.length)]!;
    const place = PLACES[Math.floor(rng() * PLACES.length)]!;
    const locKind = sampleLocKind(rng);
    const th = themeVector(rng, group.theme);
    // ~1.5% of synthetic events are "notable": bigger, non-minor, higher impact.
    const notable = rng() < 0.015;
    const impact = notable ? 1.8 + rng() * 1.2 : rng() * 1.4;
    out.push({
      year,
      text,
      lat: locKind === "none" ? 0 : place[0] + (rng() - 0.5) * 6,
      lon: locKind === "none" ? 0 : place[1] + (rng() - 0.5) * 8,
      locKind,
      th,
      impact,
      real: notable,
      minor: !notable,
    });
  }
  return out;
}

function main(): void {
  const records = useMock ? generateMockEvents() : generateSynthetic(COUNT);
  mkdirSync(path.dirname(OUT), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`wrote ${records.length} events to ${path.relative(REPO_ROOT, OUT)}`);
}

// Only run as a CLI, not on import (tests/perf.test.ts imports
// generateSynthetic without wanting a side-effecting overwrite of
// data/raw/events.ndjson).
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main();
}
