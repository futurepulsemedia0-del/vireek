/**
 * Onboarding time-to-value: data access for the staff card (staff only).
 *
 * Thin wrappers over the SECURITY DEFINER RPCs in supabase/migrations/20290305000000_onboarding_ttv.sql:
 *   staff_ttv_overview, staff_ttv_alert_ack, staff_ttv_config_set, staff_ttv_settings_set.
 * Authorization and audit logging are enforced by the database (is_vireek_staff + _growth_assert_staff); this
 * module never decides who may see what. Reads return a result object so the card can render each state;
 * writes throw `TtvApiError` so the caller can show one generic error and keep the form open.
 */
import { supabase } from '@/lib/supabase';
import {
  TTV_STALL_HOURS_MAX,
  TTV_STALL_HOURS_MIN,
  TTV_WATCH_DAYS_MAX,
  TTV_WATCH_DAYS_MIN,
  parseTtvOverview,
  type TtvMilestone,
  type TtvOverview,
} from '@/lib/ttv';

export type TtvFailure = 'forbidden' | 'invalid' | 'not_found' | 'error';

export class TtvApiError extends Error {
  readonly reason: TtvFailure;
  constructor(reason: TtvFailure, message?: string) {
    super(message ?? reason);
    this.name = 'TtvApiError';
    this.reason = reason;
  }
}

export type TtvFetchResult =
  | { ok: true; overview: TtvOverview }
  | { ok: false; reason: Exclude<TtvFailure, 'not_found'> };

interface RpcError { message?: string; code?: string }

/** 42501 / 'forbidden' = not staff; 22023 / 'invalid_*' = argument rejected by the database. */
export function failureFromError(error: RpcError | null | undefined): TtvFailure {
  const message = error?.message ?? '';
  if (error?.code === '42501' || /forbidden/i.test(message)) return 'forbidden';
  if (error?.code === '22023' || /invalid_/i.test(message)) return 'invalid';
  return 'error';
}

export async function fetchTtvOverview(days: number): Promise<TtvFetchResult> {
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: 'invalid' };
  try {
    const { data, error } = await supabase.rpc('staff_ttv_overview', { p_days: days });
    if (error) {
      const reason = failureFromError(error);
      return { ok: false, reason: reason === 'not_found' ? 'error' : reason };
    }
    return { ok: true, overview: parseTtvOverview(data) };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Acknowledges one open alert. Resolves true when it was newly acknowledged, false when it was already acknowledged or resolved. */
export async function ackTtvAlert(alertId: string): Promise<boolean> {
  if (!alertId) throw new TtvApiError('invalid');
  const { data, error } = await supabase.rpc('staff_ttv_alert_ack', { p_id: alertId });
  if (error) throw new TtvApiError(failureFromError(error), error.message);
  return data === true;
}

/** Sets the stall threshold (hours) and alert switch for one milestone. */
export async function setTtvThreshold(milestone: TtvMilestone, stallHours: number, alertEnabled: boolean): Promise<void> {
  if (!Number.isInteger(stallHours) || stallHours < TTV_STALL_HOURS_MIN || stallHours > TTV_STALL_HOURS_MAX) {
    throw new TtvApiError('invalid', 'invalid_stall_hours');
  }
  const { data, error } = await supabase.rpc('staff_ttv_config_set', {
    p_milestone: milestone,
    p_stall_hours: stallHours,
    p_alert_enabled: alertEnabled,
  });
  if (error) throw new TtvApiError(failureFromError(error), error.message);
  if (data !== true) throw new TtvApiError('not_found', 'unknown_milestone');
}

/** Sets how many days after signup an account is monitored for stalls. */
export async function setTtvWatchDays(days: number): Promise<void> {
  if (!Number.isInteger(days) || days < TTV_WATCH_DAYS_MIN || days > TTV_WATCH_DAYS_MAX) {
    throw new TtvApiError('invalid', 'invalid_watch_days');
  }
  const { error } = await supabase.rpc('staff_ttv_settings_set', { p_watch_days: days });
  if (error) throw new TtvApiError(failureFromError(error), error.message);
}
