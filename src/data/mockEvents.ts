// The mockup's ~60 hand-curated events plus its 260 invented filler rows,
// ported verbatim from reel.html's `RAW` / extra-event generator. Used when
// the app (or scripts/gen-synthetic.ts) is run with the "mock data" flag
// instead of the 50k synthetic dataset.
import { THEMES } from "./types";
import type { RawEventRecord, Theme } from "./types";
import { mulberry32 } from "./rng";

// [year, text, lat, lon, war, politics, religion, economy, science, culture, impact 0-3, real?, minor?]
// Rows marked real=1 use the numbers Jev returned in the original probe; the rest are invented.
type RawRow = [number, string, number, number, number, number, number, number, number, number, number, number?, number?];

const RAW: RawRow[] = [
  [-2560, "Great Pyramid of Giza completed", 29.98, 31.13, 0.02, 0.7, 0.8, 0.4, 0.6, 0.9, 2.6],
  [-1754, "Code of Hammurabi inscribed in Babylon", 32.54, 44.42, 0.05, 0.95, 0.4, 0.5, 0.1, 0.6, 2.5],
  [-1274, "Battle of Kadesh between Egypt and the Hittites", 34.56, 36.52, 0.99, 0.9, 0.2, 0.1, 0.05, 0.2, 2.1],
  [-776, "First recorded Olympic Games at Olympia", 37.64, 21.63, 0.1, 0.3, 0.7, 0.1, 0.05, 0.9, 2.2],
  [-563, "Birth of Siddhartha Gautama in Lumbini", 27.48, 83.27, 0.02, 0.2, 0.99, 0.05, 0.05, 0.8, 2.9],
  [-490, "Battle of Marathon", 38.12, 23.97, 0.99, 0.8, 0.1, 0.05, 0.05, 0.4, 2.5],
  [-221, "Qin Shi Huang unifies China", 34.26, 108.94, 0.9, 0.99, 0.2, 0.4, 0.2, 0.4, 2.9],
  [-44, "Julius Caesar assassinated in Rome", 41.89, 12.48, 0.4, 0.99, 0.1, 0.1, 0.02, 0.3, 2.7],
  [30, "Crucifixion of Jesus in Jerusalem", 31.78, 35.23, 0.05, 0.5, 0.99, 0.05, 0.02, 0.7, 3],
  [79, "Vesuvius buries Pompeii", 40.75, 14.49, 0.02, 0.1, 0.1, 0.3, 0.4, 0.3, 1.8],
  [105, "Cai Lun refines papermaking", 34.62, 112.45, 0.01, 0.1, 0.05, 0.5, 0.95, 0.7, 2.6],
  [476, "Last Western Roman emperor deposed", 44.42, 12.2, 0.6, 0.99, 0.2, 0.3, 0.02, 0.2, 2.8],
  [622, "Muhammad's migration to Medina", 24.47, 39.61, 0.2, 0.6, 0.99, 0.1, 0.02, 0.5, 3],
  [732, "Battle of Tours", 47.39, 0.69, 0.99, 0.8, 0.6, 0.05, 0.02, 0.1, 2.4],
  [800, "Charlemagne crowned emperor", 41.9, 12.45, 0.2, 0.99, 0.8, 0.1, 0.02, 0.4, 2.6],
  [868, "Diamond Sutra printed in China", 40.14, 94.66, 0.01, 0.05, 0.9, 0.2, 0.8, 0.9, 2.2],
  [1054, "Great Schism splits the Church", 41.01, 28.98, 0.05, 0.6, 0.99, 0.05, 0.02, 0.4, 2.7],
  [1066, "Battle of Hastings", 50.91, 0.49, 1, 0.99, 0.48, 0.1, 0.19, 0.44, 2.59, 1],
  [1206, "Genghis Khan unites the Mongols", 47.92, 106.92, 0.95, 0.99, 0.1, 0.3, 0.05, 0.2, 2.9],
  [1215, "Magna Carta sealed at Runnymede", 51.44, -0.56, 0.2, 0.99, 0.3, 0.3, 0.02, 0.4, 2.7],
  [1258, "Mongols sack Baghdad", 33.31, 44.37, 0.99, 0.8, 0.4, 0.3, 0.4, 0.6, 2.6],
  [1347, "Black Death reaches Europe", 38.19, 15.55, 0.05, 0.3, 0.5, 0.8, 0.4, 0.3, 2.9],
  [1405, "Zheng He's first treasure voyage", 32.06, 118.8, 0.2, 0.8, 0.1, 0.8, 0.6, 0.4, 2.2],
  [1453, "Fall of Constantinople", 41.01, 28.98, 0.99, 0.95, 0.6, 0.3, 0.1, 0.3, 2.8],
  [1455, "Gutenberg Bible printed", 49.99, 8.27, 0.01, 0.1, 0.8, 0.4, 0.9, 0.95, 2.9],
  [1492, "Columbus reaches the Caribbean", 24.06, -74.53, 0.17, 0.87, 0.42, 0.71, 0.91, 0.62, 3, 1],
  [1517, "Luther's Ninety-five Theses", 51.87, 12.64, 0.03, 0.52, 0.99, 0.84, 0.05, 0.98, 2.96, 1],
  [1521, "Tenochtitlan falls to Cortés", 19.43, -99.13, 0.99, 0.9, 0.5, 0.4, 0.1, 0.4, 2.7],
  [1543, "Copernicus publishes heliocentrism", 54.36, 18.64, 0.01, 0.1, 0.5, 0.05, 0.99, 0.6, 2.9],
  [1603, "Tokugawa shogunate founded", 35.68, 139.69, 0.5, 0.99, 0.1, 0.3, 0.05, 0.3, 2.4],
  [1648, "Peace of Westphalia", 51.96, 7.62, 0.7, 0.99, 0.6, 0.2, 0.02, 0.2, 2.6],
  [1687, "Newton's Principia published", 51.51, -0.13, 0.01, 0.05, 0.1, 0.05, 0.99, 0.5, 2.9],
  [1776, "US Declaration of Independence", 39.95, -75.15, 0.6, 0.99, 0.1, 0.4, 0.05, 0.5, 2.9],
  [1789, "Storming of the Bastille", 48.85, 2.37, 0.7, 0.99, 0.3, 0.5, 0.05, 0.6, 2.9],
  [1804, "Haiti declares independence", 18.54, -72.34, 0.9, 0.99, 0.1, 0.5, 0.02, 0.4, 2.5],
  [1815, "Battle of Waterloo", 50.68, 4.41, 0.99, 0.9, 0.05, 0.2, 0.05, 0.2, 2.6],
  [1830, "Liverpool–Manchester railway opens", 53.41, -2.98, 0.01, 0.2, 0.02, 0.9, 0.9, 0.3, 2.6],
  [1859, "Darwin's Origin of Species", 51.51, -0.13, 0.01, 0.1, 0.6, 0.05, 0.99, 0.7, 3],
  [1861, "American Civil War begins", 32.75, -79.87, 0.99, 0.95, 0.2, 0.6, 0.1, 0.3, 2.8],
  [1868, "Meiji Restoration", 35.68, 139.69, 0.4, 0.99, 0.2, 0.7, 0.6, 0.5, 2.7],
  [1885, "Berlin Conference partitions Africa", 52.52, 13.4, 0.4, 0.99, 0.2, 0.8, 0.05, 0.2, 2.9],
  [1903, "Wright brothers' first flight", 36.02, -75.67, 0.01, 0.05, 0.02, 0.2, 0.99, 0.4, 2.9],
  [1914, "Assassination in Sarajevo; WWI begins", 43.86, 18.41, 0.99, 0.99, 0.05, 0.3, 0.1, 0.2, 3],
  [1917, "Russian Revolution", 59.94, 30.31, 0.8, 0.99, 0.3, 0.8, 0.05, 0.5, 3],
  [1929, "Wall Street crash", 40.71, -74.01, 0.02, 0.46, 0.02, 0.99, 0.09, 0.14, 3, 1],
  [1945, "Atomic bombing of Hiroshima", 34.39, 132.45, 0.99, 0.9, 0.1, 0.1, 0.9, 0.3, 3],
  [1947, "Partition of India", 28.61, 77.21, 0.7, 0.99, 0.9, 0.4, 0.02, 0.4, 2.9],
  [1949, "People's Republic of China founded", 39.9, 116.4, 0.8, 0.99, 0.1, 0.6, 0.05, 0.3, 3],
  [1957, "Sputnik launched", 45.92, 63.34, 0.4, 0.8, 0.01, 0.1, 0.99, 0.4, 2.9],
  [1963, "'I Have a Dream' speech", 38.89, -77.05, 0.02, 0.95, 0.5, 0.3, 0.02, 0.9, 2.6],
  [1969, "Apollo 11 lands on the Moon", 28.57, -80.65, 0.01, 0.77, 0.05, 0.08, 0.99, 0.62, 2.99, 1],
  [1989, "Fall of the Berlin Wall", 52.52, 13.4, 0.1, 0.99, 0.1, 0.6, 0.05, 0.6, 2.9],
  [1991, "World Wide Web goes public", 46.23, 6.05, 0.01, 0.1, 0.01, 0.7, 0.99, 0.7, 3],
  [1994, "End of apartheid in South Africa", -25.75, 28.19, 0.3, 0.99, 0.3, 0.5, 0.02, 0.6, 2.7],
  [2001, "September 11 attacks", 40.71, -74.01, 0.95, 0.95, 0.6, 0.5, 0.05, 0.3, 2.9],
  [2004, "Indian Ocean tsunami", 3.32, 95.85, 0.01, 0.2, 0.1, 0.5, 0.3, 0.1, 2.4],
  [2008, "Global financial crisis", 40.71, -74.01, 0.02, 0.7, 0.02, 0.99, 0.05, 0.1, 2.9],
  [2020, "COVID-19 pandemic declared", 30.59, 114.3, 0.02, 0.8, 0.1, 0.9, 0.9, 0.4, 3],
  [2022, "ChatGPT released", 37.77, -122.42, 0.01, 0.3, 0.05, 0.8, 0.99, 0.7, 2.7],
  [2026, "Large language models see widespread adoption", 37.77, -122.42, 0.01, 0.1, 0.01, 0.6, 0.99, 0.3, 1.4],
];

const EXTRA_PLACES: [number, number][] = [
  [41.9, 12.5], [30, 31], [34, 108], [28, 77], [48.8, 2.3], [51.5, -0.1], [40.7, -74], [35.7, 139.7],
  [-23.5, -46.6], [19.4, -99.1], [55.7, 37.6], [-33.9, 18.4], [6.5, 3.4], [33.3, 44.4], [37.9, 23.7],
  [39.9, 32.8], [13.7, 100.5], [-12, -77], [45.5, 9.2], [59.3, 18.1], [-33.87, 151.21],
];
const EXTRA_TEXT = [
  "A new temple is dedicated", "A border skirmish", "A trade fair is chartered", "A drought ruins the harvest",
  "A new school of poetry emerges", "A merchant guild is founded", "A local uprising is put down",
  "A comet is recorded by astronomers", "A bridge is completed", "An earthquake strikes the city",
];
const EXTRA_THEME: [number, number, number, number, number, number][] = [
  [0.05, 0.3, 0.9, 0.2, 0.05, 0.6],
  [0.95, 0.6, 0.05, 0.1, 0.02, 0.05],
  [0.02, 0.3, 0.05, 0.95, 0.1, 0.2],
  [0.05, 0.3, 0.2, 0.8, 0.2, 0.05],
  [0.02, 0.1, 0.2, 0.1, 0.05, 0.95],
  [0.02, 0.3, 0.05, 0.9, 0.1, 0.2],
  [0.8, 0.9, 0.1, 0.2, 0.02, 0.1],
  [0.01, 0.05, 0.4, 0.02, 0.9, 0.3],
  [0.02, 0.3, 0.05, 0.5, 0.7, 0.2],
  [0.02, 0.2, 0.2, 0.5, 0.3, 0.1],
];

const EXTRA_FILLER_COUNT = 260;

function themeRecord(values: readonly number[]): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t, i) => [t, values[i]!])) as Record<Theme, number>;
}

/** The mockup's small hand-curated + filler dataset (~320 events total). */
export function generateMockEvents(): RawEventRecord[] {
  const rnd = mulberry32(7);
  const out: RawEventRecord[] = RAW.map((r) => ({
    year: r[0],
    text: r[1],
    lat: r[2],
    lon: r[3],
    locKind: "point",
    th: themeRecord(r.slice(4, 10) as number[]),
    impact: r[10],
    real: !!r[11],
    minor: false,
  }));

  for (let i = 0; i < EXTRA_FILLER_COUNT; i++) {
    const u = rnd();
    const year = Math.round(
      u < 0.2
        ? -3000 + (u / 0.2) * 3000
        : u < 0.5
          ? ((u - 0.2) / 0.3) * 1500
          : u < 0.8
            ? 1500 + ((u - 0.5) / 0.3) * 400
            : 1900 + ((u - 0.8) / 0.2) * 126
    );
    const p = EXTRA_PLACES[Math.floor(rnd() * EXTRA_PLACES.length)]!;
    const k = Math.floor(rnd() * EXTRA_TEXT.length);
    const th = themeRecord(EXTRA_THEME[k]!.map((v) => Math.max(0, Math.min(1, v + (rnd() - 0.5) * 0.25))));
    out.push({
      year,
      text: EXTRA_TEXT[k]!,
      lat: p[0] + (rnd() - 0.5) * 6,
      lon: p[1] + (rnd() - 0.5) * 8,
      locKind: "point",
      th,
      impact: 0.3 + rnd() * 1.2,
      real: false,
      minor: true,
    });
  }
  return out;
}
