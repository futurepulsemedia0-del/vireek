import { describe, it, expect } from 'vitest';
import {
  STEPS, buildChecklist, isProfileComplete, isVisibleTo, sanitizeSkipped, summarize,
  type Signals, type StepKey,
} from './gettingStarted';

const none = Object.fromEntries(STEPS.map((s) => [s.key, false])) as Signals;
const owner = { isOwner: true, permissions: {} };
const member = { isOwner: false, permissions: {} };
const withDone = (...keys: StepKey[]): Signals => ({ ...none, ...Object.fromEntries(keys.map((k) => [k, true])) });
const statusOf = (steps: ReturnType<typeof buildChecklist>, key: StepKey) => steps.find((s) => s.key === key)?.status;

describe('isProfileComplete', () => {
  const hours = { mon: { open: '08:00', close: '17:00' } };
  it('needs hours plus services or service area', () => {
    expect(isProfileComplete(null)).toBe(false);
    expect(isProfileComplete({ business_hours: hours, services_offered: [], service_area: null })).toBe(false);
    expect(isProfileComplete({ business_hours: hours, services_offered: ['HVAC'], service_area: null })).toBe(true);
    expect(isProfileComplete({ business_hours: hours, services_offered: null, service_area: 'Austin, TX' })).toBe(true);
    expect(isProfileComplete({ business_hours: {}, services_offered: ['HVAC'], service_area: 'x' })).toBe(false);
  });
  it('ignores whitespace-only values', () => {
    expect(isProfileComplete({ business_hours: hours, services_offered: ['  '], service_area: '   ' })).toBe(false);
  });
});

describe('visibility', () => {
  it('owner sees every step', () => {
    expect(buildChecklist(none, [], owner)).toHaveLength(STEPS.length);
  });
  it('hides owner-only and permission-gated steps from members', () => {
    const keys = buildChecklist(none, [], member).map((s) => s.key);
    for (const hidden of ['phone_number', 'price_book', 'quote', 'team', 'invoice', 'business_profile'] as StepKey[]) {
      expect(keys).not.toContain(hidden);
    }
    expect(keys).toContain('customer');
  });
  it('grants permission-gated steps when the member has the permission', () => {
    const team = STEPS.find((s) => s.key === 'team')!;
    expect(isVisibleTo(team, { isOwner: false, permissions: { can_manage_team: true } })).toBe(true);
  });
});

describe('buildChecklist status rules', () => {
  it('detected completion wins over a skip', () => {
    expect(statusOf(buildChecklist(withDone('team'), ['team'], owner), 'team')).toBe('done');
  });
  it('skips only apply to skippable steps', () => {
    const steps = buildChecklist(none, ['team', 'customer'], owner);
    expect(statusOf(steps, 'team')).toBe('skipped');
    expect(statusOf(steps, 'customer')).toBe('todo');
  });
  it('never guesses: an unchecked source is unknown, not todo', () => {
    expect(statusOf(buildChecklist({ ...none, job: null }, [], owner), 'job')).toBe('unknown');
  });
});

describe('summarize', () => {
  it('starts at 0% with the first todo as next', () => {
    const s = summarize(buildChecklist(none, [], owner));
    expect(s).toMatchObject({ done: 0, pct: 0, complete: false });
    expect(s.next?.key).toBe('business_profile');
  });
  it('skipped steps do not inflate the percentage but do allow completion', () => {
    const skippable = STEPS.filter((x) => x.skippable).map((x) => x.key);
    const required = STEPS.filter((x) => !x.skippable).map((x) => x.key);
    const s = summarize(buildChecklist(withDone(...required), skippable, owner));
    expect(s.complete).toBe(true);
    expect(s.pct).toBe(Math.round((required.length / STEPS.length) * 100));
    expect(s.next).toBeNull();
  });
  it('is not complete while any step is unknown', () => {
    const all = withDone(...STEPS.map((x) => x.key));
    expect(summarize(buildChecklist({ ...all, job: null }, [], owner)).complete).toBe(false);
  });
  it('handles an empty checklist', () => {
    expect(summarize([])).toMatchObject({ total: 0, pct: 0, complete: false, next: null });
  });
});

describe('sanitizeSkipped', () => {
  it('drops junk, duplicates and non-skippable keys', () => {
    expect(sanitizeSkipped(['team', 'team', 'customer', 'nope', 7])).toEqual(['team']);
    expect(sanitizeSkipped(null)).toEqual([]);
  });
});
