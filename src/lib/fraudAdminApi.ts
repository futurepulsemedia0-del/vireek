// Typed client for the fraud-admin edge function. The function re-checks is_vireek_staff() on every call;
// the StaffRoute guard on the page is only UX.

import { supabase } from '@/lib/supabase';

export type OrgStatus = 'active' | 'throttled' | 'suspended';
export type CaseStatus = 'open' | 'investigating' | 'resolved';
export type Severity = 'low' | 'medium' | 'high';

export interface FraudSettings {
  enforce: boolean;
  kill_outbound_calls: boolean;
  kill_sms: boolean;
  kill_international: boolean;
  kill_otp_sms: boolean;
  otp_allowed_countries: string[];
  reason: string | null;
  consent_mode: 'off' | 'log' | 'enforce';
  campaign_approval_days: number;
  free_minutes_mode: 'monthly' | 'lifetime';
}

export interface FraudOverview {
  settings: FraudSettings | null;
  openCases: number;
  pendingApprovals: number;
  suspended: number;
  throttled: number;
  denied24h: Record<string, number>;
  knownCountries: string[];
  /** Maximum possible loss per signup over a 30-day horizon, by plan (cents). */
  lossBounds: Array<{ plan: string; unverifiedCents: number; verifiedCents: number }>;
}

export interface FraudCase {
  id: string;
  user_id: string;
  status: CaseStatus;
  severity: Severity;
  title: string;
  signals: Array<{ code: string; detail: string }>;
  appeal_text: string | null;
  appeal_at: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export class FraudAdminError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('fraud-admin', { body });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status ?? 500;
    throw new FraudAdminError(error.message, status);
  }
  return data as T;
}

export const fetchOverview = () => call<FraudOverview>({ action: 'overview' });
export const fetchCases = (status?: CaseStatus) => call<{ cases: FraudCase[] }>({ action: 'cases', status }).then((r) => r.cases);
export const setOrgStatus = (userId: string, status: OrgStatus, reason: string, days?: number) =>
  call<{ ok: true }>({ action: 'set_status', user_id: userId, status, reason, days });
export const updateCase = (id: string, status: CaseStatus, resolution?: string) =>
  call<{ ok: true }>({ action: 'case_update', id, status, resolution });
export const updateKillSwitch = (patch: Partial<Pick<FraudSettings, 'enforce' | 'kill_outbound_calls' | 'kill_sms' | 'kill_international' | 'kill_otp_sms'>>, reason: string) =>
  call<{ ok: true }>({ action: 'kill_switch', ...patch, reason });
export interface PendingApproval { user_id: string; campaign: string; status: 'pending'; created_at: string }
export const fetchApprovals = () => call<{ approvals: PendingApproval[] }>({ action: 'approvals' }).then((r) => r.approvals);
export const decideApproval = (userId: string, campaign: string, decision: 'approved' | 'rejected', note?: string) =>
  call<{ ok: true }>({ action: 'approval_decide', user_id: userId, campaign, decision, note });
export const updateRollout = (patch: Partial<Pick<FraudSettings, 'consent_mode' | 'free_minutes_mode' | 'campaign_approval_days'>>, reason: string) =>
  call<{ ok: true }>({ action: 'kill_switch', ...patch, reason });
export const fetchWeeklyReport = () => call<{ report: string }>({ action: 'weekly_report' }).then((r) => r.report);
export const submitAppeal = (text: string) => call<{ ok: true }>({ action: 'appeal', text });
