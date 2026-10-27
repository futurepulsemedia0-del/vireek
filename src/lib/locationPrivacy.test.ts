import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  consentStatus,
  effectiveLevel,
  fetchLocationPrivacy,
  fetchMyTrackingStatus,
  gateCopy,
  mapToRules,
  recordLocationConsent,
  rulesToMap,
  saveLocationPrivacy,
  summarizeConsent,
  type ConsentOverviewRow,
  type RoleOption,
  type VisibilityRule,
} from './locationPrivacy';
import { getTrackingGate, isTrackingAllowedNow, resetTrackingGate } from './trackingGate';

const overview = (over: Partial<ConsentOverviewRow>): ConsentOverviewRow => ({
  teamMemberId: 'm1',
  name: 'Sam',
  email: 'sam@example.com',
  role: 'member',
  action: null,
  version: null,
  at: null,
  onShift: false,
  ...over,
});

describe('effectiveLevel', () => {
  const rules: VisibilityRule[] = [
    { role_kind: 'base_role', role_key: 'dispatcher', level: 'full' },
    { role_kind: 'base_role', role_key: 'member', level: 'none' },
    { role_kind: 'custom_role', role_key: 'role-1', level: 'current' },
  ];

  it('uses the account default when no rule matches', () => {
    expect(effectiveLevel(rules, { role: 'sales' }, 'current')).toBe('current');
  });

  it('uses the base-role rule', () => {
    expect(effectiveLevel(rules, { role: 'dispatcher' }, 'none')).toBe('full');
  });

  it('lets a custom-role rule override the base-role rule', () => {
    expect(effectiveLevel(rules, { role: 'member', customRoleId: 'role-1' }, 'full')).toBe('current');
  });

  it('falls back to the base role when the custom role has no rule', () => {
    expect(effectiveLevel(rules, { role: 'dispatcher', customRoleId: 'role-9' }, 'none')).toBe('full');
  });
});

describe('rule map round-trip', () => {
  const roles: RoleOption[] = [
    { kind: 'base_role', key: 'member', label: 'member' },
    { kind: 'custom_role', key: 'role-1', label: 'Dispatcher' },
  ];

  it('drops inherit rows and roles that no longer exist', () => {
    const rules = mapToRules(
      { 'base_role:member': 'inherit', 'custom_role:role-1': 'full', 'base_role:gone': 'none' },
      roles,
    );
    expect(rules).toEqual([{ role_kind: 'custom_role', role_key: 'role-1', level: 'full' }]);
  });

  it('round-trips through the editor map', () => {
    const rules: VisibilityRule[] = [{ role_kind: 'base_role', role_key: 'member', level: 'none' }];
    expect(mapToRules(rulesToMap(rules), roles)).toEqual(rules);
  });
});

describe('consent status', () => {
  it('reads the latest action against the notice version', () => {
    expect(consentStatus({ action: null, version: null }, 1)).toBe('none');
    expect(consentStatus({ action: 'revoked', version: 1 }, 1)).toBe('revoked');
    expect(consentStatus({ action: 'granted', version: 1 }, 1)).toBe('granted');
    expect(consentStatus({ action: 'granted', version: 1 }, 2)).toBe('outdated');
  });

  it('summarizes the team and flags on-shift technicians without consent', () => {
    const s = summarizeConsent(
      [
        overview({ teamMemberId: 'a', action: 'granted', version: 2, onShift: true }),
        overview({ teamMemberId: 'b', action: 'granted', version: 1, onShift: true }),
        overview({ teamMemberId: 'c', action: 'revoked', version: 2 }),
        overview({ teamMemberId: 'd' }),
      ],
      2,
    );
    expect(s).toEqual({ total: 4, granted: 1, pending: 2, revoked: 1, onShiftWithoutConsent: 1 });
  });
});

describe('gate copy', () => {
  it('explains each reason', () => {
    expect(gateCopy('off_duty').title).toBe('Location sharing is paused');
    expect(gateCopy('no_consent').title).toBe('Location consent needed');
    expect(gateCopy('allowed').title).toBe('Location sharing is on');
  });
});

describe('client calls', () => {
  beforeEach(() => {
    rpc.mockReset();
    resetTrackingGate();
  });

  it('maps the settings payload and defaults unknown values safely', async () => {
    rpc.mockResolvedValue({
      data: {
        configured: true,
        track_only_on_shift: true,
        require_consent: true,
        notice_version: 3,
        default_visibility: 'bogus',
        hide_vehicle_off_duty: false,
        rules: [
          { role_kind: 'base_role', role_key: 'member', level: 'none' },
          { role_kind: 'base_role', role_key: 'x', level: 'weird' },
        ],
        roles: [{ kind: 'custom_role', key: 'r1', label: 'Dispatcher' }],
      },
      error: null,
    });
    const s = await fetchLocationPrivacy();
    expect(s.trackOnlyOnShift).toBe(true);
    expect(s.noticeVersion).toBe(3);
    expect(s.defaultVisibility).toBe('full');
    expect(s.rules).toEqual([{ role_kind: 'base_role', role_key: 'member', level: 'none' }]);
    expect(s.roles).toEqual([{ kind: 'custom_role', key: 'r1', label: 'Dispatcher' }]);
  });

  it('sends the save payload with the exact RPC parameter names', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await saveLocationPrivacy({
      trackOnlyOnShift: true,
      requireConsent: true,
      defaultVisibility: 'current',
      hideVehicleOffDuty: false,
      rules: [],
      bumpNotice: true,
    });
    expect(rpc).toHaveBeenCalledWith('save_location_privacy', {
      p_track_only_on_shift: true,
      p_require_consent: true,
      p_default_visibility: 'current',
      p_hide_vehicle_off_duty: false,
      p_rules: [],
      p_bump_notice: true,
    });
  });

  it('throws the server error', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('You do not have permission to manage location privacy') });
    await expect(fetchLocationPrivacy()).rejects.toThrow('permission');
  });

  it('records consent through the RPC', async () => {
    rpc.mockResolvedValue({ data: 'log-1', error: null });
    expect(await recordLocationConsent('granted')).toBe('log-1');
    expect(rpc.mock.calls[0][0]).toBe('record_location_consent');
    expect(rpc.mock.calls[0][1].p_action).toBe('granted');
  });

  it('primes the client gate from the server status', async () => {
    rpc.mockResolvedValue({
      data: { reason: 'off_duty', on_shift: false, consent_current: true, requires_consent: true, track_only_on_shift: true, notice_version: 1 },
      error: null,
    });
    const s = await fetchMyTrackingStatus();
    expect(s.allowed).toBe(false);
    expect(isTrackingAllowedNow()).toBe(false);
    expect(getTrackingGate().reason).toBe('off_duty');
  });

  it('fails open until the server has answered', () => {
    expect(isTrackingAllowedNow()).toBe(true);
  });
});
