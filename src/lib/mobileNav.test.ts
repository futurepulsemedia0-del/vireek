import { describe, expect, it } from 'vitest';
import { BOTTOM_NAV_ITEMS, getBottomNavActiveKey } from './mobileNav';

describe('getBottomNavActiveKey', () => {
  it.each([
    ['/dashboard', 'overview'],
    ['/dashboard/', 'overview'],
    ['/dashboard/jobs', 'jobs'],
    ['/dashboard/jobs/abc/edit', 'jobs'],
    ['/dashboard/calls', 'calls'],
    ['/dashboard/calls/42', 'calls'],
    ['/dashboard/live-calls', 'calls'],
    ['/dashboard/voicemails', 'calls'],
    ['/dashboard/inbox', 'inbox'],
    ['/dashboard/inbox/thread-1', 'inbox'],
  ])('%s → %s', (path, key) => {
    expect(getBottomNavActiveKey(path)).toBe(key);
  });

  it.each(['/dashboard/settings', '/dashboard/call-routing', '/dashboard/jobs-archive', '/login'])(
    '%s belongs to "More" (no tab active)',
    (path) => {
      expect(getBottomNavActiveKey(path)).toBeNull();
    },
  );

  it('defines exactly four tabs (the fifth slot is "More")', () => {
    expect(BOTTOM_NAV_ITEMS.map((i) => i.key)).toEqual(['overview', 'jobs', 'calls', 'inbox']);
  });
});
