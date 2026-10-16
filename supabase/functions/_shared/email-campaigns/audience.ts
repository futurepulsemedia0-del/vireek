// supabase/functions/_shared/email-campaigns/audience.ts
//
// Pure compliance gate for bulk email. Given resolved segment members, decides
// who may actually be emailed and records WHY everyone else was excluded, so the
// dashboard can show an honest "N eligible, M excluded (reason)" before sending.

export interface Contact {
  customer_id?: string;
  lead_id?: string;
  email: string | null;
  name: string | null;
}

export type ExclusionReason =
  | "no_email"
  | "invalid_email"
  | "suppressed"
  | "not_opted_in"
  | "lead_no_consent"
  | "duplicate";

export interface EligibleRecipient {
  customer_id: string;
  email: string;
  name: string | null;
}

export interface AudienceAnalysis {
  total: number;
  eligible: EligibleRecipient[];
  excluded: Record<ExclusionReason, number>;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/**
 * Rules (all must pass):
 *  - has a syntactically valid email
 *  - not on the account's suppression list (unsubscribed / bounced / complained)
 *  - is a CUSTOMER with customers.marketing_opt_in = true. Leads carry no
 *    consent record, so they are never bulk-emailed.
 *  - one message per address per campaign
 */
export function analyzeAudience(
  contacts: Contact[],
  suppressed: Set<string>,
  optedInCustomerIds: Set<string>,
): AudienceAnalysis {
  const excluded: Record<ExclusionReason, number> = {
    no_email: 0,
    invalid_email: 0,
    suppressed: 0,
    not_opted_in: 0,
    lead_no_consent: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  const eligible: EligibleRecipient[] = [];

  for (const c of contacts) {
    const email = normalizeEmail(c.email);
    if (!email) { excluded.no_email++; continue; }
    if (!isValidEmail(email)) { excluded.invalid_email++; continue; }
    if (suppressed.has(email)) { excluded.suppressed++; continue; }
    if (!c.customer_id) { excluded.lead_no_consent++; continue; }
    if (!optedInCustomerIds.has(c.customer_id)) { excluded.not_opted_in++; continue; }
    if (seen.has(email)) { excluded.duplicate++; continue; }
    seen.add(email);
    eligible.push({ customer_id: c.customer_id, email, name: c.name });
  }

  return { total: contacts.length, eligible, excluded };
}
