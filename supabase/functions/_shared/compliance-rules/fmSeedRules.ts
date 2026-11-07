// supabase/functions/_shared/compliance-rules/fmSeedRules.ts
//
// Starter Rule Pack for the "fm_submission" surface: ServiceChannel Managed
// (SCM) trade-partner rules, drafted from the official 2026 Trade Partner Guide.
// Seeded as "in_review": NOTHING is enforced until a staff reviewer approves it
// (Compliance -> Rule review). Rules that could not be confirmed in the guide are
// marked "UNVERIFIED" in their source note and use the weakest severity.
//
// Scope: these are the platform's published defaults for the ServiceChannel
// Managed program. A given customer may require more or less — customer-specific
// packs are NOT part of this seed.

import type { RuleKind, Severity, SourceRef, Surface } from "./types.ts";

export interface FmSeedRule {
  packSlug: string;
  packName: string;
  ruleKey: string;
  jurisdiction: "US";
  kind: RuleKind;
  severity: Severity;
  appliesTo: Surface[];
  title: string;
  ownerExplanation: string;
  params: Record<string, unknown>;
  sourceRefs: SourceRef[];
}

export const FM_SEED_EFFECTIVE_FROM = "2026-11-04";
export const FM_PACK_SLUG = "servicechannel-managed-2026";
const PACK_NAME = "ServiceChannel Managed (2026 Trade Partner Guide)";
const GUIDE_URL = "https://servicechannel.com/wp-content/uploads/2025/10/Trade-Partner-Guidelines-2026.pdf";
const GUIDE = "ServiceChannel Trade Partner 2026 Guide for Success";
const RETRIEVED = "2026-11-04";
const REVIEW = "Page number from the 2026 edition read on 2026-11-04 — reviewer must confirm against the current guide.";

const guideRef = (page: string, note: string): SourceRef => ({
  citation: `${GUIDE}, ${page}`, type: "other", url: GUIDE_URL, retrievedOn: RETRIEVED, note: `${note} ${REVIEW}`,
});

const base = { packSlug: FM_PACK_SLUG, packName: PACK_NAME, jurisdiction: "US" as const, appliesTo: ["fm_submission"] as Surface[] };

export const FM_SEED_RULES: FmSeedRule[] = [
  {
    ...base, ruleKey: "sc-nte-cap", kind: "fm_nte_cap", severity: "block",
    title: "ServiceChannel: invoice may not exceed the NTE",
    ownerExplanation: "ServiceChannel will not accept an invoice above the work order's current NTE (not-to-exceed). To bill more, you need an approved proposal that raises the NTE first. Vireek checks the invoice total against the NTE before you send it.",
    params: { documentTypes: ["invoice"] },
    sourceRefs: [guideRef("p. 15", "Invoice may not exceed the NTE."),
      { citation: "ServiceChannel University (provider): Invoices", type: "other", url: "https://servicechannel.atlassian.net/wiki/spaces/SCUCP/pages/614924513/Invoices", retrievedOn: RETRIEVED }],
  },
  {
    ...base, ruleKey: "sc-parts-need-proposal", kind: "fm_proposal_before_parts", severity: "warn",
    title: "ServiceChannel: get a proposal approved before ordering parts above the NTE",
    ownerExplanation: "When parts would push the job above the NTE, the customer expects an approved proposal before you commit to them. Vireek warns before you place a parts order that would exceed the NTE with no approved proposal.",
    params: { documentTypes: ["parts_order"] },
    sourceRefs: [guideRef("p. 10", "The guide confirms check-in is blocked until a proposal is approved. UNVERIFIED: no explicit 'approval before ordering parts' sentence was located — confirm per customer.")],
  },
  {
    ...base, ruleKey: "sc-invoice-within-10-days", kind: "fm_invoice_deadline", severity: "warn",
    title: "ServiceChannel: invoice within 10 days of Completed/Confirmed",
    ownerExplanation: "ServiceChannel expects the invoice within 10 days of the work order reaching Completed/Confirmed. Vireek counts calendar days from that date and warns you before the window closes.",
    params: { days: 10, warnDays: 3, anchor: "work_confirmed", documentTypes: ["invoice"] },
    sourceRefs: [guideRef("pp. 9, 15", "10-day invoicing window counted from Completed/Confirmed; ServiceChannel's own learning page calls it a best practice."),
      { citation: "ServiceChannel Learning Channel: Invoice promptly to get paid fast", type: "other", url: "https://servicechannel.com/learning-channel/get-paid-faster/", retrievedOn: RETRIEVED }],
  },
  {
    ...base, ruleKey: "sc-ineligible-after-90-days", kind: "fm_ineligibility_window", severity: "require",
    title: "ServiceChannel: not invoiced within 90 days becomes ineligible for billing",
    ownerExplanation: "A work order that is not invoiced within 90 days can become ineligible for billing, so the money is lost. Vireek counts the days and tells you in time to invoice or ask the customer for an exception.",
    params: { days: 90, warnDays: 14, anchor: "work_received", documentTypes: ["invoice"] },
    sourceRefs: [guideRef("p. 15", "Ineligible after 90 days. UNVERIFIED: the guide and a ServiceChannel learning page word this differently ('becomes' vs 'may be') and do not state the start date precisely. The window is counted from the day the work order was RECEIVED (the earliest, safest start; same as Work-Order Guard) — reviewer to confirm whether Completed/Confirmed applies instead.")],
  },
  {
    ...base, ruleKey: "sc-no-sales-tax-billing-portal", kind: "fm_prohibited_line_item", severity: "block",
    title: "ServiceChannel: no sales tax line when you bill ServiceChannel",
    ownerExplanation: "Invoices billed to ServiceChannel are rejected if they contain a sales tax line. If you bill the customer directly, tax can be allowed, so Vireek only applies this rule when the billing party is ServiceChannel.",
    params: { categories: ["sales_tax"], appliesWhenBilling: "portal", documentTypes: ["invoice"] },
    sourceRefs: [guideRef("p. 15", "Sales tax is rejected when billing ServiceChannel; allowed when billing the customer directly.")],
  },
  {
    ...base, ruleKey: "sc-no-new-business-fees", kind: "fm_prohibited_line_item", severity: "block",
    title: "ServiceChannel: no \"New Business Fee\" lines on proposals or invoices",
    ownerExplanation: "ServiceChannel does not allow New Business Fees as line items. Proposals that contain one are rejected automatically. Vireek flags the line so you can remove it before sending.",
    params: { categories: ["new_business_fee"], documentTypes: ["invoice", "proposal"] },
    sourceRefs: [guideRef("pp. 13, 15", "New Business Fees may not appear as line items on proposals or invoices.")],
  },
  {
    ...base, ruleKey: "sc-one-invoice-per-work-order", kind: "fm_single_invoice", severity: "block",
    title: "ServiceChannel: one invoice per work order",
    ownerExplanation: "ServiceChannel accepts one invoice for each work order. A second invoice is refused, and a rejected invoice cannot be edited. Vireek stops you from creating a duplicate.",
    params: { documentTypes: ["invoice"] },
    sourceRefs: [guideRef("p. 15", "One invoice per work order.")],
  },
  {
    ...base, ruleKey: "sc-subcontractor-invoice-attached", kind: "fm_required_attachment", severity: "require",
    title: "ServiceChannel: attach the subcontractor's invoice",
    ownerExplanation: "When a subcontractor did part of the work, ServiceChannel expects their invoice attached to yours. Vireek reminds you when a subcontractor is involved and nothing is attached.",
    params: { attachment: "subcontractor_invoice", label: "Subcontractor invoice", condition: "has_subcontractor", documentTypes: ["invoice"] },
    sourceRefs: [guideRef("p. 15", "Attach subcontractor invoices.")],
  },
];
