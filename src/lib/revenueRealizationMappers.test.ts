import { describe, expect, it } from 'vitest';
import {
  capturedByMonth, lineItemsTotalCents, mapAgreements, mapDeclined, mapDiscounts, mapUnderpriced, mapWarranty, occurrencesPerYear,
  type AgreementRow,
} from '../../supabase/functions/_shared/revenue-realization/mappers';
import { detectDeclinedRisk, detectDiscountOverPolicy, detectUnderpriced } from '../../supabase/functions/_shared/revenue-realization/engine';

const NOW = Date.parse('2028-06-15T12:00:00Z');

describe('mappers', () => {
  it('lineItemsTotalCents matches subtotal × (1 + tax) and tolerates junk', () => {
    expect(lineItemsTotalCents([{ quantity: 2, unit_price_cents: 5000 }, { quantity: 1, unit_price_cents: 2500 }], 10)).toBe(13_750);
    expect(lineItemsTotalCents(null, 5)).toBe(0);
    expect(lineItemsTotalCents([{ quantity: -3, unit_price_cents: 100 }], 0)).toBe(0);
  });

  it('mapDeclined picks the recommended option and detects a later quote by email or phone', () => {
    const item = { id: 'i', package_id: 'p', severity: 'urgent' as const, recommended_option_id: 'b', decided_at: '2028-06-01T00:00:00Z',
      options: [{ id: 'a', line_items: [{ quantity: 1, unit_price_cents: 1000 }] }, { id: 'b', line_items: [{ quantity: 1, unit_price_cents: 90_000 }] }] };
    const pkg = { id: 'p', job_id: 'j', customer_name: 'Bo', customer_email: 'Bo@x.com', customer_phone: '(555) 123-4567', tax_percent: 0 };
    const [f] = mapDeclined([item], [pkg], []);
    expect(f.optionTotalCents).toBe(90_000);
    expect(f.laterQuoteOrJob).toBe(false);
    expect(mapDeclined([item], [pkg], [{ customer_email: 'bo@x.com', customer_phone: null, created_at: '2028-06-05T00:00:00Z' }])[0].laterQuoteOrJob).toBe(true);
    expect(mapDeclined([item], [pkg], [{ customer_email: null, customer_phone: '555-123-4567', created_at: '2028-06-05T00:00:00Z' }])[0].laterQuoteOrJob).toBe(true);
    expect(mapDeclined([item], [pkg], [{ customer_email: 'bo@x.com', customer_phone: null, created_at: '2028-05-01T00:00:00Z' }])[0].laterQuoteOrJob).toBe(false);
    expect(detectDeclinedRisk([f], NOW)).toHaveLength(1);
    expect(mapDeclined([item], [], [])).toHaveLength(0);
  });

  it('mapDiscounts keeps only overridden checks whose quote exists', () => {
    const base = { id: 'c', quote_id: 'q', requested_by: null, revenue_cents: 50_000, estimated_cost_cents: 40_000, margin_floor_pct: 30, verdict: 'overridden', override_reason: null, created_at: '2028-06-01T00:00:00Z' };
    const facts = mapDiscounts([base, { ...base, id: 'd', verdict: 'within_floor' }, { ...base, id: 'e', quote_id: 'missing' }], [{ id: 'q', status: 'accepted', customer_name: 'Ana' }]);
    expect(facts).toHaveLength(1);
    expect(detectDiscountOverPolicy(facts)[0].amountCents).toBe(Math.ceil(40_000 / 0.7) - 50_000);
  });

  it('mapWarranty converts nulls to zero', () => {
    const [w] = mapWarranty([{ id: 'w', job_id: null, customer_name: 'x', status: 'eligible', claimed_amount_cents: null, part_cost_cents: null, labor_cost_cents: 500, claim_deadline: null, created_at: '2028-06-01T00:00:00Z' }]);
    expect(w).toMatchObject({ partCostCents: 0, laborCostCents: 500, claimedCents: null });
  });

  it('agreements: annual value from the interval, successor detection', () => {
    expect(occurrencesPerYear('month', 1)).toBe(12);
    expect(occurrencesPerYear('week', 2)).toBe(26);
    expect(occurrencesPerYear('year', 1)).toBe(1);
    const a: AgreementRow = { id: 'a', customer_id: 'c', customer_name: 'Ana', title: 'PM', service_type: 'pm', interval_unit: 'month', interval_count: 3, start_date: '2027-07-01', end_date: '2028-06-30', price_amount: 150, status: 'active', preferred_technician_id: 't' };
    expect(mapAgreements([a], [a])[0]).toMatchObject({ annualValueCents: 60_000, successorExists: false, ownerId: 't' });
    const renewed = { ...a, id: 'b', start_date: '2028-07-01' };
    expect(mapAgreements([a], [a, renewed])[0].successorExists).toBe(true);
    expect(mapAgreements([a], [a, { ...renewed, service_type: 'other' }])[0].successorExists).toBe(false);
  });

  it('underpriced: exact beats keyword, only flat services, inactive ignored', () => {
    const job = { id: 'j', customer_name: 'x', service_type: 'Tune-Up', invoice_amount: 100, assigned_technician_id: 't', scheduled_datetime: null, created_at: '2028-06-01T00:00:00Z' };
    const book = [
      { service_name: 'tune-up', pricing_model: 'flat', price_cents: 20_000, keywords: [], active: true },
      { service_name: 'x', pricing_model: 'hourly', price_cents: 99_999, keywords: ['tune-up'], active: true },
    ];
    const f = mapUnderpriced([job], book);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ match: 'exact', bookCents: 20_000, invoicedCents: 10_000 });
    expect(mapUnderpriced([job], [{ ...book[0], active: false }])).toHaveLength(0);
    expect(mapUnderpriced([job], [{ service_name: 'z', pricing_model: 'flat', price_cents: 20_000, keywords: ['TUNE-UP'], active: true }])[0].match).toBe('keyword');
    expect(detectUnderpriced(f)).toHaveLength(1);
  });

  it('capturedByMonth buckets by UTC month and ignores invalid rows', () => {
    expect(capturedByMonth([{ cents: 100, at: '2028-05-31T23:59:59Z' }, { cents: 200, at: '2028-06-01T00:00:00Z' }, { cents: 50, at: '2028-06-20T10:00:00Z' }, { cents: -5, at: '2028-06-02T00:00:00Z' }, { cents: 9, at: 'nope' }]))
      .toEqual({ '2028-05-01': 100, '2028-06-01': 250 });
  });
});
