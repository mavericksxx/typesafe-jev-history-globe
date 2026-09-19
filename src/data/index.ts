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

  /** Events with lo <= t <= hi. Cost is O(log n + k) for k matches, not O(n). */
  range(lo: number, hi: number): HistoryEvent[] {
    if (hi < lo) return [];
    const start = this.lowerBound(lo);
    const end = this.upperBound(hi);
    return this.events.slice(start, end);
  }
}

export const eventIndex = new EventIndex();
