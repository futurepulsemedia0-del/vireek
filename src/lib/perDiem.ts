import { supabase } from '@/lib/supabase';

/**
 * Per diem & lodging — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20271210000100_per_diem_lodging.sql.
 * The database computes and stores every amount; computePerDiem() mirrors the same rules
 * only so the form can show an instant preview.
 */

export type TripStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type IneligibleReason = 'disabled' | 'too_close' | 'not_overnight';
export type RateSource = 'city' | 'state' | 'default';

export interface PerDiemRate {
  state: string;
  city: string | null;
  mealCents: number;
  lodgingCapCents: number;
}

export interface PerDiemPolicy {
  configured: boolean;
  enabled: boolean;
  minDistanceMiles: number;
  requireOvernight: boolean;
  defaultMealCents: number;
  defaultLodgingCapCents: number;
  firstLastDayPct: number;
  lodgingRequiresReceipt: boolean;
  canEdit: boolean;
  rates: PerDiemRate[];
}

export interface PerDiemCalc {
  eligible: boolean;
  reason: IneligibleReason | null;
  days: number;
  nights: number;
  mealRateCents: number;
  lodgingCapCents: number;
  rateSource: RateSource;
  mealTotalCents: number;
  lodgingAllowedCents: number;
  lodgingOverCents: number;
  totalCents: number;
}

export interface TripInput {
  state: string;
  city: string;
  startDate: string;
  endDate: string;
  oneWayMiles: number;
  lodgingActualCents: number;
}

export interface PerDiemTrip {
  id: string;
  submittedBy: string;
  travelerName: string;
  jobId: string | null;
  destinationCity: string | null;
  destinationState: string;
  oneWayMiles: number;
  startDate: string;
  endDate: string;
  days: number;
  nights: number;
  mealTotalCents: number;
  lodgingActualCents: number;
  lodgingAllowedCents: number;
  totalCents: number;
  receiptPath: string | null;
  notes: string | null;
  status: TripStatus;
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  expenseId: string | null;
}

export interface SaveTripInput extends TripInput {
  jobId: string | null;
  notes: string;
  receiptPath: string | null;
  receiptMime: string | null;
}

export const STATUS_LABEL: Record<TripStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const REASON_COPY: Record<IneligibleReason, string> = {
  disabled: 'Per diem is not turned on for this account.',
  too_close: 'This trip is under the minimum distance for per diem.',
  not_overnight: 'Per diem requires at least one overnight stay.',
};

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days between two YYYY-MM-DD dates (end - start); NaN when either is invalid. */
export function daysBetween(start: string, end: string): number {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok(start) || !ok(end)) return Number.NaN;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? Number.NaN : Math.round((b - a) / DAY_MS);
}

/** Which rate applies: a city rate, else the state rate, else the account default. */
export function pickRate(
  policy: Pick<PerDiemPolicy, 'defaultMealCents' | 'defaultLodgingCapCents' | 'rates'>,
  state: string,
  city: string,
): { mealCents: number; lodgingCapCents: number; source: RateSource } {
  const c = city.trim().toLowerCase();
  const st = state.trim().toUpperCase();
  if (c) {
    const hit = policy.rates.find((r) => r.state === st && r.city !== null && r.city.trim().toLowerCase() === c);
    if (hit) return { mealCents: hit.mealCents, lodgingCapCents: hit.lodgingCapCents, source: 'city' };
  }
  const stateHit = policy.rates.find((r) => r.state === st && r.city === null);
  if (stateHit) return { mealCents: stateHit.mealCents, lodgingCapCents: stateHit.lodgingCapCents, source: 'state' };
  return { mealCents: policy.defaultMealCents, lodgingCapCents: policy.defaultLodgingCapCents, source: 'default' };
}

/**
 * Mirrors per_diem_compute(). Meals: first and last day at firstLastDayPct, middle days in
 * full. Lodging: actual cost, capped at the nightly cap x nights.
 */
export function computePerDiem(policy: PerDiemPolicy, trip: TripInput): PerDiemCalc | null {
  const nights = daysBetween(trip.startDate, trip.endDate);
  if (!Number.isFinite(nights) || nights < 0 || nights > 60) return null;
  const days = nights + 1;
  const rate = pickRate(policy, trip.state, trip.city);
  const lodging = Math.max(0, Math.round(trip.lodgingActualCents) || 0);

  let reason: IneligibleReason | null = null;
  if (!policy.enabled) reason = 'disabled';
  else if (trip.oneWayMiles < policy.minDistanceMiles) reason = 'too_close';
  else if (policy.requireOvernight && nights < 1) reason = 'not_overnight';

  let mealTotal = 0;
  let lodgingAllowed = 0;
  if (!reason) {
    mealTotal = Math.round(rate.mealCents * (Math.max(days - 2, 0) + (Math.min(days, 2) * policy.firstLastDayPct) / 100));
    lodgingAllowed = Math.min(lodging, rate.lodgingCapCents * nights);
  }
  return {
    eligible: reason === null,
    reason,
    days,
    nights,
    mealRateCents: rate.mealCents,
    lodgingCapCents: rate.lodgingCapCents,
    rateSource: rate.source,
    mealTotalCents: mealTotal,
    lodgingAllowedCents: lodgingAllowed,
    lodgingOverCents: reason ? 0 : lodging - lodgingAllowed,
    totalCents: mealTotal + lodgingAllowed,
  };
}

export function describeRate(source: RateSource, state: string, city: string): string {
  if (source === 'city') return `${city.trim()}, ${state} rate`;
  if (source === 'state') return `${state} state rate`;
  return 'Account default rate';
}

export function tripSummary(trips: PerDiemTrip[]): { awaiting: number; awaitingCents: number; approvedCents: number } {
  let awaiting = 0;
  let awaitingCents = 0;
  let approvedCents = 0;
  for (const t of trips) {
    if (t.status === 'submitted') {
      awaiting += 1;
      awaitingCents += t.totalCents;
    } else if (t.status === 'approved') approvedCents += t.totalCents;
  }
  return { awaiting, awaitingCents, approvedCents };
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const m = (e as { message: string }).message.trim();
    if (m) return m;
  }
  return fallback;
}

// ------------------------------------------------------------------
// RPC wrappers
// ------------------------------------------------------------------

export async function fetchPerDiemPolicy(): Promise<PerDiemPolicy> {
  const { data, error } = await supabase.rpc('get_per_diem_policy');
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const rates = (Array.isArray(d.rates) ? d.rates : []) as Record<string, unknown>[];
  return {
    configured: d.configured === true,
    enabled: d.enabled === true,
    minDistanceMiles: num(d.min_distance_miles, 50),
    requireOvernight: d.require_overnight !== false,
    defaultMealCents: num(d.default_meal_cents, 6800),
    defaultLodgingCapCents: num(d.default_lodging_cap_cents, 12000),
    firstLastDayPct: num(d.first_last_day_pct, 75),
    lodgingRequiresReceipt: d.lodging_requires_receipt !== false,
    canEdit: d.can_edit === true,
    rates: rates.map((r) => ({
      state: String(r.state),
      city: (r.city as string | null) ?? null,
      mealCents: num(r.meal_cents),
      lodgingCapCents: num(r.lodging_cap_cents),
    })),
  };
}

export async function savePerDiemPolicy(policy: Omit<PerDiemPolicy, 'configured' | 'canEdit'>): Promise<void> {
  const { error } = await supabase.rpc('save_per_diem_policy', {
    p_data: {
      enabled: policy.enabled,
      min_distance_miles: policy.minDistanceMiles,
      require_overnight: policy.requireOvernight,
      default_meal_cents: policy.defaultMealCents,
      default_lodging_cap_cents: policy.defaultLodgingCapCents,
      first_last_day_pct: policy.firstLastDayPct,
      lodging_requires_receipt: policy.lodgingRequiresReceipt,
    },
    p_rates: policy.rates.map((r) => ({
      state: r.state,
      city: r.city,
      meal_cents: r.mealCents,
      lodging_cap_cents: r.lodgingCapCents,
    })),
  });
  if (error) throw error;
}

const TRIP_COLUMNS =
  'id, submitted_by, traveler_name, job_id, destination_city, destination_state, one_way_miles, start_date, end_date, days, nights, meal_total_cents, lodging_actual_cents, lodging_allowed_cents, total_cents, receipt_path, notes, status, review_note, submitted_at, reviewed_at, expense_id';

export async function fetchPerDiemTrips(limit = 200): Promise<PerDiemTrip[]> {
  const { data, error } = await supabase
    .from('per_diem_trips')
    .select(TRIP_COLUMNS)
    .order('start_date', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    id: String(r.id),
    submittedBy: String(r.submitted_by),
    travelerName: String(r.traveler_name ?? ''),
    jobId: (r.job_id as string | null) ?? null,
    destinationCity: (r.destination_city as string | null) ?? null,
    destinationState: String(r.destination_state),
    oneWayMiles: num(r.one_way_miles),
    startDate: String(r.start_date),
    endDate: String(r.end_date),
    days: num(r.days, 1),
    nights: num(r.nights),
    mealTotalCents: num(r.meal_total_cents),
    lodgingActualCents: num(r.lodging_actual_cents),
    lodgingAllowedCents: num(r.lodging_allowed_cents),
    totalCents: num(r.total_cents),
    receiptPath: (r.receipt_path as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    status: r.status as TripStatus,
    reviewNote: (r.review_note as string | null) ?? null,
    submittedAt: (r.submitted_at as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    expenseId: (r.expense_id as string | null) ?? null,
  }));
}

export async function savePerDiemTrip(id: string | null, input: SaveTripInput, submit: boolean): Promise<string> {
  const { data, error } = await supabase.rpc('save_per_diem_trip', {
    p_id: id,
    p_data: {
      destination_state: input.state,
      destination_city: input.city.trim() || null,
      start_date: input.startDate,
      end_date: input.endDate,
      one_way_miles: input.oneWayMiles,
      lodging_actual_cents: input.lodgingActualCents,
      job_id: input.jobId,
      notes: input.notes,
      receipt_path: input.receiptPath,
      receipt_mime: input.receiptMime,
    },
    p_submit: submit,
  });
  if (error) throw error;
  return data as string;
}

export async function reviewPerDiemTrip(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
  const { error } = await supabase.rpc('review_per_diem_trip', { p_id: id, p_decision: decision, p_note: note ?? null });
  if (error) throw error;
}

export async function deletePerDiemTrip(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_per_diem_trip', { p_id: id });
  if (error) throw error;
}
