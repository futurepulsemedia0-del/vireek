// src/lib/readableText.ts
//
// THE one implementation of "which text colour goes on this arbitrary background" (tenant brand colours, landing-page
// accents, widget launchers). Pure: no I/O, no Supabase — safe for any bundle.
//
// Guarantee: for EVERY 6-digit colour the result has a WCAG contrast >= 4.5:1 (worst case 4.58:1). A plain white-or-ink
// choice cannot give that (worst case 4.23:1: mid-tone brand colours land in a dead zone), so pure black is the fallback.
//
// public/chat-widget.js, public/website-widgets.js and supabase/functions/_shared/direct-mail/engine.ts cannot import this
// file; they carry a marked copy of the same algorithm. readableText.parity.test.ts fails if a copy drifts.

export type ReadableText = '#FFFFFF' | '#0F172A' | '#000000';

const WHITE: ReadableText = '#FFFFFF';
const INK: ReadableText = '#0F172A';
const BLACK: ReadableText = '#000000';

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parse(input: string): [number, number, number] | null {
  const raw = input.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(raw) ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const INK_LUMINANCE = luminance(15, 23, 42);

const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Text colour for `background`: white or ink if either reaches `minRatio`, otherwise black. Invalid input → white. */
export function readableTextColor(background: string, minRatio = 4.5): ReadableText {
  const rgb = parse(background);
  if (!rgb) return WHITE;
  const lum = luminance(rgb[0], rgb[1], rgb[2]);
  const onWhite = ratio(lum, 1);
  const onInk = ratio(lum, INK_LUMINANCE);
  const best = onWhite >= onInk ? WHITE : INK;
  return Math.max(onWhite, onInk) >= minRatio ? best : BLACK;
}
