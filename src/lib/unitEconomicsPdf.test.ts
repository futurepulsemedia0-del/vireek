import { describe, it, expect } from 'vitest';
import { buildUnitEconomicsPdf } from '@/lib/unitEconomicsPdf';
import { buildPlanStats, buildTenantMargins, summarizeMargins } from '@/lib/marginDashboard';

describe('buildUnitEconomicsPdf', () => {
  it('produces a valid PDF for an empty and a populated report', () => {
    const ms = buildTenantMargins([{ account_id: 'a', email: 'a@x.com', company_name: 'Acme', plan: 'starter', voice_seconds: 3000, voice_calls: 5, reported_voice_cost_usd: 6, calls_with_cost: 5, ai_cost_usd: 2 }], { fallbackVoiceCpm: null, days: 30 });
    const base = { title: 'T', periodLabel: 'Oct', generatedAtIso: '2026-11-04T00:00:00Z', coverage: { callsTotal: 5, callsWithCost: 5 }, drivers: [], freeTier: { orgs: 0, avgCostUsd: null }, reconciliation: null, assumptions: ['a'] };
    for (const m of [ms, []]) {
      const doc = buildUnitEconomicsPdf({ ...base, totals: summarizeMargins(m), planStats: buildPlanStats(m), negative: [] });
      expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
      expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
    }
  });
});
