import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FILTERS,
  PRESET_IDS,
  SECTIONS_BY_TYPE,
  applyPreset,
  applyPresetStyle,
  buildSampleData,
  computeTotals,
  contrastWithWhite,
  defaultDesign,
  designsEqual,
  filterTemplates,
  formatDocDate,
  hasUnsupportedPdfChars,
  isNumericLike,
  moveSection,
  normalizeColor,
  normalizeDesign,
  normalizeTemplate,
  normalizeTemplates,
  pdfSafeText,
  setSectionVisible,
  summarizeTemplates,
  tint,
  uniqueCopyName,
  unsupportedFields,
  validateName,
  visibleSections,
  type DocumentTemplate,
} from './documentTemplates';

function tpl(over: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 't1',
    user_id: 'owner',
    name: 'Classic',
    doc_type: 'invoice',
    design: defaultDesign('invoice'),
    is_default: false,
    status: 'active',
    revision: 1,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...over,
  };
}

describe('normalizeColor / tint / contrast', () => {
  it('normalizes short, long and prefixed hex', () => {
    expect(normalizeColor('#abc', '#000000')).toBe('#AABBCC');
    expect(normalizeColor('203ad8', '#000000')).toBe('#203AD8');
    expect(normalizeColor(' #0f172a ', '#000000')).toBe('#0F172A');
  });
  it('falls back for junk', () => {
    expect(normalizeColor('red', '#111111')).toBe('#111111');
    expect(normalizeColor(42, '#111111')).toBe('#111111');
    expect(normalizeColor('#12345', '#111111')).toBe('#111111');
  });
  it('tint mixes toward white', () => {
    expect(tint('#000000', 1)).toEqual([255, 255, 255]);
    expect(tint('#000000', 0)).toEqual([0, 0, 0]);
  });
  it('contrast with white: black is high, white is ~1', () => {
    expect(contrastWithWhite('#000000')).toBeGreaterThan(15);
    expect(contrastWithWhite('#FFFFFF')).toBeLessThan(1.1);
  });
});

describe('normalizeDesign', () => {
  it('returns a complete default design for garbage input', () => {
    for (const junk of [null, undefined, 5, 'x', [], {}]) {
      expect(normalizeDesign(junk, 'quote')).toEqual(defaultDesign('quote'));
    }
  });
  it('clamps numbers and rejects bad enums', () => {
    const d = normalizeDesign(
      { page: { size: 'poster', margin: 999 }, theme: { font: 'comic', baseSize: 1 }, header: { accentBar: 'neon' } },
      'invoice',
    );
    expect(d.page.size).toBe('a4');
    expect(d.page.margin).toBe(72);
    expect(d.theme.font).toBe('helvetica');
    expect(d.theme.baseSize).toBe(8);
    expect(d.header.accentBar).toBe('top');
  });
  it('snaps base size to 0.5 steps', () => {
    expect(normalizeDesign({ theme: { baseSize: 10.3 } }, 'quote').theme.baseSize).toBe(10.5);
  });
  it('caps text length and strips control characters', () => {
    const d = normalizeDesign({ header: { title: `A\u0000B${'x'.repeat(100)}` }, terms: `l1\r\nl2\u0007` }, 'quote');
    expect(d.header.title.length).toBeLessThanOrEqual(24);
    expect(d.header.title.includes('\u0000')).toBe(false);
    expect(d.terms).toBe('l1\nl2');
  });
  it('keeps default labels when a label is blanked', () => {
    expect(normalizeDesign({ table: { amountLabel: '   ' } }, 'invoice').table.amountLabel).toBe('Amount');
  });
  it('is idempotent', () => {
    const once = normalizeDesign({ theme: { primary: '#abc' }, header: { tagline: ' hi  there ' } }, 'quote');
    expect(normalizeDesign(once, 'quote')).toEqual(once);
  });
});

describe('sections', () => {
  it('drops unknown / duplicate / wrong-type sections and appends missing ones', () => {
    const d = normalizeDesign(
      { sections: [{ id: 'totals', visible: false }, { id: 'totals', visible: true }, { id: 'bogus' }, { id: 'metrics' }, 7] },
      'invoice',
    );
    const ids = d.sections.map((s) => s.id);
    expect(ids[0]).toBe('totals');
    expect(d.sections[0].visible).toBe(false);
    expect(ids.includes('metrics' as never)).toBe(false);
    expect([...ids].sort()).toEqual([...SECTIONS_BY_TYPE.invoice].sort());
  });
  it('moveSection swaps and is bounds-safe', () => {
    const d = defaultDesign('quote');
    const moved = moveSection(d, 'items', -1);
    expect(moved.sections[0].id).toBe('items');
    expect(moved.sections[1].id).toBe('customer');
    expect(moveSection(d, 'customer', -1)).toBe(d);
    const last = d.sections[d.sections.length - 1].id;
    expect(moveSection(d, last, 1)).toBe(d);
  });
  it('visibleSections respects visibility and order', () => {
    const d = setSectionVisible(moveSection(defaultDesign('quote'), 'items', -1), 'signature', false);
    const v = visibleSections(d, 'quote');
    expect(v[0]).toBe('items');
    expect(v.includes('signature')).toBe(false);
  });
});

describe('presets', () => {
  it('every preset is valid for every doc type', () => {
    for (const type of ['quote', 'invoice', 'report'] as const) {
      for (const id of PRESET_IDS) {
        const d = applyPreset(type, id);
        expect(normalizeDesign(d, type)).toEqual(d);
        expect(d.sections).toHaveLength(SECTIONS_BY_TYPE[type].length);
      }
    }
  });
  it('applyPresetStyle changes style but keeps content and section order', () => {
    const custom = moveSection(
      normalizeDesign({ ...defaultDesign('quote'), terms: 'My terms', header: { ...defaultDesign('quote').header, title: 'ESTIMATE' } }, 'quote'),
      'items',
      -1,
    );
    const out = applyPresetStyle(custom, 'quote', 'modern');
    expect(out.theme.primary).toBe('#0F172A');
    expect(out.header.accentBar).toBe('band');
    expect(out.terms).toBe('My terms');
    expect(out.header.title).toBe('ESTIMATE');
    expect(out.sections[0].id).toBe('items');
  });
  it('presets differ from each other', () => {
    expect(designsEqual(applyPreset('quote', 'classic'), applyPreset('quote', 'modern'), 'quote')).toBe(false);
  });
});

describe('templates', () => {
  it('normalizeTemplate rejects rows without identity or with a bad type', () => {
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate({ id: 'a', user_id: 'o', name: 'n', doc_type: 'memo' })).toBeNull();
    expect(normalizeTemplate({ user_id: 'o', name: 'n', doc_type: 'quote' })).toBeNull();
  });
  it('normalizeTemplate repairs a partial row', () => {
    const t = normalizeTemplate({ id: 'a', user_id: 'o', name: 'n', doc_type: 'quote', design: { theme: { primary: '#fff' } }, is_default: true });
    expect(t?.design.theme.primary).toBe('#FFFFFF');
    expect(t?.is_default).toBe(true);
    expect(t?.status).toBe('active');
    expect(t?.revision).toBe(1);
  });
  it('normalizeTemplates skips bad rows and tolerates non-arrays', () => {
    expect(normalizeTemplates('nope')).toEqual([]);
    expect(normalizeTemplates([null, { id: 'a', user_id: 'o', name: 'n', doc_type: 'report' }])).toHaveLength(1);
  });
});

describe('filter / summary', () => {
  const list = [
    tpl({ id: 'a', name: 'Alpha', updated_at: '2026-01-05T00:00:00Z' }),
    tpl({ id: 'b', name: 'Beta', is_default: true, updated_at: '2026-01-01T00:00:00Z' }),
    tpl({ id: 'c', name: 'Gamma', doc_type: 'quote', updated_at: '2026-01-09T00:00:00Z' }),
    tpl({ id: 'd', name: 'Old', status: 'archived' }),
  ];
  it('hides archived by default, defaults first, then newest', () => {
    expect(filterTemplates(list, DEFAULT_FILTERS).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });
  it('filters by type, query and archived flag', () => {
    expect(filterTemplates(list, { ...DEFAULT_FILTERS, type: 'quote' }).map((t) => t.id)).toEqual(['c']);
    expect(filterTemplates(list, { ...DEFAULT_FILTERS, query: ' ALP ' }).map((t) => t.id)).toEqual(['a']);
    expect(filterTemplates(list, { ...DEFAULT_FILTERS, showArchived: true })).toHaveLength(4);
  });
  it('summarizes counts and defaults', () => {
    const s = summarizeTemplates(list);
    expect(s.active).toBe(3);
    expect(s.archived).toBe(1);
    expect(s.byType.invoice).toBe(2);
    expect(s.defaults.invoice).toBe('b');
    expect(s.defaults.quote).toBeNull();
  });
});

describe('naming', () => {
  it('validates names', () => {
    expect(validateName('   ')).not.toBeNull();
    expect(validateName('x'.repeat(81))).not.toBeNull();
    expect(validateName('Good name')).toBeNull();
  });
  it('uniqueCopyName avoids collisions case-insensitively', () => {
    expect(uniqueCopyName('Classic', ['Classic'])).toBe('Classic (copy)');
    expect(uniqueCopyName('Classic', ['Classic', 'classic (COPY)'])).toBe('Classic (copy 2)');
    expect(uniqueCopyName('Classic (copy)', ['Classic', 'Classic (copy)'])).toBe('Classic (copy 2)');
    expect(uniqueCopyName('x'.repeat(80), []).length).toBeLessThanOrEqual(80);
  });
});

describe('PDF-safe text', () => {
  it('keeps Latin-1 and WinAnsi punctuation, replaces the rest', () => {
    expect(pdfSafeText('Café — “quoted” €5')).toBe('Café — “quoted” €5');
    expect(pdfSafeText('سلام')).toBe('????');
    expect(pdfSafeText('a\u0007b\tc')).toBe('ab c');
  });
  it('detects unsupported characters', () => {
    expect(hasUnsupportedPdfChars('plain text')).toBe(false);
    expect(hasUnsupportedPdfChars('日本語')).toBe(true);
    expect(hasUnsupportedPdfChars(null)).toBe(false);
  });
  it('names the fields that contain them', () => {
    const d = normalizeDesign({ header: { title: 'فاکتور' }, footer: { text: 'ok' } }, 'invoice');
    expect(unsupportedFields(d, 'name')).toEqual(['Title']);
  });
});

describe('totals & sample data', () => {
  it('computeTotals matches the quote formula and clamps discount', () => {
    const items = [{ description: 'a', quantity: 2, unit_price_cents: 1000 }];
    expect(computeTotals(items, 10, 0)).toEqual({ subtotalCents: 2000, discountCents: 0, taxCents: 200, totalCents: 2200 });
    expect(computeTotals(items, 10, 999999).discountCents).toBe(2000);
    expect(computeTotals(items, -5, -5).totalCents).toBe(2000);
    expect(computeTotals(items, 10, 0, 123).taxCents).toBe(123);
    expect(computeTotals(items, 10, 0, null).taxCents).toBe(200);
  });
  it('sample data exists for every type and is internally consistent', () => {
    const now = new Date(2026, 0, 31);
    const inv = buildSampleData('invoice', {}, now);
    expect(inv.lineItems.length).toBeGreaterThan(0);
    expect(inv.secondaryDate).toBe('2026-02-14');
    expect(buildSampleData('quote', {}, now).secondaryDateLabel).toBe('Valid until');
    const rep = buildSampleData('report', { name: ' Acme ' }, now);
    expect(rep.business.name).toBe('Acme');
    expect(rep.report?.rows.every((r) => r.length === rep.report?.columns.length)).toBe(true);
  });
  it('formatDocDate handles dates, timestamps and junk', () => {
    expect(formatDocDate('2026-03-05')).toBe('March 5, 2026');
    expect(formatDocDate(null)).toBe('—');
    expect(formatDocDate('not a date')).toBe('—');
  });
  it('isNumericLike', () => {
    for (const v of ['12', '$1,200.50', '64%', '(3)', '1.2k']) expect(isNumericLike(v)).toBe(true);
    for (const v of ['Repair', '', 'abc 12']) expect(isNumericLike(v)).toBe(false);
  });
});
