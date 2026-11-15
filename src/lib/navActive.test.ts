import { describe, it, expect } from 'vitest';
import { isNavItemActive } from './navActive';

const HREFS = [
  '/dashboard',
  '/dashboard/calls',
  '/dashboard/calls/flows',
  '/dashboard/inventory',
  '/dashboard/inventory/counts',
  '/dashboard/settings',
  '/dashboard/phone-numbers',
  '/dashboard/phone-numbers/reputation',
];
const active = (path: string) => HREFS.filter((h) => isNavItemActive(path, h, HREFS));

describe('isNavItemActive', () => {
  it('highlights only /dashboard on the overview', () => {
    expect(active('/dashboard')).toEqual(['/dashboard']);
  });
  it('highlights exactly one item on a parent route', () => {
    expect(active('/dashboard/calls')).toEqual(['/dashboard/calls']);
  });
  it('prefers the most specific child over its parent', () => {
    expect(active('/dashboard/calls/flows')).toEqual(['/dashboard/calls/flows']);
    expect(active('/dashboard/inventory/counts')).toEqual(['/dashboard/inventory/counts']);
    expect(active('/dashboard/phone-numbers/reputation')).toEqual(['/dashboard/phone-numbers/reputation']);
  });
  it('keeps the parent active for detail pages without their own entry', () => {
    expect(active('/dashboard/calls/abc-123')).toEqual(['/dashboard/calls']);
  });
  it('does not match on a partial segment', () => {
    expect(active('/dashboard/calls-archive')).toEqual([]);
  });
  it('keeps Settings active on its account sub-route', () => {
    expect(active('/dashboard/settings/account')).toEqual(['/dashboard/settings']);
  });
  it('ignores a trailing slash, query string, hash and case', () => {
    expect(active('/Dashboard/Calls/')).toEqual(['/dashboard/calls']);
    expect(isNavItemActive('/dashboard/calls?tab=missed#x', '/dashboard/calls', HREFS)).toBe(true);
  });
  it('matches nothing for unrelated paths', () => {
    expect(active('/pricing')).toEqual([]);
  });
});
