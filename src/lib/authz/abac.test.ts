import { describe, it, expect } from 'vitest';
import {
  decide,
  maskRecord,
  whatCanSee,
  whoCanSee,
  type AbacPolicy,
  type AclEntry,
  type FieldMaskRule,
  type PrincipalAttrs,
  type RecordAttrs,
} from './abac';

const NOW = '2026-11-05T09:00:00.000Z';
const LATER = '2026-11-06T09:00:00.000Z';
const EARLIER = '2026-11-04T09:00:00.000Z';

const principal = (over: Partial<PrincipalAttrs> = {}): PrincipalAttrs => ({
  userId: 'u1', isOwner: false, locationIds: [], teamIds: [], clearances: [], ...over,
});
const rec = (over: Partial<RecordAttrs> = {}): RecordAttrs => ({
  resource: 'jobs', recordId: 'j1', locationId: 'L1', teamId: 'T1', valueCents: 10_000, sensitivityTags: [], ...over,
});
const pol = (over: Partial<AbacPolicy> = {}): AbacPolicy => ({
  id: 'p1', resource: 'jobs', actions: ['select'], enabled: true, appliesMinValueCents: null, appliesTags: [],
  requireLocationMatch: false, requireTeamMatch: false, requireClearance: null, ...over,
});
const ctx = (over: Partial<{ policies: AbacPolicy[]; acl: AclEntry[]; baseAllowed: boolean }> = {}) => ({
  policies: [], acl: [], baseAllowed: true, now: NOW, ...over,
});

describe('base behavior', () => {
  it('defers to the base decision when no policy or ACL applies', () => {
    expect(decide(principal(), rec(), 'select', ctx())).toEqual({ allowed: true, reason: 'base_allowed', policyId: null });
    expect(decide(principal(), rec(), 'select', ctx({ baseAllowed: false }))).toEqual({ allowed: false, reason: 'base_denied', policyId: null });
  });
  it('owners always pass, even against deny ACLs and policies', () => {
    const acl: AclEntry[] = [{ resource: 'jobs', recordId: 'j1', userId: 'u1', effect: 'deny', actions: ['select'], expiresAt: null }];
    const d = decide(principal({ isOwner: true }), rec(), 'select', ctx({ acl, policies: [pol({ requireClearance: 'x' })] }));
    expect(d.reason).toBe('owner');
  });
});

describe('location / team policies', () => {
  it('restricted principals only see matching locations; unrestricted principals see all', () => {
    const p = [pol({ requireLocationMatch: true })];
    expect(decide(principal({ locationIds: ['L1'] }), rec(), 'select', ctx({ policies: p })).allowed).toBe(true);
    const denied = decide(principal({ locationIds: ['L2'] }), rec(), 'select', ctx({ policies: p }));
    expect(denied).toEqual({ allowed: false, reason: 'policy_location', policyId: 'p1' });
    expect(decide(principal(), rec(), 'select', ctx({ policies: p })).allowed).toBe(true);
  });
  it('fails closed when a restricted principal meets a record with no location or team', () => {
    expect(decide(principal({ locationIds: ['L1'] }), rec({ locationId: null }), 'select', ctx({ policies: [pol({ requireLocationMatch: true })] })).allowed).toBe(false);
    expect(decide(principal({ teamIds: ['T1'] }), rec({ teamId: null }), 'select', ctx({ policies: [pol({ requireTeamMatch: true })] })).reason).toBe('policy_team');
    expect(decide(principal(), rec({ locationId: null }), 'select', ctx({ policies: [pol({ requireLocationMatch: true })] })).allowed).toBe(true);
  });
});

describe('applicability: job value and sensitivity tags', () => {
  const high = pol({ id: 'hv', appliesMinValueCents: 5_000_000, requireClearance: 'high_value' });
  const conf = pol({ id: 'conf', appliesTags: ['confidential', 'legal'], requireClearance: 'confidential' });
  it('only applies value policies at or above the threshold, and null value never applies', () => {
    expect(decide(principal(), rec({ valueCents: 4_999_999 }), 'select', ctx({ policies: [high] })).allowed).toBe(true);
    expect(decide(principal(), rec({ valueCents: 5_000_000 }), 'select', ctx({ policies: [high] })).reason).toBe('policy_clearance');
    expect(decide(principal(), rec({ valueCents: null }), 'select', ctx({ policies: [high] })).allowed).toBe(true);
    expect(decide(principal({ clearances: ['high_value'] }), rec({ valueCents: 9_000_000 }), 'select', ctx({ policies: [high] })).allowed).toBe(true);
  });
  it('applies tag policies when any tag intersects', () => {
    expect(decide(principal(), rec({ sensitivityTags: ['legal'] }), 'select', ctx({ policies: [conf] })).policyId).toBe('conf');
    expect(decide(principal(), rec({ sensitivityTags: ['other'] }), 'select', ctx({ policies: [conf] })).allowed).toBe(true);
  });
  it('requires ALL applicable policies to pass and reports the first failing one deterministically', () => {
    const both = ctx({ policies: [conf, high] });
    const r = rec({ valueCents: 6_000_000, sensitivityTags: ['legal'] });
    expect(decide(principal({ clearances: ['confidential'] }), r, 'select', both).policyId).toBe('hv');
    expect(decide(principal({ clearances: ['confidential', 'high_value'] }), r, 'select', both).allowed).toBe(true);
  });
  it('ignores disabled policies, other resources and other actions', () => {
    const base = { requireClearance: 'x' };
    expect(decide(principal(), rec(), 'select', ctx({ policies: [pol({ ...base, enabled: false })] })).allowed).toBe(true);
    expect(decide(principal(), rec(), 'select', ctx({ policies: [pol({ ...base, resource: 'quotes' })] })).allowed).toBe(true);
    expect(decide(principal(), rec(), 'update', ctx({ policies: [pol({ ...base })] })).allowed).toBe(true);
  });
});

describe('record ACL overrides', () => {
  const entry = (over: Partial<AclEntry>): AclEntry => ({ resource: 'jobs', recordId: 'j1', userId: 'u1', effect: 'allow', actions: ['select'], expiresAt: null, ...over });
  const strict = pol({ requireClearance: 'x' });
  it('explicit allow beats policy denial; explicit deny beats everything but owner', () => {
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({})] })).reason).toBe('acl_allow');
    expect(decide(principal(), rec(), 'select', ctx({ acl: [entry({ effect: 'deny' })] })).reason).toBe('acl_deny');
    expect(decide(principal(), rec(), 'select', ctx({ acl: [entry({}), entry({ effect: 'deny' })] })).reason).toBe('acl_deny');
  });
  it('honors expiry, user, record and action scoping', () => {
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({ expiresAt: EARLIER })] })).allowed).toBe(false);
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({ expiresAt: LATER })] })).allowed).toBe(true);
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({ userId: 'u2' })] })).allowed).toBe(false);
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({ recordId: 'j2' })] })).allowed).toBe(false);
    expect(decide(principal(), rec(), 'select', ctx({ policies: [strict], acl: [entry({ actions: ['update'] })] })).allowed).toBe(false);
  });
});

describe('field masking', () => {
  const rules: FieldMaskRule[] = [
    { resource: 'jobs', field: 'cost_cents', strategy: 'redact', exemptClearance: 'finance' },
    { resource: 'jobs', field: 'margin_pct', strategy: 'null', exemptClearance: 'finance' },
    { resource: 'customers', field: 'phone', strategy: 'partial', exemptClearance: null },
  ];
  const row = { id: 'j1', cost_cents: 12_345, margin_pct: 31.5, title: 'AC swap' };
  it('masks by strategy, preserves other fields, and does not mutate the row', () => {
    const out = maskRecord(row, 'jobs', principal(), rules);
    expect(out).toEqual({ id: 'j1', cost_cents: 0, margin_pct: null, title: 'AC swap' });
    expect(row.cost_cents).toBe(12_345);
  });
  it('partial masking keeps only the last four characters; short values are fully masked', () => {
    expect(maskRecord({ phone: '+4915112345678' }, 'customers', principal(), rules).phone).toBe('••••••••••5678');
    expect(maskRecord({ phone: '123' }, 'customers', principal(), rules).phone).toBe('•••');
  });
  it('exempts owners and holders of the exempt clearance, and leaves other resources and null values alone', () => {
    expect(maskRecord(row, 'jobs', principal({ isOwner: true }), rules)).toEqual(row);
    expect(maskRecord(row, 'jobs', principal({ clearances: ['finance'] }), rules)).toEqual(row);
    expect(maskRecord(row, 'quotes', principal(), rules)).toEqual(row);
    expect(maskRecord({ cost_cents: null }, 'jobs', principal(), rules)).toEqual({ cost_cents: null });
  });
});

describe('policy simulation', () => {
  const policies = [pol({ requireLocationMatch: true })];
  it('whoCanSee lists each principal with the reason', () => {
    const res = whoCanSee(rec(), [principal({ userId: 'a', locationIds: ['L1'] }), principal({ userId: 'b', locationIds: ['L2'] }), principal({ userId: 'c', isOwner: true })],
      { policies, acl: [], baseAllowed: () => true, now: NOW });
    expect(res.map((r) => [r.userId, r.decision.allowed, r.decision.reason])).toEqual([
      ['a', true, 'base_allowed'], ['b', false, 'policy_location'], ['c', true, 'owner'],
    ]);
  });
  it('whatCanSee evaluates every record for one person', () => {
    const res = whatCanSee(principal({ locationIds: ['L1'] }), [rec({ recordId: 'a' }), rec({ recordId: 'b', locationId: 'L9' })], { policies, acl: [], baseAllowed: true, now: NOW });
    expect(res.map((r) => [r.recordId, r.decision.allowed])).toEqual([['a', true], ['b', false]]);
  });
});
