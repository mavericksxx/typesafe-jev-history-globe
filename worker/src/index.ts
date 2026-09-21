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

export type ScoreResult =
  | { status: "ok"; themes: Record<Theme, number>; impact: number; confidence: number }
  | { status: "not_historical" }
  | { status: "not_accurate" };

export function mapJevAnswers(answers: JevAnswers): ScoreResult {
  if (answers.real.noul < REAL_THRESHOLD) return { status: "not_historical" };
  if (answers.accurate.noul < ACCURATE_THRESHOLD) return { status: "not_accurate" };
  const themes = Object.fromEntries(THEMES.map((t) => [t, answers[t].noul])) as Record<Theme, number>;
  return { status: "ok", themes, impact: answers.impact.score, confidence: answers.impact.confidence };
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

/** scripts/score-events.ts's probe measured ~460-680 input tokens/call for
 * its 6 theme questions + impact. This Worker sends the same 7 questions
 * plus two more ("real" and "accurate"), so round the upper end (750,
 * covering 7 questions) up ~15% for the extra "accurate" question — each
 * added noul question costs roughly that much more per call — to 900
 * tok/call as the pre-charge estimate used to decide whether to even start a
 * call. Same "never start a request that could blow the cap" pattern
 * score-events.ts uses for its own token cap.
 *
 * At the two ends of that per-call range, the daily cap corresponds to:
 *   11,904,761 / 900 ≈ 13,227 calls/day (worst case, used for the gate)
 *   11,904,761 / 600 ≈ 19,841 calls/day (typical case)
 * Either way, comfortably above anything the per-visitor limits (300/day)
 * could produce short of tens of thousands of distinct daily visitors. */
export const PRECHARGE_ESTIMATE_TOKENS = 900;

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

    let upstream: Response;
    try {
      upstream = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: validated.text, model: MODEL, questions: QUESTIONS }),
      });
    } catch {
      return json({ status: "error", message: "upstream unreachable" }, 502, cors);
    }
    if (!upstream.ok) return json({ status: "error", message: `upstream ${upstream.status}` }, 502, cors);

    const data = (await upstream.json()) as JevResponse;
    await recordSpend(store, data.usage.input_tokens, now);
    return json(mapJevAnswers(data.answers), 200, cors);
  },
};
