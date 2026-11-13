/**
 * Landscaping pack — shared shapes (database rows as the client sees them).
 * Money is ALWAYS integer cents; areas are square feet / linear feet (imperial, like the rest of the pack framework).
 */

import type { HolidayPolicy, PauseWindow, SeasonRule } from './recurrence.ts';
import type { WeatherPolicy } from './weather.ts';

export type ContractStatus = 'draft' | 'active' | 'paused' | 'ended';
export type BillingMode = 'per_visit' | 'monthly_flat';
export type VisitKind = 'maintenance' | 'addon' | 'makeup';
export type VisitStatus = 'scheduled' | 'in_progress' | 'completed' | 'skipped' | 'cancelled';
export type VisitSkipReason = 'holiday' | 'paused' | 'weather' | 'manual' | 'contract_ended' | 'crew_unavailable';
export type AddonKind = 'snow' | 'fertilization' | 'cleanup' | 'other';
export type AddonBilling = 'per_visit' | 'per_event' | 'one_time';

export interface ChecklistTaskTemplate {
  key: string;
  label: string;
  /** Completing the visit requires this task to be done (or marked not-applicable with a note). */
  required: boolean;
}

export interface LandscapeContract {
  id: string;
  customer_id: string | null;
  property_id: string | null;
  title: string;
  status: ContractStatus;
  start_date: string;
  end_date: string | null;
  seasons: SeasonRule[];
  holiday_policy: HolidayPolicy;
  holiday_set: 'none' | 'us_core';
  extra_holidays: string[];
  workdays: number[];
  preferred_time: string;
  timezone: string;
  duration_minutes: number;
  default_crew_id: string | null;
  billing_mode: BillingMode;
  visit_price_cents: number;
  monthly_fee_cents: number;
  tax_percent: number;
  weather_policy: WeatherPolicy;
  checklist: ChecklistTaskTemplate[];
  require_photos: boolean;
  pauses: PauseWindow[];
  notes: string | null;
}

export interface LandscapeAddon {
  id: string;
  contract_id: string;
  kind: AddonKind;
  label: string;
  billing: AddonBilling;
  price_cents: number;
  /** Months (1–12) the add-on may be scheduled/triggered; wraps the year-end like seasons do. */
  season_from_month: number;
  season_to_month: number;
  /** Fertilization rounds: months (1–12) in which one round is scheduled. */
  round_months: number[];
  /** Snow: trigger depth in cm (event creates one visit). */
  snow_trigger_cm: number | null;
  active: boolean;
}

/** The slice of a visit that metrics / billing / routing care about. */
export interface VisitRow {
  id: string;
  contract_id: string;
  addon_id: string | null;
  kind: VisitKind;
  status: VisitStatus;
  skip_reason: VisitSkipReason | null;
  visit_date: string;
  scheduled_at: string;
  crew_id: string | null;
  crew_size: number;
  route_position: number | null;
  planned_minutes: number;
  started_at: string | null;
  completed_at: string | null;
  price_cents: number;
  billed_invoice_id: string | null;
  tasks_total: number;
  tasks_done: number;
}
