// Drives the narrative scroll FROM the reel — the reverse direction of
// narrative/index.ts's scroll-drives-reel sync. Used during playback and
// timeline clicks/drags: instead of the user scrolling to move `pos`, `pos`
// moves and this eases `window.scrollTo` so the narrative item (era or
// landmark) matching the current position sits at the viewport centre.
//
// Only meaningful on the desktop two-column layout (min-width:861px) where
// the narrative sits beside the sticky stage — on the stacked mobile
// layout the narrative and the stage share the same scroll, so hijacking
// it would fight the user's ability to read either one. isDesktopLayout
// lets callers (loop.ts) gate on that without doing their own media query.
import { T } from "../data/timescale";

interface Anchor {
  t: number;
  /** Document-space Y (i.e. relative to the top of the page, not the
   * viewport) of this item's vertical centre. */
  docY: number;
}

const DESKTOP_QUERY = "(min-width: 861px)";

export class ReelScroll {
  private anchors: Anchor[] = [];
  private readonly desktopQuery: MediaQueryList;

  constructor() {
    this.desktopQuery =
      typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : ({ matches: true } as MediaQueryList);
  }

  get isDesktopLayout(): boolean {
    return this.desktopQuery.matches;
  }

  /** Recomputes anchors' document-space centre from the same era-sec +
   * landmark-card elements the comet rail uses. Call after narrative
   * render and on resize (positions/heights can change). */
  measure(items: readonly HTMLElement[]): void {
    const scrollY = window.scrollY;
    const anchors: Anchor[] = [];
    for (const el of items) {
      const year = Number(el.dataset.year);
      if (Number.isNaN(year)) continue;
      const r = el.getBoundingClientRect();
      anchors.push({ t: T(year), docY: (r.top + r.bottom) / 2 + scrollY });
    }
    anchors.sort((a, b) => a.t - b.t);
    this.anchors = anchors;
  }

  /** The scrollY that would put the T-interpolated anchor at viewport
   * centre — interpolating continuously between the two bracketing anchors
   * by `pos` rather than snapping item to item, so a full playback run
   * glides smoothly instead of jumping. Null if nothing's measured yet. */
  targetScrollY(pos: number): number | null {
    const a = this.anchors;
    if (!a.length) return null;
    let docY: number;
    const first = a[0]!;
    const last = a[a.length - 1]!;
    if (a.length === 1 || pos <= first.t) {
      docY = first.docY;
    } else if (pos >= last.t) {
      docY = last.docY;
    } else {
      let i = 1;
      while (i < a.length - 1 && a[i]!.t < pos) i++;
      const lo = a[i - 1]!;
      const hi = a[i]!;
      const span = hi.t - lo.t || 1;
      const frac = (pos - lo.t) / span;
      docY = lo.docY + (hi.docY - lo.docY) * frac;
    }
    return Math.max(0, docY - window.innerHeight / 2);
  }

  /** Eases window scroll toward `target` by a fraction `k` (0..1) of the
   * remaining distance, or jumps straight there under reduced motion. A
   * plain window.scrollTo per frame, not scrollIntoView — this needs
   * fractional, continuously-interpolated targets scrollIntoView can't
   * express. */
  step(target: number, k: number, reducedMotion: boolean): void {
    const current = window.scrollY;
    const next = reducedMotion ? target : current + (target - current) * k;
    window.scrollTo(0, next);
  }
}
