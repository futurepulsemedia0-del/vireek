// supabase/functions/_shared/business-brain/types.ts
//
// Ask Vireek — "Business Brain". Shared types for the deterministic
// analytics engine, the fact pack handed to the LLM, and the structured
// answer returned to the dashboard. Pure types: no runtime imports.

export type Topic =
  | "profit_drivers"
  | "money_leaks"
  | "technician_fit"
  | "customer_outreach"
  | "capacity_whatif"
  | "hiring_whatif"
  | "recommendations"
  | "overview";

// ---------------------------------------------------------------------
// Raw rows (only the columns we actually read).
// ---------------------------------------------------------------------

export interface JobRow {
  id: string;
  customer_name: string;
  customer_id: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  job_status: string;
  invoice_amount: number | null;
  invoice_status: string;
  duration_minutes: number | null;
  expected_duration_minutes: number | null;
  started_at: string | null;
  completed_at: string | null;
  is_rework: boolean | null;
  next_maintenance_date: string | null;
  created_at: string;
}

/** Mirrors the `job_profitability` view (cents). */
export interface CostRow {
  job_id: string;
  revenue_cents: number | null;
  total_cost_cents: number | null;
  labor_cost_cents: number | null;
  material_cost_cents: number | null;
  gross_profit_cents: number | null;
  margin_pct: number | null;
  /** How many cost entries back this row; 0 means cost is UNKNOWN, not zero. */
  cost_entry_count?: number | null;
}

export interface TechRow {
  id: string;
  member_name: string | null;
  skills: string[] | null;
  max_jobs_per_day: number | null;
  dispatch_enabled: boolean | null;
  hourly_cost_rate_cents?: number | null;
}

export interface CallRow {
  call_datetime: string;
  status: string | null;
  is_emergency: boolean | null;
}

export interface LeadRow {
  id: string;
  name: string;
  service_interested: string | null;
  stage: string;
  created_at: string;
}

export interface LineItem {
  quantity?: number;
  unit_price_cents?: number;
}

export interface QuoteRow {
  id: string;
  customer_name: string;
  status: string;
  sent_at: string | null;
  valid_until: string | null;
  line_items: LineItem[] | null;
  tax_percent: number | null;
  created_at: string;
}

export interface InvoiceRow {
  id: string;
  customer_name: string;
  status: string;
  due_date: string | null;
  line_items: LineItem[] | null;
  tax_percent: number | null;
  created_at: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  lifecycle_stage: string | null;
  last_contacted_at: string | null;
}

export interface RawData {
  now: Date;
  timeZone: string;
  jobs: JobRow[];
  /** null = the job_profitability view is not available for this account. */
  costs: CostRow[] | null;
  techs: TechRow[];
  calls: CallRow[];
  leads: LeadRow[];
  quotes: QuoteRow[];
  invoices: InvoiceRow[];
  customers: CustomerRow[];
  /** Human-readable notes about data that could not be loaded or was truncated. */
  gaps: string[];
}

// ---------------------------------------------------------------------
// Question understanding
// ---------------------------------------------------------------------

export type Period = "yesterday" | "today" | "this_week" | "last_week" | "this_month";

export interface QuestionPlan {
  topics: Topic[];
  period: Period;
  extraJobs: number | null;
  hires: number;
  trade: string | null;
  /** Free text of the question, lower-cased and digit-normalised (for job/customer name matching). */
  normalized: string;
}

// ---------------------------------------------------------------------
// Analytics output. Money is always whole US dollars unless a key ends
// in `_cents`. Everything here is JSON-serialisable and goes into the
// fact pack verbatim.
// ---------------------------------------------------------------------

export interface DayPoint {
  date: string;
  jobs: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number | null;
}

export interface Coverage {
  jobs_in_window: number;
  completed_jobs: number;
  costed_jobs_pct: number | null;
  has_cost_data: boolean;
  technicians: number;
  history_days: number;
}

export interface ServiceLine {
  service: string;
  jobs: number;
  revenue: number;
  profit: number | null;
  margin_pct: number | null;
  avg_ticket: number;
  rework_rate_pct: number;
}

export interface Leak {
  kind: string;
  label: string;
  amount: number;
  basis: "measured" | "estimated";
  count: number;
  examples: string[];
}

export interface Candidate {
  who: string;
  reason: string;
  value: number;
  action: string;
}

// ---------------------------------------------------------------------
// Structured answer (what the dashboard renders)
// ---------------------------------------------------------------------

export type Verdict = "yes" | "no" | "conditional" | "info";

export interface AnswerFinding {
  title: string;
  detail: string;
  impact_usd: number | null;
  evidence: string[];
}

export interface AnswerAction {
  action: string;
  owner: "owner" | "dispatcher" | "technician" | "office" | "finance";
  urgency: "now" | "today" | "this_week" | "this_month";
  expected_impact_usd: number | null;
}

export interface EvidenceRef {
  ref: string;
  value: string | number | boolean | null;
}

export interface BrainAnswer {
  headline: string;
  answer: string;
  verdict: Verdict | null;
  findings: AnswerFinding[];
  actions: AnswerAction[];
  confidence: { level: "low" | "medium" | "high"; reason: string };
  assumptions: string[];
  data_gaps: string[];
  follow_ups: string[];
  evidence: EvidenceRef[];
  topics: Topic[];
  source: "ai" | "engine";
  grounding: { checked: number; matched: number; ratio: number };
  as_of: string;
  timezone: string;
  coverage: Coverage;
}
