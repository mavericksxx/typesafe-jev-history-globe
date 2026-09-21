import { describe, expect, it } from "vitest";
import { easeThemes } from "../src/panel/live";
import { THEMES } from "../src/data/types";
import type { Theme } from "../src/data/types";

function themes(partial: Partial<Record<Theme, number>>): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((k) => [k, partial[k] ?? 0])) as Record<Theme, number>;
}

describe("easeThemes", () => {
  it("moves toward the target without reaching it in one small step", () => {
    const cur = themes({});
    const target = themes({ war: 1 });
    const next = easeThemes(cur, target, 0.05, false);
    expect(next.war).toBeGreaterThan(0);
    expect(next.war).toBeLessThan(1);
  });

  it("settles close to the target after ~380ms (the tuned settle time)", () => {
    let cur = themes({});
    const target = themes({ war: 0.8 });
    for (let i = 0; i < 40; i++) cur = easeThemes(cur, target, 0.38 / 40, false);
    expect(cur.war).toBeGreaterThan(0.75);
  });

  it("continues from the current displayed value when the target changes mid-ease, not from the old target", () => {
    let cur = themes({});
    cur = easeThemes(cur, themes({ war: 1 }), 0.05, false);
    const midFlightValue = cur.war;
    expect(midFlightValue).toBeGreaterThan(0);
    expect(midFlightValue).toBeLessThan(1);

    // Retarget before the first ease finished — the next step must start
    // from midFlightValue, not snap back to 0 or keep heading to the old target.
    cur = easeThemes(cur, themes({ war: 0 }), 0.05, false);
    expect(cur.war).toBeLessThan(midFlightValue);
    expect(cur.war).toBeGreaterThan(0);
  });

  it("snaps straight to the target under reduced motion", () => {
    const cur = themes({ war: 0.1 });
    const target = themes({ war: 0.9, politics: 0.4 });
    const next = easeThemes(cur, target, 0.016, true);
    expect(next).toEqual(target);
  });

  it("clamps output to 0..1 even given out-of-range input", () => {
    const cur = themes({ war: 1.5, politics: -0.3 });
    const target = themes({ war: 1.5, politics: -0.3 });
    const next = easeThemes(cur, target, 0, false);
    expect(next.war).toBeLessThanOrEqual(1);
    expect(next.politics).toBeGreaterThanOrEqual(0);
  });

  it("never overshoots past 0..1 while easing toward in-range targets", () => {
    let cur = themes({});
    const target = themes({ war: 1, politics: 0 });
    for (let i = 0; i < 200; i++) {
      cur = easeThemes(cur, target, 0.1, false);
      for (const t of THEMES) {
        expect(cur[t]).toBeGreaterThanOrEqual(0);
        expect(cur[t]).toBeLessThanOrEqual(1);
      }
    }
  });
});
