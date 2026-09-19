// Manifest + lazy shard loading. Pure data-fetching (uses `fetch`, which
// exists in both the browser and Node/tsx, so build scripts can reuse this
// module too) — no DOM.
import { T } from "./timescale";
import { THEMES, EXT_THEMES, REGIONS } from "./types";
import type { HistoryEvent, LocKind, Theme, ExtTheme } from "./types";

export interface ManifestShard {
  file: string;
  /** Inclusive start index into the columnar dataset. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

export interface Manifest {
  version: number;
  totalEvents: number;
  shardSize: number;
  /** Content-hashed filename (e.g. "index.9f2a1c0e3b.json") — immutable-cacheable. */
  columnarFile: string;
  /** Content-hashed filename. */
  erasFile: string;
  shards: ManifestShard[];
}

/** Structure-of-arrays: one array per field, one entry per event, in index order. */
export interface ColumnarIndex {
  year: number[];
  lat: number[];
  lon: number[];
  /** 0 = point, 1 = country, 2 = none. */
  locKind: number[];
  /** Index into REGIONS. */
  region: number[];
  impact: number[];
  conf: number[];
  real: number[];
  minor: number[];
  th: Record<Theme, number[]>;
  ext: Record<ExtTheme, number[]>;
}

export interface EraCopy {
  year: number;
  title: string;
  body: string;
}

const LOC_KINDS: LocKind[] = ["point", "country", "none"];

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function loadManifest(baseUrl: string): Promise<Manifest> {
  return fetchJson<Manifest>(`${baseUrl}/manifest.json`);
}

export function loadColumnarIndex(baseUrl: string, manifest: Manifest): Promise<ColumnarIndex> {
  return fetchJson<ColumnarIndex>(`${baseUrl}/${manifest.columnarFile}`);
}

export function loadEras(baseUrl: string, manifest: Manifest): Promise<EraCopy[]> {
  return fetchJson<EraCopy[]>(`${baseUrl}/${manifest.erasFile}`);
}

/** Build HistoryEvent[] from the columnar index. Text stays "" until a shard loads. */
export function eventsFromColumnar(col: ColumnarIndex): HistoryEvent[] {
  const n = col.year.length;
  const events: HistoryEvent[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const th = Object.fromEntries(THEMES.map((t) => [t, col.th[t]![i]!])) as Record<Theme, number>;
    const ext = Object.fromEntries(EXT_THEMES.map((t) => [t, col.ext[t]![i]!])) as Record<ExtTheme, number>;
    const top = THEMES.reduce((a, b) => (th[a] >= th[b] ? a : b));
    const year = col.year[i]!;
    events[i] = {
      idx: i,
      year,
      t: T(year),
      text: "",
      lat: col.lat[i]!,
      lon: col.lon[i]!,
      locKind: LOC_KINDS[col.locKind[i]!] ?? "none",
      th,
      ext,
      top,
      impact: col.impact[i]!,
      conf: col.conf[i]!,
      region: REGIONS[col.region[i]!] ?? "europe",
      real: col.real[i] === 1,
      minor: col.minor[i] === 1,
    };
  }
  return events;
}

// ---- lazy text shards, cached by shard start index ----
const shardCache = new Map<number, Promise<Record<number, string>>>();

function shardFor(manifest: Manifest, idx: number): ManifestShard | undefined {
  // manifest.shards has ~25 entries for a 50k dataset at shardSize 2000; a
  // linear find here is not the per-frame, per-event scan the "never scan
  // all events" rule is about.
  return manifest.shards.find((s) => idx >= s.start && idx < s.end);
}

export async function loadTextFor(
  baseUrl: string,
  manifest: Manifest,
  idx: number
): Promise<string | undefined> {
  const shard = shardFor(manifest, idx);
  if (!shard) return undefined;
  let pending = shardCache.get(shard.start);
  if (!pending) {
    pending = fetchJson<Record<number, string>>(`${baseUrl}/${shard.file}`);
    // Evict on failure so a transient network blip doesn't permanently
    // poison every future request for this shard.
    pending.catch(() => shardCache.delete(shard.start));
    shardCache.set(shard.start, pending);
  }
  const texts = await pending;
  return texts[idx];
}

export function resetShardCache(): void {
  shardCache.clear();
}

/** Binds a manifest + base URL into a `(event) => Promise<text>` resolver
 * that fills in and caches `event.text` in place on first use. */
export function createTextResolver(
  baseUrl: string,
  manifest: Manifest
): (e: HistoryEvent) => Promise<string> {
  return async (e: HistoryEvent) => {
    if (e.text) return e.text;
    const text = await loadTextFor(baseUrl, manifest, e.idx);
    if (text !== undefined) e.text = text;
    return e.text;
  };
}
