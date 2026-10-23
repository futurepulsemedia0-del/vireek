import { describe, expect, it } from 'vitest';
import {
  GRAPH_SIZE,
  IdentityError,
  buildHouseholdGraph,
  candidateToPair,
  confidenceTone,
  describeSignals,
  displayKey,
  groupKeys,
  normalizeProfile,
  normalizeSignals,
  toIdentityError,
  type IdentityCandidate,
  type IdentityProfile,
} from './identityResolution';


const profileRaw = {
  customer_id: 'c1',
  keys: [
    { id: 'k1', type: 'phone', value: '5125550123', raw: '+1 512-555-0123', source: 'backfill', is_primary: true, seen_count: 3, last_seen_at: '2027-11-01T00:00:00Z' },
    { id: 'k2', type: 'email', value: 'a@b.com', raw: null, source: 'ingest_lead', is_primary: false, seen_count: 1 },
    { id: 'bad', type: 'fax', value: '1' },
    { type: 'phone', value: 'no-id' },
  ],
  household: {
    id: 'h1',
    name: 'Smith household',
    members: [
      { customer_id: 'c1', name: 'John Smith', status: 'confirmed', source: 'address', confidence: 75, is_self: true },
      { customer_id: 'c2', name: 'Jane Smith', phone: '555', status: 'suggested', source: 'address', confidence: 75, is_self: false },
      { customer_id: 'c3', name: 'Old Tenant', status: 'rejected', source: 'phone', confidence: 55, is_self: false },
      { customer_id: '', name: 'ghost' },
    ],
  },
  candidates: [{ id: 'm1', other_id: 'c9', other_name: 'Johnny S', score: '82', band: 'review', signals: [{ type: 'phone', weight: 78 }, { type: 'name', weight: 25 }] }],
};

describe('confidenceTone', () => {
  it('mirrors the SQL bands', () => {
    expect(confidenceTone(95)).toBe('high');
    expect(confidenceTone(90)).toBe('high');
    expect(confidenceTone(89)).toBe('medium');
    expect(confidenceTone(60)).toBe('medium');
    expect(confidenceTone(59)).toBe('low');
  });
});

describe('normalizeSignals / describeSignals', () => {
  it('drops unknown or malformed signals', () => {
    expect(normalizeSignals([{ type: 'phone', weight: 78 }, { type: 'dna' }, null, 'x'])).toEqual([{ type: 'phone', weight: 78 }]);
    expect(normalizeSignals(undefined)).toEqual([]);
  });
  it('describes signals for humans', () => {
    expect(describeSignals([{ type: 'phone', weight: 78 }, { type: 'name', weight: 45 }])).toBe('Same phone · Similar name');
    expect(describeSignals([])).toBe('No matching signals');
  });
});

describe('normalizeProfile', () => {
  it('rejects garbage', () => {
    expect(normalizeProfile(null)).toBeNull();
    expect(normalizeProfile([])).toBeNull();
    expect(normalizeProfile({})).toBeNull();
  });
  it('keeps valid keys, members and candidates, drops invalid ones', () => {
    const p = normalizeProfile(profileRaw)!;
    expect(p.keys.map((k) => k.id)).toEqual(['k1', 'k2']);
    expect(p.keys[0].isPrimary).toBe(true);
    expect(p.household?.members.map((m) => m.customerId)).toEqual(['c1', 'c2', 'c3']);
    expect(p.household?.members[0].isSelf).toBe(true);
    expect(p.candidates[0].score).toBe(82);
    expect(p.candidates[0].signals).toHaveLength(2);
  });
  it('tolerates a missing household', () => {
    const p = normalizeProfile({ customer_id: 'c1', keys: [], household: null, candidates: [] })!;
    expect(p.household).toBeNull();
  });
});

describe('groupKeys / displayKey', () => {
  it('groups by type and prefers the raw value', () => {
    const p = normalizeProfile(profileRaw)!;
    const g = groupKeys(p.keys);
    expect(g.phone).toHaveLength(1);
    expect(g.email).toHaveLength(1);
    expect(g.address).toHaveLength(0);
    expect(displayKey(p.keys[0])).toBe('+1 512-555-0123');
    expect(displayKey(p.keys[1])).toBe('a@b.com');
  });
});

describe('buildHouseholdGraph', () => {
  const p = normalizeProfile(profileRaw) as IdentityProfile;
  it('places self in the centre and omits rejected members', () => {
    const g = buildHouseholdGraph('John Smith', p);
    const self = g.nodes.find((n) => n.id === 'self')!;
    expect(self.x).toBe(GRAPH_SIZE.width / 2);
    expect(self.y).toBe(GRAPH_SIZE.height / 2);
    expect(g.nodes.filter((n) => n.kind === 'member').map((n) => n.id)).toEqual(['m:c2']);
    expect(g.nodes.filter((n) => n.kind === 'phone' || n.kind === 'email')).toHaveLength(2);
  });
  it('is deterministic and every edge has both endpoints', () => {
    const a = buildHouseholdGraph('John Smith', p);
    const b = buildHouseholdGraph('John Smith', p);
    expect(a).toEqual(b);
    const ids = new Set(a.nodes.map((n) => n.id));
    for (const e of a.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
  it('marks unconfirmed members as dashed', () => {
    const g = buildHouseholdGraph('John Smith', p);
    expect(g.edges.find((e) => e.to === 'm:c2')?.dashed).toBe(true);
  });
  it('survives an empty profile and keeps nodes inside the canvas', () => {
    const g = buildHouseholdGraph('', { customerId: 'x', keys: [], household: null, candidates: [] });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].label).toBe('Customer');
    const many = normalizeProfile({
      customer_id: 'c1',
      keys: Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, type: 'phone', value: `${i}`.repeat(10) })),
      household: { id: 'h', name: 'H', members: Array.from({ length: 20 }, (_, i) => ({ customer_id: `c${i}`, name: `P${i}`, status: 'suggested', source: 'address', confidence: 75 })) },
      candidates: [],
    })!;
    const big = buildHouseholdGraph('Big', many);
    expect(big.nodes.length).toBeLessThanOrEqual(1 + 8 + 6);
    for (const n of big.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(big.width);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(big.height);
    }
  });
});

describe('candidateToPair', () => {
  const base: IdentityCandidate = {
    id: 'm1', score: 96, band: 'auto_merge', source: 'call', createdAt: '2027-11-02T00:00:00Z',
    signals: [{ type: 'phone', weight: 78 }, { type: 'email', weight: 92 }, { type: 'name', weight: 45 }],
    a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' },
  };
  it('maps to the shape MergeDialog expects', () => {
    const pair = candidateToPair(base);
    expect(pair.kind).toBe('customers');
    expect(pair.key).toBe('a:b');
    expect(pair.reasons).toEqual(['phone', 'email']);
    expect(pair.confidence).toBe('high');
    expect(candidateToPair({ ...base, band: 'review' }).confidence).toBe('medium');
  });
});

describe('toIdentityError', () => {
  it('maps server codes to friendly errors', () => {
    expect(toIdentityError({ message: 'forbidden' }).code).toBe('forbidden');
    expect(toIdentityError({ code: '42501' }).code).toBe('forbidden');
    expect(toIdentityError({ message: 'not_found' }).code).toBe('not_found');
    expect(toIdentityError({ code: 'P0002' }).code).toBe('not_found');
    expect(toIdentityError({ message: 'invalid_threshold' }).code).toBe('invalid');
    const e = toIdentityError({ message: 'boom' });
    expect(e).toBeInstanceOf(IdentityError);
    expect(e.code).toBe('unknown');
    expect(e.message).toBe('boom');
  });
});
