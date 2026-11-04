import { describe, expect, it } from 'vitest';
import type { JobBrief } from '@/lib/technicianOS';
import * as B from './preJobBrief';
import * as I from './invoiceAssist';

const NOW = Date.parse('2026-11-03T00:00:00Z');
const brief = (job: Record<string, unknown> = {}): JobBrief => ({
  job: { id: 'j', customer_name: 'Ann', service_type: 'AC repair', safety_flag: false, safety_flag_note: null, ...job },
  customer: { name: 'Ann Lee' },
  equipment: [
    { make: 'Trane', model: 'XR14', equipment_type: 'AC', install_date: '2019-05-01', warranty_expires_at: '2029-05-01' },
    { make: '', model: null, equipment_type: 'Furnace', install_date: null, warranty_expires_at: '2020-01-01' },
  ],
  previous_notes: [{ notes: 'Replaced   capacitor\n and checked charge', date: '2025-06-01T10:00:00Z' }],
  warranty_claims: [{ status: 'open' }, { status: 'Closed' }],
  likely_diagnosis: { severity: 'high', confidence: 0.8 },
  customer_preferences: [{ category: 'pets', fact: 'Has dog' }],
  parts_check: [{ part_name: 'capacitor', shortage: 2 }, { part_name: 'x', shortage: 0 }],
} as unknown as JobBrief);

describe('pre-job brief', () => {
  it('warranty state and equipment age', () => {
    expect(B.warrantyState('2029-01-01', NOW)).toBe('active');
    expect(B.warrantyState('2020-01-01', NOW)).toBe('expired');
    expect(B.warrantyState(null, NOW)).toBe('unknown');
    expect(B.warrantyState('garbage', NOW)).toBe('unknown');
    expect(B.ageYears('2019-05-01', NOW)).toBe(7);
    expect(B.ageYears('2099-01-01', NOW)).toBeNull();
  });
  it('orders by priority with safety first and counts only open claims', () => {
    const items = B.buildBriefItems(brief({ safety_flag: true, safety_flag_note: 'Gas smell' }), NOW);
    expect(items[0]).toMatchObject({ kind: 'safety', params: { note: 'Gas smell' } });
    items.forEach((x, i) => { if (i > 0) expect(items[i - 1].priority).toBeLessThanOrEqual(x.priority); });
    expect(items.find((x) => x.kind === 'claims')?.params.count).toBe(1);
    expect(items.find((x) => x.kind === 'shortage')?.params.parts).toBe('2 capacitor');
    expect(items.find((x) => x.kind === 'previous')?.params.text).toBe('Replaced capacitor and checked charge');
    expect(items.find((x) => x.kind === 'diagnosis')?.params.pct).toBe(80);
  });
  it('has no safety item when not flagged and no items for an error payload', () => {
    expect(B.buildBriefItems(brief(), NOW).some((x) => x.kind === 'safety')).toBe(false);
    expect(B.buildBriefItems({ error: 'forbidden' } as unknown as JobBrief)).toEqual([]);
  });
  it('fitSpoken drops low priority first but always keeps safety', () => {
    const long = Array(30).fill('word').join(' ');
    expect(B.fitSpoken([{ text: long, priority: 1 }, { text: 'short fact', priority: 3 }, { text: `low pri ${long}`, priority: 8 }], 40)).toEqual([long, 'short fact']);
    const huge = Array(200).fill('w').join(' ');
    expect(B.fitSpoken([{ text: huge, priority: 1 }, { text: 'x y', priority: 2 }], 150)).toEqual([huge]);
    const r = B.fitSpoken([{ text: 'a b c', priority: 2 }, { text: 'd e f', priority: 3 }, { text: 'g h i', priority: 4 }], 6);
    expect(r).toEqual(['a b c', 'd e f']);
    expect(B.estimateSeconds(r)).toBeLessThanOrEqual(B.BRIEF_SECONDS);
    expect(B.BRIEF_MAX_WORDS).toBe(150);
  });
});

const book: I.BookItem[] = [
  { id: '1', service_name: 'Capacitor replacement', keywords: ['run capacitor'], price_cents: 25000, pricing_model: 'flat', active: true },
  { id: '2', service_name: 'Labor', keywords: null, price_cents: 15000, pricing_model: 'hourly', active: true },
  { id: '3', service_name: 'Old thing', keywords: null, price_cents: 1, pricing_model: 'flat', active: false },
];
const base: I.AssistInput = { invoiceLines: [], loggedParts: [], loggedMinutes: null, onsiteMinutes: null, priceBook: book };
const line = (description: string, quantity: number, unit_price_cents: number): I.InvLine => ({ description, quantity, unit_price_cents });

describe('invoice assist (flags only, never edits)', () => {
  it('similarity basics', () => {
    expect(I.similarity('Run Capacitor 45/5', 'run capacitors')).toBe(1);
    expect(I.similarity('abc', 'xyz')).toBe(0);
    expect(I.similarity('', 'x')).toBe(0);
  });
  it('flags a logged part that is not on the invoice', () => {
    const f = I.reconcileInvoice({ ...base, invoiceLines: [line('Labor', 1, 15000)], loggedParts: [{ name: 'contactor', quantity: 1 }], loggedMinutes: 60 });
    expect(f.map((x) => x.kind)).toEqual(['part_not_billed']);
  });
  it('flags a billed quantity below the logged quantity', () => {
    const f = I.reconcileInvoice({ ...base, invoiceLines: [line('Run capacitor', 1, 25000)], loggedParts: [{ name: 'run capacitor', quantity: 2 }] });
    expect(f[0]).toMatchObject({ kind: 'part_qty_low', data: { billed: 1 } });
  });
  it('flags under-billed labor using the larger of logged and on-site time, with a 15 min tolerance', () => {
    const l = I.reconcileInvoice({ ...base, invoiceLines: [line('Labor', 1, 15000)], loggedMinutes: 45, onsiteMinutes: 130 }).find((x) => x.kind === 'labor_under_billed');
    expect(l?.data).toMatchObject({ workMin: 130, billedMin: 60 });
    expect(I.reconcileInvoice({ ...base, invoiceLines: [line('Labor', 1, 15000)], loggedMinutes: 70 })).toHaveLength(0);
    const none = I.reconcileInvoice({ ...base, invoiceLines: [line('Run capacitor', 1, 25000)], loggedMinutes: 90 });
    expect(none[0].data.billedMin).toBe(0);
  });
  it('flags prices below the price book; ignores inactive items', () => {
    const f = I.reconcileInvoice({ ...base, invoiceLines: [line('Capacitor replacement', 1, 20000), line('Old thing', 1, 0)] });
    expect(f.map((x) => x.kind)).toEqual(['price_below_book']);
    expect(f[0].lineIndex).toBe(0);
  });
  it('returns no flags for a consistent invoice', () => {
    expect(I.reconcileInvoice({ ...base, invoiceLines: [line('Capacitor replacement', 1, 25000), line('Labor', 1, 15000)], loggedParts: [{ name: 'capacitor replacement', quantity: 1 }], loggedMinutes: 55, onsiteMinutes: 58 })).toEqual([]);
  });
  it('each logged part claims a distinct invoice line', () => {
    const f = I.reconcileInvoice({ ...base, priceBook: [], invoiceLines: [line('Run capacitor', 1, 1)], loggedParts: [{ name: 'run capacitor', quantity: 1 }, { name: 'run capacitor', quantity: 1 }] });
    expect(f.map((x) => x.kind)).toEqual(['part_not_billed']);
  });
  it('recognises Spanish and Persian labor lines', () => {
    for (const d of ['Mano de obra', 'ساعت کار']) {
      expect(I.reconcileInvoice({ ...base, priceBook: [], invoiceLines: [line(d, 2, 1)], loggedMinutes: 100 })).toHaveLength(0);
    }
  });
});
