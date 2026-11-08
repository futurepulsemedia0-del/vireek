import { describe, expect, it } from 'vitest';
import { FIELD_DEFS, OVERRIDABLE_KEYS, resolveValues } from './fieldRegistry';
import { renderTemplate } from './mergeEngine';

const now = new Date('2026-06-01T12:00:00Z');

describe('fieldRegistry', () => {
  it('has unique keys', () => {
    expect(new Set(FIELD_DEFS.map((f) => f.key)).size).toBe(FIELD_DEFS.length);
  });

  it('takes customer/job/org values from facts only and trims them', () => {
    const r = resolveValues({
      customer: { name: '  Jordan  ', email: '', customer_type: 'commercial' },
      job: { service_type: 'AC', scheduled_datetime: '2026-06-09T14:00:00Z' },
      organization: { company_name: 'Acme' },
      now,
    });
    expect(r.values['customer.name']).toBe('Jordan');
    expect('customer.email' in r.values).toBe(false);
    expect(r.values['job.scheduled_date']).toBe('2026-06-09T14:00:00Z');
    expect(r.values['document.generated_date']).toBe('2026-06-01');
    expect(r.rejected).toEqual([]);
  });

  it('refuses to let overrides spoof customer, organization or server fields', () => {
    const r = resolveValues({
      customer: { name: 'Real' },
      overrides: { 'customer.name': 'Fake', 'organization.name': 'Fake', 'document.generated_date': '2000-01-01', bogus: 1 },
      now,
    });
    expect(r.values['customer.name']).toBe('Real');
    expect(r.values['document.generated_date']).toBe('2026-06-01');
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['bogus', 'customer.name', 'document.generated_date', 'organization.name']);
    expect(OVERRIDABLE_KEYS.has('document.total')).toBe(true);
  });

  it('type-checks overrides', () => {
    const r = resolveValues({
      overrides: {
        'document.total': 18900,
        'document.deposit': 1.5,
        'document.effective_date': '2026-02-30',
        'document.requires_deposit': 'yes',
        'document.reference': 'AGR-1',
      },
      now,
    });
    expect(r.values['document.total']).toBe(18900);
    expect(r.values['document.reference']).toBe('AGR-1');
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['document.deposit', 'document.effective_date', 'document.requires_deposit']);
  });

  it('renders end to end through the engine', () => {
    const { values } = resolveValues({
      customer: { name: 'Jordan' },
      overrides: { 'document.total': 485000, 'document.requires_deposit': true, 'document.deposit': 100000 },
      now,
    });
    const t = 'For {{customer.name}}: {{document.total}}{{#if document.requires_deposit}}, deposit {{document.deposit}}{{/if}}.';
    const r = renderTemplate(t, values, { fields: FIELD_DEFS, currency: 'USD', locale: 'en-US' });
    expect(r.text).toBe('For Jordan: $4,850.00, deposit $1,000.00.');
    expect(r.complete).toBe(true);
  });
});
