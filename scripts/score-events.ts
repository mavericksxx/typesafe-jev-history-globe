// Scores a sample of data/raw/events.ndjson with Jev (via the typesafe.ai
// systemone API — see scripts/probe-composite.mjs for the proven
// request/response shape) and writes real theme/impact/confidence/minor
// values back onto the matching records, replacing the placeholder flat
// 1.5 impact and keyword-guessed theme vector fetch-wikidata.ts leaves in
// place. Mirrors fetch-wikidata.ts's conventions: disk-cached + resumable,
// retries 429/502/503/504 and network errors with exponential backoff, and
// is deliberately capped so a run can never spend past a fixed token budget.
//
// Usage:
//   node --env-file=.env --import tsx scripts/score-events.ts --limit=500
//   node --env-file=.env --import tsx scripts/score-events.ts --limit=500 --dry-run
//
// (tsx's own CLI also works: `npx tsx scripts/score-events.ts --limit=500`,
// as long as TYPESAFE_API_KEY is in the environment — .env is not
// auto-loaded by tsx, hence --env-file above.)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/data/types";
import type { RawEventRecord, Theme } from "../src/data/types";
import { PERIODS, resolveQuotas } from "./fetch-wikidata";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const CACHE_DIR = path.join(REPO_ROOT, "data/cache/scores");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** Bump whenever question wording changes below — folded into the cache
 * key so a re-run after a prompt edit re-scores instead of serving stale
 * answers from the old wording.
 *
 * v1 -> v2 (Task 3): the impact question's original wording ("how much did
 * this event change the course of world history?") measurably got answered
 * as "how important is this KIND of thing in general" rather than "did THIS
 * INSTANCE change anything" — institution foundings (a university, a mosque,
 * a hospital, a company) systematically scored 2.0-2.5+ on the pilot sample,
 * forcing MINOR_THRESHOLD up to an arbitrary 2.9 as a workaround (see below).
 * v2's wording explicitly tells the model to ignore how famous/large the
 * resulting institution became and to judge only the founding act itself.
 * Probed live against a 60-event mixed sample (40 institution foundings +
 * 20 marquee world-historical events, scripts/probe-impact-wording.mjs,
 * ~$0.004): average institution score fell from ~0.9 to ~0.03 while marquee
 * events (World War I/II, Black Death, Fall of Constantinople, ...) stayed
 * at 2.3-3.0 — see this file's git history / PLAN.md for the full
 * before/after table. */
const PROMPT_VERSION = "v2";

const THEME_QUESTIONS: Record<Theme, string> = {
  war: "Does this event involve war, battle or armed conflict?",
  politics: "Does this event involve political power, rulers or government?",
  religion: "Does this event involve religion or religious institutions?",
  economy: "Does this event involve trade, money or the economy?",
  science: "Does this event involve science, discovery or technology?",
  culture: "Does this event involve art, culture or ideas?",
};

const QUESTIONS = {
  ...Object.fromEntries(
    Object.entries(THEME_QUESTIONS).map(([k, q]) => [k, { type: "noul", instructions: q }])
  ),
  impact: {
    type: "score",
    instructions:
      "Score how much THIS ONE EVENT, by itself, changed the course of history — not how well-known, large, or prestigious the resulting institution or place is today. The founding of a specific named university, mosque, hospital, company, museum or bank is ALMOST ALWAYS a 0 or 1 on this scale: it is a routine administrative act, even when the institution it created later became famous. Only score 2+ if this specific founding, opening, election, or building event itself directly triggered a war, a revolution, a famine, a mass migration, or comparably wide upheaval at the time.",
    criteria: [
      "Routine and local: a specific institution, building, or settlement being founded/opened, an ordinary election, a routine treaty. True even for a famous, large, or old institution — its current fame does not change how small this one act was at the time.",
      "Notable within one country or region, but did not itself set off events beyond it — e.g. a founding that sparked significant regional change, a contested election, a regional treaty.",
      "This specific event reshaped a whole region for generations — a major war, a revolution, an empire's rise or collapse, a conquest.",
      "This specific event changed the course of world history across many countries and generations — a world war, a global pandemic, the fall of a major ancient empire.",
    ],
  },
} as const;

/** $/input-token, measured (output tokens are free for this model/endpoint). */
const COST_PER_TOKEN = 42 / 1_000_000_000;

/** Generous enough for ~1000 events at the probed ~460 tok/event, with
 * headroom — this run only scores --limit (default 500) of them, so in
 * practice the cap is a backstop against a runaway retry storm or a bad
 * --limit, not something a normal run should approach. */
const DEFAULT_TOKEN_CAP = 500_000;

/** Impact >= this is "notable" (minor: false) — gets its own pulse, card and
 * stroke in the renderer (src/loop.ts, src/globe/dots.ts).
 *
 * Re-derived for PROMPT_VERSION v2's reworded impact question (Task 3): with
 * v1's wording, institutions systematically scored 2.0-2.5+, forcing this
 * threshold up to an arbitrary 2.9 just to keep the notable fraction near
 * budget. v2's probe (scripts/probe-impact-wording.mjs, 60-event mixed
 * sample) instead pushed the entire institution-founding population down to
 * ~0.0-0.6 while leaving genuinely region-or-world-changing events (a major
 * war, a revolution, an empire's rise/fall, a world war) at 1.7-3.0 — a clean
 * gap opens up right around the criteria's own "reshaped a whole region for
 * generations" boundary (level 2 of 0..3). 2.0 is that boundary, taken
 * directly from the criteria text rather than reverse-engineered from a
 * fraction target, and was verified against the probe sample to separate the
 * two populations without an arbitrary cliff. It is re-checked against the
 * actual full-corpus distribution once Task 4 scores everything (see the
 * final report) and nudged only if the resulting notable fraction is wildly
 * off the ~2% budget — moving the threshold alone never requires re-scoring
 * anything, since it's applied to the already-cached impact score. */
const MINOR_THRESHOLD = 2.0;

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const DEFAULT_CONCURRENCY = 4;

// ---- CLI args ---------------------------------------------------------
function argNum(flag: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${flag}=`));
  return a ? Number(a.split("=")[1]) : fallback;
}
const LIMIT = argNum("limit", 500);
const TOKEN_CAP = argNum("cap", DEFAULT_TOKEN_CAP);
const CONCURRENCY = argNum("concurrency", DEFAULT_CONCURRENCY);
const DRY_RUN = process.argv.includes("--dry-run");

// ---- Sampling: spread across periods, themes, and sitelink tiers ------

function periodIndexFor(year: number): number {
  const i = PERIODS.findIndex((p) => year >= p.start && year < p.end);
  return i === -1 ? PERIODS.length - 1 : i;
}

function topTheme(th: Record<Theme, number>): Theme {
  let best: Theme = THEMES[0]!;
  let bestScore = -Infinity;
  for (const t of THEMES) {
    if (th[t] > bestScore) {
      bestScore = th[t];
      best = t;
    }
  }
  return best;
}

/** Picks `limit` records out of `records`, spread proportionally across the
 * 11 historical periods (same weights fetch-wikidata.ts uses for fetching,
 * via resolveQuotas), then within each period spread evenly across the six
 * themes (by each record's top-scoring theme), then within each
 * period/theme bucket interleaved high- and low-sitelink records — so the
 * sample isn't dominated by whichever bucket happens to have the most
 * highly-linked events. Deterministic given the same input file and limit. */
export function sampleRepresentative(records: RawEventRecord[], limit: number): RawEventRecord[] {
  if (records.length <= limit) return records.slice();

  const byPeriod: RawEventRecord[][] = PERIODS.map(() => []);
  for (const r of records) byPeriod[periodIndexFor(r.year)]!.push(r);

  const periodCeilings = byPeriod.map((rs) => rs.length);
  const periodQuotas = resolveQuotas(limit, PERIODS, periodCeilings);

  const picked: RawEventRecord[] = [];
  for (let pi = 0; pi < PERIODS.length; pi++) {
    const quota = periodQuotas[pi]!;
    if (quota <= 0) continue;
    const pool = byPeriod[pi]!;

    const byTheme = new Map<Theme, RawEventRecord[]>(THEMES.map((t) => [t, []]));
    for (const r of pool) byTheme.get(topTheme(r.th))!.push(r);

    const themesPresent = THEMES.filter((t) => byTheme.get(t)!.length > 0);
    const share = Math.max(1, Math.floor(quota / Math.max(1, themesPresent.length)));
    let remaining = quota;

    for (const t of themesPresent) {
      if (remaining <= 0) break;
      const bucket = byTheme.get(t)!;
      const take = Math.min(share, bucket.length, remaining);
      // Interleave high- and low-sitelink records: sort descending, then
      // alternately take from the front (high notability) and back (low /
      // undated-sitelinks) so a bare toponym with sitelinks=0 is as likely
      // to be sampled as a marquee event with thousands.
      const sorted = [...bucket].sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
      let lo = 0;
      let hi = sorted.length - 1;
      for (let k = 0; k < take; k++) {
        if (k % 2 === 0) picked.push(sorted[lo++]!);
        else picked.push(sorted[hi--]!);
      }
      remaining -= take;
    }

    // Leftover quota (uneven division, or some themes ran dry): fill from
    // whatever's left in the period pool, highest-sitelink-first, skipping
    // anything already picked.
    if (remaining > 0) {
      const pickedSet = new Set(picked);
      const leftovers = [...pool]
        .filter((r) => !pickedSet.has(r))
        .sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
      for (const r of leftovers) {
        if (remaining <= 0) break;
        picked.push(r);
        remaining--;
      }
    }
  }
  return picked;
}

// ---- Identity + caching -------------------------------------------------

/** A record has no single stable id field pre-scoring; qid is stable for
 * Wikidata-sourced records (the overwhelming majority), and year+text is a
 * reasonable fallback for anything without one (synthetic/mock records). */
function identityFor(r: RawEventRecord): string {
  return r.qid ?? `${r.year}|${r.text}`;
}

function cacheKeyFor(r: RawEventRecord): string {
  return createHash("sha1").update(`${identityFor(r)}::${r.text}::${PROMPT_VERSION}`).digest("hex");
}

interface JevAnswer {
  answers: Record<Theme, { noul: number }> & {
    impact: { score: number; confidence: number; probabilities: Record<string, number> };
  };
  usage: { input_tokens: number };
}

function readCache(key: string): JevAnswer | null {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as JevAnswer;
}

function writeCache(key: string, data: JevAnswer): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(data));
}

// ---- API call with retry/backoff (mirrors fetch-wikidata.ts's runQuery) --

async function scoreOne(text: string): Promise<JevAnswer> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY not set (run with `node --env-file=.env` or export it)");

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: text, model: MODEL, questions: QUESTIONS }),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const backoffMs = RETRY_BASE_MS * 2 ** attempt;
      console.warn(`  network error (${(err as Error).message}), retrying in ${Math.round(backoffMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    if (res.ok) return (await res.json()) as JevAnswer;

    // Same retryable set fetch-wikidata.ts settled on, including 504 — its
    // history notes that omitting 504 aborted whole runs on a single slow
    // request, a bug worth not repeating here.
    const retryable = [429, 502, 503, 504].includes(res.status);
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`systemone request failed (${res.status} ${res.statusText})`);
    }
    const retryAfterHeader = Number(res.headers.get("Retry-After"));
    const backoffMs =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : RETRY_BASE_MS * 2 ** attempt;
    console.warn(`  ${res.status}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

// ---- Mapping Jev's answer onto the schema -------------------------------

export function applyJevAnswer(r: RawEventRecord, answer: JevAnswer["answers"]): RawEventRecord {
  const th = Object.fromEntries(THEMES.map((t) => [t, answer[t].noul])) as Record<Theme, number>;
  const impact = answer.impact.score;
  return {
    ...r,
    th,
    impact,
    confidence: answer.impact.confidence,
    minor: impact < MINOR_THRESHOLD,
  };
}

// ---- Spend cap + bounded concurrency ------------------------------------

/** Runs `worker` over `items` with at most `concurrency` in flight at once,
 * stopping early (worker is simply never called again) once `shouldStop()`
 * returns true — checked before each new item is dispatched, not just at
 * the end, so the cap can't be blown by a burst of already-queued starts. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (item: T, i: number) => Promise<void>
): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      if (shouldStop()) return;
      const i = next++;
      await worker(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

function readRaw(): RawEventRecord[] {
  const text = readFileSync(RAW_PATH, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEventRecord);
}

async function main(): Promise<void> {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, RAW_PATH)} — run fetch-wikidata.ts first`);
  }
  const all = readRaw();
  const sample = sampleRepresentative(all, LIMIT);
  console.log(
    `score-events: sampled ${sample.length}/${all.length} events (limit=${LIMIT}, cap=${TOKEN_CAP} tok, concurrency=${CONCURRENCY})`
  );

  if (DRY_RUN) {
    console.log("dry run: not calling the API or writing output");
    return;
  }

  let spentTokens = 0;
  let cacheHits = 0;
  let capHit = false;
  const scored = new Map<string, RawEventRecord>(); // identity -> scored record

  await runPool(
    sample,
    CONCURRENCY,
    () => capHit,
    async (r) => {
      const key = cacheKeyFor(r);
      let answer = readCache(key);
      if (answer) {
        cacheHits++;
      } else {
        // Hard cap: never even start a request that would push us over —
        // checked per-item right before spending, using the measured
        // ~460 tok/event as the pre-charge estimate so the cap can't be
        // blown by a burst of concurrent in-flight requests either.
        if (spentTokens + 460 > TOKEN_CAP) {
          capHit = true;
          return;
        }
        answer = await scoreOne(r.text);
        writeCache(key, answer);
        spentTokens += answer.usage.input_tokens;
        const cost = spentTokens * COST_PER_TOKEN;
        console.log(
          `  scored "${r.text.slice(0, 60)}" — ${spentTokens} tok so far ($${cost.toFixed(4)})`
        );
      }
      scored.set(identityFor(r), applyJevAnswer(r, answer.answers));
    }
  );

  if (capHit) {
    console.warn(`token cap (${TOKEN_CAP}) reached — stopped early with ${scored.size}/${sample.length} scored this run`);
  }
  console.log(
    `done: ${scored.size} newly-mapped (${cacheHits} served from cache), ${spentTokens} input tokens spent this run (~$${(spentTokens * COST_PER_TOKEN).toFixed(4)})`
  );

  const merged = all.map((r) => scored.get(identityFor(r)) ?? r);
  const notable = merged.filter((r) => scored.has(identityFor(r)) && !r.minor).length;
  const totalScored = merged.filter((r) => scored.has(identityFor(r))).length;
  if (totalScored > 0) {
    console.log(
      `notable (non-minor) fraction among scored events: ${notable}/${totalScored} (${((notable / totalScored) * 100).toFixed(1)}%)`
    );
  }

  writeFileSync(RAW_PATH, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${path.relative(REPO_ROOT, RAW_PATH)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
