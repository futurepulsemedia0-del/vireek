/**
 * Landscaping pack — pure client mappers + error text (no React, no Supabase), so they run in any test environment.
 */

import type { BillingContract, ContractSchedule, LandscapeContract } from '@/lib/tradePacks/landscaping/index';

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

const ERROR_TEXT: Record<string, string> = {
  landscaping_not_enabled: 'The Landscaping module is not enabled for this account.',
  permission_denied: 'You need owner or admin permission for this action.',
  photos_required: 'Add at least one BEFORE and one AFTER photo before completing this visit.',
  required_tasks_open: 'Finish the required checklist tasks first.',
  job_missing: 'This visit has no job yet, so photos cannot be attached. Re-route or reassign it first.',
  note_required_for_na: 'Add a short note explaining why the task does not apply.',
  visit_closed: 'This visit is already closed.',
  invalid_order: 'The route changed while you were editing. Reload and try again.',
  locked_stops_cannot_move: 'Stops that are finished, skipped or in progress cannot be moved.',
  slot_conflict: 'Another job for that technician overlaps the new times.',
  pause_overlaps: 'That pause overlaps another pause on this contract.',
  not_paused: 'This contract is not paused on that date.',
  pause_already_started: 'This pause has already started. Resume the contract instead.',
  invalid_period: 'Pick a valid billing month.',
  period_in_future: 'That billing month has not ended yet.',
  start_date_locked: 'The start date cannot change after visits exist. Create a new contract instead.',
  billing_mode_locked: 'The billing mode cannot change after invoices exist.',
  invalid_status_transition: 'That status change is not allowed.',
};

export function friendlyLandscapingError(e: unknown): string {
  const raw = (e as { message?: string } | null)?.message ?? '';
  for (const k of Object.keys(ERROR_TEXT)) if (raw.includes(k)) return ERROR_TEXT[k];
  if (/row-level security|42501/i.test(raw)) return 'You do not have permission to do that.';
  if (/duplicate key|23505/i.test(raw)) return 'That already exists.';
  return raw || 'Something went wrong. Please try again.';
}

export interface Pause {
  id: string;
  contract_id: string;
  from_date: string;
  to_date: string | null;
  reason: string | null;
}

/** A contract plus its customer name and the raw pause rows (`pauses` on the contract is the engine's window form). */
export type ContractListItem = LandscapeContract & { customer_name: string; pauseRows: Pause[] };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function toContract(r: Record<string, unknown>): LandscapeContract {
  return {
    id: r.id as string,
    customer_id: (r.customer_id as string | null) ?? null,
    property_id: (r.property_id as string | null) ?? null,
    title: r.title as string,
    status: r.status as LandscapeContract['status'],
    start_date: r.start_date as string,
    end_date: (r.end_date as string | null) ?? null,
    seasons: (r.seasons as LandscapeContract['seasons']) ?? [],
    holiday_policy: r.holiday_policy as LandscapeContract['holiday_policy'],
    holiday_set: r.holiday_set as LandscapeContract['holiday_set'],
    extra_holidays: ((r.extra_holidays as string[] | null) ?? []).slice(),
    workdays: ((r.workdays as number[] | null) ?? []).map(Number),
    preferred_time: String(r.preferred_time ?? '09:00').slice(0, 5),
    timezone: r.timezone as string,
    duration_minutes: Number(r.duration_minutes),
    default_crew_id: (r.default_crew_id as string | null) ?? null,
    billing_mode: r.billing_mode as LandscapeContract['billing_mode'],
    visit_price_cents: Number(r.visit_price_cents),
    monthly_fee_cents: Number(r.monthly_fee_cents),
    tax_percent: Number(r.tax_percent),
    weather_policy: r.weather_policy as LandscapeContract['weather_policy'],
    checklist: (r.checklist as LandscapeContract['checklist']) ?? [],
    require_photos: Boolean(r.require_photos),
    pauses: [],
    notes: (r.notes as string | null) ?? null,
  };
}

export function contractSchedule(c: LandscapeContract): ContractSchedule {
  return {
    startDate: c.start_date,
    endDate: c.end_date,
    seasons: c.seasons,
    holidayPolicy: c.holiday_policy,
    holidaySet: c.holiday_set,
    extraHolidays: c.extra_holidays,
    workdays: c.workdays,
    pauses: c.pauses,
    preferredTime: c.preferred_time,
    timezone: c.timezone,
  };
}

export function billingContract(c: LandscapeContract): BillingContract {
  return {
    id: c.id,
    title: c.title,
    billing_mode: c.billing_mode,
    monthly_fee_cents: c.monthly_fee_cents,
    tax_percent: c.tax_percent,
    start_date: c.start_date,
    end_date: c.end_date,
    pauses: c.pauses,
    status: c.status,
  };
}

