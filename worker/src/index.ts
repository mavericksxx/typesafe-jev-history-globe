// Cloudflare Worker: proxies event text typed into the "Try it live" panel
// to the Jev "systemone" scoring API, holding the API key as a Worker
// secret (never shipped to the browser) and rate-limiting requests.
//
// Deployed as its own Worker (worker/wrangler.toml), separate from the
// Pages app at the repo root (wrangler.toml / `npm run deploy`) — a Worker
// and a Pages project are different Cloudflare products with different
// deploy commands, and this one owns a secret and a KV binding the static
// site has no business seeing.
//
// Kept framework-free and dependency-free (no @cloudflare/workers-types)
// so it typechecks standalone under the repo's existing `tsc --noEmit` via
// the small ambient KVNamespace shape below — Request/Response/fetch/crypto
// already come from the "DOM" lib the root tsconfig includes.

/** Mirrors src/data/types.ts's THEMES. Duplicated (not imported) so this
 * Worker has zero runtime dependency on the app's source tree — keep the
 * two lists in sync by hand if THEMES ever changes. */
const THEMES = ["war", "politics", "religion", "economy", "science", "culture"] as const;
type Theme = (typeof THEMES)[number];

// Unlike THEMES above, the country centroid table IS imported rather than
// duplicated: it's 176 generated entries (scripts/gen-country-centroids.ts),
// and hand-keeping a copy of that in sync would just reintroduce the mistake
// the generator exists to avoid. wrangler bundles this JSON in at build
// time, same as any other import — it doesn't create a live runtime
// dependency on the app, just a source-tree one at build time.
import { COUNTRY_CENTROIDS } from "../../src/live/countryCentroids";

const COUNTRIES = Object.keys(COUNTRY_CENTROIDS);

// ---- KV shape (ambient, so we don't need @cloudflare/workers-types) -----

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  TYPESAFE_API_KEY: string;
  LIMITS: KVNamespace;
}

// ---- CORS ---------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "https://epochs.parthkohale.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ---- Input validation -----------------------------------------------------

export const MAX_TEXT_LEN = 300;

export type ValidateResult = { ok: true; text: string } | { ok: false; error: string };

export function validateText(input: unknown): ValidateResult {
  if (typeof input !== "string") return { ok: false, error: "text must be a string" };
  const text = input.trim();
  if (!text) return { ok: false, error: "text must not be empty" };
  if (text.length > MAX_TEXT_LEN) return { ok: false, error: `text must be ${MAX_TEXT_LEN} characters or fewer` };
  return { ok: true, text };
}

// ---- The Jev request: SAME v2 wording as scripts/score-events.ts --------
// (PROMPT_VERSION "v2" there). This must stay byte-identical to that file's
// THEME_QUESTIONS/QUESTIONS.impact so the live feature agrees with how the
// corpus itself was scored — see that file's PROMPT_VERSION comment for why
// the wording is what it is. A 7th question ("real") is new here: the
// scored corpus never needed a junk-input filter, but free-text user input
// does.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

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
  real: {
    type: "noul",
    instructions:
      // Wording matters more than the threshold here. An earlier version asked
      // whether the text "really happened", which a personal anecdote passes
      // easily — probed live: "i had toast for breakfast" scored 0.52 and "my
      // grandmother moved house in 1987" 0.62, while a genuine but obscure
      // record ("Debdieba, a temple, founded c. 3001 BC") scored only 0.25. No
      // threshold separates those. Asking instead whether it belongs in the
      // *historical record* splits them cleanly: real 0.74-0.99, junk
      // 0.01-0.04. Re-probe before changing this wording.
      //
      // This question only tests whether the input BELONGS to the domain of
      // history (vs. anecdote/fiction/nonsense) — it does not test whether
      // what it claims is actually true. A counterfactual like "Napoleon
      // wins at Waterloo" belongs to the historical record just as much as
      // the real outcome does, so it passes this question too. See
      // "accurate" below for the second, factual-correctness check.
      "Is this a public historical event, place, or institution — something that belongs in the historical record rather than a personal anecdote, a private everyday occurrence, fiction, or nonsense?",
  },
  accurate: {
    type: "noul",
    instructions:
      // Added to catch counterfactuals ("the Soviet Union lands the first
      // human on the Moon", "Harold defeats William at Hastings") that the
      // "real" question above lets through, because they belong to the
      // historical record in form even though they're false in substance.
      // Probed with scripts/probe-accurate-wording.mjs against the live API:
      //   true-known (Apollo 11, Bastille, Hastings, 1929 crash): 0.83-0.95
      //   true-obscure (Debdieba temple, Credit Suisse, Council of
      //     Cesaracosta, Ragusa-Ottoman treaty): 0.18-0.61 — the regression
      //     risk class; MUST clear the threshold, and does, with room below.
      //   counterfactuals (6 cases: Soviet Moon landing, Harold beats
      //     William, Napoleon wins Waterloo, colonies stay British, Siege of
      //     Vorenhalt, Second Martian War): 0.01-0.04
      //   junk (toast, grandmother, Gandalf, keyboard mash, spam): 0.05-0.49
      //     — irrelevant here since junk is already rejected by "real"
      //     above; both questions must pass.
      //   ambiguous: "1067: Battle of Hastings" (wrong date) 0.60 (passes —
      //     it's substantially the real event); "Romulus founds Rome in 753
      //     BC" (legendary) 0.17 (passes, barely — documented, not designed
      //     for).
      // Gap sits between counterfactuals (max 0.04) and true-obscure records
      // (min 0.18); see ACCURATE_THRESHOLD below.
      "Did this actually happen as described, with the people, places, and outcome given being factually correct according to the historical record?",
  },
} as const;

// ---- Location + year (for pinning the event on the /ask globe) ----------
//
// Wording matters here the same way it did for "real"/"accurate" above.
// Probed with scripts/probe-country-question.mjs, two phrasings:
//   "physical" ("where did this physically take place?") sends
//     "1969: Apollo 11 lands on the Moon" to the USA at only 0.88-0.85
//     confidence (the model hedges between the US and "nowhere"), and a
//     bare "Apollo 11 lands on the Moon" the same.
//   "associated" ("which country is this event most associated with —
//     the state/institution/people responsible") sends BOTH Apollo 11
//     phrasings to the USA at 1.00. That's the wording shipped below.
// This is a deliberate product trade-off, not a side effect: it means a
// live pin means "whose event this was", not "where it physically
// happened", which is NOT how the 15,356 corpus events are pinned (they're
// geocoded to physical location). Dropping the single most iconic event
// anyone will type ("Apollo 11") because the Moon isn't a country would be
// a worse outcome than that one inconsistency, so this is the accepted
// trade. The /ask UI must label the pin as "associated with <country>",
// not imply a precise physical site.
//
// The same probe also showed the model will confidently (0.96-0.99) commit
// a genuinely multi-country event (World War II -> Germany, the Silk Road
// -> China) to a SINGLE country rather than reporting low confidence — so
// UNKNOWN_COUNTRY_THRESHOLD below only catches cases where the model itself
// is unsure, not "this event spans many countries but the model picked
// one anyway". That's a known gap, left as-is: the alternative (asking a
// second question just to detect multi-country spread) doubles the cost
// of every request for a case that's rare among typed-in single events.
const COUNTRY_QUESTION = {
  type: "choice",
  instructions:
    "Which present-day country is this event most associated with — the country of the state, institution, or people responsible for it — even if the event itself took place somewhere with no country (such as in space, at sea, or in Antarctica)?",
  criteria: Object.fromEntries(COUNTRIES.map((c) => [c, null])),
} as const;

/** Probed minimum observed confidence for a country the model DID commit to
 * was 0.69 (an anachronistic ancient site, "Debdieba... c. 3001 BC" ->
 * Egypt); every clearly-resolvable case in the probe cleared 0.8. 0.35 sits
 * well under that whole observed cluster, so in practice this only fires
 * when the model returns something close to a coin flip, not merely
 * "somewhat uncertain" — see the probe's multi-country note above for why a
 * tighter threshold wouldn't catch that failure mode anyway. */
export const UNKNOWN_COUNTRY_THRESHOLD = 0.35;

// A "score" question (like impact above) instead of another wide "choice"
// question — asking the model to place a plain multiple-choice question
// over 176 countries already costs ~1650 input tokens/call (probed); a
// second choice question over year-buckets would roughly double that
// again for comparatively little payoff, since most typed events already
// carry a parseable year and never reach this question at all (see
// src/live/parseYear.ts — the client parses first, and this question is
// only included when that fails). NOT separately live-probed for accuracy
// (unlike everything else in this file) — flagged here rather than
// silently shipped as if it had been.
const YEAR_EDGES = [-3000, -1000, 0, 500, 1000, 1500, 1750, 1900, 2026];
const YEAR_QUESTION = {
  type: "score",
  instructions: "When did this event take place? Pick the era it belongs to.",
  criteria: [
    "Before 1000 BC",
    "1000 BC to 1 BC",
    "1 AD to 500 AD",
    "500 to 1000 AD",
    "1000 to 1500 AD",
    "1500 to 1750 AD",
    "1750 to 1900 AD",
    "1900 to present",
  ],
} as const;

/** Maps a YEAR_QUESTION score (0..criteria.length-1, fractional) to a
 * representative year by linearly interpolating between YEAR_EDGES. */
export function yearFromScore(score: number): number {
  const s = Math.max(0, Math.min(YEAR_EDGES.length - 2, score));
  const i = Math.min(YEAR_EDGES.length - 2, Math.floor(s));
  const frac = s - i;
  return Math.round(YEAR_EDGES[i]! + frac * (YEAR_EDGES[i + 1]! - YEAR_EDGES[i]!));
}

interface JevAnswers {
  war: { noul: number };
  politics: { noul: number };
  religion: { noul: number };
  economy: { noul: number };
  science: { noul: number };
  culture: { noul: number };
  impact: { score: number; confidence: number };
  real: { noul: number };
  accurate: { noul: number };
  /** Present only when the request included COUNTRY_QUESTION. */
  country?: { probabilities: Record<string, number> };
  /** Present only when the request included YEAR_QUESTION (client couldn't
   * parse a year itself). */
  year?: { score: number };
}

interface JevResponse {
  answers: JevAnswers;
  usage: { input_tokens: number };
}

// ---- Response mapping -----------------------------------------------------
// We proxy only what the UI needs, never the raw upstream payload.

/** Below this, the input is treated as not describing a real event and the
 * UI shows "that doesn't look like a historical event" instead of a
 * confidently-scored nonsense answer. */
/** Measured gap with the wording above is real 0.74-0.99 vs junk 0.01-0.04, so
 * 0.3 sits in empty space rather than on top of either cluster. */
export const REAL_THRESHOLD = 0.3;

/** Below this, the input belongs to the historical record in form (it
 * passed REAL_THRESHOLD) but doesn't match it in substance — a
 * counterfactual — and the UI shows "that doesn't match the historical
 * record", distinct from "that doesn't look like a historical event". */
/** Measured with scripts/probe-accurate-wording.mjs: counterfactuals score
 * 0.01-0.04, true-obscure records (the regression risk — corpus entries like
 * "Debdieba, a temple, founded c. 3001 BC") score 0.18-0.61, true well-known
 * events score 0.83-0.95. 0.1 sits in the gap between the counterfactual
 * cluster and the true-obscure cluster, not adjacent to either. Re-probe
 * before changing this wording or threshold. */
export const ACCURATE_THRESHOLD = 0.1;

/** "none" is the honest fallback: the model was unsure of a country (below
 * UNKNOWN_COUNTRY_THRESHOLD), or the request never asked (shouldn't
 * happen in practice — every /ask request includes COUNTRY_QUESTION). The
 * client must not invent a position for "none" — see src/live/client.ts. */
export type Location =
  | { kind: "country"; country: string; lat: number; lon: number }
  | { kind: "none" };

export type ScoreResult =
  | { status: "ok"; themes: Record<Theme, number>; impact: number; confidence: number; location?: Location; year?: number; yearIsApproximate?: boolean }
  | { status: "not_historical" }
  | { status: "not_accurate" };

function resolveLocation(answers: JevAnswers): Location | undefined {
  if (!answers.country) return undefined;
  const entries = Object.entries(answers.country.probabilities);
  if (entries.length === 0) return { kind: "none" };
  const [name, prob] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (prob < UNKNOWN_COUNTRY_THRESHOLD) return { kind: "none" };
  const centroid = COUNTRY_CENTROIDS[name];
  if (!centroid) return { kind: "none" };
  return { kind: "country", country: name, lat: centroid[1], lon: centroid[0] };
}

export function mapJevAnswers(answers: JevAnswers, parsedYear?: number): ScoreResult {
  if (answers.real.noul < REAL_THRESHOLD) return { status: "not_historical" };
  if (answers.accurate.noul < ACCURATE_THRESHOLD) return { status: "not_accurate" };
  const themes = Object.fromEntries(THEMES.map((t) => [t, answers[t].noul])) as Record<Theme, number>;
  const location = resolveLocation(answers);
  // A year the client parsed out of the text ("1969: ...") is exact. A year
  // derived from YEAR_QUESTION is an 8-bucket interpolation and is only ever
  // roughly right — probed live, "1969: Apollo 11..." came back 1900 and
  // "1789: the storming of the Bastille" 1750. That is fine for placing a pin
  // in an era, but presenting it as a precise date would be a lie, so the
  // caller is told which kind it got and hedges the label accordingly.
  const year = parsedYear ?? (answers.year ? yearFromScore(answers.year.score) : undefined);
  const yearIsApproximate = parsedYear === undefined && year !== undefined;
  return {
    status: "ok",
    themes,
    impact: answers.impact.score,
    confidence: answers.impact.confidence,
    location,
    year,
    yearIsApproximate,
  };
}

// ---- Rate limiting --------------------------------------------------------
//
// Storage primitive: KV, not a Durable Object. These are soft caps (a
// couple of counters per visitor plus one global daily spend counter) —
// nothing needs strict per-request consistency or coordination, KV's
// eventual consistency (usually sub-second within a colo, up to ~60s
// globally) just means a burst right at a boundary can slip a request or
// two past a limit, which is fine for "rest the model for the day", not
// fine for billing enforcement. A Durable Object would give atomic
// increments, but at this scale (a few hundred calls/day) that
// correctness buys nothing worth the extra moving part.
//
// Visitors are identified by CF-Connecting-IP. That header is set by
// Cloudflare at the edge and cannot be spoofed by the client — only
// Cloudflare itself controls it — so it's an adequate visitor key here.

export const PER_SECOND_LIMIT = 2;
export const PER_DAY_LIMIT = 300;

/** $/input-token, same figure scripts/score-events.ts measures (output
 * tokens are free for this model/endpoint). */
const COST_PER_TOKEN = 42 / 1_000_000_000;

const GLOBAL_DAILY_SPEND_CAP_USD = 0.5;

/** $0.50 / ($42 per 1e9 input tokens) = 0.50 * 1e9 / 42 ≈ 11,904,761 input
 * tokens/day. */
export const GLOBAL_DAILY_TOKEN_CAP = Math.floor(GLOBAL_DAILY_SPEND_CAP_USD / COST_PER_TOKEN);

/** Was 900 tok/call (6 theme questions + impact + real + accurate). The
 * /ask feature adds COUNTRY_QUESTION, which scripts/probe-country-question.mjs
 * measured at ~1650-1665 input tokens/call ON ITS OWN (a 176-option choice
 * question's criteria list is itself most of the prompt) — plus, when the
 * client couldn't parse a year, YEAR_QUESTION (a small "score" question,
 * a few dozen tokens, same shape as "impact" above). Rounding the base 900
 * up to 1000 for slack and adding the measured country-question cost:
 * 1000 + 1650 = 2650, rounded up to 2800 tok/call as the pre-charge
 * estimate used to decide whether to even start a call.
 *
 * At 2800 tok/call the daily cap corresponds to:
 *   11,904,761 / 2800 ≈ 4,251 calls/day
 * Still comfortably above anything the per-visitor limits (300/day) could
 * produce short of ~14 distinct daily visitors maxing out their quota —
 * an acceptable ceiling for a personal project's live-scoring feature. */
export const PRECHARGE_ESTIMATE_TOKENS = 2800;

export interface RateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

function kvStore(kv: KVNamespace): RateStore {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttlSeconds) => kv.put(key, value, { expirationTtl: ttlSeconds }),
  };
}

function dayKeyPart(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until this UTC day rolls over, plus an hour of slack — used as
 * the TTL for daily counters so a stale key can't linger indefinitely, but
 * also can't expire mid-day. */
const DAY_TTL_SECONDS = 25 * 60 * 60;
/** Cloudflare KV rejects any expirationTtl below 60 ("Expiration TTL must be
 * at least 60"), which an in-memory fake store won't catch — it cost a live
 * 1101 on first deploy. The per-second key already embeds the unix second, so
 * a longer TTL only means the spent key lingers harmlessly after its second
 * has passed; it never widens the 2-calls-per-second window itself. */
const SECOND_TTL_SECONDS = 60;

export type VisitorLimitResult =
  | { allowed: true }
  | { allowed: false; scope: "second" | "day" };

export async function checkVisitorLimit(store: RateStore, ip: string, now: number): Promise<VisitorLimitResult> {
  const secKey = `sec:${ip}:${Math.floor(now / 1000)}`;
  const secCount = Number((await store.get(secKey)) ?? "0");
  if (secCount >= PER_SECOND_LIMIT) return { allowed: false, scope: "second" };

  const dayKey = `day:${ip}:${dayKeyPart(now)}`;
  const dayCount = Number((await store.get(dayKey)) ?? "0");
  if (dayCount >= PER_DAY_LIMIT) return { allowed: false, scope: "day" };

  await store.put(secKey, String(secCount + 1), SECOND_TTL_SECONDS);
  await store.put(dayKey, String(dayCount + 1), DAY_TTL_SECONDS);
  return { allowed: true };
}

/** True if there's still budget for (an estimate of) one more call today. */
export async function hasGlobalBudget(store: RateStore, now: number): Promise<boolean> {
  const spent = Number((await store.get(`spend:${dayKeyPart(now)}`)) ?? "0");
  return spent + PRECHARGE_ESTIMATE_TOKENS <= GLOBAL_DAILY_TOKEN_CAP;
}

export async function recordSpend(store: RateStore, tokens: number, now: number): Promise<void> {
  const key = `spend:${dayKeyPart(now)}`;
  const spent = Number((await store.get(key)) ?? "0");
  await store.put(key, String(spent + tokens), DAY_TTL_SECONDS);
}

// ---- Handler ---------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ status: "error", message: "POST only" }, 405, cors);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ status: "invalid", message: "invalid JSON body" }, 400, cors);
    }
    const validated = validateText((body as { text?: unknown } | null)?.text);
    if (!validated.ok) return json({ status: "invalid", message: validated.error }, 400, cors);

    // The client (src/live/parseYear.ts) parses a year out of the text
    // itself first — free, and more reliable than the model for the
    // common "1969: ..." case — and only omits it when that fails, in
    // which case YEAR_QUESTION below asks the model instead.
    const rawYear = (body as { year?: unknown } | null)?.year;
    const clientYear = typeof rawYear === "number" && Number.isFinite(rawYear) ? rawYear : undefined;

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const store = kvStore(env.LIMITS);
    const now = Date.now();

    const visitorCheck = await checkVisitorLimit(store, ip, now);
    if (!visitorCheck.allowed) return json({ status: "rate_limited", scope: visitorCheck.scope }, 429, cors);

    // Distinct status for "the daily spend cap is hit" — deliberately not a
    // 429 (that's a per-visitor thing the caller could retry shortly) or a
    // generic 5xx (nothing is broken). The UI reads this to show "Jev is
    // resting" rather than a network-error state.
    if (!(await hasGlobalBudget(store, now))) return json({ status: "resting" }, 503, cors);

    const questions: Record<string, unknown> = { ...QUESTIONS, country: COUNTRY_QUESTION };
    if (clientYear === undefined) questions.year = YEAR_QUESTION;

    let upstream: Response;
    try {
      upstream = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: validated.text, model: MODEL, questions }),
      });
    } catch {
      return json({ status: "error", message: "upstream unreachable" }, 502, cors);
    }
    if (!upstream.ok) return json({ status: "error", message: `upstream ${upstream.status}` }, 502, cors);

    const data = (await upstream.json()) as JevResponse;
    await recordSpend(store, data.usage.input_tokens, now);
    return json(mapJevAnswers(data.answers, clientYear), 200, cors);
  },
};
