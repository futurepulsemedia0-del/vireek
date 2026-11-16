import type { DeepContentData } from './types';

export function deepText(d: DeepContentData): string {
  const parts: string[] = [d.eyebrow, d.title, d.intro];
  for (const s of d.sections) {
    parts.push(s.title);
    for (const b of s.blocks) {
      if (b.kind === 'p') parts.push(b.text);
      if (b.kind === 'list') parts.push(...b.items);
      if (b.kind === 'steps') b.items.forEach((i) => parts.push(i.title, i.text));
      if (b.kind === 'callout') parts.push(b.title, b.text);
      if (b.kind === 'table') parts.push(b.caption, ...b.headers, ...b.rows.flat());
    }
  }
  (d.faqs ?? []).forEach((f) => parts.push(f.q, f.a));
  return parts.join(' ');
}

/** Claims Vireek must not make without evidence; prices live only in PRICING_PLANS. */
export const BANNED_CLAIMS: RegExp[] = [
  /\bSOC ?2\b/i,
  /\bISO ?27001\b/i,
  /\bHIPAA\b/i,
  /\btrusted by\b/i,
  /\bthousands of (customers|contractors|businesses)\b/i,
  /\b\d[\d,]*\+? (customers|contractors|businesses|companies)\b/i,
  /\bguaranteed?\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\b#1\b/,
  /\$\s?\d/,
];

/** Strings that are expected to repeat across pages are excluded by being trade-specific; this collects the rest. */
export function uniquenessStrings(d: DeepContentData): string[] {
  const out: string[] = [];
  for (const s of d.sections) {
    for (const b of s.blocks) {
      if (b.kind === 'p') out.push(b.text);
      if (b.kind === 'list') out.push(...b.items);
      if (b.kind === 'steps') b.items.forEach((i) => out.push(i.text));
      if (b.kind === 'callout') out.push(b.text);
      if (b.kind === 'table') out.push(...b.rows.flat());
    }
  }
  (d.faqs ?? []).forEach((f) => out.push(f.a));
  return out;
}
