import { describe, expect, it } from 'vitest';
import {
  deadlineState, evidenceReadiness, filterDisputes, formatMoney, reasonMeta, safeFileName, statusMeta,
  validateDraft, validateEvidenceFile, type StripeDisputeRow,
} from './disputes';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function row(over: Partial<StripeDisputeRow>): StripeDisputeRow {
  return {
    id: 'r', user_id: 'u', stripe_dispute_id: 'dp_1', stripe_charge_id: null, payment_request_id: null, job_id: null,
    customer_name: 'Jane Roe', amount_cents: 10000, currency: 'usd', reason: 'general', network_reason_code: null, status: 'needs_response',
    is_charge_refundable: null, evidence_due_by: null, has_evidence: false, past_due: false, submission_count: 0, evidence_submitted_at: null,
    net_balance_cents: 0, opened_at: '2026-10-01T00:00:00Z', closed_at: null, evidence_draft: {}, last_event_type: null, updated_at: '2026-10-01T00:00:00Z', ...over,
  };
}

describe('disputes helpers', () => {
  it('classifies deadlines', () => {
    expect(deadlineState(null, NOW).kind).toBe('none');
    expect(deadlineState(hoursFromNow(-1), NOW).kind).toBe('overdue');
    expect(deadlineState(hoursFromNow(5), NOW)).toMatchObject({ kind: 'critical', label: '5h left' });
    expect(deadlineState(hoursFromNow(60), NOW).kind).toBe('soon');
    expect(deadlineState(hoursFromNow(24 * 9), NOW)).toMatchObject({ kind: 'ok', label: '9d left' });
    expect(deadlineState('not-a-date', NOW).kind).toBe('none');
  });

  it('degrades gracefully for unknown statuses and reasons', () => {
    expect(statusMeta('prevented')).toEqual({ label: 'Prevented', tone: 'neutral' });
    expect(reasonMeta('brand_new_reason').label).toBe('Brand new reason');
    expect(reasonMeta(null).key).toBe('general');
  });

  it('scores evidence readiness against the dispute reason', () => {
    const empty = evidenceReadiness('product_not_received', {}, []);
    expect(empty.pct).toBe(0);
    expect(empty.missingFiles).toContain('service_documentation');
    const partial = evidenceReadiness('product_not_received', { product_description: 'Replaced capacitor', service_date: '2026-09-30' }, [{ category: 'service_documentation' }]);
    expect(partial.pct).toBe(Math.round((3 / 5) * 100));
    expect(evidenceReadiness('duplicate', { duplicate_charge_explanation: 'x' }, [{ category: 'duplicate_charge_documentation' }, { category: 'receipt' }]).pct).toBe(100);
  });

  it('validates files against type, count and the 4.5 MB total', () => {
    expect(validateEvidenceFile({ name: 'a.gif', type: 'image/gif', size: 10 }, [])).toMatch(/PDF, JPG or PNG/);
    expect(validateEvidenceFile({ name: 'a.pdf', type: 'application/pdf', size: 0 }, [])).toMatch(/empty/);
    expect(validateEvidenceFile({ name: 'a.pdf', type: 'application/pdf', size: 1_000_000 }, [])).toBeNull();
    expect(validateEvidenceFile({ name: 'a.pdf', type: 'application/pdf', size: 1_000_000 }, [{ size_bytes: 4_000_000 }])).toMatch(/cannot exceed/);
    expect(validateEvidenceFile({ name: 'a.pdf', type: 'application/pdf', size: 1 }, Array.from({ length: 20 }, () => ({ size_bytes: 1 })))).toMatch(/at most 20/);
  });

  it('validates draft text limits', () => {
    expect(validateDraft({ product_description: 'ok' })).toBeNull();
    expect(validateDraft({ product_description: 'x'.repeat(20001) })).toMatch(/Description of the service/);
    const big = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'x'.repeat(20000)]));
    expect(validateDraft(big)).toMatch(/in total/);
  });

  it('sorts action items by nearest deadline, then newest; filters by tab and query', () => {
    const rows = [
      row({ id: 'won', status: 'won', opened_at: '2026-10-05T00:00:00Z' }),
      row({ id: 'late', evidence_due_by: hoursFromNow(100) }),
      row({ id: 'soon', evidence_due_by: hoursFromNow(10), customer_name: 'Bob Stone' }),
      row({ id: 'lost', status: 'lost', opened_at: '2026-10-07T00:00:00Z' }),
    ];
    expect(filterDisputes(rows, 'all', '').map((r) => r.id)).toEqual(['soon', 'late', 'lost', 'won']);
    expect(filterDisputes(rows, 'action', '').map((r) => r.id)).toEqual(['soon', 'late']);
    expect(filterDisputes(rows, 'all', 'stone').map((r) => r.id)).toEqual(['soon']);
    expect(filterDisputes(rows, 'review', '')).toEqual([]);
  });

  it('formats money and file names safely', () => {
    expect(formatMoney(123456, 'usd')).toBe('$1,234.56');
    expect(formatMoney(100, 'zzzz')).toBe('1.00 ZZZZ');
    expect(safeFileName('Signed Work Order (final) #2.pdf')).toBe('Signed_Work_Order_final_2.pdf');
    expect(safeFileName('???')).toBe('_');
  });
});
