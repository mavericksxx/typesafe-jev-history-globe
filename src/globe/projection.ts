// The d3-geo orthographic projection + path generator, ported from
// reel.html. Pure setup; no drawing here.
import { geoOrthographic, geoPath, geoGraticule10 } from "d3-geo";
import type { GeoPath, GeoProjection } from "d3-geo";

export function createProjection(context: CanvasRenderingContext2D): {
  projection: GeoProjection;
  path: GeoPath;
} {
  const projection = geoOrthographic().clipAngle(90).precision(0.4);
  const path = geoPath(projection, context);
  return { projection, path };
}

/** Sizes the projection to a `size` x `size` canvas (in CSS pixels, pre-DPR). */
export function fitProjection(projection: GeoProjection, size: number): void {
  projection.translate([size / 2, size / 2]).scale(size * 0.34);
}

export const graticule = geoGraticule10();
