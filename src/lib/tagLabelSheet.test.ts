import { describe, expect, it, vi } from 'vitest';
import { SHEET_PRESETS, drawTagSheet, labelsPerSheet, paginateTags, slotRect, type TagPdfDoc } from '@/lib/tagLabelSheet';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

function fakeDoc() {
  const calls = { rect: 0, addPage: 0, text: [] as string[] };
  const doc: TagPdfDoc = {
    setFillColor() {}, setDrawColor() {}, setTextColor() {}, setLineWidth() {}, setFont() {}, setFontSize() {},
    rect() { calls.rect += 1; }, roundedRect() {},
    text(t) { calls.text.push(Array.isArray(t) ? t.join(' ') : t); },
    splitTextToSize(t) { return [t]; },
    addPage() { calls.addPage += 1; },
  };
  return { doc, calls };
}

const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ token: `ABCDEFGH2345${String(1000 + i).slice(-4)}`.replace(/[^0-9A-Z]/g, '2') }));

describe('presets', () => {
  it('have the advertised label counts', () => {
    expect(labelsPerSheet(SHEET_PRESETS.a4_24)).toBe(24);
    expect(labelsPerSheet(SHEET_PRESETS.letter_30)).toBe(30);
    expect(labelsPerSheet(SHEET_PRESETS.a4_8)).toBe(8);
  });
  it('keep every label inside the page', () => {
    for (const p of Object.values(SHEET_PRESETS)) {
      for (let s = 0; s < labelsPerSheet(p); s++) {
        const r = slotRect(p, s);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(p.pageW);
        expect(r.y + r.h).toBeLessThanOrEqual(p.pageH);
      }
    }
  });
});

describe('paginateTags', () => {
  it('fills pages and respects the start slot', () => {
    const p = SHEET_PRESETS.a4_8;
    expect(paginateTags([1, 2, 3], p, 0)).toHaveLength(1);
    const pages = paginateTags(Array.from({ length: 10 }, (_, i) => i), p, 6);
    expect(pages).toHaveLength(2);
    expect(pages[0].map((x) => x.slot)).toEqual([6, 7]);
    expect(pages[1][0].slot).toBe(0);
  });
  it('clamps an out-of-range start slot and handles empty input', () => {
    expect(paginateTags([1], SHEET_PRESETS.a4_8, 99)[0][0].slot).toBe(7);
    expect(paginateTags([], SHEET_PRESETS.a4_8)).toEqual([]);
  });
});

describe('drawTagSheet', () => {
  it('adds a page per full sheet and draws QR modules', () => {
    const { doc, calls } = fakeDoc();
    const pages = drawTagSheet(doc, tags(10), { preset: 'a4_8', origin: 'https://vireek.com' });
    expect(pages).toBe(2);
    expect(calls.addPage).toBe(1);
    expect(calls.rect).toBeGreaterThan(100);
    expect(calls.text.some((t) => t.includes('VIREEK TAG'))).toBe(true);
  });
  it('prints the human-readable code', () => {
    const { doc, calls } = fakeDoc();
    drawTagSheet(doc, [{ token: 'ABCDEFGH23456789' }], { preset: 'a4_24' });
    expect(calls.text).toContain('VTG-ABCD-EFGH-2345-6789');
  });
});
