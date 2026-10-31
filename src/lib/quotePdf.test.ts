import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));

import { buildQuoteDocInput, quotePdfFilename, quoteReference, type QuotePdfSource } from './quotePdf';

const li = (d: string, q: number, p: number) => ({ description: d, quantity: q, unit_price_cents: p });
const opt = (id: string, tier: string, items = [li('A', 1, 10000)], recommended = false) =>
  ({ id, tier, name: `${tier} plan`, summary: `${tier} summary`, warranty_label: '1 year', recommended, line_items: items });

const quote = (over: Partial<QuotePdfSource> = {}): QuotePdfSource => ({
  id: '1a2b3c4d-0000-4000-8000-000000000000', customer_name: 'Jane Doe', customer_phone: '555', customer_email: 'j@x.com',
  line_items: [li('Diagnostic', 2, 5000)], options: [], recommended_option_id: null, selected_option_id: null, accepted_total_cents: null,
  tax_percent: 10, tax_exempt: false, deposit_percent: 25, presentation_note: null,
  service_address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701' }, status: 'sent',
  valid_until: '2026-11-30', sent_at: null, created_at: '2026-10-29T10:00:00Z', ...over,
} as QuotePdfSource);
const labels = { recommended: 'Recommended', selected: 'Selected' };

describe('buildQuoteDocInput', () => {
  it('flat quote: same math as the screen (subtotal + rounded tax) and deposit', () => {
    const d = buildQuoteDocInput(quote(), 'Acme', labels);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]).toMatchObject({ subtotalCents: 10000, taxCents: 1000, totalCents: 11000, depositCents: 2750 });
    expect(d.number).toBe('Q-1A2B3C4D');
    expect(d.serviceAddress).toBe('1 Main St, Austin, TX, 78701');
    expect(d.contact).toEqual(['555', 'j@x.com']);
  });
  it('tiered quote: one group per option, headline tagged Recommended', () => {
    const d = buildQuoteDocInput(quote({ options: [opt('o1', 'Good'), opt('o2', 'Best', [li('B', 1, 30000)], true)] as never, recommended_option_id: 'o2' }), 'Acme', labels);
    expect(d.groups.map((g) => g.title)).toEqual(['Good \u2014 Good plan', 'Best \u2014 Best plan']);
    expect(d.groups[1]!.tags).toEqual(['Recommended']);
    expect(d.groups[1]!.totalCents).toBe(33000);
  });
  it('accepted tiered quote shows only the chosen option, tagged Selected', () => {
    const d = buildQuoteDocInput(quote({ status: 'accepted', selected_option_id: 'o1', options: [opt('o1', 'Good'), opt('o2', 'Best')] as never }), 'Acme', labels);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.tags).toContain('Selected');
  });
  it('accepted total that differs from the itemised total is shown as total-only (never mismatched sums)', () => {
    const d = buildQuoteDocInput(quote({ status: 'accepted', accepted_total_cents: 15000 }), 'Acme', labels);
    expect(d.groups[0]).toMatchObject({ totalCents: 15000, totalOnly: true });
    const same = buildQuoteDocInput(quote({ status: 'accepted', accepted_total_cents: 11000 }), 'Acme', labels);
    expect(same.groups[0]!.totalOnly).toBe(false);
  });
  it('no address → null; reference is stable', () => {
    expect(buildQuoteDocInput(quote({ service_address: null }), null, labels).serviceAddress).toBeNull();
    expect(quoteReference('abc-def')).toBe('Q-ABCDEF');
  });
  it('filename follows the export scheme and is path-safe', () => {
    expect(quotePdfFilename({ id: 'x', customer_name: '../Jane Doe' }, 'Acme HVAC', new Date('2026-10-30T00:00:00Z'))).toBe('acme-hvac-quote-2026-10-30-jane-doe.pdf');
  });
});
