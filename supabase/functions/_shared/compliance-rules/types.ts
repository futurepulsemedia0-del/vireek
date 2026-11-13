// supabase/functions/_shared/compliance-rules/types.ts
//
// Regulation-as-code: shared types. Pure TypeScript, zero dependencies — runs
// unchanged in Deno (edge functions), Node (Vitest) and the browser (the
// dashboard simulator imports the exact engine the server enforces).
//
// NOT LEGAL ADVICE. Rule packs are a compliance aid. Every rule version must
// be reviewed by qualified counsel before it is approved (see the staff review
// workflow in supabase/migrations/20271110000000_compliance_rule_packs.sql).
  import type { FmFacts, FmFix } from "./fmSubmission.ts";

export const RULE_KINDS = [
  "recording_consent",
  "ai_disclosure",
  "quiet_hours",
  "consent_required",
  "license_display",
  "rescission",
  "required_notice",
  "price_cap",
  "deposit_limit",
  "written_contract_threshold",
    "fm_nte_cap",
    "fm_proposal_before_parts",
    "fm_invoice_deadline",
    "fm_ineligibility_window",
    "fm_prohibited_line_item",
    "fm_single_invoice",
    "fm_required_attachment",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const SURFACES = ["call", "sms", "email", "quote", "contract", "fm_submission"] as const;
export type Surface = (typeof SURFACES)[number];

export type Purpose = "marketing" | "service" | "emergency";

/** block = cannot proceed until fixed; require = must do an action; warn/info = advisory. */
export type Severity = "block" | "require" | "warn" | "info";

export type VersionStatus = "draft" | "in_review" | "approved" | "rejected" | "retired";

export type ConsentType =
  | "call_recording"
  | "marketing_sms"
  | "marketing_email"
  | "data_processing"
  | "marketing_call"
  | "ai_voice";
export type ConsentState = "granted" | "revoked" | "none";

export type MatchOn = "either" | "counterparty" | "business";

export interface SourceRef {
  citation: string;
  type: "statute" | "regulation" | "agency_guidance" | "case_law" | "other";
  url?: string;
  note?: string;
  /** YYYY-MM-DD the reviewer last verified the source text. */
  retrievedOn?: string;
}

/** One immutable, effective-dated version of one rule in one jurisdiction. */
export interface RuleVersion {
  id: string;
  /** Pack slug, e.g. "us-fl". */
  packSlug: string;
  ruleKey: string;
  version: number;
  /** "US" (federal) or "US-XX" (state / DC). */
  jurisdiction: string;
  kind: RuleKind;
  severity: Severity;
  appliesTo: Surface[];
  title: string;
  /** Plain-language explanation shown to the account owner. */
  ownerExplanation: string;
  params: Record<string, unknown>;
  sourceRefs: SourceRef[];
  status: VersionStatus;
  /** First day the version applies (YYYY-MM-DD, inclusive). */
  effectiveFrom: string;
  /** First day it NO LONGER applies (exclusive). null = open-ended. */
  effectiveTo: string | null;
  legalReviewed?: boolean;
  legalReviewer?: string | null;
  legalReviewedAt?: string | null;
}

export type SaleLocation = "customer_home" | "business_premises" | "phone" | "online" | "other";

export interface DocumentFacts {
  totalCents?: number;
  /** Pre-emergency / list price for price-cap checks. */
  baselinePriceCents?: number;
  saleLocation?: SaleLocation;
  /** When the customer signed (defaults to ctx.at). */
  signedAt?: Date;
  isEmergencyRepair?: boolean;
  emergencyWaiverSigned?: boolean;
  /** A state of emergency / disaster declaration is in force for the work location. */
  emergencyDeclared?: boolean;
  licenseNumberShown?: boolean;
  cancellationNoticePresent?: boolean;
  /** ids of required notices already included in the document. */
  noticesPresent?: string[];
  /** Deposit / down payment requested up front, in cents. */
  depositCents?: number;
  /** The agreement exists as a signed or otherwise written contract. */
  isWritten?: boolean;
  /**
   * Eligibility codes the CUSTOMER voluntarily declared (e.g. "age_65_plus").
   * Never inferred from voice, name or demographics — the engine only reads
   * what the customer chose to tell us.
   */
  customerEligibility?: string[];
}

export interface BusinessLicense {
  state: string; // "TX"
  number: string;
  trade?: string | null;
  expiresOn?: string | null;
}

export interface EvalContext {
  surface: Surface;
  purpose?: Purpose; // default "service"
  /** Evaluation instant (default: now). */
  at?: Date;
  /** Business's home state (US state code). */
  businessState?: string | null;
  /** Customer / recipient / caller / job-site state. */
  counterpartyState?: string | null;
  /** How the counterparty state was derived — surfaced as an assumption when weak. */
  counterpartyStateBasis?: "explicit" | "address" | "phone" | "unknown";
  /** Recipient IANA timezone (quiet hours). Falls back to businessTimezone. */
  counterpartyTimezone?: string | null;
  businessTimezone?: string | null;
  outbound?: boolean; // default true
  aiVoice?: boolean;
  aiGenerated?: boolean;
  disclosureGiven?: boolean;
  /** Latest consent state per type. Missing = "none". */
  consent?: Partial<Record<ConsentType, ConsentState>>;
  licenses?: BusinessLicense[];
  document?: DocumentFacts;
    /** Facts for the fm_submission surface (portal pre-submission checks). */
    fm?: FmFacts;
}

export type FindingStatus = "pass" | "fail" | "action" | "info";

export interface Finding {
  versionId: string;
  ruleKey: string;
  packSlug: string;
  jurisdiction: string;
  kind: RuleKind;
  severity: Severity;
  status: FindingStatus;
  title: string;
  message: string;
  explanation: string;
  sourceRefs: SourceRef[];
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type ActionType =
  | "say_script"
  | "disclose"
  | "obtain_consent"
  | "add_notice"
  | "display_license"
  | "add_license_to_profile"
  | "wait_until"
  | "hold_work"
  | "provide_baseline"
  | "reduce_price"
  | "reduce_deposit"
  | "get_written_contract"
    | "fix_before_sending";

export interface RequiredAction {
  type: ActionType;
  text: string;
  versionId: string;
  ruleKey: string;
    /** Structured fix for fm_submission findings (applied to a draft by the app; never submits). */
    fix?: FmFix;
}

export interface SkippedRule {
  versionId: string;
  ruleKey: string;
  reason: "surface" | "jurisdiction" | "purpose" | "condition" | "invalid_params";
}

export type Outcome = "allow" | "allow_with_actions" | "block";

export interface EvaluationResult {
  outcome: Outcome;
  findings: Finding[];
  actions: RequiredAction[];
  skipped: SkippedRule[];
  /** Things the engine had to assume (unknown state, missing consent record...). */
  assumptions: string[];
  /** ISO instant used for effective-date resolution. */
  evaluatedAt: string;
  /** YYYY-MM-DD (in the evaluation timezone) used for effective-date resolution. */
  effectiveDate: string;
  jurisdictions: { business: string | null; counterparty: string | null };
  appliedVersionIds: string[];
  /** Earliest compliant instant for calls/texts blocked by quiet hours. */
  nextAllowedAt: string | null;
  recording: { permitted: "yes" | "after_consent" | "no"; script: string | null } | null;
  /** End-of-day (YYYY-MM-DD) of the customer's right of rescission, if one applies. */
  rescissionDeadline: string | null;
  /**
   * Voluntary eligibility questions that would unlock an approved, extended
   * protection in the customer's state. Offer them as an OPTION; never require
   * an answer and never guess it.
   */
  eligibilityPrompts: Array<{ code: string; jurisdiction: string; ruleKey: string }>;
}
