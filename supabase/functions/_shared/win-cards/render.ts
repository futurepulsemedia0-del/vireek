// supabase/functions/_shared/win-cards/render.ts
//
// Server-side card renderer → SVG string. Pure, dependency-free, deterministic (so snapshot-testable).
// Input is PublicFields ONLY — the renderer cannot see private facts, so it cannot leak them.
// PNG (needed by Facebook/LinkedIn/X OG crawlers) is produced by rasterising this SVG in the edge function.

import { seededRandom } from "./token.ts";
import type { CardFormat, PublicFields, Theme, TriggerType } from "./types.ts";

export const FORMATS: Record<CardFormat, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  og: { w: 1200, h: 630 },
  story: { w: 1080, h: 1920 },
};

const PALETTE: Record<Theme, { bg: string; bg2: string; text: string; muted: string; chip: string; chipText: string; line: string }> = {
  light: { bg: "#F7F8FB", bg2: "#FFFFFF", text: "#0B1220", muted: "#4A5568", chip: "#E8EDF7", chipText: "#1B2A4A", line: "#D5DBE8" },
  dark: { bg: "#0B1220", bg2: "#121A2C", text: "#F4F6FB", muted: "#A9B4CC", chip: "#1C2740", chipText: "#DCE4F5", line: "#26324F" },
};

const EYEBROW: Record<TriggerType, string> = {
  after_hours_booking: "After-hours booking",
  emergency_handled: "Emergency handled",
  recovered_large_job: "Missed call recovered",
  milestone_calls: "Milestone",
  speed_to_lead_record: "Response-time record",
  five_star_ai_job: "5-star review",
};

export interface RenderOptions {
  format: CardFormat;
  theme: Theme;
  /** White-label: replaces the Vireek wordmark with `brandName`; no "powered by" mark. */
  whiteLabel?: boolean;
  brandName?: string | null;
  accent?: string | null; // #RRGGBB
  animated?: boolean;
  /** Seed for the decorative waveform (use the public attribution ref, never the token). */
  seed: string;
}

export const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Greedy word-wrap by approximate glyph width (no font metrics available server-side). */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";

export function altText(p: PublicFields): string {
  return [p.headline, p.detail, p.valueText, p.timeBucketText, p.serviceText].filter(Boolean).join(" ");
}

export function renderCardSvg(p: PublicFields, o: RenderOptions): string {
  const { w, h } = FORMATS[o.format];
  const c = PALETTE[o.theme];
  const accent = o.accent && HEX.test(o.accent) ? o.accent : o.theme === "dark" ? "#6FA2FF" : "#2457E6";
  const story = o.format === "story";
  const og = o.format === "og";
  const pad = og ? 64 : 80;
  const hSize = og ? 48 : story ? 84 : 76;
  const dSize = og ? 24 : 34;
  const cw = hSize * 0.6; // ExtraBold average glyph width, conservative
  const headLines = wrap(p.headline, Math.floor((w - pad * 2) / cw), 4);
  const detailLines = p.detail ? wrap(p.detail, Math.floor((w - pad * 2) / (dSize * 0.58)), 3) : [];

  let y = story ? 380 : og ? 120 : 240;
  const out: string[] = [];

  out.push(`<text x="${pad}" y="${y}" font-size="${og ? 22 : 28}" font-weight="700" letter-spacing="2" fill="${accent}">${xmlEscape(EYEBROW[p.trigger].toUpperCase())}</text>`);
  y += og ? 48 : 84;
  headLines.forEach((l, i) => out.push(`<text x="${pad}" y="${y + i * hSize * 1.12}" font-size="${hSize}" font-weight="800" fill="${c.text}">${xmlEscape(l)}</text>`));
  y += headLines.length * hSize * 1.12 + (og ? 6 : 14);
  detailLines.forEach((l, i) => out.push(`<text x="${pad}" y="${y + i * dSize * 1.4}" font-size="${dSize}" fill="${c.muted}">${xmlEscape(l)}</text>`));
  y += detailLines.length * dSize * 1.4 + (og ? 18 : 40);

  if (p.valueText) {
    const fs = og ? 36 : 56;
    const bw = Math.min(w - pad * 2, p.valueText.length * fs * 0.6 + 64);
    out.push(`<rect x="${pad}" y="${y - fs}" width="${bw}" height="${fs * 1.6}" rx="${fs * 0.5}" fill="${accent}"/>`);
    out.push(`<text x="${pad + 32}" y="${y + fs * 0.1}" font-size="${fs}" font-weight="800" fill="#FFFFFF">${xmlEscape(p.valueText)}</text>`);
    y += fs * 1.6 + (og ? 6 : 12);
  }

  const chips = [p.timeBucketText, p.serviceText, p.monthText].filter((x): x is string => !!x);
  let cx = pad;
  const cfs = og ? 22 : 28;
  for (const t of chips) {
    const cwid = t.length * cfs * 0.56 + 40;
    if (cx + cwid > w - pad) break;
    out.push(`<rect x="${cx}" y="${y}" width="${cwid}" height="${cfs * 1.9}" rx="${cfs * 0.95}" fill="${c.chip}"/>`);
    out.push(`<text x="${cx + 20}" y="${y + cfs * 1.28}" font-size="${cfs}" font-weight="600" fill="${c.chipText}">${xmlEscape(t)}</text>`);
    cx += cwid + 14;
  }
  const contentBottom = y + (chips.length ? cfs * 1.9 : 0);

  // Decorative waveform. NOT audio, NOT derived from any call.
  const bars = og ? 40 : 52;
  const rnd = seededRandom(o.seed);
  const wvTop = h - (og ? 130 : story ? 330 : 270);
  const wvH = og ? 50 : 90;
  const bw2 = (w - pad * 2) / bars;
  const waveform: string[] = [];
  const showWave = contentBottom + 24 <= wvTop;
  for (let i = 0; showWave && i < bars; i++) {
    const bh = Math.max(6, Math.round(wvH * (0.15 + 0.85 * Math.sin((i / bars) * Math.PI) * (0.4 + 0.6 * rnd()))));
    const x = pad + i * bw2;
    const delay = (i % 12) * 0.08;
    waveform.push(`<rect class="bar" x="${x.toFixed(1)}" y="${wvTop + (wvH - bh) / 2}" width="${(bw2 * 0.6).toFixed(1)}" height="${bh}" rx="3" fill="${accent}" opacity="0.55"${o.animated ? ` style="animation-delay:${delay.toFixed(2)}s"` : ""}/>`);
  }

  const brand = o.whiteLabel ? (o.brandName?.trim() || p.businessName || "") : "Vireek";
  const footerY = h - (og ? 40 : 64);
  const footer: string[] = [];
  if (p.businessName && !o.whiteLabel) footer.push(`<text x="${pad}" y="${footerY - (og ? 30 : 44)}" font-size="${og ? 24 : 32}" font-weight="700" fill="${c.text}">${xmlEscape(p.businessName)}</text>`);
  if (p.disclaimer) footer.push(`<text x="${pad}" y="${footerY - (og ? 0 : 6)}" font-size="${og ? 16 : 20}" fill="${c.muted}">${xmlEscape(wrap(p.disclaimer, og ? 110 : 80, 1)[0])}</text>`);
  if (brand) footer.push(`<text x="${w - pad}" y="${footerY}" text-anchor="end" font-size="${og ? 24 : 30}" font-weight="800" fill="${c.text}">${xmlEscape(brand)}</text>`);

  const anim = o.animated
    ? `@media (prefers-reduced-motion: no-preference){.bar{transform-box:fill-box;transform-origin:center;animation:wc-pulse 1.8s ease-in-out infinite}}@keyframes wc-pulse{0%,100%{transform:scaleY(.55)}50%{transform:scaleY(1)}}`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d" font-family="${FONT}">`,
    `<title id="t">${xmlEscape(altText(p))}</title>`,
    `<desc id="d">Decorative waveform shown for style only. It is not a recording.</desc>`,
    anim ? `<style>${anim}</style>` : "",
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bg2}"/><stop offset="1" stop-color="${c.bg}"/></linearGradient></defs>`,
    `<rect width="${w}" height="${h}" fill="url(#g)"/>`,
    `<rect x="0" y="0" width="${w}" height="10" fill="${accent}"/>`,
    ...out,
    ...waveform,
    ...footer,
    `</svg>`,
  ].filter(Boolean).join("\n");
}
