/**
 * Commercial pack — "is this visit covered?" (PURE). Inputs mirror the existing Service Agreement tables
 * (commercial_contracts, agreement_assets, agreement_entitlements, agreement_visits); this function never queries.
 */

export type ContractStatus = 'draft' | 'active' | 'expiring_soon' | 'expired' | 'terminated' | 'renewed';
export type CoverageLevel = 'full' | 'labor_only' | 'parts_only' | 'inspection_only' | 'excluded';
export type VisitKind = 'pm_visit' | 'service_call' | 'emergency_call' | 'labor_hours';
export type WorkScope = 'labor' | 'parts' | 'inspection';

export interface CoverageContract { status: ContractStatus; startDate: string | null; endDate: string | null }
export interface CoveredAsset { siteId: string | null; equipmentId: string | null; level: CoverageLevel }
export interface EntitlementState { kind: VisitKind; included: number; used: number; overageRateCents: number | null }

export interface CoverageQuery {
  /** Date of the visit, YYYY-MM-DD. */
  onDate: string;
  siteId?: string | null;
  equipmentId?: string | null;
  kind: VisitKind;
  /** Units consumed (visits, or hours for labor_hours). */
  quantity?: number;
}

export type ReasonCode =
  | 'contract_inactive' | 'outside_term' | 'asset_not_in_scope' | 'asset_excluded' | 'whole_customer_scope'
  | 'kind_not_included' | 'entitlement_exhausted' | 'overage_billable' | 'labor_not_covered' | 'parts_not_covered';

export interface CoverageVerdict {
  verdict: 'covered' | 'covered_overage' | 'not_covered';
  /** Does the agreement pay for labor / parts on this visit? */
  laborCovered: boolean;
  partsCovered: boolean;
  coveredQuantity: number;
  /** Units beyond what the entitlement still includes: billed at `overageCents` when the contract sets an overage rate, otherwise at standard rates. */
  overageQuantity: number;
  overageCents: number;
  /** Units left in the period after this visit; null when not applicable. */
  remainingAfter: number | null;
  reasons: ReasonCode[];
}

const none = (reasons: ReasonCode[]): CoverageVerdict => ({
  verdict: 'not_covered', laborCovered: false, partsCovered: false, coveredQuantity: 0, overageQuantity: 0, overageCents: 0, remainingAfter: null, reasons,
});

export function checkVisitCoverage(c: CoverageContract, assets: CoveredAsset[], ent: EntitlementState[], q: CoverageQuery): CoverageVerdict {
  const qty = q.quantity ?? 1;
  if (!(qty > 0)) throw new RangeError('quantity must be positive');
  if (c.status !== 'active' && c.status !== 'expiring_soon') return none(['contract_inactive']);
  if ((c.startDate && q.onDate < c.startDate) || (c.endDate && q.onDate > c.endDate)) return none(['outside_term']);

  const reasons: ReasonCode[] = [];
  let level: CoverageLevel = 'full';
  if (assets.length === 0) {
    reasons.push('whole_customer_scope');
  } else {
    // Most specific match wins: the exact equipment row, then the site row.
    const match = (q.equipmentId && assets.find((a) => a.equipmentId === q.equipmentId))
      || (q.siteId && assets.find((a) => a.equipmentId == null && a.siteId === q.siteId))
      || null;
    if (!match) return none(['asset_not_in_scope']);
    if (match.level === 'excluded') return none(['asset_excluded']);
    level = match.level;
  }

  const e = ent.find((x) => x.kind === q.kind);
  if (!e) return none([...reasons, 'kind_not_included']);
  const left = Math.max(0, e.included - e.used);
  const coveredQty = Math.min(qty, left);
  const overQty = qty - coveredQty;
  const laborCovered = level === 'full' || level === 'labor_only';
  const partsCovered = level === 'full' || level === 'parts_only';
  if (!laborCovered) reasons.push('labor_not_covered');
  if (!partsCovered) reasons.push('parts_not_covered');

  if (coveredQty === 0) {
    if (e.overageRateCents == null) return none([...reasons, 'entitlement_exhausted']);
    return {
      verdict: 'covered_overage', laborCovered: false, partsCovered: false, coveredQuantity: 0, overageQuantity: overQty,
      overageCents: Math.round(overQty * e.overageRateCents), remainingAfter: 0, reasons: [...reasons, 'entitlement_exhausted', 'overage_billable'],
    };
  }
  if (overQty > 0 && e.overageRateCents == null) {
    // Part of the request fits, the rest is simply not covered.
    return {
      verdict: 'covered', laborCovered, partsCovered, coveredQuantity: coveredQty, overageQuantity: overQty, overageCents: 0, remainingAfter: 0,
      reasons: [...reasons, 'entitlement_exhausted'],
    };
  }
  return {
    verdict: overQty > 0 ? 'covered_overage' : 'covered', laborCovered, partsCovered, coveredQuantity: coveredQty, overageQuantity: overQty,
    overageCents: overQty > 0 ? Math.round(overQty * (e.overageRateCents ?? 0)) : 0, remainingAfter: Math.max(0, left - coveredQty),
    reasons: overQty > 0 ? [...reasons, 'overage_billable'] : reasons,
  };
}
