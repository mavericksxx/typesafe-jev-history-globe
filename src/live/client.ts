// The "Try it live" client: calls the Cloudflare Worker (worker/src/index.ts)
// that proxies to Jev, and turns its response into UI state. No mock here —
// see git history (commit dcd5452) for the deleted keyword-regex stand-in
// this replaces for real.
import { IMPACT_LABELS, THEMES } from "../data/types";
import type { Theme } from "../data/types";
import { parseYear } from "./parseYear";

/** Mirrors worker/src/index.ts's `Location`. "none" means Jev couldn't
 * place the event confidently — the UI must say so, never invent a pin
 * (see worker/src/index.ts's UNKNOWN_COUNTRY_THRESHOLD comment). */
export type LiveLocation = { kind: "country"; country: string; lat: number; lon: number } | { kind: "none" };

/** Build-time config (Vite `import.meta.env`), not a secret — just where
 * the Worker lives. Falls back to `undefined`, in which case the panel
 * degrades to its "error" state without ever attempting a request; the app
 * must work with the Worker unreachable or not yet deployed. Set via a
 * `VITE_JEV_WORKER_URL` env var at build time, e.g. in `.env`:
 *   VITE_JEV_WORKER_URL=https://epochs-jev-proxy.<your-subdomain>.workers.dev
 */
const WORKER_URL = import.meta.env.VITE_JEV_WORKER_URL as string | undefined;

export type LiveState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "scored"; themes: Record<Theme, number>; impact: number; confidence: number; location: LiveLocation; year?: number; yearIsApproximate?: boolean }
  | { kind: "not_historical" }
  | { kind: "not_accurate" }
  | { kind: "rate_limited" }
  | { kind: "resting" }
  | { kind: "error" };

/** Thrown/rethrown AbortErrors are the caller's problem (a superseded
 * request) — this only ever resolves to a LiveState, it doesn't return one
 * for an abort. */
export async function scoreLive(text: string, signal: AbortSignal): Promise<LiveState> {
  if (!WORKER_URL) return { kind: "error" };

  // Parse a year out of the text ourselves first — free, and more reliable
  // than asking the model for the common "1969: ..." case. Only when this
  // fails does the Worker ask the model instead (see worker/src/index.ts's
  // YEAR_QUESTION).
  const year = parseYear(text);

  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, year }),
    signal,
  });

  if (res.status === 429) return { kind: "rate_limited" };
  if (res.status === 503) return { kind: "resting" };
  if (!res.ok) return { kind: "error" };

  const data = (await res.json()) as {
    status: string;
    themes?: Record<Theme, number>;
    impact?: number;
    confidence?: number;
    location?: LiveLocation;
    year?: number;
    yearIsApproximate?: boolean;
  };

  if (data.status === "not_historical") return { kind: "not_historical" };
  if (data.status === "not_accurate") return { kind: "not_accurate" };
  if (data.status === "ok" && data.themes && data.impact != null && data.confidence != null) {
    return {
      kind: "scored",
      themes: data.themes,
      impact: data.impact,
      confidence: data.confidence,
      location: data.location ?? { kind: "none" },
      year: data.year,
      yearIsApproximate: data.yearIsApproximate,
    };
  }
  return { kind: "error" };
}

/** Pure mapping from a LiveState to the small status line under the bars —
 * kept separate from scoreLive so it's testable without mocking fetch. */
export function liveStatusText(state: LiveState, latencyMs?: number): string {
  switch (state.kind) {
    case "idle":
      return "Type an event above.";
    case "loading":
      return "Judging…";
    case "scored": {
      const label = IMPACT_LABELS[Math.min(IMPACT_LABELS.length - 1, Math.max(0, Math.round(state.impact)))];
      const latency = latencyMs != null ? ` · ${latencyMs} ms` : "";
      const loc = state.location.kind === "country" ? ` · associated with ${state.location.country}` : " · location unknown, not pinned";
      return `impact ${state.impact.toFixed(2)} / 3 · ${label}${loc}${latency}`;
    }
    case "not_historical":
      return "That doesn't look like a historical event.";
    case "not_accurate":
      return "That doesn't match the historical record.";
    case "rate_limited":
      return "Slow down a little — try again in a moment.";
    case "resting":
      return "Jev is resting for today — check back tomorrow.";
    case "error":
      return "Couldn't reach Jev right now.";
  }
}

/** Zeroed bar values for states with no themes to show yet. */
export function zeroThemes(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
}
