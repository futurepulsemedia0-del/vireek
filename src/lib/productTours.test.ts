import { describe, expect, it } from 'vitest';
import {
  TIPS, TOURS, beginRecord, clampStep, computeCardPosition, decideAutoStart, describeStatus, finishRecord,
  mergeRecords, moveRecord, normalizePath, reconcileLegacy, resolveTourRole, tipCopy, tipRecord, visibleSteps,
  type AutoStartInput, type TourRecord,
} from './productTours';

const NOW = '2026-10-18T10:00:00.000Z';
const LATER = '2026-10-18T11:00:00.000Z';

const rec = (over: Partial<TourRecord> = {}): TourRecord => ({
  tourId: 'owner', version: 1, status: 'in_progress', stepIndex: 0,
  startedAt: NOW, completedAt: null, skippedAt: null, replayCount: 0, updatedAt: NOW, ...over,
});

describe('tour definitions', () => {
  it.each(Object.entries(TOURS))('%s tour is well-formed', (key, tour) => {
    expect(tour.id).toBe(key);
    const ids = tour.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('welcome');
    expect(ids[ids.length - 1]).toBe('replay');
    for (const s of tour.steps) {
      expect(s.title.trim()).not.toBe('');
      expect(s.body.trim()).not.toBe('');
      for (const sel of s.targets ?? []) expect(() => document.querySelectorAll(sel)).not.toThrow();
    }
    for (const p of tour.entryPaths) expect(p).toBe(normalizePath(p));
  });

  it('technician steps all live on the technician route', () => {
    for (const s of TOURS.technician.steps) expect(s.route).toBe('/tech/today');
  });

  it('every tip has copy and valid roles', () => {
    for (const tip of Object.values(TIPS)) {
      expect(tip.title).not.toBe('');
      expect(tip.body).not.toBe('');
    }
  });

  it('tipCopy prefers role-specific copy', () => {
    expect(tipCopy('customers.add', 'owner').body).toMatch(/import/i);
    expect(tipCopy('customers.add', 'office').body).toBe(TIPS['customers.add'].body);
  });
});

describe('resolveTourRole', () => {
  it('maps people to the right tour', () => {
    expect(resolveTourRole({ isOwner: true, teamRole: 'technician' })).toBe('owner');
    expect(resolveTourRole({ isOwner: false, teamRole: 'technician' })).toBe('technician');
    expect(resolveTourRole({ isOwner: false, profileRole: 'admin' })).toBe('admin');
    expect(resolveTourRole({ isOwner: false, teamRole: 'admin' })).toBe('admin');
    expect(resolveTourRole({ isOwner: false, profileRole: 'member', teamRole: 'member' })).toBe('office');
    expect(resolveTourRole({ isOwner: false })).toBe('office');
  });
});

describe('visibleSteps', () => {
  const hasAnalytics = (steps: { id: string }[]) => steps.some((s) => s.id === 'analytics');
  it('hides permission-gated steps unless allowed', () => {
    expect(hasAnalytics(visibleSteps(TOURS.admin, { isOwner: false, permissions: {} }))).toBe(false);
    expect(hasAnalytics(visibleSteps(TOURS.admin, { isOwner: false, permissions: { can_view_billing: true } }))).toBe(true);
  });
  it('always shows everything to owners', () => {
    expect(visibleSteps(TOURS.owner, { isOwner: true, permissions: {} })).toHaveLength(TOURS.owner.steps.length);
  });
});

describe('normalizePath / clampStep', () => {
  it('normalizes trailing slashes', () => {
    expect(normalizePath('/dashboard/')).toBe('/dashboard');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });
  it('clamps safely', () => {
    expect(clampStep(9, 5)).toBe(4);
    expect(clampStep(-3, 5)).toBe(0);
    expect(clampStep(NaN, 5)).toBe(0);
    expect(clampStep(2, 0)).toBe(0);
    expect(clampStep(2.9, 5)).toBe(2);
  });
});

describe('record transitions', () => {
  const def = { id: 'owner', version: 2 };

  it('auto: creates a fresh in-progress record', () => {
    const r = beginRecord(undefined, def, 8, NOW, 'auto');
    expect(r).toMatchObject({ tourId: 'owner', version: 2, status: 'in_progress', stepIndex: 0, startedAt: NOW, replayCount: 0 });
  });

  it('resume: keeps position, clamped to the current step count', () => {
    expect(beginRecord(rec({ stepIndex: 3 }), def, 8, LATER, 'resume').stepIndex).toBe(3);
    expect(beginRecord(rec({ stepIndex: 9 }), def, 5, LATER, 'resume').stepIndex).toBe(4);
  });

  it('resume on a finished tour restarts without counting a replay', () => {
    const r = beginRecord(rec({ status: 'completed', stepIndex: 7 }), def, 8, LATER, 'resume');
    expect(r).toMatchObject({ status: 'in_progress', stepIndex: 0, replayCount: 0 });
  });

  it('replay: restarts, counts, and keeps completion history', () => {
    const r = beginRecord(rec({ status: 'completed', completedAt: NOW, replayCount: 1 }), def, 8, LATER, 'replay');
    expect(r).toMatchObject({ status: 'in_progress', stepIndex: 0, replayCount: 2, completedAt: NOW });
  });

  it('moveRecord clamps and stamps', () => {
    expect(moveRecord(rec(), 99, 5, LATER)).toMatchObject({ stepIndex: 4, updatedAt: LATER });
  });

  it('finishRecord stamps the right timestamp', () => {
    expect(finishRecord(rec(), 'completed', LATER)).toMatchObject({ status: 'completed', completedAt: LATER, skippedAt: null });
    expect(finishRecord(rec(), 'skipped', LATER)).toMatchObject({ status: 'skipped', skippedAt: LATER, completedAt: null });
  });

  it('tipRecord is a completed tip: record', () => {
    expect(tipRecord('jobs.create', NOW)).toMatchObject({ tourId: 'tip:jobs.create', status: 'completed' });
  });

  it('describeStatus', () => {
    expect(describeStatus(undefined)).toBe('not_started');
    expect(describeStatus(rec({ status: 'skipped' }))).toBe('skipped');
  });
});

describe('reconcileLegacy', () => {
  it('marks dashboard tours completed for people who finished the old tour', () => {
    expect(reconcileLegacy({}, TOURS.owner, true, NOW)).toMatchObject({ tourId: 'owner', status: 'completed', version: 0 });
  });
  it('does nothing otherwise', () => {
    expect(reconcileLegacy({}, TOURS.owner, false, NOW)).toBeNull();
    expect(reconcileLegacy({ owner: rec() }, TOURS.owner, true, NOW)).toBeNull();
    expect(reconcileLegacy({}, TOURS.technician, true, NOW)).toBeNull();
    expect(reconcileLegacy({}, null, true, NOW)).toBeNull();
  });
});

describe('mergeRecords', () => {
  it('newest updatedAt wins and reports local rows to push', () => {
    const remote = { owner: rec({ updatedAt: NOW, stepIndex: 1 }), admin: rec({ tourId: 'admin', updatedAt: LATER }) };
    const local = {
      owner: rec({ updatedAt: LATER, stepIndex: 4 }),
      admin: rec({ tourId: 'admin', updatedAt: NOW }),
      'tip:x': rec({ tourId: 'tip:x', updatedAt: NOW }),
    };
    const { merged, localNewer } = mergeRecords(remote, local);
    expect(merged.owner.stepIndex).toBe(4);
    expect(merged.admin.updatedAt).toBe(LATER);
    expect(merged['tip:x']).toBeDefined();
    expect(localNewer.map((r) => r.tourId).sort()).toEqual(['owner', 'tip:x']);
  });
});

describe('decideAutoStart', () => {
  const base: AutoStartInput = {
    loaded: true, signedIn: true, profileReady: true, onboardingCompleted: true,
    tour: TOURS.owner, record: undefined, pathname: '/dashboard', isActive: false, snoozed: false,
  };
  it('starts for a first-time person on the entry page', () => {
    expect(decideAutoStart(base)).toBe('start');
    expect(decideAutoStart({ ...base, pathname: '/dashboard/' })).toBe('start');
  });
  it('waits for data, auth and onboarding', () => {
    expect(decideAutoStart({ ...base, loaded: false })).toBeNull();
    expect(decideAutoStart({ ...base, signedIn: false })).toBeNull();
    expect(decideAutoStart({ ...base, profileReady: false })).toBeNull();
    expect(decideAutoStart({ ...base, onboardingCompleted: false })).toBeNull();
  });
  it('does not require onboarding for invited roles', () => {
    expect(decideAutoStart({ ...base, tour: TOURS.office, onboardingCompleted: false })).toBe('start');
  });
  it('stays quiet off the entry page, while active, or when snoozed', () => {
    expect(decideAutoStart({ ...base, pathname: '/dashboard/jobs' })).toBeNull();
    expect(decideAutoStart({ ...base, isActive: true })).toBeNull();
    expect(decideAutoStart({ ...base, snoozed: true })).toBeNull();
  });
  it('offers to resume a paused tour and never re-shows finished ones', () => {
    expect(decideAutoStart({ ...base, record: rec() })).toBe('resume-prompt');
    expect(decideAutoStart({ ...base, record: rec({ status: 'completed' }) })).toBeNull();
    expect(decideAutoStart({ ...base, record: rec({ status: 'skipped' }) })).toBeNull();
  });
});

describe('computeCardPosition', () => {
  const viewport = { w: 1280, h: 800 };
  const card = { w: 360, h: 240 };
  it('uses a bottom sheet on phones and centers without a target', () => {
    expect(computeCardPosition({ top: 0, left: 0, width: 10, height: 10 }, { w: 500, h: 800 }, card)).toEqual({ kind: 'sheet' });
    expect(computeCardPosition(null, viewport, card)).toEqual({ kind: 'center' });
  });
  it('prefers below the target', () => {
    expect(computeCardPosition({ top: 100, left: 100, width: 200, height: 40 }, viewport, card)).toEqual({ kind: 'anchored', top: 156, left: 100 });
  });
  it('flips above when there is no room below', () => {
    expect(computeCardPosition({ top: 700, left: 100, width: 200, height: 40 }, viewport, card)).toEqual({ kind: 'anchored', top: 444, left: 100 });
  });
  it('goes beside tall targets such as the sidebar', () => {
    expect(computeCardPosition({ top: 0, left: 0, width: 240, height: 800 }, viewport, card)).toEqual({ kind: 'anchored', top: 16, left: 256 });
  });
  it('clamps horizontally inside the viewport', () => {
    const p = computeCardPosition({ top: 100, left: 1200, width: 60, height: 40 }, viewport, card);
    expect(p).toEqual({ kind: 'anchored', top: 156, left: 904 });
  });
  it('falls back to center when nothing fits', () => {
    expect(computeCardPosition({ top: 0, left: 0, width: 1280, height: 800 }, viewport, card)).toEqual({ kind: 'center' });
  });
});
