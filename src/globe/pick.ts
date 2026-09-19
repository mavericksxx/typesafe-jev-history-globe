// Hover picking: nearest visible event to a pointer position. Ported from
// reel.html's pointermove handler.
import { geoDistance } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { HistoryEvent } from "../data/types";

const MAX_PICK_DISTANCE_PX = 10;

/** `events` should be the same windowed slice the globe is currently drawing. */
export function pickNearest(
  events: readonly HistoryEvent[],
  projection: GeoProjection,
  mx: number,
  my: number
): HistoryEvent | null {
  const r = projection.rotate();
  const center: [number, number] = [-r[0], -r[1]];
  let best: HistoryEvent | null = null;
  let bestDist = MAX_PICK_DISTANCE_PX;
  for (const e of events) {
    if (e.locKind === "none") continue;
    if (geoDistance([e.lon, e.lat], center) > 1.52) continue;
    const p = projection([e.lon, e.lat]);
    if (!p) continue;
    const d = Math.hypot(p[0] - mx, p[1] - my);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}
