// The mockup's piecewise timescale: dense modern centuries get more screen
// (and slider) space than the sparse ancient ones. Ported verbatim from
// reel.html's `T` / `fmtYear`.
import { scaleLinear } from "d3-scale";

export const T = scaleLinear()
  .domain([-3000, 0, 1000, 1500, 1800, 1900, 2026])
  .range([0, 0.14, 0.3, 0.44, 0.6, 0.76, 1])
  .clamp(true);

export function fmtYear(y: number): string {
  if (y < 0) return `${-y} BC`;
  if (y < 1000) return `AD ${y}`;
  return `${y}`;
}
