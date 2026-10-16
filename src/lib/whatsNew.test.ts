import { describe, it, expect } from 'vitest';
import {
  parseReleaseDate,
  buildReleases,
  unreadReleaseIds,
  filterReleases,
  countByType,
  badgeLabel,
  MAX_UNREAD,
} from './whatsNew';

const raw = [
  { date: 'September 5, 2026', entries: [{ type: 'new' as const, title: 'Calendar', body: 'b' }, { type: 'fixed' as const, title: 'Bug', body: 'b' }] },
  { date: 'September 6, 2026', entries: [{ type: 'improved' as const, title: 'Invites', body: 'b' }] },
  { date: 'Someday soon', entries: [{ type: 'security' as const, title: 'Hardening', body: 'b' }] },
  { date: 'September 6, 2026', entries: [{ type: 'new' as const, title: 'Second drop', body: 'b' }] },
];

describe('parseReleaseDate', () => {
  it('parses real dates and rejects junk or impossible dates', () => {
    expect(parseReleaseDate('September 6, 2026')).toBe('2026-09-06');
    expect(parseReleaseDate('  december 31, 2026 ')).toBe('2026-12-31');
    expect(parseReleaseDate('February 31, 2026')).toBeNull();
    expect(parseReleaseDate('Smarch 3, 2026')).toBeNull();
    expect(parseReleaseDate('2026-09-06')).toBeNull();
  });
});

describe('buildReleases', () => {
  const releases = buildReleases(raw);
  it('sorts newest first, keeps undated last, and gives same-day releases distinct ids', () => {
    expect(releases.map((r) => r.id)).toEqual(['2026-09-06', '2026-09-06-2', '2026-09-05', 'undated-2']);
  });
});

describe('unreadReleaseIds', () => {
  const releases = buildReleases(raw);
  it('counts unread dated releases only, minus the ones already read', () => {
    expect(unreadReleaseIds(releases, new Set())).toEqual(['2026-09-06', '2026-09-06-2', '2026-09-05']);
    expect(unreadReleaseIds(releases, new Set(['2026-09-06']))).toEqual(['2026-09-06-2', '2026-09-05']);
  });
  it('ignores releases older than the account', () => {
    expect(unreadReleaseIds(releases, new Set(), { accountCreatedAt: '2026-09-06T10:00:00Z' })).toEqual(['2026-09-06', '2026-09-06-2']);
    expect(unreadReleaseIds(releases, new Set(), { accountCreatedAt: '2026-10-01T00:00:00Z' })).toEqual([]);
  });
  it('never exceeds the newest-N window, even when older ones are unread', () => {
    const many = buildReleases(Array.from({ length: 12 }, (_, i) => ({ date: `January ${i + 1}, 2026`, entries: [{ type: 'new' as const, title: 't', body: 'b' }] })));
    expect(unreadReleaseIds(many, new Set()).length).toBe(MAX_UNREAD);
    // Reading the newest does not pull an older release into the window.
    expect(unreadReleaseIds(many, new Set([many[0].id])).length).toBe(MAX_UNREAD - 1);
  });
});

describe('filterReleases / countByType / badgeLabel', () => {
  const releases = buildReleases(raw);
  it('filters by entry type and drops emptied releases', () => {
    expect(filterReleases(releases, 'fixed', null).map((r) => r.id)).toEqual(['2026-09-05']);
    expect(filterReleases(releases, 'all', null).length).toBe(4);
  });
  it('restricts to given release ids', () => {
    expect(filterReleases(releases, 'all', new Set(['2026-09-06'])).map((r) => r.id)).toEqual(['2026-09-06']);
  });
  it('counts entries per type', () => {
    expect(countByType(releases)).toEqual({ all: 5, new: 2, improved: 1, security: 1, fixed: 1 });
  });
  it('formats the badge', () => {
    expect([badgeLabel(0), badgeLabel(3), badgeLabel(12)]).toEqual(['', '3', '9+']);
  });
});
