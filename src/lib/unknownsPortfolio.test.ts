import { describe, expect, it, vi } from 'vitest';
import { assessJobUnknowns, type UnknownsInput } from '@/lib/unknownsEngine';
import { summarizePortfolio, type PortfolioJob } from '@/lib/unknownsPortfolio';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const input = (over: Partial<UnknownsInput['job']> = {}, resolveAll = false): UnknownsInput => ({
  job: {
    id: 'j', job_status: 'scheduled', service_type: 'Repair', dispatch_note: 'Gate code 1234 dog',
    address: '1 Main St', latitude: 1, longitude: 2, site_id: null, customer_phone: '5',
    quote_id: null, invoice_amount: null, technician_diagnosis: null, diagnosis_notes: null,
    before_photo_count: 0, ...over,
  },
  diagnosis: { ok: true, data: [] },
  equipment: { ok: true, data: [] },
  parts: { ok: true, data: [] },
  site: { ok: true, data: null },
  compliance: { ok: true, data: null },
  noSurprise: null,
  resolutions: resolveAll
    ? (['diagnosis', 'equipment_identity', 'site_condition', 'permit_requirement', 'scope_and_price'] as const).map((dimension) => ({
        dimension, resolution: 'verified' as const, value: 'Confirmed', note: null, resolved_by: 'u', resolved_at: null,
      }))
    : [],
});

const pj = (id: string, i: UnknownsInput): PortfolioJob => ({
  id, customer_name: id, service_type: null, scheduled_datetime: null, job_status: 'scheduled', report: assessJobUnknowns(i),
});

describe('summarizePortfolio', () => {
  it('handles an empty portfolio', () => {
    const s = summarizePortfolio([]);
    expect(s.total).toBe(0);
    expect(s.avgReadinessPct).toBeNull();
  });

  it('counts verdicts, ranks the riskiest job first and rolls up dimensions', () => {
    const s = summarizePortfolio([pj('clear', input({}, true)), pj('bad', input())]);
    expect(s.total).toBe(2);
    expect(s.byVerdict.clear).toBe(1);
    expect(s.byVerdict.resolve_first).toBe(1);
    expect(s.jobs[0].id).toBe('bad');
    const diag = s.dimensions.find((d) => d.key === 'diagnosis')!;
    expect(diag.applicable).toBe(2);
    expect(diag.openCount).toBe(1);
    expect(s.dimensions[0].openCount).toBeGreaterThanOrEqual(s.dimensions[s.dimensions.length - 1].openCount);
  });
});
