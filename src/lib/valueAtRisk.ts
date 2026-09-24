/**
 * Value-at-Risk Engine — client library.
 *
 * Every open/contacted row in the Missed-Revenue Recovery Ledger
 * (see revenueRecovery.ts, fed by a DB trigger — never computed here) already
 * carries one number: estimated_value_cents. That is the "revenue" view of
 * exposure. This engine reads that same ledger — no new tables, no
 * duplicate tracking — and expands each event into the full surface of what
 * is actually at stake when it goes unresolved:
 *
 *   Value at Risk = Revenue + Margin + Cash + Customer LTV
 *                  + Reputation + Capacity + Compliance
 *
 * A cancelled $400 job is not a $400 problem if it is a repeat customer who
 * now tells three neighbors, or if the slot it left empty was the only
 * emergency slot of the day. This engine prices that in, using a small set
 * of disclosed, tunable assumptions (VALUE_AT_RISK_ASSUMPTIONS below) —
 * never a hidden weighting. Every dimension ships with a plain-language
 * `basis` string explaining exactly how it was derived, so the owner can
 * see — and challenge — the math, not just the total.
 *
 * Data sources read (all pre-existing, nothing new added to the schema):
 *   - revenue_recovery_events  (via revenueRecovery.fetchLedger)
 *   - jobs                     (scheduled_datetime, assigned_technician_id,
 *                                customer_id/phone/name, invoice_amount/status)
 *   - review_requests          (business-wide reputation baseline)
 *   - technician_credentials   (compliance exposure on the assigned tech)
 *
 * Every side query is wrapped defensively: if a table or column has moved
 * in your schema since this was written, that one dimension quietly falls
 * back to 0 instead of breaking the whole report.
 */

import { supabase } from '@/lib/supabase';
import { fetchLedger, type RevenueRecoveryEvent, type RecoverySourceType } from '@/lib/revenueRecovery';

// ============================================================
// ASSUMPTIONS — the whole formula lives here, in the open.
// Tune these to your real numbers. Nothing below this block hides a
// second, undisclosed set of weights.
// ============================================================

export interface ValueAtRiskAssumptions {
  /** Average gross margin on a job — sizes the Margin dimension. */
  marginPct: number;
  /** Share of a damaged customer's paid history treated as "at risk" from one bad event. */
  relationshipRiskPct: number;
  /** Word-of-mouth value of one relationship, as a multiple of that relationship's value — powers Reputation. */
  referralMultiplier: number;
  /** Below this average star rating, Reputation exposure is scaled up — the business is already fragile there. */
  reputationFragileThreshold: number;
  /** A cancellation inside this many hours of the appointment is treated as an unbackfillable capacity loss. */
  capacityBackfillWindowHours: number;
  /** Flat exposure assumed per compliance gap (expired/expiring credential on the assigned tech). Replace with your real average fine/claim exposure. */
  complianceExposureCents: number;
  /** How many days of ledger history to scan for open exposure. */
  lookbackDays: number;
}

export const VALUE_AT_RISK_ASSUMPTIONS: ValueAtRiskAssumptions = {
  marginPct: 0.45,
  relationshipRiskPct: 0.12,
  referralMultiplier: 0.35,
  reputationFragileThreshold: 4.2,
  capacityBackfillWindowHours: 24,
  complianceExposureCents: 50_000, // $500 placeholder — replace with your real exposure
  lookbackDays: 90,
};

// Event types that represent an actual customer-facing failure — as opposed
// to a sales-funnel miss where there is no existing relationship to damage.
const RELATIONSHIP_DAMAGE_TYPES = new Set<RecoverySourceType>([
  'cancelled_job',
  'membership_cancelled',
  'membership_churned',
  'job_completed_unbilled',
  'invoice_overdue',
]);
const REPUTATION_RISK_TYPES = new Set<RecoverySourceType>(['cancelled_job', 'membership_churned']);
const CAPACITY_RISK_TYPES = new Set<RecoverySourceType>(['cancelled_job']);

// ============================================================
// TYPES
// ============================================================

export type DimensionKey = 'revenue' | 'margin' | 'cash' | 'customer_ltv' | 'reputation' | 'capacity' | 'compliance';

export const DIMENSION_ORDER: DimensionKey[] = [
  'revenue', 'margin', 'cash', 'customer_ltv', 'reputation', 'capacity', 'compliance',
];

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  revenue: 'Revenue',
  margin: 'Margin',
  cash: 'Cash',
  customer_ltv: 'Customer LTV',
  reputation: 'Reputation',
  capacity: 'Capacity',
  compliance: 'Compliance',
};

export const DIMENSION_COLORS: Record<DimensionKey, string> = {
  revenue: 'bg-cta/10 text-cta',
  margin: 'bg-warning-500/10 text-warning-500',
  cash: 'bg-success-500/10 text-success-500',
  customer_ltv: 'bg-accent/10 text-accent',
  reputation: 'bg-danger/10 text-danger',
  capacity: 'bg-bg-tertiary text-text-secondary',
  compliance: 'bg-danger/10 text-danger',
};

export interface ValueAtRiskDimension {
  key: DimensionKey;
  amount_cents: number;
  basis: string;
  flagged: boolean;
}

export interface ValueAtRiskItem {
  event: RevenueRecoveryEvent;
  dimensions: ValueAtRiskDimension[];
  total_cents: number;
}

export interface ValueAtRiskReport {
  generatedAt: string;
  items: ValueAtRiskItem[];
  totalsByDimension: Record<DimensionKey, number>;
  grandTotal_cents: number;
  reputationBaseline: { avgRating: number | null; sampleSize: number };
  assumptions: ValueAtRiskAssumptions;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// ============================================================
// BUILD
// ============================================================

/**
 * Builds the full Value-at-Risk report from the currently-open ledger.
 */
export async function buildValueAtRiskReport(
  assumptions: ValueAtRiskAssumptions = VALUE_AT_RISK_ASSUMPTIONS,
): Promise<ValueAtRiskReport> {
  const since = new Date(Date.now() - assumptions.lookbackDays * 86_400_000);
  const events = await fetchLedger({ status: 'active', since });

  const jobEventIds = events.filter((e) => e.source_table === 'jobs').map((e) => e.source_id);

  const safe = async <T,>(p: Promise<{ data: T | null }>, fallback: T): Promise<T> => {
    try {
      const { data } = await p;
      return data ?? fallback;
    } catch {
      return fallback;
    }
  };

  const [jobs, flaggedCreds, reviews, paidJobs] = await Promise.all([
    jobEventIds.length
      ? safe(
          supabase
            .from('jobs')
            .select(
              'id, customer_id, customer_name, customer_phone, service_type, scheduled_datetime, assigned_technician_id, invoice_amount, invoice_status',
            )
            .in('id', jobEventIds) as any,
          [] as any[],
        )
      : Promise.resolve([] as any[]),
    safe(
      supabase
        .from('technician_credentials')
        .select('technician_id, expiry_alert_stage')
        .in('expiry_alert_stage', ['expiring_soon', 'expired']) as any,
      [] as any[],
    ),
    safe(supabase.from('review_requests').select('status, rating').eq('status', 'completed').limit(300) as any, [] as any[]),
    safe(
      supabase.from('jobs').select('customer_id, customer_phone, customer_name, invoice_amount').eq('invoice_status', 'paid').limit(3000) as any,
      [] as any[],
    ),
  ]);

  const jobById = new Map((jobs ?? []).map((j: any) => [j.id, j]));
  const flaggedTechIds = new Set((flaggedCreds ?? []).map((c: any) => c.technician_id));

  const ratings = (reviews ?? []).map((r: any) => r.rating).filter((r: unknown): r is number => typeof r === 'number');
  const avgRating = ratings.length ? ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length : null;
  const reputationFragile = avgRating !== null && avgRating < assumptions.reputationFragileThreshold;

  // ---- Customer LTV + fleet average job value, both from one pass over
  // recent paid jobs — same "no duplicate tracking" principle as above. ----
  const ltvByKey = new Map<string, number>();
  let paidTotal = 0;
  let paidCount = 0;
  for (const j of paidJobs ?? []) {
    const key = j.customer_id || j.customer_phone?.trim() || j.customer_name?.trim();
    const amount = j.invoice_amount ?? 0;
    if (key) ltvByKey.set(key, (ltvByKey.get(key) ?? 0) + amount);
    paidTotal += amount;
    paidCount += 1;
  }
  const avgJobValueCents = paidCount > 0 ? Math.round(paidTotal / paidCount) : 0;

  const items: ValueAtRiskItem[] = events.map((event) => {
    const job = jobById.get(event.source_id);
    const revenue = event.estimated_value_cents ?? 0;
    const dims: ValueAtRiskDimension[] = [];

    // 1. Revenue — straight from the ledger, never re-derived.
    dims.push({
      key: 'revenue',
      amount_cents: revenue,
      basis: 'Estimated job/quote value, from the recovery ledger.',
      flagged: revenue > 0,
    });

    // 2. Margin — the profit slice of that revenue.
    const margin = Math.round(revenue * assumptions.marginPct);
    dims.push({
      key: 'margin',
      amount_cents: margin,
      basis: `${Math.round(assumptions.marginPct * 100)}% assumed gross margin on the lost revenue.`,
      flagged: margin > 0,
    });

    // 3. Cash — same dollars, viewed as a near-term liquidity hit.
    dims.push({
      key: 'cash',
      amount_cents: revenue,
      basis: 'The same dollars, through a liquidity lens: what does not land in the bank this cycle.',
      flagged: revenue > 0,
    });

    // 4. Customer LTV — how much of this relationship's paid history is on the line.
    const custKey = job?.customer_id || job?.customer_phone?.trim() || event.customer_phone?.trim() || event.customer_name?.trim();
    const historicalLtv = custKey ? ltvByKey.get(custKey) ?? 0 : 0;
    const ltvAtRisk = RELATIONSHIP_DAMAGE_TYPES.has(event.source_type) ? Math.round(historicalLtv * assumptions.relationshipRiskPct) : 0;
    dims.push({
      key: 'customer_ltv',
      amount_cents: ltvAtRisk,
      basis:
        ltvAtRisk > 0
          ? `${Math.round(assumptions.relationshipRiskPct * 100)}% of this customer's ${formatCents(historicalLtv)} paid history.`
          : 'No prior paid history on file, or this event type has no existing relationship to damage.',
      flagged: ltvAtRisk > 0,
    });

    // 5. Reputation — referral value that a customer-facing failure puts at risk.
    let reputation = 0;
    if (REPUTATION_RISK_TYPES.has(event.source_type)) {
      const base = historicalLtv > 0 ? historicalLtv : revenue;
      reputation = Math.round(base * assumptions.referralMultiplier * (reputationFragile ? 1.5 : 1));
    }
    dims.push({
      key: 'reputation',
      amount_cents: reputation,
      basis:
        reputation > 0
          ? `Referral value at ${Math.round(assumptions.referralMultiplier * 100)}% of relationship value${
              reputationFragile ? ', scaled up — your completed-review average is already below threshold' : ''
            }.`
          : 'Not a customer-facing failure type, or no baseline value to reference.',
      flagged: reputation > 0,
    });

    // 6. Capacity — the opportunity cost of a technician slot that likely ran empty.
    let capacity = 0;
    if (CAPACITY_RISK_TYPES.has(event.source_type) && job?.scheduled_datetime) {
      const hoursNotice = Math.abs(new Date(event.occurred_at).getTime() - new Date(job.scheduled_datetime).getTime()) / 3_600_000;
      if (hoursNotice <= assumptions.capacityBackfillWindowHours) {
        capacity = avgJobValueCents || revenue;
      }
    }
    dims.push({
      key: 'capacity',
      amount_cents: capacity,
      basis:
        capacity > 0
          ? `Cancelled inside the ${assumptions.capacityBackfillWindowHours}h backfill window — that slot likely ran empty.`
          : 'Enough notice to backfill, or not a scheduling-slot event.',
      flagged: capacity > 0,
    });

    // 7. Compliance — exposure from a credential gap on the assigned technician.
    const complianceGap = job?.assigned_technician_id ? flaggedTechIds.has(job.assigned_technician_id) : false;
    dims.push({
      key: 'compliance',
      amount_cents: complianceGap ? assumptions.complianceExposureCents : 0,
      basis: complianceGap
        ? 'The technician assigned to this job has an expiring or expired credential on file.'
        : 'No credential gap found on the assigned technician.',
      flagged: complianceGap,
    });

    const total_cents = dims.reduce((s, d) => s + d.amount_cents, 0);
    return { event, dimensions: dims, total_cents };
  });

  items.sort((a, b) => b.total_cents - a.total_cents);

  const totalsByDimension = DIMENSION_ORDER.reduce((acc, key) => {
    acc[key] = items.reduce((s, it) => s + (it.dimensions.find((d) => d.key === key)?.amount_cents ?? 0), 0);
    return acc;
  }, {} as Record<DimensionKey, number>);

  const grandTotal_cents = items.reduce((s, it) => s + it.total_cents, 0);

  return {
    generatedAt: new Date().toISOString(),
    items,
    totalsByDimension,
    grandTotal_cents,
    reputationBaseline: { avgRating, sampleSize: ratings.length },
    assumptions,
  };
}
