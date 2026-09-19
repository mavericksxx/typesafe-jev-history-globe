// The sorted event index. Pure data structure, no DOM. Every per-frame query
// (dot window, stream cards, era aggregate, histogram bucket) goes through the
// bisector here instead of scanning the full event list.
import { bisector } from "d3-array";
import type { HistoryEvent } from "./types";

const byT = bisector((e: HistoryEvent) => e.t);

export class EventIndex {
  private events: HistoryEvent[] = [];

  setEvents(events: readonly HistoryEvent[]): void {
    this.events = [...events].sort((a, b) => a.t - b.t);
  }

  get size(): number {
    return this.events.length;
  }

  all(): readonly HistoryEvent[] {
    return this.events;
  }

  at(i: number): HistoryEvent | undefined {
    return this.events[i];
  }

  /** Index of the first event with t strictly greater than `t`. */
  upperBound(t: number): number {
    return byT.right(this.events, t);
  }

  /** Index of the first event with t greater than or equal to `t`. */
  lowerBound(t: number): number {
    return byT.left(this.events, t);
  }

  /** Count of events with t <= `t` — O(log n), never a full scan. */
  countUpTo(t: number): number {
    return this.upperBound(t);
  }

  /**
   * `[start, end)` indices into `all()` covering events with `lo <= t <= hi`.
   * Returns indices, not a copy — callers iterate `all()` between them
   * directly (`for (let i = start; i < end; i++)`), so a windowed query
   * never allocates a slice of a 50k-event array on every frame.
   */
  range(lo: number, hi: number): [start: number, end: number] {
    if (hi < lo) return [0, 0];
    return [this.lowerBound(lo), this.upperBound(hi)];
  }
}

export const eventIndex = new EventIndex();

/** Clamps a `[start, end)` window to its most recent `max` entries — for any
 * per-frame window (dot draw, era snapshot) whose bisected width can blow up
 * in a dense era regardless of how narrow the underlying T-space window is. */
export function boundToMostRecent(start: number, end: number, max: number): [start: number, end: number] {
  return [Math.max(start, end - max), end];
}
