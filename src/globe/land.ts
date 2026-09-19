// World land mass, from the canonical `world-atlas` land-110m TopoJSON —
// the same data reel.html had inlined, via topojson-client's `feature`.
import { feature } from "topojson-client";
// world-atlas ships plain .json with no bundled types; the shape is a
// standard TopoJSON Topology with a single "land" GeometryCollection.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import rawLand from "world-atlas/land-110m.json";

interface Topology {
  type: "Topology";
  objects: Record<string, { type: string }>;
  arcs: unknown;
  bbox?: number[];
  transform?: { scale: [number, number]; translate: [number, number] };
}

const topology = rawLand as unknown as Topology;

// topojson-client's types are loose enough that a plain cast through
// `unknown` here keeps this file simple without pulling in
// topojson-specification just for one call site.
export const land = feature(
  topology as never,
  topology.objects.land as never
) as unknown as import("geojson").FeatureCollection;
