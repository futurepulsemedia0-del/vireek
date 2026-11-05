/**
 * Phase 0 runner: observational incrementality from natural variation only.
 * Turns rows of public.incrementality_phase0_call_dataset() into estimator input and runs the analysis.
 * Never changes call routing and never writes to the value ledger (observational results are NOT the
 * "experimental" tier).
 */
import {
  assessEstimate,
  bookingSensitivity,
  incrementalRevenueTotal,
  stratifiedAtt,
  type Assessment,
  type BookingSensitivity,
  type BootstrapOptions,
  type CallObservation,
  type IncrementalTotal,
  type StratifiedEstimate,
} from './estimators';

export interface Phase0Row {
  call_id: string;
  call_datetime: string;
  answered: boolean;
  is_emergency: boolean;
  source: string;
  intent: string;
  customer_id: string | null;
  booked: boolean;
  booked_revenue_cents: number;
}

/** Coarse time block in the business's own time zone (weekday/weekend x four day parts). */
export function timeBlockOf(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const day = wd === 'Sat' || wd === 'Sun' ? 'weekend' : 'weekday';
  const part = hour >= 22 || hour < 6 ? 'overnight' : hour < 9 ? 'early' : hour < 17 ? 'day' : 'evening';
  return `${day}_${part}`;
}

/** ISO-ish week bucket (UTC Monday-based) used as the bootstrap cluster for a single account. */
export function weekClusterOf(iso: string): string {
  const d = new Date(iso);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

export function toObservations(rows: readonly Phase0Row[], accountId: string, timeZone: string): CallObservation[] {
  return rows.map((r) => ({
    id: r.call_id,
    businessId: accountId,
    clusterId: weekClusterOf(r.call_datetime),
    answered: r.answered,
    timeBlock: timeBlockOf(r.call_datetime, timeZone),
    category: r.intent || 'unknown',
    urgency: r.is_emergency ? 'emergency' : 'routine',
    source: r.source || 'unknown',
    booked: r.booked,
    bookedRevenueCents: Math.max(0, Math.round(r.booked_revenue_cents)),
  }));
}

export interface Phase0Result {
  bookingRate: { estimate: StratifiedEstimate | null; sensitivity: BookingSensitivity | null; assessment: Assessment };
  revenue: { estimate: StratifiedEstimate | null; total: IncrementalTotal | null; assessment: Assessment };
  /** Emergencies are always answered by design; they are excluded so they cannot distort the contrast. */
  excludedEmergencyCalls: number;
}

export function runPhase0(obs: readonly CallObservation[], options?: BootstrapOptions): Phase0Result {
  const nonEmergency = obs.filter((o) => o.urgency !== 'emergency');
  const bk = stratifiedAtt(nonEmergency, 'booked', options);
  let sens: BookingSensitivity | null = null;
  if (bk) {
    const answered = nonEmergency.filter((o) => o.answered);
    const rate = answered.length > 0 ? answered.filter((o) => o.booked).length / answered.length : 0;
    sens = bookingSensitivity(bk, rate);
  }
  const rev = stratifiedAtt(nonEmergency, 'bookedRevenueCents', options);
  return {
    bookingRate: { estimate: bk, sensitivity: sens, assessment: assessEstimate(bk, sens) },
    revenue: { estimate: rev, total: rev ? incrementalRevenueTotal(rev) : null, assessment: assessEstimate(rev, sens) },
    excludedEmergencyCalls: obs.length - nonEmergency.length,
  };
}
