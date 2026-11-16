import { describe, expect, it } from 'vitest';
import { decideMfaEnforcement, parseMfaEnforcementState } from './mfaEnforcementLogic';

const base = { required: true, enrolled: false, aal: 'aal1', policy_active: true, enforced: false, grace_ends_at: null, days_left: 5 };
const s = (o: Record<string, unknown> = {}) => parseMfaEnforcementState({ ...base, ...o });

describe('decideMfaEnforcement', () => {
  it('allows when unknown, not required, policy off or already enrolled', () => {
    expect(decideMfaEnforcement(null)).toBe('allow');
    expect(decideMfaEnforcement(s({ required: false }))).toBe('allow');
    expect(decideMfaEnforcement(s({ policy_active: false }))).toBe('allow');
    expect(decideMfaEnforcement(s({ enrolled: true }))).toBe('allow');
  });
  it('shows grace, then blocks', () => {
    expect(decideMfaEnforcement(s())).toBe('grace');
    expect(decideMfaEnforcement(s({ enforced: true }))).toBe('must_enroll');
  });
  it('rejects malformed payloads', () => {
    expect(parseMfaEnforcementState({})).toBeNull();
    expect(parseMfaEnforcementState('x')).toBeNull();
  });
});
