/** Supplier Entitlement Audit — shared types. All money is integer cents; all dates are 'YYYY-MM-DD'. */

export type ProgramType = 'volume_rebate' | 'patronage' | 'co_op' | 'price_agreement' | 'warranty_credit';
export type ProgramStatus = 'draft' | 'active' | 'archived';
export type EnrollmentStatus = 'not_required' | 'enrolled' | 'not_enrolled' | 'unknown';
export type TierMode = 'retroactive_all' | 'marginal';

export type FindingType =
  | 'price_deviation'
  | 'rebate_owed'
  | 'rebate_accruing'
  | 'tier_gap'
  | 'unapplied_credit'
  | 'warranty_credit_missing'
  | 'warranty_credit_short'
  | 'coop_unclaimed'
  | 'duplicate_invoice';

export type ConfidenceBand = 'low' | 'medium' | 'high';
export type DeadlineRisk = 'none' | 'ok' | 'soon' | 'critical' | 'expired';
export type FindingStatus =
  | 'open' | 'packet_ready' | 'claimed' | 'partially_recovered' | 'recovered' | 'dismissed' | 'superseded';
export type ReviewStatus = 'auto_accepted' | 'needs_review' | 'confirmed' | 'rejected';

export interface Tier { thresholdCents: number; rateBps: number }
export interface PricePoint { sku: string; unitPriceCents: number }

/** Effective (rules + per-account override merged and validated) program used by the engine. */
export interface Program {
  id: string;
  vendorId: string;
  name: string;
  type: ProgramType;
  status: ProgramStatus;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  enrollment: EnrollmentStatus;
  claimDeadline: string | null;
  requiredDocuments: string[];
  documentsOnFile: string[];
  sourceUrl: string | null;
  lastVerifiedAt: string | null;
  tiers: Tier[];
  tierMode: TierMode;
  priceSchedule: PricePoint[];
  toleranceBps: number;
  toleranceCents: number;
  coopAccrualBps: number;
  coopCapCents: number | null;
  warnings: string[];
}

export interface StatementMeta {
  id: string;
  vendorId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  parseStatus: string;
  fileName: string | null;
}

export interface StatementLine {
  id: string;
  statementId: string;
  lineNo: number;
  invoiceNo: string | null;
  invoiceDate: string | null;
  sku: string | null;
  description: string | null;
  qty: number | null;
  unitPriceCents: number | null;
  extendedCents: number | null;
  isCredit: boolean;
  currency: string;
  confidence: number;
  reviewStatus: ReviewStatus;
}

export interface CreditMemo {
  id: string;
  vendorId: string;
  memoNo: string | null;
  memoDate: string | null;
  amountCents: number;
  appliedCents: number;
  currency: string;
  reason: 'rebate' | 'patronage' | 'co_op' | 'price_adjustment' | 'return' | 'warranty' | 'other';
  appliedStatus: 'unapplied' | 'partially_applied' | 'applied' | 'void';
  invoiceNo: string | null;
  programId: string | null;
  warrantyClaimId: string | null;
  confidence: number;
  needsReview: boolean;
}

export interface WarrantyClaimLite {
  id: string;
  vendorId: string | null;
  label: string;
  status: string;
  submittedAt: string | null; // date
  claimDeadline: string | null;
  claimedCents: number | null;
  approvedCents: number | null;
  creditReceivedCents: number | null;
}

export interface VendorBillLite {
  id: string;
  vendorId: string | null;
  billNumber: string | null;
  amountCents: number;
  billDate: string;
  status: string;
}

export interface RecoveryLite { findingDedupeKey: string; programId: string | null; amountCents: number }

export interface AuditSettings {
  minConfidence: number;        // lines below this need human review and are NEVER used in numbers
  creditGraceDays: number;      // an unapplied credit younger than this is not yet "late"
  warrantyGraceDays: number;    // days after submission before a missing warranty credit is flagged
  staleVerificationMonths: number;
}

export const DEFAULT_SETTINGS: AuditSettings = {
  minConfidence: 0.85,
  creditGraceDays: 30,
  warrantyGraceDays: 45,
  staleVerificationMonths: 12,
};

export interface AuditInput {
  now: Date;
  timeZone: string;
  vendors: { id: string; name: string }[];
  programs: Program[];
  statements: StatementMeta[];
  lines: StatementLine[];
  creditMemos: CreditMemo[];
  warrantyClaims: WarrantyClaimLite[];
  vendorBills: VendorBillLite[];
  settings?: Partial<AuditSettings>;
}

export interface EvidenceRef {
  kind: 'statement_line' | 'invoice' | 'credit_memo' | 'warranty_claim' | 'vendor_bill' | 'program' | 'statement';
  id: string;
  label: string;
  amountCents?: number;
  detail?: string;
}

export interface Finding {
  dedupeKey: string;
  type: FindingType;
  kind: string | null;
  vendorId: string;
  programId: string | null;
  warrantyClaimId: string | null;
  title: string;
  summary: string;
  lowCents: number;
  likelyCents: number;
  highCents: number;
  currency: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  deadline: string | null;
  deadlineRisk: DeadlineRisk;
  /** true = not recoverable money (accruing rebate, tier gap): shown separately, never summed into "estimated". */
  isOpportunity: boolean;
  evidence: EvidenceRef[];
  howCalculated: string[];
  warnings: string[];
  fingerprint: string;
  label: 'estimate';
}

export interface FindingRow {
  id: string;
  dedupe_key: string;
  status: FindingStatus;
  recovered_cents: number;
}
