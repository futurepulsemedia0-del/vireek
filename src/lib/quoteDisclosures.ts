import { fetchCatalog, fetchProfile } from '@/lib/complianceRules';
import {
  buildQuoteDisclosures,
  unavailableDisclosures,
  type QuoteDisclosures,
} from '../../supabase/functions/_shared/compliance-rules/estimateDisclosures';
import { buildQuoteDocInput, type QuotePdfSource } from '@/lib/quotePdf';

/**
 * Loads the account's compliance profile and the counsel-approved rule catalog, then builds the required
 * notices, license lines and missing-field warnings for one quote. Never throws: if the rules cannot be
 * loaded the result carries a visible `rules_unavailable` warning instead (the quote still renders).
 *
 * NOT LEGAL ADVICE: only text supplied by approved, legally reviewed rule versions is ever returned.
 */
export async function loadQuoteDisclosures(q: QuotePdfSource, accountOwnerId: string): Promise<QuoteDisclosures> {
  try {
    const [rules, profile] = await Promise.all([fetchCatalog(), fetchProfile(accountOwnerId)]);
    const doc = buildQuoteDocInput(q, null, { recommended: '', selected: '' });
    const top = doc.groups.reduce((a, g) => (g.totalCents > a.totalCents ? g : a), doc.groups[0]!);
    return buildQuoteDisclosures({
      rules,
      businessState: profile?.business_state ?? null,
      licenses: profile?.licenses ?? [],
      serviceAddress: q.service_address,
      customerPhone: q.customer_phone,
      totalCents: top.totalCents,
      depositCents: top.depositCents > 0 ? top.depositCents : undefined,
    });
  } catch {
    return unavailableDisclosures('Compliance rules could not be loaded, so state-specific notices were not added to this quote.');
  }
}

/** Shape expected by buildQuoteDocInput / downloadQuotePdf. */
export function toQuotePdfDisclosures(d: QuoteDisclosures) {
  return { clauses: d.clauses.map((c) => ({ title: c.title, text: c.text })), licenseLines: d.licenseLines };
}
