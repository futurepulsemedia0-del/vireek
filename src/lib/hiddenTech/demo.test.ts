import { describe, expect, it } from 'vitest';
import { buildDemoSnapshot, generateDemo } from './demo';
import { LEAK_CAUSES } from './leakEngine';

const NOW = Date.parse('2027-03-17T09:00:00Z'); // a Wednesday

describe('demo data', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(generateDemo(NOW))).toBe(JSON.stringify(generateDemo(NOW)));
  });

  it('produces a realistic ledger with several causes and approvable-looking suggestions', () => {
    const s = buildDemoSnapshot(NOW);
    expect(s.actual.techs).toHaveLength(4);
    expect(s.actual.totals.utilization > 20 && s.actual.totals.utilization < 95).toBe(true);
    const present = LEAK_CAUSES.filter((c) => s.actual.totals.byCause[c] > 0);
    expect(present.length >= 5).toBe(true);
    expect(s.fixes.some((f) => f.kind === 'fill_gap')).toBe(true);
    expect(s.fixes.every((f) => f.status === 'suggested' && f.recoveredHours === null)).toBe(true); // demo never claims recovery
    expect(s.recovered.hours).toBe(0);
  });
});
