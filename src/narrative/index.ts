// Scroll narrative: renders the era sections from eras.json, interleaved
// with landmark cards from landmarks.json bucketed into whichever era's
// year range they fall in, and wires an IntersectionObserver that eases the
// timeline (and, for a landmark, the globe's camera) toward whichever item
// is in view. Ported from reel.html's static `.era-sec` markup +
// IntersectionObserver, extended for landmarks.
import type { EraCopy } from "../data/loader";
import type { LandmarkEvent, Theme } from "../data/types";
import { T, fmtYear } from "../data/timescale";
import { setNarrativeTarget, setNarrativeLandmark } from "../state";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function eraSectionHtml(era: EraCopy): string {
  return (
    `<article class="era-sec" data-kind="era" data-year="${era.year}"><div class="era-plate">` +
    `<h2>${escapeHtml(era.title)}</h2><p>${escapeHtml(era.body)}</p>` +
    `</div></article>`
  );
}

function landmarkCardHtml(lm: LandmarkEvent): string {
  return (
    `<p class="landmark-card" data-kind="landmark" data-year="${lm.year}" data-lat="${lm.lat}" data-lon="${lm.lon}" data-top="${lm.top}">` +
    `<span class="landmark-year">${fmtYear(lm.year)}</span> · <span class="landmark-title">${escapeHtml(lm.text)}</span>` +
    `</p>`
  );
}

/**
 * Buckets each landmark under the last era whose year is <= its own — i.e.
 * chronologically, between that era's start and the next one's. `eras` must
 * already be sorted by year. Exported for testing; also used by
 * renderNarrative.
 */
export function bucketLandmarks(eras: readonly EraCopy[], landmarks: readonly LandmarkEvent[]): LandmarkEvent[][] {
  const buckets: LandmarkEvent[][] = eras.map(() => []);
  for (const lm of landmarks) {
    let bucket = 0;
    for (let i = 0; i < eras.length; i++) {
      if (eras[i]!.year <= lm.year) bucket = i;
      else break;
    }
    buckets[bucket]!.push(lm);
  }
  for (const b of buckets) b.sort((a, b2) => a.year - b2.year);
  return buckets;
}

export function renderNarrative(
  container: HTMLElement,
  eras: readonly EraCopy[],
  landmarks: readonly LandmarkEvent[]
): void {
  const sortedEras = [...eras].sort((a, b) => a.year - b.year);
  const buckets = bucketLandmarks(sortedEras, landmarks);
  let html = "";
  sortedEras.forEach((era, i) => {
    html += eraSectionHtml(era);
    for (const lm of buckets[i]!) html += landmarkCardHtml(lm);
  });
  container.innerHTML = html;
}

export function observeNarrative(root: HTMLElement): void {
  if (!("IntersectionObserver" in window)) return;
  const items = root.querySelectorAll<HTMLElement>(".era-sec, .landmark-card");
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const year = Number(el.dataset.year);
        if (Number.isNaN(year)) continue;
        setNarrativeTarget(T(year));
        if (el.dataset.kind === "landmark") {
          const lat = Number(el.dataset.lat);
          const lon = Number(el.dataset.lon);
          const top = el.dataset.top as Theme | undefined;
          if (!Number.isNaN(lat) && !Number.isNaN(lon) && top) {
            setNarrativeLandmark({ year, lat, lon, top, text: "" });
            continue;
          }
        }
        setNarrativeLandmark(null);
      }
    },
    { rootMargin: "-50% 0px -50% 0px", threshold: 0 }
  );
  items.forEach((el) => io.observe(el));
}
