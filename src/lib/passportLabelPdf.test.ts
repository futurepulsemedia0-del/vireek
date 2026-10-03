import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { drawPassportLabels, toPdfPassports } from '@/lib/passportLabelPdf';

describe('toPdfPassports', () => {
  const p = (code: string, make = 'Carrier') => ({ public_code: code, make, model: 'X1', equipment_type: 'Furnace', serial_number: 'SN123' });

  it('maps, normalises and de-duplicates by code', () => {
    const out = toPdfPassports([
      { equipment_id: 'a', passport: p('abcdefghjkmn') },
      { equipment_id: 'b', passport: [p('ABCDEFGHJKMN')] },
      { equipment_id: 'c', passport: p('0123456789AB', 'Trane') },
      { equipment_id: 'd', passport: null },
    ]);
    expect(out.map((o) => o.code)).toEqual(['ABCDEFGHJKMN', '0123456789AB']);
    expect(out[0].title).toBe('Carrier X1');
  });

  it('returns [] for no rows', () => {
    expect(toPdfPassports([])).toEqual([]);
  });
});

function fakeDoc() {
  const calls = { rect: 0, text: 0, addPage: 0 };
  const doc = {
    setFillColor() {}, setDrawColor() {}, setTextColor() {}, setFont() {}, setFontSize() {},
    rect() { calls.rect++; },
    roundedRect() {},
    text() { calls.text++; },
    splitTextToSize: (t: string) => [t],
    addPage() { calls.addPage++; },
  };
  return { doc, calls };
}

describe('drawPassportLabels', () => {
  const layout = { pageHeight: 842, margin: 48, contentWidth: 500 };
  const one = { code: 'ABCDEFGHJKMN', title: 'Carrier X1', equipmentType: 'Furnace', serial: 'SN1' };

  it('draws nothing and keeps y when there are no passports', () => {
    const { doc, calls } = fakeDoc();
    expect(drawPassportLabels(doc, 100, [], layout)).toBe(100);
    expect(calls.rect + calls.text).toBe(0);
  });

  it('draws a vector QR (many module rects) and advances y', () => {
    const { doc, calls } = fakeDoc();
    const y = drawPassportLabels(doc, 100, [one], layout, 'https://vireek.com');
    expect(y).toBeGreaterThan(100);
    expect(calls.rect).toBeGreaterThan(100);
    expect(calls.addPage).toBe(0);
  });

  it('starts a new page when there is no room', () => {
    const { doc, calls } = fakeDoc();
    const y = drawPassportLabels(doc, 800, [one], layout);
    expect(calls.addPage).toBe(1);
    expect(y).toBeLessThan(400);
  });
});
