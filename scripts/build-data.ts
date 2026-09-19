// Reads data/raw/events.ndjson and writes the public/data/ bundle the app
// fetches at runtime: manifest.json (short-lived), a content-hashed columnar
// index, content-hashed ~2k-event text shards, and a content-hashed
// eras.json. Only manifest.json keeps a stable name — everything else it
// references can be cached immutably forever because its filename changes
// whenever its content does.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXT_THEMES, REGIONS, THEMES } from "../src/data/types";
import type { LocKind, RawEventRecord } from "../src/data/types";
import type { ColumnarIndex, EraCopy, Manifest, ManifestShard } from "../src/data/loader";
import { mulberry32 } from "../src/data/rng";
import { deriveExtra, regionOf } from "../src/data/derive";
import { LANDMARKS } from "../src/data/landmarks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const OUT_DIR = path.join(REPO_ROOT, "public/data");
const SHARD_SIZE = 2000;

const LOC_KIND_CODE: Record<LocKind, number> = { point: 0, country: 1, none: 2 };

/** Keeps the columnar JSON small: 2 decimal places is well past the visual
 * precision a pixel-art globe needs for any of these fields. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Writes `content` under a content-hashed filename (`<base>.<hash><ext>`)
 * and returns that filename, so the manifest can reference it and callers
 * can cache it immutably forever. */
function writeHashed(base: string, ext: string, content: string): string {
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 10);
  const file = `${base}.${hash}${ext}`;
  writeFileSync(path.join(OUT_DIR, file), content);
  return file;
}

// Narrative copy for the scroll eras (see narrative/index.ts / comet.ts,
// which render/anchor these plus src/data/landmarks.ts's cards between
// them). Independent of the event dataset. Global on purpose — not
// Europe-only — with concrete places, people and dates in each body.
const ERAS: EraCopy[] = [
  {
    year: -3000,
    title: "Early civilisations",
    body: "Sumerian cities like Uruk and Ur develop cuneiform writing and centralized temple economies along the Tigris and Euphrates, while Egypt unifies under its first pharaohs along the Nile and the Indus Valley's Harappa and Mohenjo-daro lay out planned streets and drainage. None of these societies yet know of the others; each invents administration, irrigation, and record-keeping on its own.",
  },
  {
    year: -2000,
    title: "Bronze Age",
    body: "Bronze weapons and chariots spread from the Near East to the Aegean and China, where the Shang dynasty casts ritual vessels along the Yellow River. Babylon rises under Hammurabi, whose law code is carved onto a stone stele around 1754 BC, while Minoan Crete trades across the Mediterranean. Long-distance trade in tin and copper links Britain, Anatolia, and the Levant into the first international bronze economy.",
  },
  {
    year: -1200,
    title: "Iron Age empires",
    body: "Around 1200 BC a wave of destructions — the Bronze Age Collapse — brings down Mycenaean Greece, the Hittite Empire, and cities across the eastern Mediterranean within a few decades. Iron tools and weapons, cheaper than bronze, spread as new powers rebuild: Assyria conquers an empire stretching from Egypt to the Persian Gulf, while Phoenician sailors carry an alphabet and colonies across the Mediterranean, from Tyre to Carthage.",
  },
  {
    year: -500,
    title: "Classical Greece",
    body: "Athens experiments with citizen assembly and jury courts while Sparta organizes itself entirely around its army; both unite briefly to repel Persian invasions at Marathon in 490 BC and Salamis in 480 BC. Philosophy, tragedy, and geometry flourish in Athens even as the Peloponnesian War exhausts the Greek city-states. Further east, the Achaemenid Persian Empire administers the largest state the world has yet seen, from Egypt to the Indus.",
  },
  {
    year: -221,
    title: "Rome & Han",
    body: "Rome, having just defeated Carthage in the Punic Wars, expands from an Italian city-state into a Mediterranean power. In China, Qin Shi Huang unifies the warring states in 221 BC, and the Han dynasty that follows in 206 BC builds long-distance roads and standardizes currency and law, eventually trading indirectly with Rome via the Silk Road. At their height, Rome and Han China together govern close to half of the world's population.",
  },
  {
    year: 250,
    title: "Late antiquity",
    body: "The Roman Empire strains under civil war and invasion, while Constantine legalizes Christianity in 313 and moves the capital east to Constantinople. In India, the Gupta Empire presides over advances in mathematics, including the concept of zero, and in Mesoamerica the Maya build monumental cities like Tikal. Han China collapses into competing kingdoms, and Buddhism spreads from India along trade routes into Central Asia and China.",
  },
  {
    year: 600,
    title: "Early medieval",
    body: "The Prophet Muhammad's teachings in Mecca and Medina found a religion that, within a century of his death in 632, unites Arabia and conquers territory from Spain to Persia. In China, the Tang dynasty reunifies the empire in 618 and presides over a cosmopolitan capital at Chang'an, then the world's largest city. Western Europe fragments into small kingdoms after Rome's fall, while the Maya civilization reaches its classic-period height.",
  },
  {
    year: 800,
    title: "Islamic Golden Age",
    body: "The Abbasid Caliphate, ruling from Baghdad, founds the House of Wisdom, where scholars translate Greek, Persian, and Indian texts and advance algebra, optics, and medicine. Trade networks connect Song-era China, India, East Africa's Swahili coast, and Muslim Spain, moving paper-making technology and Hindu-Arabic numerals into wider use. In West Africa, the Ghana Empire grows wealthy controlling trans-Saharan gold and salt trade.",
  },
  {
    year: 1000,
    title: "High medieval",
    body: "Song China issues the world's first government paper currency and builds a canal and market economy supporting cities of a million people, while the Seljuk Turks expand from Persia into Anatolia. In 1096 the First Crusade sets out from Western Europe to capture Jerusalem, beginning two centuries of conflict and exchange between Christian and Muslim states. In sub-Saharan Africa, Great Zimbabwe's stone city rises as a trading hub for gold and ivory.",
  },
  {
    year: 1200,
    title: "Mongol era",
    body: "Genghis Khan unites the Mongol tribes in 1206 and launches conquests that, within decades, create the largest contiguous land empire in history, stretching from Korea to Hungary. His successors sack Baghdad in 1258, ending the Abbasid Caliphate there, while the Pax Mongolica reopens Silk Road trade so thoroughly that Marco Polo can travel from Venice to Kublai Khan's court. The same routes also carry the plague that will become the Black Death toward Europe.",
  },
  {
    year: 1400,
    title: "Renaissance",
    body: "After the Black Death kills roughly a third of Europe's population, Italian city-states like Florence and Venice grow wealthy on trade and patronize a revival of classical art and learning. Constantinople falls to the Ottomans in 1453, ending the Byzantine Empire and pushing Greek scholars west, while the Ming dynasty's Zheng He leads treasure fleets across the Indian Ocean to East Africa. Gutenberg's printing press, developed around 1450, begins spreading texts faster than any copyist could.",
  },
  {
    year: 1490,
    title: "Age of exploration",
    body: "Columbus reaches the Caribbean in 1492 under the Spanish crown, and Vasco da Gama sails around Africa to India in 1498, opening direct sea routes that remake global trade. The Ottoman Empire controls the eastern Mediterranean and much of the old Silk Road, pushing European states to seek routes by sea, while the Songhai Empire dominates trade across the Niger River in West Africa. Within decades, Spanish conquistadors topple the Aztec and Inca empires, and the Columbian Exchange begins moving crops, animals, and diseases between hemispheres.",
  },
  {
    year: 1650,
    title: "Revolutions",
    body: "Isaac Newton and the Royal Society formalize a scientific method that reshapes how Europeans understand the natural world, while Enlightenment writers question monarchy and religious authority. Those ideas feed the American Declaration of Independence in 1776, the French Revolution in 1789, and the Haitian Revolution of 1791, the only successful slave revolt to found a state. Meanwhile Qing China and Mughal India remain the world's largest economies, largely untouched by these upheavals.",
  },
  {
    year: 1800,
    title: "Industrial age",
    body: "Steam power and mechanized textile production, first concentrated in Britain, spread to continental Europe, the United States, and Japan, while railways and telegraphs shrink travel and communication times. European powers colonize most of Africa after the 1884 Berlin Conference and impose unequal treaties on China after the Opium Wars, even as Japan's 1868 Meiji Restoration rapidly industrializes it into a rival power. Mass migration moves tens of millions of people across oceans over the century.",
  },
  {
    year: 1900,
    title: "World wars",
    body: "Assassination in Sarajevo triggers the First World War in 1914, drawing empires and their colonies into a conflict that kills some 20 million people and topples the Russian, Ottoman, Austro-Hungarian, and German empires. A second global war from 1939 to 1945 kills far more, including the Holocaust's six million Jewish victims, and ends with atomic bombs dropped on Hiroshima and Nagasaki. Independence movements gather strength throughout these decades, from India's Congress Party to Ghana's Kwame Nkrumah.",
  },
  {
    year: 1946,
    title: "Cold War",
    body: "The United States and Soviet Union emerge as rival superpowers in the aftermath of the Second World War, dividing much of the world into competing blocs while fighting proxy conflicts in Korea, Vietnam, and Afghanistan rather than each other directly. Decolonization accelerates: India gains independence in 1947, and dozens of African nations follow through the 1950s and 60s, many joining the Non-Aligned Movement rather than choosing a side. The Space Race puts Sputnik in orbit in 1957 and American astronauts on the Moon in 1969, before the Berlin Wall falls in 1989.",
  },
  {
    year: 1990,
    title: "Digital age",
    body: "The Soviet Union dissolves in 1991, and the World Wide Web, released to the public that same year, begins connecting computers worldwide into a single network. China's economic reforms and India's liberalization pull hundreds of millions out of poverty and shift manufacturing and technology work globally, while a 2008 financial crisis starting in American mortgage markets spreads worldwide within weeks. Smartphones, social media, and artificial intelligence reshape daily life and politics on every continent within a single generation.",
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
    columnar.lat.push(round2(r.lat));
    columnar.lon.push(round2(r.lon));
    columnar.locKind.push(LOC_KIND_CODE[r.locKind]);
    columnar.region.push(REGIONS.indexOf(region));
    columnar.impact.push(round2(r.impact));
    columnar.conf.push(round2(conf));
    columnar.real.push(r.real ? 1 : 0);
    columnar.minor.push(r.minor ? 1 : 0);
    for (const t of THEMES) columnar.th[t]!.push(round2(r.th[t]));
    for (const t of EXT_THEMES) columnar.ext[t]!.push(round2(ext[t]));
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
    const shardMap: Record<number, string> = {};
    for (let i = start; i < end; i++) shardMap[i] = texts[i]!;
    const content = JSON.stringify(shardMap);
    const hash = createHash("sha1").update(content).digest("hex").slice(0, 10);
    const file = `shards/shard-${String(start).padStart(6, "0")}.${hash}.json`;
    writeFileSync(path.join(OUT_DIR, file), content);
    shards.push({ file, start, end });
  }
  return shards;
}

function main(): void {
  const records = readRaw();
  // Sort by year up front so index positions are already time-ordered; the
  // app's EventIndex re-sorts by T(year) at load time regardless. This sort
  // plus the seeded RNGs below make the whole build byte-for-byte
  // deterministic — no timestamps or other per-run churn anywhere in the
  // output, so a re-run with unchanged input produces identical files.
  records.sort((a, b) => a.year - b.year);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const { columnar, texts } = buildColumnar(records);
  const columnarFile = writeHashed("index", ".json", JSON.stringify(columnar));

  const shards = writeShards(texts);

  const erasFile = writeHashed("eras", ".json", JSON.stringify(ERAS));
  const landmarksFile = writeHashed("landmarks", ".json", JSON.stringify(LANDMARKS));

  const manifest: Manifest = {
    version: 1,
    totalEvents: records.length,
    shardSize: SHARD_SIZE,
    columnarFile,
    erasFile,
    landmarksFile,
    shards,
  };
  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest));

  console.log(`built public/data/: ${records.length} events, ${shards.length} shards`);
}

main();
