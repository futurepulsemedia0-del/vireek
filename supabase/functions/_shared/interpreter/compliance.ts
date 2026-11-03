// supabase/functions/_shared/interpreter/compliance.ts
//
// Pure compliance helpers for interpreted calls. NOT legal advice: the state
// list is a starting point that counsel must confirm per business.

export const RETENTION_DEFAULT_DAYS = 90;
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 730;

/** US states generally treated as requiring all-party consent to record. Confirm with counsel. */
export const ALL_PARTY_CONSENT_STATES: readonly string[] = ["CA", "CT", "DE", "FL", "IL", "MD", "MA", "MI", "MT", "NV", "NH", "OR", "PA", "WA"];

export function allPartyConsentRequired(stateCode: string | null | undefined): boolean {
  return typeof stateCode === "string" && ALL_PARTY_CONSENT_STATES.includes(stateCode.trim().toUpperCase());
}

export function clampRetentionDays(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : RETENTION_DEFAULT_DAYS;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, v));
}

export function retentionCutoff(nowMs: number, days: unknown): string {
  return new Date(nowMs - clampRetentionDays(days) * 86_400_000).toISOString();
}

/** Customer audio/text may be used to improve models only when BOTH the business opted in and this call carried consent. Default is no. */
export function mayUseForTraining(businessOptIn: boolean | null | undefined, callConsent: boolean | null | undefined): boolean {
  return businessOptIn === true && callConsent === true;
}
