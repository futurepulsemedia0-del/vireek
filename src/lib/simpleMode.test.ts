import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIMPLE_MODE_DAYS, SIMPLE_NAV_HREFS, filterToSimpleNav, isSimpleModeActive } from './simpleMode';

const NOW = Date.parse('2030-06-15T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const base = { isOwner: true, now: NOW, fullNavigationFlag: false, showEverything: false };

describe('isSimpleModeActive', () => {
  it('is on for a new owner and off after the window', () => {
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(1) })).toBe(true);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(SIMPLE_MODE_DAYS - 0.1) })).toBe(true);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(SIMPLE_MODE_DAYS) })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(400) })).toBe(false);
  });
  it('fails toward the full menu on bad data, flag, opt-out or non-owner', () => {
    expect(isSimpleModeActive({ ...base, createdAt: null })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: 'garbage' })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(-2) })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(1), fullNavigationFlag: true })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(1), showEverything: true })).toBe(false);
    expect(isSimpleModeActive({ ...base, createdAt: daysAgo(1), isOwner: false })).toBe(false);
  });
});

describe('simple navigation', () => {
  it('has at most 12 unique entries', () => {
    expect(SIMPLE_NAV_HREFS.length).toBeLessThanOrEqual(12);
    expect(new Set(SIMPLE_NAV_HREFS).size).toBe(SIMPLE_NAV_HREFS.length);
  });
  it('filters by href and keeps order of the input', () => {
    const items = [{ href: '/dashboard/x' }, { href: '/dashboard/jobs' }, { href: '/dashboard' }];
    expect(filterToSimpleNav(items).map((i) => i.href)).toEqual(['/dashboard/jobs', '/dashboard']);
  });
  it('every simple href is a real route and a real nav entry (static check of App.tsx and DashboardNav.tsx)', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const nav = readFileSync(resolve(__dirname, '../components/DashboardNav.tsx'), 'utf8');
    for (const h of SIMPLE_NAV_HREFS) {
      expect(app.includes(`path="${h}"`), `route missing: ${h}`).toBe(true);
      expect(nav.includes(`href: '${h}'`), `nav entry missing: ${h}`).toBe(true);
    }
  });
});
