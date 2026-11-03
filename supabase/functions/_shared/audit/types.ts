// supabase/functions/_shared/audit/types.ts
// Shared, dependency-free types for the Missed-Call Audit (used by Edge Functions AND the React app via
// src/lib/audit/types.ts, which re-exports from here so the wire contract cannot drift).

export type Condition = "business_hours" | "lunch" | "after_hours";
export const CONDITIONS: readonly Condition[] = ["business_hours", "lunch", "after_hours"] as const;
export const SLOT_OF: Record<Condition, 1 | 2 | 3> = { business_hours: 1, lunch: 2, after_hours: 3 };

export type AnswerKind =
  | "live_person"
  | "live_ai"
  | "ivr"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed"
  | "unknown";

export type CallStatus = "scheduled" | "claimed" | "dialing" | "completed" | "failed" | "skipped" | "cancelled";
export type AuditStatus = "verified" | "scheduled" | "running" | "complete" | "cancelled";

/** Weekly opening hours. days: 0 = Sunday .. 6 = Saturday. open/close: "HH:MM" in the business's timezone. */
export interface BusinessHours {
  days: number[];
  open: string;
  close: string;
}

/** What the test call observed. Every field is optional: absence means "could not tell", never "no". */
export interface CallObservations {
  greeting_present?: boolean;
  business_name_stated?: boolean;
  callback_promised?: boolean;
  alternate_option_offered?: boolean;
  greeting_seconds?: number | null;
  hold_seconds?: number | null;
  offered_to_book?: boolean;
  message_only?: boolean;
}

export interface ScoredCall {
  slot: number;
  condition: Condition;
  status: CallStatus;
  answer_kind: AnswerKind | null;
  ring_seconds: number | null;
  observations: CallObservations;
}

export interface SubScore {
  /** 0-100, or null when this audit has nothing to measure it with (never a made-up zero). */
  score: number | null;
  weight: number;
  /** Plain-language basis, shown in the report and the PDF. */
  basis: string;
  calls: number[];
}

export type SubScoreKey = "answer_rate" | "speed_to_answer" | "voicemail_quality" | "after_hours_coverage" | "booking_readiness";

export type Band = "strong" | "fair" | "leaking" | "critical";
export type Confidence = "ok" | "limited" | "low";

export interface FindingEvidence {
  slot: number;
  condition: Condition;
}

export interface Finding {
  id: string;
  severity: "good" | "info" | "warn" | "critical";
  title: string;
  detail: string;
  evidence: FindingEvidence[];
}

export interface ScoreResult {
  total: number | null;
  band: Band | null;
  confidence: Confidence;
  conclusive_calls: number;
  inconclusive_calls: number;
  sub: Record<SubScoreKey, SubScore>;
  findings: Finding[];
  fix_path: FixStep[];
}

export interface FixStep {
  id: string;
  title: string;
  detail: string;
  /** True when Vireek genuinely addresses this step. Steps that are plain phone-system hygiene say false. */
  vireek_can_help: boolean;
}

export interface Assumptions {
  monthlyInboundCalls: number;
  newCustomerShare: number; // 0-1: share of calls that are new-job opportunities
  afterHoursShare: number; // 0-1
  jobConversionRate: number; // 0-1: of answered new-job calls, share that book
  avgJobValue: number; // dollars
  voicemailRecoveryRate: number; // 0-1: of calls that reached voicemail, share you win back by calling back
}

export type AssumptionSource = "default" | "owner";

export interface AssumptionRow {
  key: keyof Assumptions;
  label: string;
  value: number;
  unit: "calls" | "percent" | "usd";
  source: AssumptionSource;
}

export interface Range {
  low: number;
  point: number;
  high: number;
}

export interface RevenueAtRisk {
  monthly: Range;
  annual: Range;
  miss_rate: Range; // 0-1
  sample_size: number;
  is_placeholder: boolean; // true while ANY assumption is still a default
  assumptions: AssumptionRow[];
  notes: string[];
}

export interface PlannedSlot {
  condition: Condition;
  slot: 1 | 2 | 3;
  scheduledFor: Date;
  windowEnd: Date;
}
