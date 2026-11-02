import { describe, expect, it } from 'vitest';
import { isRelevantForRole, safeDeepLink } from './whatsNewRelevance';

describe('whatsNewRelevance', () => {
  it('shows untargeted entries to everyone', () => expect(isRelevantForRole({}, 'technician')).toBe(true));
  it('filters targeted entries by role, owners/admins see all', () => {
    const e = { roles: ['technician'] };
    expect(isRelevantForRole(e, 'technician')).toBe(true);
    expect(isRelevantForRole(e, 'member')).toBe(false);
    expect(isRelevantForRole(e, 'owner')).toBe(true);
    expect(isRelevantForRole(e, 'admin')).toBe(true);
  });
  it('only allows same-origin deep links', () => {
    expect(safeDeepLink('/dashboard/calendar')).toBe('/dashboard/calendar');
    expect(safeDeepLink('//evil.com')).toBeNull();
    expect(safeDeepLink('https://evil.com')).toBeNull();
    expect(safeDeepLink('javascript:alert(1)')).toBeNull();
    expect(safeDeepLink(undefined)).toBeNull();
  });
});
