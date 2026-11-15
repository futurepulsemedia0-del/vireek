import { describe, it, expect } from 'vitest';
import { REQUIRED_KEYS } from '../../supabase/functions/_shared/sarah-learn/schema.ts';
import { FIELD_WEIGHTS, computeKnowledge, creditFor, isSnoozed, normalizeWebsite, stageFor, tierFor } from './sarahKnowledge';
import type { LearnField, LearnRun } from '@/pages/onboarding/sarah/sarahLearnLogic';

const run = (over: Partial<LearnRun> = {}): LearnRun => ({
  id: 'r1',
  status: 'interviewing',
  locale: 'en',
  website_url: null,
  started_at: '2030-01-01T00:00:00Z',
  first_draft_at: null,
  readiness_passed: false,
  readiness_score: null,
  test_call_confirmed_at: null,
  live_at: null,
  ...over,
});

const field = (key: string, over: Partial<LearnField> = {}): LearnField => ({
  id: `f-${key}`,
  key,
  value: 'x',
  prev_value: null,
  confidence: 'high',
  assumed: false,
  sensitive: false,
  origin: 'source',
  source_id: null,
  citation: null,
  status: 'approved',
  edit_count: 0,
  ...over,
});

const everything = (over: Partial<LearnField> = {}) => Object.keys(FIELD_WEIGHTS).map((k) => field(k, over));

describe('creditFor', () => {
  it('gives full credit to approved and edited, zero to rejected or missing', () => {
    expect(creditFor(field('hours', { status: 'approved' }))).toBe(1);
    expect(creditFor(field('hours', { status: 'edited' }))).toBe(1);
    expect(creditFor(field('hours', { status: 'rejected' }))).toBe(0);
    expect(creditFor(undefined)).toBe(0);
  });
  it('gives partial credit to pending drafts by confidence and halves assumed ones', () => {
    expect(creditFor(field('hours', { status: 'pending', confidence: 'high' }))).toBeCloseTo(0.6);
    expect(creditFor(field('hours', { status: 'pending', confidence: 'low' }))).toBeCloseTo(0.2);
    expect(creditFor(field('hours', { status: 'pending', confidence: 'high', assumed: true }))).toBeCloseTo(0.3);
  });
});

describe('computeKnowledge', () => {
  it('is empty and "start" without a run', () => {
    const s = computeKnowledge(null, []);
    expect(s.stage).toBe('not_started');
    expect(s.score).toBe(0);
    expect(s.tier).toBe('new');
    expect(s.next).toBe('start');
    expect(s.requiredMissing).toEqual([...REQUIRED_KEYS]);
  });

  it('reaches 100 when every weighted fact is confirmed', () => {
    const s = computeKnowledge(run({ status: 'live', live_at: '2030-01-02T00:00:00Z' }), everything());
    expect(s.score).toBe(100);
    expect(s.tier).toBe('expert');
    expect(s.gaps).toHaveLength(0);
    expect(s.requiredMissing).toHaveLength(0);
    expect(s.next).toBe('maintain');
  });

  it('is monotonic: confirming a pending field never lowers the score', () => {
    const pending = everything({ status: 'pending', confidence: 'medium' });
    const before = computeKnowledge(run(), pending).score;
    const confirmed = pending.map((f, i) => (i === 0 ? { ...f, status: 'approved' as const } : f));
    expect(computeKnowledge(run(), confirmed).score).toBeGreaterThanOrEqual(before);
  });

  it('ranks gaps by impact and is deterministic', () => {
    const fields = [field('business_name'), field('hours', { status: 'pending', confidence: 'low' })];
    const a = computeKnowledge(run(), fields).gaps.map((g) => g.key);
    const b = computeKnowledge(run(), [...fields].reverse()).gaps.map((g) => g.key);
    expect(a).toEqual(b);
    expect(a[0]).toBe('services_offered');
    const w = computeKnowledge(run(), fields).gaps.map((g) => g.impact);
    expect([...w].sort((x, y) => y - x)).toEqual(w);
  });

  it('classifies gap reasons', () => {
    const fields = [
      field('hours', { status: 'pending' }),
      field('emergency_policy', { status: 'pending', sensitive: true }),
      field('faqs', { status: 'rejected' }),
    ];
    const gaps = new Map(computeKnowledge(run(), fields).gaps.map((g) => [g.key, g.reason]));
    expect(gaps.get('hours')).toBe('unconfirmed');
    expect(gaps.get('emergency_policy')).toBe('sensitive_pending');
    expect(gaps.get('faqs')).toBe('missing');
    expect(gaps.get('services_offered')).toBe('missing');
  });

  it('reports the same go-live blockers the server enforces', () => {
    const s = computeKnowledge(run({ status: 'review' }), [
      field('business_name'),
      field('services_offered', { status: 'pending' }),
      field('pricing_signals', { status: 'pending', sensitive: true }),
    ]);
    expect(s.requiredMissing).toContain('services_offered');
    expect(s.requiredMissing).toContain('service_area');
    expect(s.requiredMissing).not.toContain('business_name');
    expect(s.sensitivePending).toBe(1);
    expect(s.pendingReview).toBe(1);
    expect(s.next).toBe('review');
  });

  it('computes per-group coverage in a fixed order', () => {
    const s = computeKnowledge(run(), everything());
    expect(s.groups.map((g) => g.group)).toEqual(['basics', 'services', 'hours_area', 'pricing', 'trust', 'voice', 'faq']);
    expect(s.groups.every((g) => g.score === 100 && g.known === g.total)).toBe(true);
  });

  it('ignores unknown keys instead of throwing', () => {
    const s = computeKnowledge(run(), [field('totally_unknown_key')]);
    expect(s.score).toBe(0);
  });
});

describe('stageFor / next action', () => {
  it('maps run status to stage', () => {
    expect(stageFor(null)).toBe('not_started');
    expect(stageFor(run({ status: 'failed' }))).toBe('not_started');
    expect(stageFor(run({ status: 'sourcing' }))).toBe('learning');
    expect(stageFor(run({ status: 'drafted' }))).toBe('learning');
    expect(stageFor(run({ status: 'interviewing' }))).toBe('learning');
    expect(stageFor(run({ status: 'review' }))).toBe('review');
    expect(stageFor(run({ status: 'readiness' }))).toBe('ready_to_test');
    expect(stageFor(run({ status: 'ready' }))).toBe('ready_to_test');
    expect(stageFor(run({ status: 'live' }))).toBe('live');
  });
  it('asks for the test call first, then go-live', () => {
    expect(computeKnowledge(run({ status: 'ready', readiness_passed: true }), everything()).next).toBe('test');
    expect(computeKnowledge(run({ status: 'ready', readiness_passed: true, test_call_confirmed_at: '2030-01-01T00:00:00Z' }), everything()).next).toBe('go_live');
  });
});

describe('tierFor', () => {
  it('has stable boundaries', () => {
    expect([0, 34, 35, 69, 70, 89, 90, 100].map(tierFor)).toEqual(['new', 'new', 'learning', 'learning', 'confident', 'confident', 'expert', 'expert']);
  });
});

describe('isSnoozed', () => {
  it('only honours a valid, future timestamp', () => {
    expect(isSnoozed(null, 1000)).toBe(false);
    expect(isSnoozed('abc', 1000)).toBe(false);
    expect(isSnoozed('999', 1000)).toBe(false);
    expect(isSnoozed('1001', 1000)).toBe(true);
  });
});

describe('normalizeWebsite', () => {
  it('adds https and rejects unsafe or malformed input', () => {
    expect(normalizeWebsite('acme-plumbing.com')).toBe('https://acme-plumbing.com/');
    expect(normalizeWebsite('http://acme.com/about')).toBe('http://acme.com/about');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('ftp://acme.com')).toBeNull();
    expect(normalizeWebsite('https://user:pw@acme.com')).toBeNull();
    expect(normalizeWebsite('localhost')).toBeNull();
    expect(normalizeWebsite('not a url')).toBeNull();
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite(`https://acme.com/${'a'.repeat(600)}`)).toBeNull();
  });
});
