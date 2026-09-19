// Pulls real historical events from Wikidata's public SPARQL endpoint and
// writes them to data/raw/events.ndjson in the same RawEventRecord shape
// gen-synthetic.ts produces, so scripts/build-data.ts's downstream pipeline
// (columnar index + text shards + eras/landmarks, all content-hashed and
// referenced from manifest.json) needs no changes to consume real data
// instead of synthetic data. Run this, then `npm run build-data`; run
// gen-synthetic.ts instead to go back to synthetic — both just populate the
// same data/raw/events.ndjson file.
//
// Usage:
//   tsx scripts/fetch-wikidata.ts                  # full run, EVENT_TARGET below (ceiling, not a quota)
//   tsx scripts/fetch-wikidata.ts --target=500      # pilot run — validate the pipeline before committing to 50k
//   tsx scripts/fetch-wikidata.ts --dry-run         # print period ceilings only, write nothing
//   tsx scripts/fetch-wikidata.ts --dry-run --target=25000   # ceilings for any target, no fetch
//
// Scaling: EVENT_TARGET is the only knob that needs to change to go from the
// ~500-event pilot to the full 50,000-event run. Everything else (period
// quotas, paging, caching, rate limiting) is written to scale with it —
// periods that are simply thin in the historical record cap out at their
// measured ceiling instead of being backfilled with more modern events.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/data/types";
import type { LocKind, RawEventRecord, Theme } from "../src/data/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const CACHE_DIR = path.join(REPO_ROOT, "data/cache/wikidata");
const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "epochs-history-globe/0.1 (pilot data collection; contact: parthkohale@gmail.com)";

/** Total real events to collect. Raise this to scale the pull — nothing else
 * in this file needs to change. Per-period quotas below are proportional
 * shares of this number, each capped by that period's measured ceiling. */
// The user's stated end goal is the full ~50,000 events (matching the
// synthetic dataset size the renderer is already perf-benchmarked against),
// treated as a CEILING — periods that run dry per resolveQuotas() stay dry
// rather than being padded, duplicated, or backfilled from modern events to
// hit the number. Run this script with a smaller value first (see the
// pilot invocation in the module doc comment above) to validate the
// pipeline before committing to a 50k pull.
export const EVENT_TARGET = 50_000;

/** Be polite to a shared public endpoint: minimum gap between live HTTP
 * requests (cached reads are instant and don't count against this). */
const RATE_LIMIT_MS = 3000;
const PAGE_SIZE = 200;

/** One slice of the 3000 BC - present timeline, with the fraction of
 * EVENT_TARGET it's entitled to. Weights sum to 1. Skewed toward modern
 * (real Wikidata coverage skews that way too) but nowhere near as hard as
 * raw density would push it, so antiquity isn't crowded out entirely — and
 * each period still caps at whatever the record actually has (see
 * `resolveQuotas`), rather than modern periods absorbing the shortfall. */
export interface Period {
  label: string;
  start: number; // inclusive year, negative = BC
  end: number; // exclusive year
  weight: number;
}

export const PERIODS: Period[] = [
  { label: "3000-1000 BC", start: -3000, end: -1000, weight: 0.05 },
  { label: "1000-500 BC", start: -1000, end: -500, weight: 0.04 },
  { label: "500 BC - 1 BC", start: -500, end: 0, weight: 0.05 },
  { label: "1-500 AD", start: 0, end: 500, weight: 0.06 },
  { label: "500-1000", start: 500, end: 1000, weight: 0.06 },
  { label: "1000-1500", start: 1000, end: 1500, weight: 0.08 },
  { label: "1500-1800", start: 1500, end: 1800, weight: 0.1 },
  { label: "1800-1900", start: 1800, end: 1900, weight: 0.12 },
  { label: "1900-1950", start: 1900, end: 1950, weight: 0.14 },
  { label: "1950-2000", start: 1950, end: 2000, weight: 0.16 },
  { label: "2000-present", start: 2000, end: 2027, weight: 0.14 },
];

const WEIGHT_SUM = PERIODS.reduce((s, p) => s + p.weight, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(`PERIODS weights must sum to 1, got ${WEIGHT_SUM}`);
}

/** Given a measured ceiling per period (how many qualifying Wikidata items
 * actually exist for it), compute how many to fetch from each: the smaller
 * of its proportional share of `target` and its ceiling. Periods that run
 * dry simply produce fewer events — their leftover share is NOT redistributed
 * to other (e.g. modern) periods, so the output stays spread across history
 * rather than collapsing back into a modern-heavy sample. */
export function resolveQuotas(
  target: number,
  periods: Period[],
  ceilings: number[]
): number[] {
  return periods.map((p, i) => {
    const share = Math.round(target * p.weight);
    return Math.max(0, Math.min(share, ceilings[i] ?? 0));
  });
}

// ---- Wikidata date / coordinate parsing -----------------------------------

/** Parses a Wikidata SPARQL dateTime literal ("+1945-08-06T00:00:00Z",
 * "-002600-01-01T00:00:00Z") into a signed calendar year. Returns null if it
 * doesn't match the expected shape — callers must drop the event rather than
 * guess. */
export function parseWikidataYear(value: string | undefined | null): number | null {
  if (!value) return null;
  // The leading sign is present on most Wikidata dateTime literals but not
  // all (the SPARQL endpoint sometimes omits "+" for CE dates) — default to
  // positive when it's missing rather than dropping the event.
  const m = /^([+-])?(\d{1,6})-\d{2}-\d{2}/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const year = Number(m[2]);
  if (!Number.isFinite(year)) return null;
  return sign * year;
}

/** Parses a WKT "Point(lon lat)" literal into {lat, lon}. Returns null (and
 * the event is dropped) if it's missing or malformed, or the coordinates are
 * out of range. */
export function parseWikidataPoint(value: string | undefined | null): { lat: number; lon: number } | null {
  if (!value) return null;
  const m = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(value.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// ---- Theme classification --------------------------------------------------
// Cheap keyword classification against the item label, mirroring
// src/data/derive.ts's approach — a stand-in, not a real Jev call. Explicitly
// out of scope per the task brief to do LLM-based scoring here.
const THEME_KEYWORDS: Record<Theme, RegExp> = {
  war: /war|battle|siege|invasion|conquest|revolt|uprising|massacre|rebellion/i,
  politics: /treaty|election|coronation|independence|republic|constitution|parliament|revolution|assassinat|founded|unification/i,
  religion: /church|temple|mosque|cathedral|pope|council of|synod|monastery|pilgrimage|crusade/i,
  economy: /trade|famine|market|currency|railway|company|financial|depression|stock/i,
  science: /discover|expedition|invention|observatory|publish|theory|spacecraft|launch|patent/i,
  culture: /festival|painting|opera|novel|monument|olympic|film|architecture/i,
};

export function classifyTheme(label: string): Record<Theme, number> {
  const scores = Object.fromEntries(THEMES.map((t) => [t, 0.1])) as Record<Theme, number>;
  let matched = false;
  for (const t of THEMES) {
    if (THEME_KEYWORDS[t].test(label)) {
      scores[t] = 0.75;
      matched = true;
    }
  }
  if (!matched) scores.politics = 0.4; // documented placeholder lead theme
  return scores;
}

// ---- SPARQL -----------------------------------------------------------------

// A curated list of common historical-event classes, queried by direct
// wdt:P31 (VALUES + UNION of direct instance-of) rather than a transitive
// wdt:P31/wdt:P279* walk from a broad root like "occurrence" (Q1190554).
// The transitive form times out (HTTP 504) at Wikidata's scale — it has to
// walk a huge subclass tree for every candidate item. A fixed class list is
// the standard workaround and is cheap enough to page through repeatedly.
const EVENT_CLASSES = [
  "Q1190554", // occurrence (direct instances only, no subclass walk)
  "Q178561", // battle
  "Q198", // war
  "Q124757", // siege
  "Q3839081", // massacre
  "Q131569", // treaty
  "Q1002697", // military occupation
  "Q3241045", // uprising
  "Q45382", // rebellion
  "Q1656682", // event
  "Q2334719", // historical period event / historical event subclass
];

function classValuesClause(): string {
  return `VALUES ?class { ${EVENT_CLASSES.map((q) => `wd:${q}`).join(" ")} }`;
}

function buildEventsQuery(period: Period, limit: number, offset: number): string {
  return `SELECT ?item ?itemLabel ?date ?coord ?article WHERE {
  ${classValuesClause()}
  ?item wdt:P31 ?class .
  ?item wdt:P625 ?coord .
  { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?item
LIMIT ${limit}
OFFSET ${offset}`;
}

function buildCountQuery(period: Period): string {
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  ${classValuesClause()}
  ?item wdt:P31 ?class .
  ?item wdt:P625 ?coord .
  { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
}`;
}

interface SparqlBinding {
  item: { value: string };
  itemLabel?: { value: string };
  date?: { value: string };
  coord?: { value: string };
  article?: { value: string };
}
interface SparqlResponse {
  results: { bindings: SparqlBinding[] };
}

function cacheKeyFor(query: string): string {
  return createHash("sha1").update(query).digest("hex").slice(0, 16);
}

let lastRequestAt = 0;
async function politeDelay(): Promise<void> {
  const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/** Runs a SPARQL query, transparently caching the raw JSON response to disk
 * keyed by the query text's hash. A re-run (or a resumed interrupted run)
 * that asks for the same query never re-hits the endpoint. */
async function runQuery(query: string, cacheTag: string): Promise<unknown> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${cacheTag}-${cacheKeyFor(query)}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  await politeDelay();
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
  });
  if (!res.ok) {
    throw new Error(`SPARQL query failed (${res.status} ${res.statusText}): ${cacheTag}`);
  }
  const json = await res.json();
  writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

async function fetchCeiling(period: Period, periodIdx: number): Promise<number> {
  const json = (await runQuery(buildCountQuery(period), `count-${periodIdx}`)) as {
    results: { bindings: { c: { value: string } }[] };
  };
  const raw = json.results.bindings[0]?.c?.value;
  return raw ? Number(raw) : 0;
}

function citationFor(qid: string, article?: string): string {
  return article ?? `https://www.wikidata.org/wiki/${qid}`;
}

function qidFromUri(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

/** Converts one SPARQL binding into a RawEventRecord, or null if it's
 * missing a usable date or coordinates — such rows are dropped, never
 * guessed at. */
export function bindingToRecord(b: SparqlBinding): RawEventRecord | null {
  const year = parseWikidataYear(b.date?.value);
  const point = parseWikidataPoint(b.coord?.value);
  if (year === null || point === null) return null;
  const qid = qidFromUri(b.item.value);
  const label = b.itemLabel?.value ?? qid;
  return {
    year,
    text: label,
    lat: point.lat,
    lon: point.lon,
    locKind: "point" as LocKind,
    th: classifyTheme(label),
    // No Jev scoring in this pilot (out of scope) — documented placeholder,
    // mid-scale on the 0..3 impact range used elsewhere in the pipeline.
    impact: 1.5,
    real: true,
    minor: false,
    qid,
    source: citationFor(qid, b.article?.value),
  };
}

async function fetchPeriodEvents(period: Period, periodIdx: number, quota: number): Promise<RawEventRecord[]> {
  const out: RawEventRecord[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < quota; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, quota - offset);
    const query = buildEventsQuery(period, limit, offset);
    const json = (await runQuery(query, `page-${periodIdx}-${offset}`)) as SparqlResponse;
    const bindings = json.results?.bindings ?? [];
    if (bindings.length === 0) break; // endpoint has nothing more for this window
    for (const b of bindings) {
      const rec = bindingToRecord(b);
      if (!rec || !rec.qid) continue;
      if (seen.has(rec.qid)) continue;
      seen.add(rec.qid);
      out.push(rec);
    }
    if (bindings.length < limit) break; // short page: nothing more to page through
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const targetArg = process.argv.find((a) => a.startsWith("--target="));
  const target = targetArg ? Number(targetArg.split("=")[1]) : EVENT_TARGET;

  console.log(`fetch-wikidata: target ${target} events across ${PERIODS.length} periods (ceiling, not a quota to fill)`);
  const ceilings: number[] = [];
  for (let i = 0; i < PERIODS.length; i++) {
    const c = await fetchCeiling(PERIODS[i]!, i);
    ceilings.push(c);
    console.log(`  ceiling ${PERIODS[i]!.label}: ${c} qualifying items (date + coordinates)`);
  }

  const quotas = resolveQuotas(target, PERIODS, ceilings);
  for (let i = 0; i < PERIODS.length; i++) {
    console.log(`  quota   ${PERIODS[i]!.label}: ${quotas[i]} (of ${Math.round(target * PERIODS[i]!.weight)} desired)`);
  }

  if (dryRun) {
    console.log("dry run: not fetching events or writing output");
    return;
  }

  const all: RawEventRecord[] = [];
  for (let i = 0; i < PERIODS.length; i++) {
    const period = PERIODS[i]!;
    const quota = quotas[i]!;
    if (quota <= 0) continue;
    const events = await fetchPeriodEvents(period, i, quota);
    console.log(`  fetched ${events.length}/${quota} for ${period.label}`);
    all.push(...events);
  }

  // Deterministic ordering: same cached input always yields the same file.
  all.sort((a, b) => a.year - b.year || (a.qid ?? "").localeCompare(b.qid ?? ""));

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${all.length} real events to ${path.relative(REPO_ROOT, OUT_PATH)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
