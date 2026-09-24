/**
 * Invisible Revenue Map — client library.
 *
 * No new tables, no AI call, no fabricated numbers. Pulls four kinds of
 * not-yet-in-pipeline revenue straight from data that already exists:
 *
 *   asset_risk       <- equipment_maintenance_alerts (Equipment Lifecycle)
 *   capacity_gap      <- capacityDemand.fetchCapacityStatus (Capacity Demand)
 *   churn_upsell       <- jobs + customers, same cadence math as
 *                         CustomerIntelligencePage (LTV / avg cycle / risk)
 *   referral_candidate <- the same customer aggregation, filtered to
 *                         healthy/VIP customers with no referral_codes row
 *                         yet — the one genuinely missing signal; everything
 *                         else already exists elsewhere in the app.
 *
 * Dollar estimates are only shown where they come from real numbers
 * (a customer's own paid history, or your own recent average job value).
 * Where there's nothing honest to anchor a number to, it's left blank
 * rather than guessed.
 */

import { supabase } from '@/lib/supabase';
import { fetchCapacityStatus } from '@/lib/capacityDemand';

// ============================================================
// TYPES
// ============================================================

export type OpportunityType = 'asset_risk' | 'capacity_gap' | 'churn_upsell' | 'referral_candidate';

export interface RevenueOpportunity {
  id: string;
  type: OpportunityType;
  customerName: string | null;
  title: string;
  detail: string;
  estimatedValue: number | null;
  nextAction: string;
  actionHref: string;
}

export interface RevenueMapReport {
  generatedAt: string;
  totalEstimatedValue: number;
  opportunities: RevenueOpportunity[];
}

export const TYPE_LABELS: Record<OpportunityType, string> = {
  asset_risk: 'Assets heading toward failure or replacement',
  capacity_gap: 'Open capacity you could be selling',
  churn_upsell: 'Customers overdue for their next service',
  referral_candidate: 'Happy customers worth asking for a referral',
};

// ============================================================
// HELPERS
// ============================================================

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function formatDate(iso: string | null): string {
  if (!iso) return 'unknown date';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================
// BUILD
// ============================================================

export async function buildRevenueMap(): Promise<RevenueMapReport> {
  const opportunities: RevenueOpportunity[] = [];

  const [
    alertsRes,
    jobsRes,
    customersRes,
    referralCodesRes,
  ] = await Promise.all([
    supabase.from('equipment_maintenance_alerts')
      .select('id, equipment_id, risk_level, predicted_issue, recommended_action, predicted_service_due')
      .eq('is_dismissed', false)
      .order('risk_level', { ascending: false })
      .limit(50),
    supabase.from('jobs')
      .select('id, customer_id, customer_name, customer_phone, invoice_amount, invoice_status, created_at')
      .order('created_at', { ascending: true })
      .limit(3000),
    supabase.from('customers').select('id, name, phone, lifecycle_stage'),
    supabase.from('referral_codes').select('customer_id'),
  ]);

  // ---- Recent average paid job value — the one honest $ anchor we reuse ----
  const paidAmounts = (jobsRes.data ?? [])
    .filter((j) => j.invoice_status === 'paid' && typeof j.invoice_amount === 'number')
    .slice(-200)
    .map((j) => j.invoice_amount as number);
  const avgJobValue = paidAmounts.length > 0 ? paidAmounts.reduce((s, v) => s + v, 0) / paidAmounts.length : null;

  // ---- 1) Asset risk — straight from Equipment Lifecycle's own alerts -----
  if (alertsRes.data && alertsRes.data.length > 0) {
    const equipmentIds = alertsRes.data.map((a) => a.equipment_id);
    const { data: equipmentRows } = await supabase
      .from('equipment')
      .select('id, customer_id, equipment_type, make, model')
      .in('id', equipmentIds);
    const customerIds = (equipmentRows ?? []).map((e) => e.customer_id).filter(Boolean);
    const { data: ownerRows } = customerIds.length
      ? await supabase.from('customers').select('id, name').in('id', customerIds)
      : { data: [] as { id: string; name: string }[] };

    const equipmentById = new Map((equipmentRows ?? []).map((e) => [e.id, e]));
    const customerById = new Map((ownerRows ?? []).map((c) => [c.id, c.name]));

    for (const a of alertsRes.data) {
      if (a.risk_level === 'low') continue; // only medium/high earn a spot on the map
      const eq = equipmentById.get(a.equipment_id);
      const customerName = eq ? customerById.get(eq.customer_id) ?? null : null;
      opportunities.push({
        id: `asset_${a.id}`,
        type: 'asset_risk',
        customerName,
        title: eq ? `${eq.make ?? ''} ${eq.model ?? eq.equipment_type}`.trim() : 'Equipment',
        detail: `${a.predicted_issue}${a.predicted_service_due ? ` — service window opens ${formatDate(a.predicted_service_due)}` : ''}`,
        estimatedValue: null,
        nextAction: a.recommended_action || 'Reach out before this becomes an emergency call.',
        actionHref: '/dashboard/equipment-lifecycle',
      });
    }
  }

  // ---- Customer aggregation, same cadence math CustomerIntelligencePage uses ----
  const customersById = new Map((customersRes.data ?? []).map((c) => [c.id, c]));
  const customersByPhone = new Map((customersRes.data ?? []).filter((c) => c.phone).map((c) => [c.phone!.trim(), c]));

  type Agg = { key: string; customerId: string | null; name: string; phone: string | null; ltv: number; dates: string[] };
  const byCustomer = new Map<string, Agg>();
  for (const job of jobsRes.data ?? []) {
    const key = job.customer_id || job.customer_phone?.trim() || job.customer_name?.trim();
    if (!key) continue;
    const paid = job.invoice_status === 'paid' ? job.invoice_amount ?? 0 : 0;
    const existing = byCustomer.get(key);
    if (!existing) {
      byCustomer.set(key, { key, customerId: job.customer_id, name: job.customer_name, phone: job.customer_phone, ltv: paid, dates: [job.created_at] });
    } else {
      existing.ltv += paid;
      existing.dates.push(job.created_at);
      if (!existing.customerId && job.customer_id) existing.customerId = job.customer_id;
    }
  }

  const now = new Date();
  const referredIds = new Set((referralCodesRes.data ?? []).map((r) => r.customer_id).filter(Boolean));

  for (const agg of byCustomer.values()) {
    const sortedDates = [...agg.dates].sort();
    const jobCount = sortedDates.length;
    const lastJobAt = sortedDates[sortedDates.length - 1];
    const daysSinceLastJob = daysBetween(now, new Date(lastJobAt));

    let avgCycleDays: number | null = null;
    if (jobCount >= 2) {
      let totalGap = 0;
      for (let i = 1; i < sortedDates.length; i++) totalGap += daysBetween(new Date(sortedDates[i]), new Date(sortedDates[i - 1]));
      avgCycleDays = Math.round(totalGap / (sortedDates.length - 1));
    }

    const matched = (agg.customerId && customersById.get(agg.customerId)) || (agg.phone && customersByPhone.get(agg.phone.trim())) || null;
    const perJobValue = jobCount > 0 && agg.ltv > 0 ? agg.ltv / jobCount : null;

    // ---- 2) Churn / upsell — overdue relative to THEIR OWN rhythm --------
    if (avgCycleDays !== null && matched?.lifecycle_stage !== 'inactive') {
      const cycle = Math.max(avgCycleDays, 14);
      const ratio = daysSinceLastJob / cycle;
      if (ratio > 1.25 && ratio <= 3) {
        opportunities.push({
          id: `upsell_${agg.key}`,
          type: 'churn_upsell',
          customerName: agg.name,
          title: `${agg.name} is overdue for their next visit`,
          detail: `They normally come back every ~${avgCycleDays} days — it's been ${daysSinceLastJob}.`,
          estimatedValue: perJobValue,
          nextAction: 'A quick check-in call or text, before they call a competitor instead.',
          actionHref: '/dashboard/customer-intelligence',
        });
      }
    }

    // ---- 3) Referral candidates — healthy/VIP, proven, never asked -------
    const isHealthy = matched?.lifecycle_stage === 'vip' || (avgCycleDays !== null && daysSinceLastJob / Math.max(avgCycleDays, 14) <= 1.25);
    if (matched && isHealthy && jobCount >= 2 && agg.ltv > 0 && !referredIds.has(matched.id)) {
      opportunities.push({
        id: `referral_${agg.key}`,
        type: 'referral_candidate',
        customerName: agg.name,
        title: `${agg.name} — never asked for a referral`,
        detail: `${jobCount} paid jobs on file, no referral code issued to them yet.`,
        estimatedValue: null,
        nextAction: 'Send them their referral link on the next visit or invoice.',
        actionHref: '/dashboard/marketing',
      });
    }
  }

  // ---- 4) Capacity — next 7 days, reusing the Capacity Demand engine -----
  const capacityChecks = await Promise.all(
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() + i + 1);
      return fetchCapacityStatus(d.toISOString().slice(0, 10)).catch(() => null);
    })
  );
  for (const c of capacityChecks) {
    if (!c || c.status !== 'low' || c.normal_slots_remaining <= 0) continue;
    opportunities.push({
      id: `capacity_${c.date}`,
      type: 'capacity_gap',
      customerName: null,
      title: `${c.normal_slots_remaining} open slot${c.normal_slots_remaining === 1 ? '' : 's'} on ${formatDate(c.date)}`,
      detail: `Day is running at ${c.load_pct ?? '?'}% of capacity.`,
      estimatedValue: avgJobValue !== null ? avgJobValue * c.normal_slots_remaining : null,
      nextAction: 'Push a same-week promo or call your waitlist to fill it.',
      actionHref: '/dashboard/capacity-demand',
    });
  }

  const totalEstimatedValue = opportunities.reduce((s, o) => s + (o.estimatedValue ?? 0), 0);

  return { generatedAt: new Date().toISOString(), totalEstimatedValue, opportunities };
}
