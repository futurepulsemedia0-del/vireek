// Marketing-safe claims (Task E). READ-ONLY, PURE. Emits only claims the account's own data supports, with qualifiers.
// No causal wording. No cross-customer figure unless anonymized + thresholded, and then it is flagged [VERIFY].
import type { BaselineComparison } from './invoiceAttribution.ts';

export interface AccountProof {
  currency: string;
  periodsObserved: number;
  outcomeCount: number;
  recoveredCents: number;
  comparison: BaselineComparison | null;
}

export interface Claim {
  id: 'recovered_after_followup' | 'days_to_payment_lower' | 'first_pass_higher';
  text: string;
  qualifiers: string[];
  basis: 'own_data';
}

export const MIN_OUTCOMES_FOR_CLAIM = 5;

const money = (cents: number, currency: string): string => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
};

const OBS = 'Observational comparison of this account only; it does not show that Vireek caused the change.';

export function generateOwnClaims(p: AccountProof, minOutcomes = MIN_OUTCOMES_FOR_CLAIM): Claim[] {
  const out: Claim[] = [];
  if (p.periodsObserved >= 1 && p.outcomeCount >= minOutcomes && p.recoveredCents > 0) {
    out.push({
      id: 'recovered_after_followup',
      text: `Over ${p.periodsObserved} month(s), ${money(p.recoveredCents, p.currency)} in payments was recorded on ${p.outcomeCount} overdue invoices after a logged Vireek follow-up.`,
      qualifiers: [
        'Counts only invoices that met Vireek\'s written attribution rules and were not contested.',
        'Payment followed the action; this does not prove it would not have arrived otherwise.',
        'Based on this account\'s own records.',
      ],
      basis: 'own_data',
    });
  }
  const c = p.comparison;
  if (c && c.status === 'compared') {
    if (c.dso.sample === 'adequate' && c.dso.change === 'observed_lower' && c.dso.baseline !== null && c.dso.current !== null) {
      out.push({
        id: 'days_to_payment_lower',
        text: `Average days to payment was ${c.dso.baseline.toFixed(1)} before Vireek and ${c.dso.current.toFixed(1)} after (n=${c.dso.baselineN} and ${c.dso.currentN}).`,
        qualifiers: [OBS, 'Seasonality, customer mix and other changes can also move this number.'],
        basis: 'own_data',
      });
    }
    if (c.firstPass.sample === 'adequate' && c.firstPass.change === 'observed_higher' && c.firstPass.baseline !== null && c.firstPass.current !== null) {
      out.push({
        id: 'first_pass_higher',
        text: `First-pass invoice acceptance rose from ${(c.firstPass.baseline * 100).toFixed(0)}% to ${(c.firstPass.current * 100).toFixed(0)}% (n=${c.firstPass.baselineN} and ${c.firstPass.currentN}; intervals do not overlap).`,
        qualifiers: [OBS, 'Payer rules and invoice mix can also move this number.'],
        basis: 'own_data',
      });
    }
  }
  return out;
}

export interface BenchmarkClaim {
  text: string;
  flags: ['[VERIFY]', '[COUNSEL]'];
  accounts: number;
}

/** Cross-customer figure: one value per DISTINCT account, median only, >= minAccounts, else null. */
export function benchmarkClaim(perAccountValues: readonly number[], metricLabel: string, minAccounts = 10): BenchmarkClaim | null {
  const vals = perAccountValues.filter((v) => Number.isFinite(v));
  if (vals.length < minAccounts) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return {
    text: `Across ${s.length} accounts, the median ${metricLabel} was ${median.toFixed(1)}. Anonymized; accounts are not identifiable.`,
    flags: ['[VERIFY]', '[COUNSEL]'],
    accounts: s.length,
  };
}
