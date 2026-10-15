// Pure types + helpers for /tech/profile (no Supabase import, so it is trivially testable).

export type CredentialStatus = 'active' | 'revoked' | 'pending_renewal';
export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'no_expiry' | 'pending_renewal' | 'revoked';
export type AlertLeadDays = 14 | 30 | 60 | 90;

export const ALERT_LEAD_OPTIONS: AlertLeadDays[] = [14, 30, 60, 90];
export const MAX_JOBS_MIN = 1;
export const MAX_JOBS_MAX = 30;

export interface TechCredential {
  id: string;
  credential_type: string;
  credential_name: string | null;
  issuing_authority: string | null;
  credential_number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  status: CredentialStatus;
}

export interface TechnicianMember {
  id: string;
  member_name: string | null;
  member_email: string;
  member_phone: string | null;
  skills: string[];
  languages: string[];
  service_area: string | null;
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
}

export interface TechnicianPreferences {
  notify_credential_expiry: boolean;
  credential_alert_days: AlertLeadDays;
  notify_job_assigned: boolean;
  notify_schedule_change: boolean;
}

export const DEFAULT_PREFERENCES: TechnicianPreferences = {
  notify_credential_expiry: true,
  credential_alert_days: 30,
  notify_job_assigned: true,
  notify_schedule_change: true,
};

export interface MyTechnicianProfile {
  member: TechnicianMember;
  credentials: TechCredential[];
  preferences: TechnicianPreferences;
}

const DAY_MS = 86_400_000;

/** Whole calendar days from today (local) to a YYYY-MM-DD date. Negative = in the past. */
export function daysUntil(date: string | null, now: Date = new Date()): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}

export function credentialExpiryState(
  c: Pick<TechCredential, 'status' | 'expires_at'>,
  leadDays: number = 30,
  now: Date = new Date()
): ExpiryState {
  if (c.status === 'revoked') return 'revoked';
  if (c.status === 'pending_renewal') return 'pending_renewal';
  const days = daysUntil(c.expires_at, now);
  if (days === null) return 'no_expiry';
  if (days < 0) return 'expired';
  return days <= leadDays ? 'expiring' : 'valid';
}

export function expiryLabel(state: ExpiryState, expiresAt: string | null, now: Date = new Date()): string {
  const days = daysUntil(expiresAt, now);
  switch (state) {
    case 'revoked':
      return 'Revoked';
    case 'pending_renewal':
      return 'Renewal pending';
    case 'no_expiry':
      return 'No expiry date';
    case 'expired': {
      const n = Math.abs(days ?? 0);
      return `Expired ${n} day${n === 1 ? '' : 's'} ago`;
    }
    default: {
      const n = days ?? 0;
      if (n === 0) return 'Expires today';
      return `Expires in ${n} day${n === 1 ? '' : 's'}`;
    }
  }
}

const RANK: Record<ExpiryState, number> = {
  expired: 0,
  expiring: 1,
  pending_renewal: 2,
  valid: 3,
  no_expiry: 4,
  revoked: 5,
};

export function credentialTitle(c: Pick<TechCredential, 'credential_name' | 'credential_type'>): string {
  const name = c.credential_name?.trim();
  if (name) return name;
  const t = c.credential_type.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Credential';
}

/** Most urgent first; within a group, soonest expiry first. Does not mutate the input. */
export function sortCredentials(list: readonly TechCredential[], leadDays: number = 30, now: Date = new Date()): TechCredential[] {
  const key = (c: TechCredential) => ({
    rank: RANK[credentialExpiryState(c, leadDays, now)],
    days: daysUntil(c.expires_at, now) ?? Number.MAX_SAFE_INTEGER,
  });
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.rank - kb.rank || ka.days - kb.days || credentialTitle(a).localeCompare(credentialTitle(b));
  });
}

export interface CredentialSummary {
  expired: number;
  expiring: number;
  pendingRenewal: number;
  valid: number;
  /** expired + expiring + pending renewal — what the technician needs to act on. */
  attention: number;
}

export function summarizeCredentials(list: readonly TechCredential[], leadDays: number = 30, now: Date = new Date()): CredentialSummary {
  const s: CredentialSummary = { expired: 0, expiring: 0, pendingRenewal: 0, valid: 0, attention: 0 };
  for (const c of list) {
    const state = credentialExpiryState(c, leadDays, now);
    if (state === 'expired') s.expired += 1;
    else if (state === 'expiring') s.expiring += 1;
    else if (state === 'pending_renewal') s.pendingRenewal += 1;
    else if (state === 'valid' || state === 'no_expiry') s.valid += 1;
  }
  s.attention = s.expired + s.expiring + s.pendingRenewal;
  return s;
}

export function clampMaxJobs(n: number): number {
  if (!Number.isFinite(n)) return MAX_JOBS_MIN;
  return Math.min(MAX_JOBS_MAX, Math.max(MAX_JOBS_MIN, Math.round(n)));
}
