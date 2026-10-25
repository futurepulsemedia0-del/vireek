import { describe, it, expect } from 'vitest';
import { computeHealth } from '../../supabase/functions/_shared/staff/accountExplorer';
import type { AccountSignals } from '../../supabase/functions/_shared/staff/accountExplorer';
import {
  PLAYBOOKS,
  buildNudges,
  buildStaffSuccessRows,
  classifyFeature,
  computeAdoption,
  computeSuccessRisk,
  deriveSuccessView,
  isStateHiding,
  isValidNpsScore,
  nudgeKey,
  npsCategory,
  parseSnapshot,
  parseStaffOverview,
  pickActivePlaybook,
  playbookProgress,
  stepKey,
  summarizeNps,
} from './successTools';
import type { CatalogFeature, FeatureUsage, ItemState, StaffSuccessData } from './successTools';

const NOW = new Date('2026-10-24T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const feat = (key: string, over: Partial<CatalogFeature> = {}): CatalogFeature => ({
  key,
  label: key.replace(/_/g, ' '),
  tier: 'high_value',
  kind: 'setup',
  weight: 5,
  measured: true,
  ...over,
});
const use = (total: number, recent = total): FeatureUsage => ({ total, recent, lastAt: total ? daysAgo(1) : null });

const CATALOG: CatalogFeature[] = [
  feat('ai_calls', { tier: 'core', kind: 'activity', weight: 14 }),
  feat('jobs', { tier: 'core', kind: 'activity', weight: 8 }),
  feat('call_scripts', { weight: 6 }),
  feat('agreements', { kind: 'activity', weight: 8 }),
  feat('email_campaigns', { kind: 'activity', weight: 5 }),
];

describe('classifyFeature', () => {
  it('maps usage to a status', () => {
    expect(classifyFeature(feat('x', { kind: 'activity' }), use(3, 2))).toBe('active');
    expect(classifyFeature(feat('x', { kind: 'activity' }), use(3, 0))).toBe('lapsed');
    expect(classifyFeature(feat('x', { kind: 'setup' }), use(3, 0))).toBe('active');
    expect(classifyFeature(feat('x'), use(0))).toBe('unused');
    expect(classifyFeature(feat('x', { measured: false }), use(9))).toBe('unmeasured');
  });
});

describe('computeAdoption', () => {
  it('weights features, gives lapsed half credit and ignores unmeasured ones', () => {
    const r = computeAdoption(CATALOG, {
      ai_calls: use(40, 20),
      jobs: use(5, 0), // lapsed -> 0.5
      call_scripts: use(1, 0), // setup -> active
    });
    // credit = 14 + 4 + 6 = 24 of 41
    expect(r.score).toBe(Math.round((24 / 41) * 100));
    expect(r.counts).toEqual({ active: 2, lapsed: 1, unused: 2, unmeasured: 0 });
    expect(r.level).toBe('growing');
    expect(r.coreScore).toBe(Math.round((18 / 22) * 100));
    expect(r.highValueScore).toBe(Math.round((6 / 19) * 100));

    const withUnmeasured = computeAdoption([...CATALOG, feat('ghost', { weight: 20, measured: false })], { ai_calls: use(1) });
    expect(withUnmeasured.counts.unmeasured).toBe(1);
    expect(withUnmeasured.score).toBe(Math.round((14 / 41) * 100));
  });

  it('returns null / unknown when nothing is measurable', () => {
    const r = computeAdoption([feat('a', { measured: false })], {});
    expect(r.score).toBeNull();
    expect(r.level).toBe('unknown');
    expect(computeAdoption([], {}).score).toBeNull();
  });

  it('scores 100 when everything is in use and 0 when nothing is', () => {
    const all = Object.fromEntries(CATALOG.map((f) => [f.key, use(5, 5)]));
    expect(computeAdoption(CATALOG, all).score).toBe(100);
    expect(computeAdoption(CATALOG, {}).score).toBe(0);
    expect(computeAdoption(CATALOG, {}).level).toBe('minimal');
  });
});

describe('state helpers', () => {
  it('hides dismissed, skipped and still-snoozed items only', () => {
    expect(isStateHiding(undefined, NOW)).toBe(false);
    expect(isStateHiding({ status: 'dismissed', snoozedUntil: null }, NOW)).toBe(true);
    expect(isStateHiding({ status: 'skipped', snoozedUntil: null }, NOW)).toBe(true);
    expect(isStateHiding({ status: 'snoozed', snoozedUntil: daysAgo(-3) }, NOW)).toBe(true);
    expect(isStateHiding({ status: 'snoozed', snoozedUntil: daysAgo(1) }, NOW)).toBe(false);
  });
});

describe('playbooks', () => {
  const adoption = computeAdoption(
    [
      feat('phone_numbers', { tier: 'core', weight: 6 }),
      feat('call_scripts'),
      feat('call_routing'),
      feat('ai_calls', { tier: 'core', kind: 'activity', weight: 14 }),
    ],
    { phone_numbers: use(1), call_scripts: use(0) },
  );
  const def = PLAYBOOKS[0];

  it('derives step status from real usage and points at the next step', () => {
    const p = playbookProgress(def, adoption.items);
    expect(p.steps.map((s) => s.status)).toEqual(['done', 'todo', 'todo', 'todo']);
    expect(p.done).toBe(1);
    expect(p.total).toBe(4);
    expect(p.pct).toBe(25);
    expect(p.next?.id).toBe('scripts');
    expect(p.complete).toBe(false);
    expect(p.minutesLeft).toBe(10 + 8 + 5);
  });

  it('excludes skipped and unmeasured steps from the total', () => {
    const states: Record<string, ItemState> = { [stepKey(def.id, 'scripts')]: { status: 'skipped', snoozedUntil: null } };
    const p = playbookProgress(def, adoption.items, states);
    expect(p.steps[1].status).toBe('skipped');
    expect(p.total).toBe(3);
    expect(p.next?.id).toBe('routing');

    const none = playbookProgress(PLAYBOOKS[1], adoption.items); // none of its features exist -> all unknown
    expect(none.steps.every((s) => s.status === 'unknown')).toBe(true);
    expect(none.total).toBe(0);
    expect(none.complete).toBe(false);
    expect(none.next).toBeNull();
  });

  it('marks a playbook complete when every counted step is done and picks the furthest-along open one', () => {
    const all = computeAdoption(
      [feat('phone_numbers'), feat('call_scripts'), feat('call_routing'), feat('ai_calls', { kind: 'activity' })],
      { phone_numbers: use(1), call_scripts: use(1), call_routing: use(1), ai_calls: use(2, 1) },
    );
    expect(playbookProgress(def, all.items).complete).toBe(true);

    const progress = PLAYBOOKS.map((d) => playbookProgress(d, adoption.items));
    expect(pickActivePlaybook(progress)?.def.id).toBe('launch_ai_receptionist');
    expect(pickActivePlaybook([])).toBeNull();
  });
});

describe('buildNudges', () => {
  const items = computeAdoption(CATALOG, { ai_calls: use(30, 10), jobs: use(4, 0) }).items;
  const ctx = { accountAgeDays: 40, now: NOW };

  it('nudges unused high-value features and lapsed core features, biggest value first', () => {
    const n = buildNudges(items, {}, ctx);
    expect(n.map((x) => x.featureKey)).toEqual(['jobs', 'agreements', 'call_scripts']);
    expect(n[0].kind).toBe('lapsed');
    expect(n[1].kind).toBe('unused');
    expect(n.every((x) => x.href.startsWith('/dashboard/'))).toBe(true);
  });

  it('respects dismiss / snooze, the cap and the focus boost', () => {
    const states: Record<string, ItemState> = {
      [nudgeKey('jobs')]: { status: 'dismissed', snoozedUntil: null },
      [nudgeKey('agreements')]: { status: 'snoozed', snoozedUntil: daysAgo(-5) },
    };
    expect(buildNudges(items, states, ctx).map((x) => x.featureKey)).toEqual(['call_scripts', 'email_campaigns']);
    expect(buildNudges(items, {}, { ...ctx, max: 1 })).toHaveLength(1);
    const plain = buildNudges(items, {}, { ...ctx, max: 10 }).map((x) => x.featureKey);
    const boosted = buildNudges(items, {}, { ...ctx, max: 10, focusFeatureKeys: new Set(['email_campaigns']) }).map((x) => x.featureKey);
    expect(plain.indexOf('email_campaigns')).toBeGreaterThanOrEqual(plain.indexOf('agreements'));
    expect(boosted.indexOf('email_campaigns')).toBeLessThanOrEqual(boosted.indexOf('agreements'));
  });

  it('stays quiet for brand-new or not-yet-activated accounts', () => {
    expect(buildNudges(items, {}, { ...ctx, accountAgeDays: 3 })).toEqual([]);
    const idle = computeAdoption(CATALOG, {}).items;
    expect(buildNudges(idle, {}, ctx)).toEqual([]);
  });
});

describe('deriveSuccessView', () => {
  it('ties the pieces together from a snapshot', () => {
    const snap = parseSnapshot({
      account_created_at: daysAgo(60),
      nps_due: true,
      features: [
        { key: 'ai_calls', label: 'AI call handling', tier: 'core', kind: 'activity', weight: 14, measured: true, total: 20, recent: 9, last_at: daysAgo(1) },
        { key: 'call_scripts', label: 'Custom call scripts', tier: 'high_value', kind: 'setup', weight: 6, measured: true, total: 0, recent: 0, last_at: null },
      ],
      states: [{ key: nudgeKey('team'), status: 'dismissed', snoozed_until: null }, { key: 'bad', status: 'weird' }],
    });
    expect(snap.npsDue).toBe(true);
    expect(Object.keys(snap.states)).toEqual([nudgeKey('team')]);
    const v = deriveSuccessView(snap, NOW);
    expect(v.ageDays).toBe(60);
    expect(v.adoption.score).toBe(70);
    expect(v.nudges.map((n) => n.featureKey)).toEqual(['call_scripts']);
  });

  it('survives garbage input', () => {
    const s = parseSnapshot(null);
    expect(s.features).toEqual([]);
    expect(deriveSuccessView(s, NOW).adoption.score).toBeNull();
    expect(parseStaffOverview(undefined).catalog).toEqual([]);
  });
});

describe('NPS maths', () => {
  it('categorizes and summarizes', () => {
    expect([0, 6, 7, 8, 9, 10].map(npsCategory)).toEqual(['detractor', 'detractor', 'passive', 'passive', 'promoter', 'promoter']);
    expect(summarizeNps({ promoters: 6, passives: 2, detractors: 2 })).toEqual({ promoters: 6, passives: 2, detractors: 2, responses: 10, score: 40 });
    expect(summarizeNps({ promoters: 0, passives: 0, detractors: 0 }).score).toBeNull();
    expect(summarizeNps({ promoters: 0, passives: 0, detractors: 3 }).score).toBe(-100);
  });

  it('validates scores strictly', () => {
    expect([0, 5, 10].every(isValidNpsScore)).toBe(true);
    expect([-1, 11, 4.5, NaN, '7', null, undefined].some(isValidNpsScore)).toBe(false);
  });
});

// ---- staff risk (layers on the REAL computeHealth) -------------------------

const signals = (over: Partial<AccountSignals> = {}): AccountSignals => ({
  id: 'a1',
  status: 'active',
  subscriptionStatus: 'active',
  dunningStage: 0,
  onboardingCompleted: true,
  minutesUsed: 300,
  minutesIncluded: 500,
  createdAt: daysAgo(200),
  lastSignInAt: daysAgo(1),
  lastCallAt: daysAgo(1),
  calls30d: 60,
  callsPrev30d: 50,
  bookings30d: 20,
  teamCount: 3,
  numbersCount: 2,
  ...over,
});
const healthy = computeHealth(signals(), NOW);
const quiet = computeHealth(signals({ lastCallAt: daysAgo(40), calls30d: 0, callsPrev30d: 30, bookings30d: 0, minutesUsed: 10 }), NOW);
const adoptionOf = (u: Record<string, FeatureUsage>) => computeAdoption(CATALOG, u);

describe('computeSuccessRisk', () => {
  it('rates a healthy, well-adopted, promoter account low risk', () => {
    const everything = Object.fromEntries(CATALOG.map((f) => [f.key, use(5)]));
    const r = computeSuccessRisk({ health: healthy, adoption: adoptionOf(everything), nps: { score: 10, comment: null, at: daysAgo(10) }, ageDays: 200, now: NOW });
    expect(r.level).toBe('low');
    expect(r.score).toBe(100);
    expect(r.reasons).toEqual([]);
    expect(r.action).toBe('No action needed.');
  });

  it('flags a quiet account with low adoption and explains why, reusing health factor details', () => {
    const r = computeSuccessRisk({ health: quiet, adoption: adoptionOf({}), nps: null, ageDays: 200, now: NOW });
    expect(r.level).toBe('high');
    expect(r.reasons.some((x) => x.text.startsWith('Recent activity:'))).toBe(true);
    expect(r.reasons.some((x) => x.text.includes('Feature adoption is 0%'))).toBe(true);
    expect(r.reasons[0].severity).toBe('high');
    expect(r.reasons.length).toBeLessThanOrEqual(5);
  });

  it('escalates on a fresh detractor even when usage looks fine, and ignores stale NPS', () => {
    const adoption = adoptionOf(Object.fromEntries(CATALOG.map((f) => [f.key, use(5)])));
    const detractor = computeSuccessRisk({ health: healthy, adoption, nps: { score: 2, comment: 'Calls drop out\nconstantly', at: daysAgo(5) }, ageDays: 200, now: NOW });
    expect(detractor.level).toBe('medium');
    expect(detractor.reasons[0].text).toBe('NPS detractor (2/10) — “Calls drop out constantly”');
    expect(detractor.action).toMatch(/Call within 2 business days/);

    const stale = computeSuccessRisk({ health: healthy, adoption, nps: { score: 2, comment: null, at: daysAgo(200) }, ageDays: 200, now: NOW });
    expect(stale.level).toBe('low');
  });

  it('puts billing first and handles new / churned / suspended accounts', () => {
    const pastDue = computeHealth(signals({ subscriptionStatus: 'past_due', dunningStage: 3 }), NOW);
    expect(computeSuccessRisk({ health: pastDue, adoption: null, nps: null, ageDays: 200, now: NOW }).action).toMatch(/billing/);

    const fresh = computeHealth(signals({ createdAt: daysAgo(2), lastCallAt: null, calls30d: 0, callsPrev30d: 0 }), NOW);
    expect(computeSuccessRisk({ health: fresh, adoption: null, nps: null, ageDays: 2, now: NOW }).level).toBe('new');

    const churned = computeHealth(signals({ status: 'canceled' }), NOW);
    expect(computeSuccessRisk({ health: churned, adoption: null, nps: null, ageDays: 200, now: NOW }).level).toBe('churned');

    const suspended = computeHealth(signals({ status: 'suspended' }), NOW);
    expect(computeSuccessRisk({ health: suspended, adoption: null, nps: null, ageDays: 200, now: NOW }).level).toBe('high');
  });

  it('renormalizes when adoption is not measurable', () => {
    const r = computeSuccessRisk({ health: healthy, adoption: computeAdoption([], {}), nps: null, ageDays: 200, now: NOW });
    expect(r.score).toBe(healthy.score);
    expect(r.level).toBe('low');
  });

  it('treats adoption stalled for 30+ days as at least medium', () => {
    const a = computeAdoption(CATALOG, { ai_calls: use(5, 5) }); // 14/41 = 34 -> not stalled
    const lowAdoption = computeAdoption(CATALOG, { email_campaigns: use(1, 1) }); // 5/41 = 12
    expect(computeSuccessRisk({ health: healthy, adoption: lowAdoption, nps: null, ageDays: 90, now: NOW }).level).toBe('medium');
    expect(computeSuccessRisk({ health: healthy, adoption: lowAdoption, nps: null, ageDays: 10, now: NOW }).level).not.toBe('high');
    expect(a.score).toBe(34);
  });
});

describe('buildStaffSuccessRows', () => {
  const data: StaffSuccessData = {
    catalog: CATALOG,
    usageByAccount: {
      good: Object.fromEntries(CATALOG.map((f) => [f.key, use(5)])),
    },
    npsLatest: {},
    nps: { ...summarizeNps({ promoters: 0, passives: 0, detractors: 0 }), days: 90 },
  };
  const acct = (id: string, name: string | null, health: ReturnType<typeof computeHealth>, createdAt = daysAgo(200)) => ({
    id, companyName: name, email: `${id}@x.com`, plan: 'pro', createdAt, health,
  });

  it('sorts highest risk first and falls back to the email as label', () => {
    const rows = buildStaffSuccessRows(
      [acct('good', 'Good Co', healthy), acct('bad', null, quiet), acct('gone', 'Gone', computeHealth(signals({ status: 'canceled' }), NOW))],
      data,
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['bad', 'good', 'gone']);
    expect(rows[0].label).toBe('bad@x.com');
    expect(rows[1].risk.level).toBe('low');
  });
});

describe('parseStaffOverview', () => {
  it('groups compact usage rows per account and picks the NPS summary', () => {
    const d = parseStaffOverview({
      catalog: [{ key: 'ai_calls', label: 'AI', tier: 'core', kind: 'activity', weight: 14, measured: true }],
      usage: [{ a: 'x', k: 'ai_calls', t: 5, r: 2, l: daysAgo(1) }, { a: '', k: 'bad', t: 1 }],
      nps: { days: 90, promoters: 3, passives: 1, detractors: 0 },
      nps_latest: [{ a: 'x', score: 9, comment: 'great', at: daysAgo(3) }],
    });
    expect(d.usageByAccount.x.ai_calls).toEqual({ total: 5, recent: 2, lastAt: expect.any(String) });
    expect(Object.keys(d.usageByAccount)).toEqual(['x']);
    expect(d.nps.score).toBe(75);
    expect(d.npsLatest.x.comment).toBe('great');
  });
});
