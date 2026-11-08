// Pure reconciliation of Stripe's live subscriptions against subscription_facts (no I/O).
// MRR rules MUST mirror growth_mrr_cents() in supabase/migrations/20281103000000_growth_analytics_core.sql.

export interface StripeSubLite {
  id: string;
  status: string;
  currency: string | null;
  interval: string | null;
  intervalCount: number;
  unitAmount: number | null;
  quantity: number;
  /** percent_off of a coupon with duration 'forever' (the only discount applied to MRR). */
  percentOffForever: number | null;
  /** Any discount that is NOT a forever percent coupon: MRR from facts may legitimately differ. */
  hasOtherDiscount: boolean;
}

export interface FactLatest {
  stripe_subscription_id: string;
  status: string;
  mrr_cents: number;
  currency: string | null;
  discount_unresolved: boolean;
}

export type MismatchKind = 'missing_in_facts' | 'missing_in_stripe' | 'mrr_mismatch' | 'status_mismatch';

export interface Mismatch {
  kind: MismatchKind;
  subscription_id: string;
  stripe_status: string | null;
  fact_status: string | null;
  stripe_mrr_cents: number | null;
  fact_mrr_cents: number | null;
  explained_by_discount: boolean;
}

export interface ReconcileResult {
  totals: Record<string, { stripe_mrr_cents: number; facts_mrr_cents: number }>;
  mismatches: Mismatch[];
  unexplained: number;
  checked: number;
}

const PAYING = new Set(['active', 'past_due']);
const DEAD = new Set(['canceled', 'incomplete_expired']);

export function stripeMrrCents(s: StripeSubLite): number {
  if (!PAYING.has(s.status) || s.unitAmount === null || s.intervalCount <= 0) return 0;
  let monthly: number;
  if (s.interval === 'month') monthly = (s.unitAmount * s.quantity) / s.intervalCount;
  else if (s.interval === 'year') monthly = (s.unitAmount * s.quantity) / (12 * s.intervalCount);
  else return 0;
  if (s.percentOffForever !== null) monthly *= 1 - Math.min(Math.max(s.percentOffForever, 0), 100) / 100;
  return Math.round(monthly);
}

/**
 * `stripeListComplete` must be false when the Stripe listing was truncated; in that case "missing_in_stripe" is not
 * evaluated (it would produce false alarms).
 */
export function reconcile(stripe: StripeSubLite[], facts: FactLatest[], stripeListComplete: boolean): ReconcileResult {
  const byFact = new Map(facts.map((f) => [f.stripe_subscription_id, f]));
  const seen = new Set<string>();
  const mismatches: Mismatch[] = [];
  const totals: ReconcileResult['totals'] = {};
  const add = (cur: string | null, key: 'stripe_mrr_cents' | 'facts_mrr_cents', v: number) => {
    const c = cur ?? 'unknown';
    totals[c] ??= { stripe_mrr_cents: 0, facts_mrr_cents: 0 };
    totals[c][key] += v;
  };

  for (const s of stripe) {
    seen.add(s.id);
    const mrr = stripeMrrCents(s);
    add(s.currency, 'stripe_mrr_cents', mrr);
    const f = byFact.get(s.id);
    if (!f) {
      // A long-dead subscription that never produced an event we stored is not a data gap.
      if (DEAD.has(s.status) && mrr === 0) continue;
      mismatches.push({ kind: 'missing_in_facts', subscription_id: s.id, stripe_status: s.status, fact_status: null,
        stripe_mrr_cents: mrr, fact_mrr_cents: null, explained_by_discount: false });
      continue;
    }
    const discountNote = s.hasOtherDiscount || f.discount_unresolved;
    if (f.status !== s.status) {
      mismatches.push({ kind: 'status_mismatch', subscription_id: s.id, stripe_status: s.status, fact_status: f.status,
        stripe_mrr_cents: mrr, fact_mrr_cents: f.mrr_cents, explained_by_discount: false });
    } else if (f.mrr_cents !== mrr) {
      mismatches.push({ kind: 'mrr_mismatch', subscription_id: s.id, stripe_status: s.status, fact_status: f.status,
        stripe_mrr_cents: mrr, fact_mrr_cents: f.mrr_cents, explained_by_discount: discountNote });
    }
  }

  for (const f of facts) {
    add(f.currency, 'facts_mrr_cents', f.mrr_cents);
    if (stripeListComplete && !seen.has(f.stripe_subscription_id) && f.mrr_cents > 0) {
      mismatches.push({ kind: 'missing_in_stripe', subscription_id: f.stripe_subscription_id, stripe_status: null,
        fact_status: f.status, stripe_mrr_cents: null, fact_mrr_cents: f.mrr_cents, explained_by_discount: false });
    }
  }

  return {
    totals,
    mismatches,
    unexplained: mismatches.filter((m) => !m.explained_by_discount).length,
    checked: stripe.length,
  };
}
