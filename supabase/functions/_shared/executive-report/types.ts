// supabase/functions/_shared/executive-report/types.ts
// Shared contracts for the Executive Monthly Report. Zero runtime logic.

export interface ReportSettings {
  user_id: string;
  enabled: boolean;
  send_day: number; // 1-28, day of month (owner's local time)
  send_hour: number; // 0-23, owner's local time
  timezone: string; // IANA
  include_owner: boolean;
  include_co_owners: boolean;
  extra_recipients: string[];
  ai_commentary_enabled: boolean;
  revenue_goal: number | null;
  jobs_goal: number | null;
  close_rate_goal_pct: number | null;
  margin_goal_pct: number | null;
}

export interface ReportPeriod {
  /** Local calendar dates, inclusive: YYYY-MM-DD. */
  start: string;
  end: string;
  label: string; // "September 2026"
  /** UTC instants: [startUtc, endUtc) — endUtc is exclusive. */
  startUtc: string;
  endUtc: string;
  prior: { start: string; end: string; label: string; startUtc: string; endUtc: string };
}

// ---- Raw rows (only the columns the report reads) ----
export interface JobRow {
  id: string;
  assigned_technician_id: string | null;
  job_status: string;
  invoice_amount: number | null;
  invoice_status: string | null;
  completed_at: string | null;
  scheduled_datetime: string | null;
  created_at: string;
  is_rework?: boolean | null;
}
export interface CostRow { job_id: string; amount: number }
export interface QuoteRow { status: string; sent_at: string | null }
export interface CallRow { status: string; call_datetime: string }
export interface RecoveryRow {
  source_type: string;
  status: string;
  occurred_at: string;
  recovered_amount_cents: number | null;
}
export interface TechnicianRef { id: string; member_name: string | null; member_email: string }

export interface ReportData {
  jobs: JobRow[];
  costs: CostRow[];
  quotes: QuoteRow[];
  calls: CallRow[];
  recoveries: RecoveryRow[];
  technicians: TechnicianRef[];
}

// ---- Computed output ----
export interface Kpis {
  revenue: number;
  collected: number;
  jobsCompleted: number;
  jobsBooked: number;
  avgTicket: number | null;
  quotesSent: number;
  quotesDecided: number;
  quotesAccepted: number;
  closeRatePct: number | null;
  missedCalls: number;
  missedCallEvents: number;
  recoveredCount: number;
  recoveredValue: number;
  recoveryRatePct: number | null;
  costedJobs: number;
  costedRevenue: number;
  totalCost: number;
  marginPct: number | null;
  reworkJobs: number;
  reworkRatePct: number | null;
}

export interface TechnicianRow {
  id: string;
  name: string;
  jobs: number;
  revenue: number;
  avgTicket: number | null;
  reworkRatePct: number | null;
}

export type GoalStatus = "achieved" | "near" | "behind" | "no_data";
export interface GoalRow {
  key: "revenue" | "jobs" | "close_rate" | "margin";
  label: string;
  unit: "currency" | "count" | "percent";
  goal: number;
  actual: number | null;
  attainmentPct: number | null;
  status: GoalStatus;
}

export interface ExecutiveMetrics {
  period: { start: string; end: string; label: string };
  current: Kpis;
  prior: Kpis;
  deltas: {
    revenuePct: number | null;
    jobsCompletedPct: number | null;
    avgTicketPct: number | null;
    closeRatePts: number | null;
    recoveredValuePct: number | null;
    marginPts: number | null;
  };
  topTechnicians: TechnicianRow[];
  goals: GoalRow[];
  dataQuality: { costCoveragePct: number | null; notes: string[] };
}

export interface Commentary {
  source: "ai" | "deterministic";
  headline: string;
  highlights: string[];
  risks: string[];
  actions: string[];
}
