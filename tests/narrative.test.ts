import { describe, expect, it } from "vitest";
import { bucketLandmarks } from "../src/narrative";
import type { EraCopy } from "../src/data/loader";
import type { LandmarkEvent } from "../src/data/types";

function era(year: number, title = `era-${year}`): EraCopy {
  return { year, title, body: "" };
}
function landmark(year: number, text = `event-${year}`): LandmarkEvent {
  return { year, lat: 0, lon: 0, text, top: "politics" };
}

describe("bucketLandmarks", () => {
  const eras = [era(-3000, "a"), era(0, "b"), era(1500, "c")];

  it("puts a landmark right at an era's start year into that era, not the previous one", () => {
    const buckets = bucketLandmarks(eras, [landmark(0)]);
    expect(buckets[0]).toHaveLength(0);
    expect(buckets[1]).toHaveLength(1);
    expect(buckets[2]).toHaveLength(0);
  });

  it("puts a landmark between two era starts into the earlier era", () => {
    const buckets = bucketLandmarks(eras, [landmark(750)]);
    expect(buckets[1]).toHaveLength(1);
    expect(buckets[1]![0]!.year).toBe(750);
  });

  it("puts a landmark before the first era's start into the first era anyway", () => {
    const buckets = bucketLandmarks(eras, [landmark(-3500)]);
    expect(buckets[0]).toHaveLength(1);
  });

  it("puts a landmark after the last era's start into the last era", () => {
    const buckets = bucketLandmarks(eras, [landmark(2020)]);
    expect(buckets[2]).toHaveLength(1);
  });

  it("sorts each bucket's landmarks by year", () => {
    const buckets = bucketLandmarks(eras, [landmark(900, "later"), landmark(100, "earlier")]);
    expect(buckets[1]!.map((l) => l.text)).toEqual(["earlier", "later"]);
  });

  it("returns one bucket per era, all empty, when there are no landmarks", () => {
    const buckets = bucketLandmarks(eras, []);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((b) => b.length === 0)).toBe(true);
  });
});
