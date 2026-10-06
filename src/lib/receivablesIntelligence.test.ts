import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  buildCashDragInsights,
  collectabilityPct,
  compareWorkflows,
  dominantDelayStage,
  type ReceivablesResult,
  type ReceivablesSegment,
} from './receivablesIntelligence';

function seg(over: Partial<ReceivablesSegment>): ReceivablesSegment {
  return {
    service_type: 'HVAC Repair', approval_gated: false, has_contract: false, invoices: 10, paid: 8,
    billed_cents: 100000, open_cents: 20000, avg_ticket_cents: 10000, median_days_to_cash: 12,
    median_approval_days: null, median_approval_to_invoice_days: null, median_job_to_invoice_days: 2,
    dispute_rate: 0, overdue_rate: 0, ...over,
  };
}

function result(segments: ReceivablesSegment[], median: number | null = 12): ReceivablesResult {
  return {
    window_days: 365, invoices_analyzed: 30, paid_invoices: 20, confidence: 'medium', method: 'aging_prior_adjusted',
    summary: {
      billed_cents: 0, collected_cents: 0, open_cents: 100000, overdue_cents: 0, disputed_open_cents: 0,
      expected_collectable_cents: 80000, at_risk_cents: 20000, median_days_to_cash: median, p90_days_to_cash: null, dso_days: null,
    },
    aging: [], graph: { nodes: [], transitions: { quote_to_approval_days: null, approval_to_invoice_days: null, job_to_invoice_days: null, invoice_to_payment_days: null } },
    segments, at_risk_invoices: [], weekly: [],
  };
}

describe('receivablesIntelligence', () => {
  it('flags only segments materially slower than the account median', () => {
    const slow = seg({ service_type: 'Roof Replacement', approval_gated: true, median_days_to_cash: 45, median_approval_days: 11, open_cents: 90000 });
    const fine = seg({ median_days_to_cash: 13 });
    const out = buildCashDragInsights(result([fine, slow]));
    expect(out).toHaveLength(1);
    expect(out[0].service_type).toBe('Roof Replacement');
    expect(out[0].delay_days).toBe(33);
  });

  it('ignores segments with too few settled invoices and missing baselines', () => {
    expect(buildCashDragInsights(result([seg({ paid: 2, median_days_to_cash: 60 })]))).toHaveLength(0);
    expect(buildCashDragInsights(result([seg({ median_days_to_cash: 60 })], null))).toHaveLength(0);
  });

  it('finds the dominant delay stage', () => {
    expect(dominantDelayStage(seg({ median_approval_days: 30, median_days_to_cash: 12 })).stage).toBe('approval');
    expect(dominantDelayStage(seg({ median_days_to_cash: 40 })).stage).toBe('collection');
  });

  it('compares approval-gated vs direct billing weighted by paid invoices', () => {
    const cmp = compareWorkflows([seg({ approval_gated: true, median_days_to_cash: 40, paid: 5 }), seg({ median_days_to_cash: 10, paid: 5 })]);
    expect(cmp?.gated_days).toBe(40);
    expect(cmp?.direct_days).toBe(10);
    expect(compareWorkflows([seg({})])).toBeNull();
  });

  it('computes collectability percentage safely', () => {
    expect(collectabilityPct(result([]))).toBe(80);
  });
});
