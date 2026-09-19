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
// QLever mirrors Wikidata but answers transitive property-path queries
// (wdt:P31/wdt:P279*) that time out (HTTP 504) against WDQS at this scale —
// used ONLY for stage-1 candidate discovery (item/class/date/sitelinks), per
// the task brief's explicit sanction. Its snapshot being a few days stale is
// irrelevant there: every candidate QID is re-resolved (coordinates, label)
// against live WDQS in stage 2, so a stale or since-deleted QID simply fails
// to resolve and is dropped rather than silently trusted.
const QLEVER_ENDPOINT = "https://qlever.dev/api/wikidata";
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
const RATE_LIMIT_MS = 4000;

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

// Boundary check (1g): year 0 must land in exactly one period. "500 BC - 1
// BC" ends at (exclusive) 0, so it covers years -500..-1; "1-500 AD" starts
// at (inclusive) 0, so it covers years 0..499. Year 0 (1 BC in the proleptic
// calendar / year 0 in astronomical numbering, see parseWikidataYear) lands
// in "1-500 AD" and nowhere else — this was already correct, verified by the
// "cover 3000 BC through the present with no gaps or overlaps" test below.
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
 * rather than collapsing back into a modern-heavy sample.
 *
 * Uses the largest-remainder method so the shares sum to exactly `target`
 * (when ceilings allow) instead of drifting from independent per-period
 * rounding: each period first gets floor(target*weight), then the
 * `target - sum(floors)` leftover slots go to the periods with the largest
 * fractional remainder, one each. */
export function resolveQuotas(
  target: number,
  periods: Period[],
  ceilings: number[]
): number[] {
  const raw = periods.map((p) => target * p.weight);
  const floors = raw.map((v) => Math.floor(v));
  let leftover = target - floors.reduce((a, b) => a + b, 0);
  const remainders = raw
    .map((v, i) => ({ i, frac: v - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const shares = [...floors];
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    shares[i] = shares[i]! + 1;
    leftover--;
  }
  return periods.map((_, i) => Math.max(0, Math.min(shares[i]!, ceilings[i] ?? 0)));
}

// ---- Wikidata date / coordinate parsing -----------------------------------

/** Parses a Wikidata SPARQL dateTime literal ("+1945-08-06T00:00:00Z",
 * "-000489-09-07T00:00:00Z") into a signed calendar year, where negative
 * means BC/BCE and the magnitude is the ordinary historical year (e.g. -490
 * means 490 BC), matching the convention `Period.start`/`.end` already use
 * elsewhere in this file. Returns null if the literal doesn't match the
 * expected shape — callers must drop the event rather than guess.
 *
 * BCE off-by-one (verified live 2026-09-20 against Q31900, Battle of
 * Marathon, commonly dated 490 BC): its wdt:P585 literal is
 * "-0489-09-07T00:00:00Z", i.e. astronomical year -489, NOT -490. Wikidata's
 * RDF export uses astronomical year numbering, where year 0 = 1 BCE and
 * year -1 = 2 BCE — every BCE year is off by one from its magnitude. The
 * previous implementation returned the astronomical value unchanged
 * (-489 for Marathon), which is 490 BC's astronomical year but reads as "489
 * BC" if naively negated back — a real off-by-one bug for every BCE event.
 * Fix: for astronomical year <= 0, historical BC year = astronomicalYear - 1
 * (so -489 -> -490, matching "490 BC"; 0 -> -1, matching "1 BC"). CE years
 * (astronomical year >= 1) are unaffected. */
export function parseWikidataYear(value: string | undefined | null): number | null {
  if (!value) return null;
  // The leading sign is present on most Wikidata dateTime literals but not
  // all (the SPARQL endpoint sometimes omits "+" for CE dates) — default to
  // positive when it's missing rather than dropping the event.
  const m = /^([+-])?(\d{1,6})-\d{2}-\d{2}/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const magnitude = Number(m[2]);
  if (!Number.isFinite(magnitude)) return null;
  const astronomicalYear = sign * magnitude;
  return astronomicalYear <= 0 ? astronomicalYear - 1 : astronomicalYear;
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

// ---- Part 5 (+ follow-up: per-theme bucketed selection) -------------------
// THEME_CLASSES is the single source of truth for every Wikidata class this
// pipeline queries by name: it drives CLASS_THEME_MAP (Part 5's theme
// derivation), EVENT_CLASSES/NON_EVENT_CLASSES (kept as derived views for the
// verify script and classValuesClause), and the per-theme candidate queries
// added in the follow-up pass below (buildThemeCandidatesQuery).
//
// `dateKind` says which Wikidata properties carry the date: "event" classes
// (battles, treaties, elections, ...) use P585 (point in time) / P580 (start
// time); "institution" classes (church buildings, universities, companies,
// ...) use P571 (inception) / P1619 (official opening) / P576 (dissolved),
// per Part 3.
//
// Every QID below was verified live 2026-09-20 against the endpoint
// (`SELECT ?label WHERE { wd:QID rdfs:label ?label . FILTER(LANG(?label)='en') }`,
// batched via VALUES) via scripts/verify-event-classes.ts, which is the
// authoritative source of truth — run `tsx scripts/verify-event-classes.ts`
// before trusting or extending this list. This file's history has already
// caught eleven wrong QIDs across three passes: six in the original
// EVENT_CLASSES draft, two in the original NON_EVENT_CLASSES draft
// (Q495015 "Fudan University" swapped in for observatory, and a flagged
// Q11424 railway placeholder), and three more in this pass's first attempt
// at broadening war/politics/religion event classes — Q209749 turned out to
// be "Gjirokastër District" (not invasion — dropped, no clean replacement
// found), Q219557 is "cult film" (not synod — replaced with the verified
// Q111161), Q747074 is "comune of Italy" (not ecumenical council — replaced
// with the verified Q51645), Q1301371 is "computer network" (not referendum
// — replaced with the verified Q43109), and Q124734 (originally guessed as
// "siege") is actually "rebellion" — kept under that correct label, with the
// real "siege" class added separately as the verified Q188055.
interface ThemeClass {
  qid: string;
  label: string;
  dateKind: "event" | "institution";
}

export const THEME_CLASSES: Record<Theme, ThemeClass[]> = {
  war: [
    { qid: "Q178561", label: "battle", dateKind: "event" },
    { qid: "Q198", label: "war", dateKind: "event" },
    { qid: "Q188055", label: "siege", dateKind: "event" },
    { qid: "Q124734", label: "rebellion", dateKind: "event" },
    { qid: "Q45382", label: "coup d'état", dateKind: "event" },
  ],
  politics: [
    { qid: "Q131569", label: "treaty", dateKind: "event" },
    { qid: "Q1656682", label: "planned event", dateKind: "event" },
    { qid: "Q40231", label: "public election", dateKind: "event" },
    { qid: "Q209715", label: "coronation", dateKind: "event" },
    { qid: "Q10931", label: "revolution", dateKind: "event" },
    { qid: "Q43109", label: "referendum", dateKind: "event" },
  ],
  religion: [
    { qid: "Q51645", label: "ecumenical council", dateKind: "event" },
    { qid: "Q111161", label: "synod", dateKind: "event" },
    { qid: "Q16970", label: "church building", dateKind: "institution" },
    { qid: "Q32815", label: "mosque", dateKind: "institution" },
    { qid: "Q34627", label: "synagogue", dateKind: "institution" },
    { qid: "Q44539", label: "temple", dateKind: "institution" },
    { qid: "Q44613", label: "monastery", dateKind: "institution" },
  ],
  // Previously just company/railway/bridge (measured 1.2% of the pilot
  // sample) — bank, stock exchange and port added this pass, each verified
  // live, to actually supply an economy bucket instead of leaving it to
  // starve on three narrow classes.
  economy: [
    { qid: "Q783794", label: "company", dateKind: "institution" },
    { qid: "Q22667", label: "railway", dateKind: "institution" },
    { qid: "Q12280", label: "bridge", dateKind: "institution" },
    { qid: "Q22687", label: "bank", dateKind: "institution" },
    { qid: "Q11691", label: "stock exchange", dateKind: "institution" },
    { qid: "Q44782", label: "port", dateKind: "institution" },
  ],
  // Previously just university/school/observatory (measured 2.3%) — hospital,
  // library, research institute and botanical garden added this pass.
  science: [
    { qid: "Q3918", label: "university", dateKind: "institution" },
    { qid: "Q3914", label: "school", dateKind: "institution" },
    { qid: "Q62832", label: "observatory", dateKind: "institution" },
    { qid: "Q16917", label: "hospital", dateKind: "institution" },
    { qid: "Q7075", label: "library", dateKind: "institution" },
    { qid: "Q31855", label: "research institute", dateKind: "institution" },
    { qid: "Q167346", label: "botanical garden", dateKind: "institution" },
  ],
  culture: [
    { qid: "Q33506", label: "museum", dateKind: "institution" },
    { qid: "Q24354", label: "theatre building", dateKind: "institution" },
    { qid: "Q22698", label: "park", dateKind: "institution" },
    { qid: "Q515", label: "city", dateKind: "institution" },
  ],
};

/** Derived from THEME_CLASSES: every event-dated (P585/P580) class, across
 * all themes. Exported for scripts/verify-event-classes.ts and kept as the
 * name this codebase has used since the original hand-picked list. */
export const EVENT_CLASSES: { qid: string; label: string }[] = THEMES.flatMap((t) =>
  THEME_CLASSES[t].filter((c) => c.dateKind === "event").map(({ qid, label }) => ({ qid, label }))
);

/** Derived from THEME_CLASSES: every institution-dated (P571/P1619/P576)
 * class — by construction these are all in religion/economy/science/culture,
 * since war and politics classes here are all event-shaped. */
export const NON_EVENT_CLASSES: { qid: string; label: string }[] = THEMES.flatMap((t) =>
  THEME_CLASSES[t].filter((c) => c.dateKind === "institution").map(({ qid, label }) => ({ qid, label }))
);

/** Derived from THEME_CLASSES: qid -> theme, for classifyThemeFromClass
 * (Part 5) and the per-theme candidate queries below. Any class not listed
 * here (almost all of the ~283k-item occurrence subclass tree, measured live
 * against QLever 2026-09-20 — far too broad and long-tailed to hand-curate
 * honestly) falls back to classifyTheme's label-keyword heuristic for scoring,
 * and to the "politics" catch-all bucket for selection (see
 * buildThemeCandidatesQuery) — both defaults matching classifyTheme's own
 * "no keyword match -> politics" fallback. */
export const CLASS_THEME_MAP: Record<string, Theme> = Object.fromEntries(
  THEMES.flatMap((t) => THEME_CLASSES[t].map((c) => [c.qid, t] as const))
);

/** Every explicitly-classed qid across all six themes — used to exclude
 * them from the "politics" catch-all bucket's broadened occurrence query, so
 * an item explicitly classed as e.g. a battle or a church building is only
 * ever offered to its own theme's bucket, never double-counted into
 * politics's catch-all too. */
const ALL_MAPPED_QIDS: string[] = Object.keys(CLASS_THEME_MAP);

/** Interim theme derivation for Part 5: prefers the class->theme map (when
 * the query supplied a recognised ?class), falling back to the label-keyword
 * heuristic (classifyTheme) for classes outside the curated map — which, for
 * the broadened occurrence-subclass tree, is most of them. Still no LLM
 * scoring (out of scope); `impact` stays the documented 1.5 placeholder. */
export function classifyThemeFromClass(label: string, classQid: string | undefined): Record<Theme, number> {
  const theme = classQid ? CLASS_THEME_MAP[classQid] : undefined;
  if (!theme) return classifyTheme(label);
  const scores = Object.fromEntries(THEMES.map((t) => [t, 0.1])) as Record<Theme, number>;
  scores[theme] = 0.8; // higher confidence than the keyword heuristic's 0.75
  return scores;
}

// ---- Follow-up: target theme shares for bucketed selection -----------------
// Ranking selection by one global sitelink order per period (the original
// Part 4) systematically favours whichever theme's classes happen to carry
// the highest sitelink counts — measured live in the first pilot: cities
// (culture) dominated at 41.9%, war/politics took most of the rest, and
// economy/science were nearly absent (1.2% / 2.3%). Fixing that means giving
// each theme its own quota, ranked by sitelinks WITHIN that theme, so a
// modest economy or science item competes only against other economy/science
// items instead of against cities and battles.
//
// These shares are NOT a flat 1/6 each — a rigid equal split would be its
// own distortion, since war and politics genuinely dominate the pre-modern
// historical record Wikidata documents. Instead: war and politics each get a
// generous-but-bounded 25% (the two together are exactly half the sample,
// not more), religion and culture get a moderate 15% each (both have deep,
// genuine historical supply — councils/temples and cities/monuments — without
// being as universally document-dense as war/politics), and economy/science
// get 10% each (real but comparatively thin categories of dated institutions
// in Wikidata's structured data, versus the much larger corpus of recorded
// wars, treaties and elections). No single theme exceeds a quarter of any
// period's quota; every theme is guaranteed a meaningful floor rather than
// being crowded out entirely. A period whose record for a given theme is
// thinner than its share (Part 2/3's ceiling for that theme, in that period)
// simply gets fewer of that theme — never padded or backfilled from another
// theme, same non-redistribution principle resolveQuotas already uses across
// periods.
export const THEME_SHARES: Record<Theme, number> = {
  war: 0.25,
  politics: 0.25,
  religion: 0.15,
  culture: 0.15,
  economy: 0.1,
  science: 0.1,
};

const THEME_SHARE_SUM = THEMES.reduce((s, t) => s + THEME_SHARES[t], 0);
if (Math.abs(THEME_SHARE_SUM - 1) > 1e-9) {
  throw new Error(`THEME_SHARES must sum to 1, got ${THEME_SHARE_SUM}`);
}

/** Splits one period's quota across the six themes by THEME_SHARES, capping
 * each theme at its own supply ceiling for that period (Part 2/3's per-theme
 * candidate count) rather than redistributing a thin theme's shortfall to
 * another theme — the same largest-remainder-with-caps approach
 * `resolveQuotas` already uses across periods, applied across themes within
 * one period instead. */
export function resolveThemeQuotas(
  periodQuota: number,
  ceilings: Record<Theme, number>
): Record<Theme, number> {
  const raw = THEMES.map((t) => periodQuota * THEME_SHARES[t]);
  const floors = raw.map((v) => Math.floor(v));
  let leftover = periodQuota - floors.reduce((a, b) => a + b, 0);
  const remainders = raw
    .map((v, i) => ({ i, frac: v - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const shares = [...floors];
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    shares[i] = shares[i]! + 1;
    leftover--;
  }
  const out = {} as Record<Theme, number>;
  THEMES.forEach((t, i) => {
    out[t] = Math.max(0, Math.min(shares[i]!, ceilings[t] ?? 0));
  });
  return out;
}

// ---- SPARQL -----------------------------------------------------------------

/** P571 (inception), P1619 (official opening), P576 (dissolved) — the dates
 * Part 3's dated non-event items carry instead of P585/P580. */
export const NON_EVENT_DATE_PROPS = ["P571", "P1619", "P576"] as const;

function classValuesClause(classes: readonly { qid: string }[]): string {
  return `VALUES ?class { ${classes.map((c) => `wd:${c.qid}`).join(" ")} }`;
}

// ---- Part 1/2/3/4: stage-1 candidate discovery -----------------------------
// Stage 1 pulls (item, class, date, sitelinks, enwiki article) with NO
// coordinate requirement — requiring wdt:P625 up front is the single biggest
// yield killer (waiving it roughly triples the ceiling, per the measurement
// in the task brief). Coordinates are resolved separately in stage 2 via a
// fallback chain, batched by QID.
//
// Run against QLEVER_ENDPOINT rather than WDQS: it answers the transitive
// wdt:P31/wdt:P279* walk from occurrence (Q1190554) directly, which is what
// lets Part 2's class broadening happen inline instead of needing a
// materialized closure fed back as hundreds of VALUES batches (283,131
// subclasses of occurrence, measured live 2026-09-20 — far too many to batch
// through WDQS's per-query VALUES limits in any reasonable time). QLever's
// snapshot lag doesn't matter here: every candidate QID stage 2 keeps is
// re-resolved (coordinates, label, sitelinks) against live WDQS, so a stale
// or since-deleted QID just fails to resolve and is silently dropped.
//
// Selection used to rank once globally per period (ORDER BY DESC(?sitelinks)
// LIMIT N) — this function is kept for the overall period-ceiling figure
// `main()` reports, but actual event selection now runs per theme bucket
// (buildThemeCandidatesQuery below), since a single global sitelink ranking
// measurably let high-sitelink classes (cities, battles) crowd out
// low-sitelink ones (a bank, a synod) regardless of theme — see THEME_SHARES.
// NOTE: the raw (pre-SAMPLE) pattern variables are named ?dateRaw/?articleRaw/
// ?sitelinksRaw, distinct from the SELECTed ?date/?article/?sitelinks —
// QLever (unlike WDQS/Blazegraph) rejects "the target of an AS clause was
// already used in the query body", i.e. `(SAMPLE(?x) AS ?x)` is invalid there.

/** Stage-1 ceiling: how many qualifying (item, class, date) candidates exist
 * for a period with NO coordinate requirement — the number Part 1 says is
 * roughly 3x the old coordinate-required ceiling. Reported in `main()` as the
 * overall period ceiling; actual selection now runs per-theme (see
 * buildThemeCandidatesQuery / resolveThemeQuotas below), each capped by its
 * own theme ceiling from buildThemeCandidateCountQuery. */
function buildCandidateCountQuery(period: Period): string {
  const nonEventValues = classValuesClause(NON_EVENT_CLASSES);
  const nonEventDates = NON_EVENT_DATE_PROPS.map((p) => `{ ?item wdt:${p} ?date }`).join(" UNION ");
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  {
    ?item wdt:P31 ?class .
    ?class wdt:P279* wd:Q1190554 .
    { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  } UNION {
    ${nonEventValues}
    ?item wdt:P31 ?class .
    ${nonEventDates}
  }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
}`;
}

// ---- Follow-up: per-theme candidate queries (bucketed selection) ----------
// Builds the WHERE-clause body (no SELECT/GROUP BY/ORDER/LIMIT wrapper) that
// selects candidates belonging to one theme bucket: its own explicit classes
// (split into event-dated and institution-dated groups, per THEME_CLASSES),
// plus — for "politics" only — the broadened occurrence-subclass catch-all
// (Part 2), excluding every explicitly-classed qid so an item already bucketed
// under war/religion/economy/science/culture isn't also double-counted into
// politics's catch-all. This is what makes selection compete like-for-like
// within a theme instead of one global sitelink ranking letting
// high-sitelink classes (cities, battles) crowd out low-sitelink ones
// (a bank, a synod) regardless of theme.
function themeQueryBody(theme: Theme, period: Period): string {
  const classes = THEME_CLASSES[theme];
  const eventClasses = classes.filter((c) => c.dateKind === "event");
  const instClasses = classes.filter((c) => c.dateKind === "institution");
  const branches: string[] = [];
  if (eventClasses.length > 0) {
    branches.push(`{
    ${classValuesClause(eventClasses)}
    ?item wdt:P31 ?class .
    { ?item wdt:P585 ?dateRaw } UNION { ?item wdt:P580 ?dateRaw }
  }`);
  }
  if (instClasses.length > 0) {
    const dateUnion = NON_EVENT_DATE_PROPS.map((p) => `{ ?item wdt:${p} ?dateRaw }`).join(" UNION ");
    branches.push(`{
    ${classValuesClause(instClasses)}
    ?item wdt:P31 ?class .
    ${dateUnion}
  }`);
  }
  if (theme === "politics") {
    const excluded = ALL_MAPPED_QIDS.map((q) => `wd:${q}`).join(", ");
    branches.push(`{
    ?item wdt:P31 ?class .
    ?class wdt:P279* wd:Q1190554 .
    FILTER(?class NOT IN (${excluded}))
    { ?item wdt:P585 ?dateRaw } UNION { ?item wdt:P580 ?dateRaw }
  }`);
  }
  return `${branches.join(" UNION ")}
  FILTER(YEAR(?dateRaw) >= ${period.start} && YEAR(?dateRaw) < ${period.end})`;
}

function buildThemeCandidatesQuery(theme: Theme, period: Period, limit: number): string {
  return `SELECT ?item ?class (SAMPLE(?dateRaw) AS ?date) (SAMPLE(?articleRaw) AS ?article) (SAMPLE(?sitelinksRaw) AS ?sitelinks) WHERE {
  ${themeQueryBody(theme, period)}
  ?item wikibase:sitelinks ?sitelinksRaw .
  OPTIONAL {
    ?articleRaw schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
}
GROUP BY ?item ?class
ORDER BY DESC(?sitelinks) ?item
LIMIT ${limit}`;
}

function buildThemeCandidateCountQuery(theme: Theme, period: Period): string {
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  ${themeQueryBody(theme, period)}
}`;
}

// ---- Part 1: stage-2 coordinate resolution with fallback chain ------------
// Rungs, first-match wins: direct coordinates -> the location it's part of
// (P276) -> that location's containing administrative entity, transitively
// (P276/P131+) -> the country of the item itself (P17). The last rung sets
// locKind: "country" (already supported by the app — gen-synthetic emits it).
// P131+ is bounded to the batch already in play (COORD_BATCH_SIZE QIDs) so it
// can't run away the way an unbounded whole-graph walk would.
export type CoordRung = "P625" | "P276" | "P131" | "P17";
export const COORD_BATCH_SIZE = 60;

function buildCoordsQuery(qids: string[]): string {
  return `SELECT ?item (SAMPLE(?c1) AS ?c1) (SAMPLE(?c2) AS ?c2) (SAMPLE(?c3) AS ?c3) (SAMPLE(?c4) AS ?c4) WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  OPTIONAL { ?item wdt:P625 ?c1 . }
  OPTIONAL { ?item wdt:P276 ?loc1 . ?loc1 wdt:P625 ?c2 . }
  OPTIONAL { ?item wdt:P276 ?loc2 . ?loc2 wdt:P131+ ?adm . ?adm wdt:P625 ?c3 . }
  OPTIONAL { ?item wdt:P17 ?country . ?country wdt:P625 ?c4 . }
}
GROUP BY ?item`;
}

interface CoordBinding {
  item: { value: string };
  c1?: { value: string };
  c2?: { value: string };
  c3?: { value: string };
  c4?: { value: string };
}

/** Picks the first rung of the fallback chain (P625 -> P276 -> P131+ -> P17)
 * that resolved to a usable point, and reports which rung it was so the
 * report can show the coordinate-source mix. Returns null if every rung came
 * back empty or malformed — such items are dropped, never guessed at. */
export function chooseCoord(
  b: CoordBinding
): { point: { lat: number; lon: number }; rung: CoordRung } | null {
  const rungs: [CoordRung, string | undefined][] = [
    ["P625", b.c1?.value],
    ["P276", b.c2?.value],
    ["P131", b.c3?.value],
    ["P17", b.c4?.value],
  ];
  for (const [rung, raw] of rungs) {
    const point = parseWikidataPoint(raw);
    if (point) return { point, rung };
  }
  return null;
}

/** Resolves labels for a batch of QIDs via a flat VALUES + label-service
 * query (no GROUP BY — each item appears once already, so the label service
 * binds normally). Requests "en,[AUTO_LANGUAGE],mul,fr,de,es" (1f) and lets
 * callers drop any QID whose label never resolved past the bare QID. */
function buildLabelsQuery(qids: string[]): string {
  return `SELECT ?item ?itemLabel WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,[AUTO_LANGUAGE],mul,fr,de,es". }
}`;
}

interface SparqlBinding {
  item: { value: string };
  class?: { value: string };
  itemLabel?: { value: string };
  date?: { value: string };
  prec?: { value: string };
  coord?: { value: string };
  article?: { value: string };
  sitelinks?: { value: string };
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

// WDQS registers common prefixes (wdt:, wd:, p:, psv:, wikibase:, schema:, ...)
// server-side, so queries against it never declare them. QLever does not —
// it requires every prefix used to be declared inline, or it 400s. Rather
// than thread "which endpoint" state through every query builder, every
// query is prefixed with this block before being sent; WDQS tolerates
// (and ignores) redundant PREFIX declarations for prefixes it already knows.
const SPARQL_PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX psv: <http://www.wikidata.org/prop/statement/value/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX schema: <http://schema.org/>
`;

const MAX_RETRIES = 5;

/** Runs a SPARQL query, transparently caching the raw JSON response to disk
 * keyed by the query text's hash. A re-run (or a resumed interrupted run)
 * that asks for the same query never re-hits the endpoint.
 *
 * Retries a live 429/502/503 with exponential backoff (honouring
 * Retry-After when the server sends one) rather than failing the whole run:
 * a shared public endpoint occasionally throttles or hiccups under a long
 * multi-period pull even with RATE_LIMIT_MS respected between requests
 * (observed live 2026-09-20 running this exact pipeline). A run that
 * ultimately fails after MAX_RETRIES still throws, and — because nothing is
 * cached until a request succeeds — simply re-invoking the script resumes
 * from every already-cached query. */
async function runQuery(query: string, cacheTag: string, endpoint = ENDPOINT): Promise<unknown> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${cacheTag}-${cacheKeyFor(query)}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  const fullQuery = SPARQL_PREFIXES + query;
  const url = `${endpoint}?query=${encodeURIComponent(fullQuery)}&format=json`;
  for (let attempt = 0; ; attempt++) {
    await politeDelay();
    // A network-level failure (socket reset, etc.) throws before `fetch`
    // even produces a Response — observed live 2026-09-20 ("other side
    // closed" mid-request). Treat that the same as a retryable HTTP status
    // rather than letting it abort the whole run; it's exactly the kind of
    // transient public-endpoint hiccup this retry loop already exists for.
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const backoffMs = RATE_LIMIT_MS * 2 ** attempt;
      console.warn(
        `  network error on ${cacheTag} (${(err as Error).message}), retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      writeFileSync(cacheFile, JSON.stringify(json));
      return json;
    }
    const retryable = res.status === 429 || res.status === 502 || res.status === 503;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`SPARQL query failed (${res.status} ${res.statusText}): ${cacheTag}`);
    }
    const retryAfterHeader = Number(res.headers.get("Retry-After"));
    const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RATE_LIMIT_MS * 2 ** attempt;
    console.warn(`  ${res.status} on ${cacheTag}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

async function fetchCeiling(period: Period, periodIdx: number): Promise<number> {
  const json = (await runQuery(buildCandidateCountQuery(period), `count-${periodIdx}`, QLEVER_ENDPOINT)) as {
    results: { bindings: { c: { value: string } }[] };
  };
  const raw = json.results.bindings[0]?.c?.value;
  return raw ? Number(raw) : 0;
}

/** Per-theme stage-1 ceiling (follow-up to Part 4): how many candidates exist
 * for one theme bucket in one period, with no coordinate requirement. Feeds
 * `resolveThemeQuotas` and the per-period-per-theme ceiling table in the
 * report. */
async function fetchThemeCeiling(theme: Theme, period: Period, periodIdx: number): Promise<number> {
  const json = (await runQuery(
    buildThemeCandidateCountQuery(theme, period),
    `theme-count-${periodIdx}-${theme}`,
    QLEVER_ENDPOINT
  )) as { results: { bindings: { c: { value: string } }[] } };
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
 * missing a usable date or coordinates, or its label never resolved past the
 * bare QID (1f) — such rows are dropped, never guessed at. `minor` is left
 * `true` here; fetchPeriodEvents flips the top ~2%-by-sitelinks per period to
 * `false` afterward (1b), since "top 2% of this period" isn't knowable from
 * a single binding in isolation. */
export function bindingToRecord(b: SparqlBinding, opts?: { rung?: CoordRung }): RawEventRecord | null {
  const year = parseWikidataYear(b.date?.value);
  const point = parseWikidataPoint(b.coord?.value);
  if (year === null || point === null) return null;
  const qid = qidFromUri(b.item.value);
  const label = b.itemLabel?.value ?? qid;
  if (/^Q\d+$/.test(label)) return null; // label never resolved (1f)
  const sitelinks = b.sitelinks?.value ? Number(b.sitelinks.value) : undefined;
  const datePrecision = b.prec?.value ? Number(b.prec.value) : undefined;
  const classQid = b.class?.value ? qidFromUri(b.class.value) : undefined;
  // Part 1: a coordinate resolved via the P17 (country) fallback rung isn't a
  // point location for the item itself — mark it locKind "country" (already
  // rendered distinctly by src/globe/dots.ts) rather than a misleadingly
  // precise "point".
  const locKind: LocKind = opts?.rung === "P17" ? "country" : "point";
  return {
    year,
    text: label,
    lat: point.lat,
    lon: point.lon,
    locKind,
    th: classifyThemeFromClass(label, classQid),
    // No Jev scoring in this pilot (out of scope) — documented placeholder,
    // mid-scale on the 0..3 impact range used elsewhere in the pipeline.
    impact: 1.5,
    real: true,
    minor: true,
    qid,
    source: citationFor(qid, b.article?.value),
    sitelinks,
    datePrecision,
  };
}

/** Fraction of each period's fetched events marked non-minor (1b), ranked by
 * Wikipedia sitelink count — a cheap notability proxy. Matches the rough
 * "~1.5% of synthetic events are notable" ratio gen-synthetic.ts uses, since
 * src/loop.ts and src/globe/dots.ts render every non-minor event with its
 * own pulse/card/stroke and would be overwhelmed if most real events were
 * non-minor. */
const NOTABLE_FRACTION = 0.02;

/** Marks the top NOTABLE_FRACTION of `events` (by sitelinks, descending) as
 * `minor: false`, the rest `minor: true`. Mutates and returns `events`. */
export function markMinor(events: RawEventRecord[]): RawEventRecord[] {
  const ranked = [...events].sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
  const notableCount = Math.max(events.length > 0 ? 1 : 0, Math.round(events.length * NOTABLE_FRACTION));
  const notableQids = new Set(ranked.slice(0, notableCount).map((e) => e.qid));
  for (const e of events) e.minor = !notableQids.has(e.qid);
  return events;
}

/** Resolves labels for a page's worth of QIDs in one batched request (see
 * buildLabelsQuery) and returns a QID -> label map. */
async function resolveLabels(qids: string[], cacheTag: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qids.length === 0) return map;
  const json = (await runQuery(buildLabelsQuery(qids), cacheTag)) as SparqlResponse;
  for (const b of json.results?.bindings ?? []) {
    const label = b.itemLabel?.value;
    if (label) map.set(qidFromUri(b.item.value), label);
  }
  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Overfetch factor for stage-1 candidates: some fraction never resolve
 * coordinates on any fallback rung (Part 1) and get dropped, so asking for
 * exactly `quota` candidates would under-deliver. 1.5x is a conservative
 * cushion given the measured ~74% overall P625-required-vs-waived yield
 * ratio from the task brief's ceiling table. */
const COORD_OVERFETCH = 1.5;

/** Tally of which fallback rung resolved each kept event's coordinates
 * (Part 1), plus how many candidates were dropped for resolving on no rung
 * at all. Reset per process; `main()` prints it in the run summary. */
export const RUNG_STATS: Record<CoordRung | "none", number> = {
  P625: 0,
  P276: 0,
  P131: 0,
  P17: 0,
  none: 0,
};

/** Resolves coordinates for a batch of QIDs (Part 1's fallback chain),
 * batched to COORD_BATCH_SIZE so the bounded P131+ rung stays cheap. Returns
 * a QID -> resolved-coordinate map; QIDs absent from the map resolved on no
 * rung and are dropped by the caller. */
async function resolveCoords(
  qids: string[],
  cacheTag: string
): Promise<Map<string, { point: { lat: number; lon: number }; rung: CoordRung }>> {
  const map = new Map<string, { point: { lat: number; lon: number }; rung: CoordRung }>();
  for (const [i, batch] of chunk(qids, COORD_BATCH_SIZE).entries()) {
    if (batch.length === 0) continue;
    const json = (await runQuery(buildCoordsQuery(batch), `${cacheTag}-${i}`)) as {
      results: { bindings: CoordBinding[] };
    };
    for (const b of json.results?.bindings ?? []) {
      const resolved = chooseCoord(b);
      const qid = qidFromUri(b.item.value);
      if (resolved) map.set(qid, resolved);
    }
  }
  return map;
}

/** Runs stage 1 (candidate discovery for one theme bucket) + stage 2
 * (coordinate resolution) for a single (period, theme, quota) slice, and
 * returns the resolved records — everything fetchPeriodEvents used to do for
 * the whole period in one global-ranked pass, now scoped to one theme bucket
 * so a thin theme's items only ever compete against their own theme's items. */
async function fetchThemeBucketEvents(
  period: Period,
  periodIdx: number,
  theme: Theme,
  quota: number
): Promise<RawEventRecord[]> {
  if (quota <= 0) return [];
  const fetchLimit = Math.ceil(quota * COORD_OVERFETCH);
  const candJson = (await runQuery(
    buildThemeCandidatesQuery(theme, period, fetchLimit),
    `theme-cand-${periodIdx}-${theme}`,
    QLEVER_ENDPOINT
  )) as SparqlResponse;
  const candidates = candJson.results?.bindings ?? [];
  if (candidates.length === 0) return [];

  // Sequential, not Promise.all: politeDelay's rate limiter tracks a single
  // shared lastRequestAt timestamp, which only holds requests to RATE_LIMIT_MS
  // apart when they're issued one at a time. Concurrent label + coordinate
  // batches raced past it and got 429'd by WDQS live during testing.
  const qids = candidates.map((b) => qidFromUri(b.item.value));
  const labels = new Map<string, string>();
  for (const [i, batch] of chunk(qids, 300).entries()) {
    const part = await resolveLabels(batch, `theme-labels-${periodIdx}-${theme}-${i}`);
    for (const [k, v] of part) labels.set(k, v);
  }
  const coords = await resolveCoords(qids, `theme-coords-${periodIdx}-${theme}`);

  const out: RawEventRecord[] = [];
  const seen = new Set<string>();
  for (const b of candidates) {
    if (out.length >= quota) break; // stage-1 order is already rank order
    const qid = qidFromUri(b.item.value);
    if (seen.has(qid)) continue;
    const resolved = coords.get(qid);
    if (!resolved) {
      RUNG_STATS.none++;
      continue; // no rung resolved a coordinate (Part 1) — drop, don't guess
    }
    const label = labels.get(qid);
    const rec = bindingToRecord(
      {
        ...b,
        itemLabel: label ? { value: label } : undefined,
        coord: { value: `Point(${resolved.point.lon} ${resolved.point.lat})` },
      },
      { rung: resolved.rung }
    );
    if (!rec || !rec.qid) continue;
    seen.add(qid);
    RUNG_STATS[resolved.rung]++;
    out.push(rec);
  }
  return out;
}

/** For one period: measures each theme's ceiling, splits the period quota
 * across themes via resolveThemeQuotas, fetches each theme bucket, and marks
 * minor/non-minor across the whole period's combined output (so "top 2%" is
 * still period-wide, not per-theme-diluted). */
async function fetchPeriodEvents(period: Period, periodIdx: number, quota: number): Promise<RawEventRecord[]> {
  if (quota <= 0) return [];
  const ceilings = {} as Record<Theme, number>;
  for (const theme of THEMES) {
    ceilings[theme] = await fetchThemeCeiling(theme, period, periodIdx);
  }
  const themeQuotas = resolveThemeQuotas(quota, ceilings);

  const out: RawEventRecord[] = [];
  for (const theme of THEMES) {
    const themeQuota = themeQuotas[theme]!;
    if (themeQuota <= 0) continue;
    const events = await fetchThemeBucketEvents(period, periodIdx, theme, themeQuota);
    console.log(`    ${theme}: ${events.length}/${themeQuota} (ceiling ${ceilings[theme]})`);
    out.push(...events);
  }
  return markMinor(out);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const targetArg = process.argv.find((a) => a.startsWith("--target="));
  const target = targetArg ? Number(targetArg.split("=")[1]) : EVENT_TARGET;

  console.log(`fetch-wikidata: target ${target} events across ${PERIODS.length} periods (ceiling, not a quota to fill)`);
  const ceilings: number[] = [];
  const themeCeilings: Record<Theme, number>[] = [];
  for (let i = 0; i < PERIODS.length; i++) {
    const c = await fetchCeiling(PERIODS[i]!, i);
    ceilings.push(c);
    console.log(`  ceiling ${PERIODS[i]!.label}: ${c} stage-1 candidates (date, coords waived — see coordinate-fallback stage)`);
    const perTheme = {} as Record<Theme, number>;
    for (const theme of THEMES) {
      perTheme[theme] = await fetchThemeCeiling(theme, PERIODS[i]!, i);
    }
    themeCeilings.push(perTheme);
    console.log(`    by theme: ${THEMES.map((t) => `${t}=${perTheme[t]}`).join(", ")}`);
  }

  const quotas = resolveQuotas(target, PERIODS, ceilings);
  let shortfall = 0;
  for (let i = 0; i < PERIODS.length; i++) {
    const desired = Math.round(target * PERIODS[i]!.weight);
    console.log(`  quota   ${PERIODS[i]!.label}: ${quotas[i]} (of ${desired} desired)`);
    // Follow-up (item 5): a theme can bind inside a period even when the
    // period's own overall quota is well under its overall ceiling — check
    // per-theme feasibility, not just the period total, so a skewed-but-full
    // 40k doesn't get reported as "reachable" when a balanced split of the
    // same target actually falls short.
    const themeQuotas = resolveThemeQuotas(quotas[i]!, themeCeilings[i]!);
    const themeTotal = THEMES.reduce((s, t) => s + themeQuotas[t]!, 0);
    if (themeTotal < quotas[i]!) {
      const short = quotas[i]! - themeTotal;
      shortfall += short;
      const binding = THEMES.filter((t) => themeQuotas[t]! < Math.round(quotas[i]! * THEME_SHARES[t]));
      console.log(
        `    per-theme split falls ${short} short of the period quota once balanced by THEME_SHARES (binding: ${binding.join(", ") || "none"})`
      );
    }
  }
  if (shortfall > 0) {
    console.log(
      `NOTE: a balanced (THEME_SHARES) split of target=${target} is ${shortfall} short of ${target} once every theme is capped at its own per-period ceiling — the honest achievable balanced total is ~${target - shortfall}, not ${target}.`
    );
  } else {
    console.log(`target=${target} is fully reachable with a THEME_SHARES-balanced split — no theme binds inside any period.`);
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

  console.log("coordinate-fallback rung mix:");
  for (const [rung, count] of Object.entries(RUNG_STATS)) {
    console.log(`  ${rung}: ${count}`);
  }

  const themeCounts = Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
  for (const r of all) {
    let top: Theme = "politics";
    let best = -1;
    for (const t of THEMES) {
      if (r.th[t] > best) {
        best = r.th[t];
        top = t;
      }
    }
    themeCounts[top]++;
  }
  console.log("theme balance (by top scoring theme):");
  for (const t of THEMES) {
    const pct = all.length ? ((themeCounts[t] / all.length) * 100).toFixed(1) : "0.0";
    console.log(`  ${t}: ${themeCounts[t]} (${pct}%)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
