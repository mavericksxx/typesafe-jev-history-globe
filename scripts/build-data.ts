// Reads data/raw/events.ndjson and writes the public/data/ bundle the app
// fetches at runtime: manifest.json, a columnar index, ~2k-event text
// shards, and eras.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXT_THEMES, REGIONS, THEMES } from "../src/data/types";
import type { LocKind, RawEventRecord } from "../src/data/types";
import type { ColumnarIndex, EraCopy, Manifest, ManifestShard } from "../src/data/loader";
import { mulberry32 } from "../src/data/rng";
import { deriveExtra, regionOf } from "../src/data/derive";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const OUT_DIR = path.join(REPO_ROOT, "public/data");
const SHARD_SIZE = 2000;

const LOC_KIND_CODE: Record<LocKind, number> = { point: 0, country: 1, none: 2 };

/** Keeps the columnar JSON small: 3 decimal places is well past the visual
 * precision a pixel-art globe needs for any of these fields. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// Static narrative copy for the five scroll eras (see PLAN.md / reel.html's
// `.era-sec` markup). Independent of the event dataset.
const ERAS: EraCopy[] = [
  {
    year: -2500,
    title: "Ancient world",
    body: "Writing, law codes, and monumental architecture appear within a few centuries of one another across Mesopotamia, Egypt, and the Indus Valley. Bronze Age states organize labor and trade at a scale unseen before, then much of the eastern Mediterranean collapses in a wave of upheaval around 1200 BC.",
  },
  {
    year: -350,
    title: "Classical",
    body: "Greek city-states experiment with citizen assemblies while Persian, then Roman, empires bind vast territories under single administrations. Philosophy, coined currency, and codified law spread along the trade and military routes those empires cut.",
  },
  {
    year: 950,
    title: "Medieval",
    body: "After Rome's western half fragments, new centers of power rise in Byzantium, Baghdad, and the Carolingian court, each preserving and extending older learning. Feudal Europe, the Islamic Golden Age, and Song China develop largely apart, linked mainly by trade along the Silk Road.",
  },
  {
    year: 1500,
    title: "Age of exploration",
    body: "Printing, gunpowder, and ocean-going ships let ideas, armies, and disease cross distances that once took generations. European voyages reach the Americas and pull Atlantic, African, and Asian economies into a single, often brutal, exchange.",
  },
  {
    year: 1950,
    title: "Modern",
    body: "Steam power, then electricity and computing, repeatedly rewrite how people work, travel, and fight. Two world wars, decolonization, and a technological acceleration compress into a single century what earlier eras took a millennium to change.",
  },
];

function readRaw(): RawEventRecord[] {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, RAW_PATH)} — run \`npm run gen-synthetic\` first`);
  }
  const text = readFileSync(RAW_PATH, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEventRecord);
}

function buildColumnar(records: RawEventRecord[]): { columnar: ColumnarIndex; texts: string[] } {
  const rng = mulberry32(42);
  const columnar: ColumnarIndex = {
    year: [],
    lat: [],
    lon: [],
    locKind: [],
    region: [],
    impact: [],
    conf: [],
    real: [],
    minor: [],
    th: Object.fromEntries(THEMES.map((t) => [t, [] as number[]])) as ColumnarIndex["th"],
    ext: Object.fromEntries(EXT_THEMES.map((t) => [t, [] as number[]])) as ColumnarIndex["ext"],
  };
  const texts: string[] = [];

  for (const r of records) {
    const ext = deriveExtra(r.text, r.th, rng);
    const region = regionOf(r.lat, r.lon);
    // Mock confidence: high-impact / hand-authored events read as confident;
    // filler events get a wider, noisier spread — stands in for Jev's conf.
    const conf = Math.max(0.15, Math.min(0.99, (r.real ? 0.82 : 0.55) + (rng() - 0.5) * 0.3));

    columnar.year.push(r.year);
    columnar.lat.push(round3(r.lat));
    columnar.lon.push(round3(r.lon));
    columnar.locKind.push(LOC_KIND_CODE[r.locKind]);
    columnar.region.push(REGIONS.indexOf(region));
    columnar.impact.push(round3(r.impact));
    columnar.conf.push(round3(conf));
    columnar.real.push(r.real ? 1 : 0);
    columnar.minor.push(r.minor ? 1 : 0);
    for (const t of THEMES) columnar.th[t]!.push(round3(r.th[t]));
    for (const t of EXT_THEMES) columnar.ext[t]!.push(round3(ext[t]));
    texts.push(r.text);
  }
  return { columnar, texts };
}

function writeShards(texts: string[]): ManifestShard[] {
  const shardsDir = path.join(OUT_DIR, "shards");
  mkdirSync(shardsDir, { recursive: true });
  const shards: ManifestShard[] = [];
  for (let start = 0; start < texts.length; start += SHARD_SIZE) {
    const end = Math.min(texts.length, start + SHARD_SIZE);
    const file = `shards/shard-${String(start).padStart(6, "0")}.json`;
    const shardMap: Record<number, string> = {};
    for (let i = start; i < end; i++) shardMap[i] = texts[i]!;
    writeFileSync(path.join(OUT_DIR, file), JSON.stringify(shardMap));
    shards.push({ file, start, end });
  }
  return shards;
}

function main(): void {
  const records = readRaw();
  // Sort by year up front so index positions are already time-ordered; the
  // app's EventIndex re-sorts by T(year) at load time regardless.
  records.sort((a, b) => a.year - b.year);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const { columnar, texts } = buildColumnar(records);
  writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(columnar));

  const shards = writeShards(texts);

  const manifest: Manifest = {
    version: 1,
    totalEvents: records.length,
    shardSize: SHARD_SIZE,
    columnarFile: "index.json",
    erasFile: "eras.json",
    shards,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(OUT_DIR, "eras.json"), JSON.stringify(ERAS));

  console.log(`built public/data/: ${records.length} events, ${shards.length} shards`);
}

main();
