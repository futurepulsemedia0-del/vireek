import { describe, expect, it } from 'vitest';
import { buildHeatmap, summarizeGaps, summarizeOutcomes } from './heatmap';
import type { HoldRow } from './api';

const h = (o: Partial<HoldRow>): HoldRow => ({ id: 'x', kind: 'value', technician_id: 't', trade: null, slot_start: '2026-11-03T09:00:00Z', slot_end: '2026-11-03T10:00:00Z', status: 'active', shadow: false, release_reason: null, ...o });
const dk = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hr = (ms: number) => new Date(ms).getUTCHours();

describe('heatmap', () => {
  it('buckets holds by day/hour and kind, released separately', () => {
    const { days, cells } = buildHeatmap([h({}), h({ kind: 'campaign' }), h({ status: 'released' }), h({ slot_start: '2026-11-04T14:00:00Z' }), h({ slot_start: 'bad' })], dk, hr);
    expect(days).toEqual(['2026-11-03', '2026-11-04']);
    expect(cells.get('2026-11-03|9')).toMatchObject({ value: 1, campaign: 1, released: 1 });
    expect(cells.get('2026-11-04|14')?.value).toBe(1);
  });
  it('outcomes split consumed / released / active / shadow', () => {
    expect(summarizeOutcomes([h({}), h({ status: 'consumed' }), h({ status: 'released' }), h({ shadow: true })])).toEqual({ held: 4, consumed: 1, released: 1, active: 1, shadowActive: 1 });
  });
  it('win rate counts only closed gaps and separates estimate from realized revenue', () => {
    const s = summarizeGaps([
      { status: 'filled', recovered_estimate_cents: 30000, realized_cents: 28000 }, { status: 'expired', recovered_estimate_cents: null, realized_cents: null },
      { status: 'open', recovered_estimate_cents: null, realized_cents: null }, { status: 'filled', recovered_estimate_cents: 10000, realized_cents: null },
    ]);
    expect(s).toEqual({ total: 3, filled: 2, winRate: 2 / 3, estimateCents: 40000, realizedCents: 28000 });
  });
  it('empty input is safe', () => { expect(summarizeGaps([]).winRate).toBe(0); expect(buildHeatmap([], dk, hr).days).toEqual([]); });
});
