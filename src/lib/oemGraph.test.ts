import { describe, it, expect } from 'vitest';
import {
  addMonths,
  buildChain,
  claimOpportunities,
  evaluateWarranty,
  filterFleet,
  fleetAttentionScore,
  formatDecodedSerial,
  formatLabor,
  formatLift,
  normalizeFleet,
  normalizeKey,
  normalizeOemGraph,
  partsCoverage,
  reliabilityHeadline,
  summarizeFleet,
  type OemFleetRow,
} from './oemGraph';

const NOW = new Date('2026-06-15T12:00:00Z');

function rawGraph(over: Record<string, unknown> = {}) {
  return {
    found: true,
    equipment: {
      id: 'eq1', equipment_type: 'furnace', make: 'Carrier', model: 'ABC-123', serial_number: '1234567890',
      install_date: '2023-06-01', warranty_expires_at: null, status: 'active', customer_id: 'c1', customer_name: 'Pat',
    },
    match: {
      method: 'exact', confidence: 1,
      manufacturer: { id: 'm1', slug: 'carrier', name: 'Carrier', support_url: null },
      model: { id: 'md1', model_number: 'ABC-123', equipment_type: 'furnace', category: null, avg_lifespan_years: 15, manual_url: null, source: 'internal' },
    },
    serial: { decoded: null, excluded_issues: 0 },
    issues: [],
    recalls: [],
    bulletins: [],
    patterns: [],
    warranty_terms: [],
    documents: [],
    reliability: null,
    claims: [],
    coverage: { model_matched: true, issues: 0, warranty_terms: 0, documents: 0, reliability: false, serial_rule: false, has_serial: true },
    ...over,
  };
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: 'i1', issue_key: 'igniter', title: 'Igniter cracks early', severity: 'high', applicability: 'applies', scope: 'model',
  labor_minutes_min: 45, labor_minutes_max: 90, parts: [{ id: 'p1', part_number: 'HK-1', part_name: 'Igniter', avg_price: 60, quantity: 1, is_required: true }],
  ...over,
});

const term = (over: Record<string, unknown> = {}) => ({ component: 'parts', months: 12, registered_months: 120, scope: 'model', ...over });

describe('normalizeOemGraph', () => {
  it('never throws and returns an empty graph for junk', () => {
    for (const junk of [null, undefined, 42, 'x', [], {}, { found: false }, { found: true }, { found: true, equipment: {} }]) {
      const g = normalizeOemGraph(junk);
      expect(g.found).toBe(false);
      expect(g.issues).toEqual([]);
      expect(g.match.method).toBe('none');
    }
  });

  it('fills defaults for nulls and drops malformed children', () => {
    const g = normalizeOemGraph(rawGraph({ issues: [null, { title: 'no id' }, issue()], warranty_terms: [{ component: 'parts' }, term()], claims: [{}] }));
    expect(g.issues).toHaveLength(1);
    expect(g.warranty_terms).toHaveLength(1);
    expect(g.claims).toHaveLength(0);
    expect(g.issues[0].parts[0].avg_price).toBe(60);
  });

  it('coerces unknown enums to safe values', () => {
    const g = normalizeOemGraph(rawGraph({ issues: [issue({ severity: 'weird', applicability: 'nope' })], match: { method: '??', confidence: 'x' } }));
    expect(g.issues[0].severity).toBe('medium');
    expect(g.issues[0].applicability).toBe('applies');
    expect(g.match.method).toBe('none');
    expect(g.match.confidence).toBe(0);
  });
});

describe('addMonths', () => {
  it('clamps the day to the end of shorter months', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
  });
  it('crosses years in both directions', () => {
    expect(addMonths('2023-11-15', 3)).toBe('2024-02-15');
    expect(addMonths('2024-02-15', -3)).toBe('2023-11-15');
    expect(addMonths('2023-06-01', 120)).toBe('2033-06-01');
  });
  it('rejects invalid input', () => {
    expect(addMonths('nope', 1)).toBeNull();
  });
});

describe('evaluateWarranty', () => {
  it('standard coverage active inside the base term', () => {
    const g = normalizeOemGraph(rawGraph({ warranty_terms: [term({ months: 60, registered_months: null })] }));
    const [w] = evaluateWarranty(g, NOW);
    expect(w.state).toBe('active');
    expect(w.expires_on).toBe('2028-06-01');
    expect(w.days_left).toBeGreaterThan(0);
  });
  it('between base and registered term is active ONLY if registered', () => {
    const g = normalizeOemGraph(rawGraph({ warranty_terms: [term()] }));
    const [w] = evaluateWarranty(g, NOW);
    expect(w.state).toBe('active_if_registered');
    expect(w.needs_registration).toBe(true);
    expect(w.expires_on).toBe('2033-06-01');
  });
  it('expired after the longest term', () => {
    const g = normalizeOemGraph(rawGraph({ equipment: { ...rawGraph().equipment, install_date: '2005-01-01' }, warranty_terms: [term()] }));
    expect(evaluateWarranty(g, NOW)[0].state).toBe('expired');
  });
  it('unknown without an install date', () => {
    const g = normalizeOemGraph(rawGraph({ equipment: { ...rawGraph().equipment, install_date: null }, warranty_terms: [term()] }));
    expect(evaluateWarranty(g, NOW)[0].state).toBe('unknown');
  });
  it('is inclusive on the last covered day', () => {
    const g = normalizeOemGraph(rawGraph({ warranty_terms: [term({ months: 36, registered_months: null })] }));
    expect(evaluateWarranty(g, new Date('2026-06-01T23:00:00Z'))[0].state).toBe('active');
    expect(evaluateWarranty(g, new Date('2026-06-02T00:00:00Z'))[0].state).toBe('expired');
  });
});

describe('partsCoverage', () => {
  it('falls back to the recorded expiry when there are no OEM terms', () => {
    const g = normalizeOemGraph(rawGraph({ equipment: { ...rawGraph().equipment, warranty_expires_at: '2027-01-01' } }));
    expect(partsCoverage(g, NOW)).toMatchObject({ state: 'active', basis: 'recorded_expiry', expires_on: '2027-01-01' });
  });
  it('reports none when nothing is known', () => {
    expect(partsCoverage(normalizeOemGraph(rawGraph()), NOW).basis).toBe('none');
  });
});

describe('claimOpportunities', () => {
  it('finds a covered issue with a required part, sorted by severity', () => {
    const g = normalizeOemGraph(rawGraph({
      warranty_terms: [term({ months: 60, registered_months: null })],
      issues: [issue({ id: 'low', title: 'B', severity: 'low' }), issue({ id: 'crit', title: 'A', severity: 'critical' })],
    }));
    const ops = claimOpportunities(g, NOW);
    expect(ops.map((o) => o.issue_id)).toEqual(['crit', 'low']);
    expect(ops[0].estimated_part_value).toBe(60);
    expect(ops[0].needs_registration).toBe(false);
  });
  it('flags registration dependence', () => {
    const g = normalizeOemGraph(rawGraph({ warranty_terms: [term()], issues: [issue()] }));
    expect(claimOpportunities(g, NOW)[0].needs_registration).toBe(true);
  });
  it('returns nothing when coverage ended, no parts are required, or a claim is already open', () => {
    const expired = normalizeOemGraph(rawGraph({ equipment: { ...rawGraph().equipment, install_date: '2005-01-01' }, warranty_terms: [term()], issues: [issue()] }));
    expect(claimOpportunities(expired, NOW)).toEqual([]);
    const noParts = normalizeOemGraph(rawGraph({ warranty_terms: [term({ months: 60, registered_months: null })], issues: [issue({ parts: [] })] }));
    expect(claimOpportunities(noParts, NOW)).toEqual([]);
    const open = normalizeOemGraph(rawGraph({ warranty_terms: [term({ months: 60, registered_months: null })], issues: [issue()], claims: [{ id: 'c', status: 'submitted' }] }));
    expect(claimOpportunities(open, NOW)).toEqual([]);
  });
  it('leaves value null when no part has a price', () => {
    const g = normalizeOemGraph(rawGraph({
      warranty_terms: [term({ months: 60, registered_months: null })],
      issues: [issue({ parts: [{ id: 'p', part_number: 'X', part_name: 'X', avg_price: null, quantity: 1, is_required: true }] })],
    }));
    expect(claimOpportunities(g, NOW)[0].estimated_part_value).toBeNull();
  });
});

describe('buildChain', () => {
  it('always returns the eight steps in order', () => {
    const steps = buildChain(normalizeOemGraph(rawGraph()), NOW);
    expect(steps.map((s) => s.key)).toEqual(['serial', 'oem', 'model', 'issue', 'bulletin', 'part', 'warranty', 'claim']);
  });
  it('reports empty links honestly (empty is not clean)', () => {
    const steps = buildChain(normalizeOemGraph(rawGraph()), NOW);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.issue.status).toBe('empty');
    expect(byKey.issue.detail[0]).toMatch(/not the same as/);
    expect(byKey.warranty.status).toBe('empty');
    expect(byKey.oem.status).toBe('ok');
  });
  it('escalates severity into the issue and bulletin steps', () => {
    const g = normalizeOemGraph(rawGraph({
      issues: [issue({ severity: 'critical' })],
      recalls: [{ id: 'r', recall_number: 'R-1', title: 'Gas valve', severity: 'critical' }],
      bulletins: [{ id: 'b', bulletin_number: 'T-9', title: 'Update' }],
    }));
    const byKey = Object.fromEntries(buildChain(g, NOW).map((s) => [s.key, s]));
    expect(byKey.issue.status).toBe('critical');
    expect(byKey.bulletin.status).toBe('critical');
    expect(byKey.bulletin.headline).toBe('1 recall · 1 bulletin');
  });
  it('handles an unmatched unit without crashing', () => {
    const g = normalizeOemGraph(rawGraph({ match: { method: 'none', confidence: 0, manufacturer: null, model: null }, equipment: { ...rawGraph().equipment, serial_number: null } }));
    const byKey = Object.fromEntries(buildChain(g, NOW).map((s) => [s.key, s]));
    expect(byKey.serial.status).toBe('attention');
    expect(byKey.oem.status).toBe('empty');
    expect(byKey.model.status).toBe('empty');
  });
  it('marks a family-only model match as needing attention', () => {
    const g = normalizeOemGraph(rawGraph({ match: { ...rawGraph().match, method: 'family', confidence: 0.6 } }));
    expect(buildChain(g, NOW).find((s) => s.key === 'model')?.status).toBe('attention');
  });
  it('shows a potential claim only when there are no claims yet', () => {
    const g = normalizeOemGraph(rawGraph({ warranty_terms: [term({ months: 60, registered_months: null })], issues: [issue()] }));
    const claim = buildChain(g, NOW).find((s) => s.key === 'claim');
    expect(claim?.headline).toBe('1 potential');
    expect(claim?.status).toBe('attention');
  });
});

describe('formatters', () => {
  it('formats labor ranges', () => {
    expect(formatLabor(45, 45)).toBe('45 min');
    expect(formatLabor(60, 120)).toBe('1 h – 2 h');
    expect(formatLabor(null, null)).toBeNull();
    expect(formatLabor(90, null)).toBe('1.5 h');
  });
  it('formats lift and headline', () => {
    expect(formatLift(1.8)).toBe('1.8×');
    expect(formatLift(2)).toBe('2×');
    const g = normalizeOemGraph(rawGraph({ reliability: { scope: 'family', model_family: 'abc123', units_observed: 40, units_failed: 10, contributor_count: 7, failure_rate_pct: 14.2, benchmark_rate_pct: 8.1, lift: 1.75, signal: 'above_benchmark', window_months: 36 } }));
    expect(reliabilityHeadline(g.reliability)).toContain('14.2% of units had a failure vs 8.1%');
    expect(reliabilityHeadline(null)).toBeNull();
  });
  it('formats decoded serial dates by precision', () => {
    expect(formatDecodedSerial({ date: '2019-01-01', precision: 'year', rule: 'r', verified: true })).toBe('2019');
    expect(formatDecodedSerial({ date: '2019-03-01', precision: 'month', rule: 'r', verified: true })).toBe('Mar 2019');
    expect(formatDecodedSerial(null)).toBeNull();
  });
  it('normalizes keys like SQL atlas_norm', () => {
    expect(normalizeKey(' ABC-123/x ')).toBe('abc123x');
    expect(normalizeKey(null)).toBe('');
  });
});

describe('fleet', () => {
  const row = (over: Record<string, unknown> = {}): OemFleetRow =>
    normalizeFleet([{ equipment_id: 'e', equipment_type: 'furnace', make: 'Carrier', model: 'A', match_method: 'exact', ...over }])[0];

  it('drops rows without an id and defaults counts', () => {
    expect(normalizeFleet([{ make: 'x' }, null, 5])).toEqual([]);
    expect(row().recall_count).toBe(0);
  });
  it('ranks recalls first, then above-benchmark models', () => {
    const recall = row({ equipment_id: 'a', recall_count: 1 });
    const bench = row({ equipment_id: 'b', reliability: { signal: 'above_benchmark' } });
    const quiet = row({ equipment_id: 'c' });
    expect(fleetAttentionScore(recall)).toBeGreaterThan(fleetAttentionScore(bench));
    expect(filterFleet([quiet, bench, recall], 'all', '').map((r) => r.equipment_id)).toEqual(['a', 'b', 'c']);
  });
  it('filters and searches', () => {
    const rows = [row({ equipment_id: 'a', make: 'Trane', customer_name: 'Zed' }), row({ equipment_id: 'b', match_method: 'none' }), row({ equipment_id: 'c', recall_count: 2 })];
    expect(filterFleet(rows, 'unmatched', '').map((r) => r.equipment_id)).toEqual(['b']);
    expect(filterFleet(rows, 'attention', '').map((r) => r.equipment_id)).toEqual(['c']);
    expect(filterFleet(rows, 'all', 'zed').map((r) => r.equipment_id)).toEqual(['a']);
  });
  it('summarizes the fleet', () => {
    const s = summarizeFleet([row(), row({ match_method: 'none' }), row({ recall_count: 1, reliability: { signal: 'above_benchmark' } }), row({ match_method: 'manufacturer' })]);
    expect(s).toMatchObject({ total: 4, matched: 2, matchedPct: 50, aboveBenchmark: 1, withRecalls: 1 });
    expect(summarizeFleet([]).matchedPct).toBe(0);
  });
});
