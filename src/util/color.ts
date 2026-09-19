export function hexToRgba(hex: string, a: number): string {
  return `${hexToRgbaPrefix(hex)}${a})`;
}

/** `"rgba(r,g,b,"` — for callers computing a per-frame alpha where
 * concatenating the number themselves avoids allocating a template string
 * (and a temporary rgba(...) call) per draw. */
export function hexToRgbaPrefix(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},`;
}
