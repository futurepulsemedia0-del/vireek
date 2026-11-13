import { describe, it, expect } from 'vitest';
import { ALL_NAV_ITEMS, filterItems } from '@/components/DashboardNav';
import type { UserPermissions } from '@/contexts/AuthContext';

const perms = new Proxy({}, { get: () => true }) as unknown as UserPermissions;

describe('Landscaping nav item is gated', () => {
  it('is registered and marked as gated', () => {
    const item = ALL_NAV_ITEMS.find((i) => i.href === '/dashboard/landscaping');
    expect(item?.gate).toBe('landscaping');
  });
  it('is hidden by default (also for the owner), so callers that pass no gates — like the command palette — never list it', () => {
    expect(filterItems(ALL_NAV_ITEMS, true, perms).some((i) => i.href === '/dashboard/landscaping')).toBe(false);
    expect(filterItems(ALL_NAV_ITEMS, true, perms, { landscaping: false }).some((i) => i.href === '/dashboard/landscaping')).toBe(false);
  });
  it('appears only when the module is allowed, and every other item is unaffected', () => {
    const on = filterItems(ALL_NAV_ITEMS, true, perms, { landscaping: true });
    const off = filterItems(ALL_NAV_ITEMS, true, perms);
    expect(on.some((i) => i.href === '/dashboard/landscaping')).toBe(true);
    expect(on.filter((i) => i.href !== '/dashboard/landscaping')).toEqual(off);
  });
});
