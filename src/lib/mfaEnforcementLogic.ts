// Pure decision logic for MFA enrollment enforcement (owner / admin / staff).
// The authoritative state comes from the DB function public.mfa_enforcement_state().
export interface MfaEnforcementState {
  required: boolean;
  enrolled: boolean;
  aal: string;
  policy_active: boolean;
  enforced: boolean;
  grace_ends_at: string | null;
  days_left: number | null;
}

export type MfaEnforcementDecision = 'allow' | 'grace' | 'must_enroll';

export function parseMfaEnforcementState(raw: unknown): MfaEnforcementState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.required !== 'boolean') return null;
  return {
    required: r.required,
    enrolled: r.enrolled === true,
    aal: typeof r.aal === 'string' ? r.aal : 'aal1',
    policy_active: r.policy_active === true,
    enforced: r.enforced === true,
    grace_ends_at: typeof r.grace_ends_at === 'string' ? r.grace_ends_at : null,
    days_left: typeof r.days_left === 'number' ? r.days_left : null,
  };
}

/** allow = nothing to do · grace = show banner · must_enroll = block the dashboard until a factor is verified. */
export function decideMfaEnforcement(s: MfaEnforcementState | null): MfaEnforcementDecision {
  if (!s || !s.required || !s.policy_active || s.enrolled) return 'allow';
  return s.enforced ? 'must_enroll' : 'grace';
}
