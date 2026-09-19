// Scroll narrative: renders the era sections from eras.json and wires an
// IntersectionObserver that eases the timeline toward whichever era is in
// view. Ported from reel.html's static `.era-sec` markup + IntersectionObserver.
import type { EraCopy } from "../data/loader";
import { T } from "../data/timescale";
import { setNarrativeTarget } from "../state";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderNarrative(container: HTMLElement, eras: readonly EraCopy[]): void {
  container.innerHTML = eras
    .map(
      (e) =>
        `<article class="era-sec" data-year="${e.year}"><div class="era-plate">` +
        `<h2>${escapeHtml(e.title)}</h2><p>${escapeHtml(e.body)}</p>` +
        `</div></article>`
    )
    .join("");
}

export function observeNarrative(root: HTMLElement): void {
  if (!("IntersectionObserver" in window)) return;
  const sections = root.querySelectorAll<HTMLElement>(".era-sec");
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const year = Number(entry.target.getAttribute("data-year"));
        if (!Number.isNaN(year)) setNarrativeTarget(T(year));
      }
    },
    { rootMargin: "-50% 0px -50% 0px", threshold: 0 }
  );
  sections.forEach((s) => io.observe(s));
}
