// Hover picking: nearest visible event to a pointer position. Ported from
// reel.html's pointermove handler.
import { geoDistance } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { HistoryEvent } from "../data/types";

const MAX_PICK_DISTANCE_PX = 10;

/** `[start, end)` should be the same bounded window `Globe.draw` is
 * currently drawing dots for (see boundDotWindow) — iterated over `all` in
 * place, no slice. */
export function pickNearest(
  all: readonly HistoryEvent[],
  start: number,
  end: number,
  projection: GeoProjection,
  mx: number,
  my: number
): HistoryEvent | null {
  const r = projection.rotate();
  const center: [number, number] = [-r[0], -r[1]];
  let best: HistoryEvent | null = null;
  let bestDist = MAX_PICK_DISTANCE_PX;
  for (let i = start; i < end; i++) {
    const e = all[i]!;
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
