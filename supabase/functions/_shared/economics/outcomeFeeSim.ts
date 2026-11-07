// supabase/functions/_shared/economics/outcomeFeeSim.ts
//
// What-if ONLY: what an outcome-linked component (per booked job and/or share of recovered revenue) would have
// yielded on historical data versus the current subscription price. Integer cents/micro; no billing logic is touched.

export interface TenantMonth {
  tenantId: string; plan: string; planPriceCents: number; costMicro: number; bookedJobs: number; recoveredCents: number;
}
export interface FeeScenario { perBookedJobCents: number; recoveredShareBps: number; label: string }
export interface TenantSim { tenantId: string; plan: string; currentRevenueCents: number; feeCents: number; feePctOfPlan: number | null; marginBeforeCents: number; marginAfterCents: number }
export interface SimResult {
  label: string; tenants: number; currentRevenueCents: number; feeCents: number; costCents: number;
  marginBeforeCents: number; marginAfterCents: number; tenantsWhereFeeExceedsPlan: number; perTenant: TenantSim[];
}

const microToCents = (m: number) => Math.round(m / 10_000);

export function simulateOutcomeFee(rows: readonly TenantMonth[], sc: FeeScenario): SimResult {
  if (!(sc.perBookedJobCents >= 0) || !(sc.recoveredShareBps >= 0) || sc.recoveredShareBps > 10_000) throw new RangeError("invalid scenario");
  const per: TenantSim[] = rows.map((r) => {
    const fee = Math.round(r.bookedJobs * sc.perBookedJobCents + (r.recoveredCents * sc.recoveredShareBps) / 10_000);
    const cost = microToCents(r.costMicro);
    return {
      tenantId: r.tenantId, plan: r.plan, currentRevenueCents: r.planPriceCents, feeCents: fee,
      feePctOfPlan: r.planPriceCents > 0 ? (fee / r.planPriceCents) * 100 : null,
      marginBeforeCents: r.planPriceCents - cost, marginAfterCents: r.planPriceCents + fee - cost,
    };
  });
  const sum = (f: (t: TenantSim) => number) => per.reduce((s, t) => s + f(t), 0);
  return {
    label: sc.label, tenants: per.length, currentRevenueCents: sum((t) => t.currentRevenueCents), feeCents: sum((t) => t.feeCents),
    costCents: sum((t) => t.currentRevenueCents - t.marginBeforeCents), marginBeforeCents: sum((t) => t.marginBeforeCents),
    marginAfterCents: sum((t) => t.marginAfterCents),
    tenantsWhereFeeExceedsPlan: per.filter((t) => t.feePctOfPlan !== null && t.feePctOfPlan > 100).length, perTenant: per,
  };
}

/** Monthly call volume at which a plan's price just covers variable cost per call. null when cost/call is unknown or 0. */
export function breakEvenCalls(planPriceCents: number, fixedCostCents: number, microPerCall: number | null): number | null {
  if (microPerCall === null || !(microPerCall > 0)) return null;
  return Math.max(0, Math.floor(((planPriceCents - fixedCostCents) * 10_000) / microPerCall));
}
