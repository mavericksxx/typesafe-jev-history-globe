// Moving-bar DOM widgets shared by the era panel and event cards. Ported
// from reel.html's makeBars/setBars.

export interface BarRow<K extends string> {
  key: K;
  row: HTMLElement;
  fill: HTMLElement;
  num: HTMLElement;
}

export function makeBars<K extends string>(
  el: HTMLElement,
  keys: readonly K[],
  colors?: Partial<Record<K, string>>
): BarRow<K>[] {
  el.innerHTML = keys
    .map((k) => {
      const c = colors?.[k] ?? "var(--ink)";
      return `<div class="bar" data-t="${k}"><span>${k}</span><div class="track"><div class="fill" style="--c:${c}"></div></div><span class="num">0.00</span></div>`;
    })
    .join("");
  return keys.map((k) => {
    const row = el.querySelector<HTMLElement>(`[data-t="${k}"]`);
    if (!row) throw new Error(`makeBars: row for "${k}" did not render`);
    const fill = row.querySelector<HTMLElement>(".fill");
    const num = row.querySelector<HTMLElement>(".num");
    if (!fill || !num) throw new Error(`makeBars: malformed row for "${k}"`);
    return { key: k, row, fill, num };
  });
}

export function setBars<K extends string>(rows: readonly BarRow<K>[], vals: Record<K, number>): K {
  let top = rows[0]!.key;
  for (const r of rows) if (vals[r.key] >= vals[top]) top = r.key;
  for (const r of rows) {
    const v = vals[r.key];
    r.fill.style.width = `${(v * 100).toFixed(1)}%`;
    r.num.textContent = v.toFixed(2);
    r.row.classList.toggle("win", r.key === top);
  }
  return top;
}

