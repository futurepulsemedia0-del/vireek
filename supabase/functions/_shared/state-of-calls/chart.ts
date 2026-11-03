// supabase/functions/_shared/state-of-calls/chart.ts
// Server-side SVG for embeddable charts and social cards. Pure string building; every dynamic string is XML-escaped
// and every number is formatted here, so no data value can inject markup. Attribution is part of the image.

import { metricByKey, type PublishedCell } from "./schema.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmt = (v: number, unit: string) => (unit === "percent" ? `${v}%` : unit === "usd" ? `$${v}` : `${v} min`);
const label = (c: PublishedCell) => c.dim_value.replace(/[-_]/g, " ");

export interface ChartInput {
  title: string;
  edition: string;       // e.g. "State of Home Service Calls 2026"
  url: string;           // attribution link text
  cells: PublishedCell[];// published cells only (suppressed cells are shown as "withheld")
  synthetic: boolean;
}

/** Horizontal bar chart of one metric across one dimension. Suppressed cells are listed as "withheld". */
export function renderBarChartSvg(input: ChartInput): string {
  const rows = input.cells.slice(0, 20);
  const unit = rows[0]?.unit ?? "percent";
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  const W = 720, rowH = 34, top = 70, left = 170, right = 90;
  const H = top + rows.length * rowH + 56;
  const bars = rows.map((r, i) => {
    const y = top + i * rowH;
    if (r.suppressed || r.value === null) {
      return `<text x="${left - 10}" y="${y + 20}" text-anchor="end" font-size="14" fill="#1f2937">${esc(label(r))}</text><text x="${left}" y="${y + 20}" font-size="13" fill="#4b5563">withheld (too few businesses)</text>`;
    }
    const w = Math.max(2, Math.round(((W - left - right) * r.value) / max));
    return `<text x="${left - 10}" y="${y + 20}" text-anchor="end" font-size="14" fill="#1f2937">${esc(label(r))}</text>` +
      `<rect x="${left}" y="${y + 6}" width="${w}" height="20" rx="3" fill="#1d4ed8"/>` +
      `<text x="${left + w + 8}" y="${y + 21}" font-size="14" font-weight="600" fill="#111827">${esc(fmt(r.value, unit))}</text>`;
  }).join("");
  const mark = input.synthetic
    ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="64" font-weight="700" fill="#dc2626" opacity="0.18" transform="rotate(-12 ${W / 2} ${H / 2})">SYNTHETIC SAMPLE</text>` : "";
  const alt = `${input.title}: ${rows.map((r) => (r.suppressed ? `${label(r)} withheld` : `${label(r)} ${fmt(r.value ?? 0, unit)}`)).join(", ")}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family="system-ui,Segoe UI,Arial,sans-serif">` +
    `<title id="t">${esc(input.title)}</title><desc id="d">${esc(alt)}</desc>` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    `<text x="16" y="34" font-size="20" font-weight="700" fill="#111827">${esc(input.title)}</text>` +
    `<text x="16" y="56" font-size="13" fill="#4b5563">${esc(input.edition)}</text>${bars}${mark}` +
    `<text x="16" y="${H - 16}" font-size="12" fill="#374151">Source: Vireek, ${esc(input.edition)} · ${esc(input.url)}</text></svg>`;
}

export interface CardInput { headline: string; value: string; caption: string; edition: string; url: string; synthetic: boolean }

/** 1200x630 social card (also usable as an Open Graph source image once exported to PNG). */
export function renderSocialCardSvg(c: CardInput): string {
  const mark = c.synthetic ? `<text x="600" y="330" text-anchor="middle" font-size="110" font-weight="800" fill="#dc2626" opacity="0.15" transform="rotate(-10 600 330)">SYNTHETIC SAMPLE</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(`${c.headline} ${c.value} ${c.caption}`)}" font-family="system-ui,Segoe UI,Arial,sans-serif">` +
    `<rect width="1200" height="630" fill="#0f172a"/><text x="64" y="96" font-size="30" font-weight="700" fill="#93c5fd">${esc(c.edition)}</text>` +
    `<text x="64" y="220" font-size="44" font-weight="600" fill="#e2e8f0">${esc(c.headline)}</text>` +
    `<text x="64" y="400" font-size="170" font-weight="800" fill="#ffffff">${esc(c.value)}</text>` +
    `<text x="64" y="470" font-size="34" fill="#cbd5e1">${esc(c.caption)}</text>${mark}` +
    `<text x="64" y="580" font-size="26" fill="#94a3b8">Source: Vireek · ${esc(c.url)}</text></svg>`;
}

/** Cells for one metric across one dimension in a period, in stable order. */
export function chartCells(cells: readonly PublishedCell[], metric: string, dim: string, period: string): PublishedCell[] {
  if (!metricByKey(metric)) return [];
  return cells.filter((c) => c.metric_key === metric && c.dim === dim && c.period_key === period)
    .sort((a, b) => a.dim_value.localeCompare(b.dim_value));
}
