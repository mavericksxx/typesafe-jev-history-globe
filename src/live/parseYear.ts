// Parses a year straight out of typed text ("1969: Apollo 11 lands…") so
// the Worker doesn't have to spend a model call asking for one (see
// worker/src/index.ts's YEAR_QUESTION comment). Only falls back to asking
// the model when this returns undefined.
//
// Convention: negative = BC, matching src/data/timescale.ts (T's domain
// starts at -3000 for 3000 BC).

/** Matches "1969", "c. 1200", "circa 1200", with an optional trailing
 * "BC"/"BCE"/"AD"/"CE". Requires a 3-4 digit year (not e.g. "in the 60s"). */
const YEAR_RE = /\bc(?:irca)?\.?\s*(\d{3,4})\s*(bce?|ad|ce)?\b|\b(\d{3,4})\s*(bce?|ad|ce)?\b/i;

export function parseYear(text: string): number | undefined {
  const m = YEAR_RE.exec(text);
  if (!m) return undefined;
  const digits = m[1] ?? m[3];
  const era = (m[2] ?? m[4] ?? "").toLowerCase();
  if (!digits) return undefined;
  const year = Number(digits);
  if (!Number.isFinite(year)) return undefined;
  return era === "bc" || era === "bce" ? -year : year;
}
