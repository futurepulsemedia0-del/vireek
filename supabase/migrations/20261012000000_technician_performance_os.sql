/*
  # Technician Performance OS

  ## Why
  Every metric this feature needs already exists in the data model:
  - `jobs.assigned_technician_id` / `job_status` / `completed_at` /
    `scheduled_datetime` / `duration_minutes` / `invoice_amount` — jobs
    volume, actual vs. estimated duration, revenue.
  - `jobs.is_rework` / `rework_of_job_id`, set server-side by
    `trg_set_job_rework_flag` (20260923000000_rework_intelligence.sql) —
    the same flag Rework Intelligence already uses is exactly a "callback":
    a repeat visit for a problem that was supposedly already fixed.
    first_time_fix_rate is simply the inverse of the callback rate.
  - `review_requests.rating` / `job_id` (20260905120000_review_requests.sql)
    — CSAT, joinable back to a technician through `jobs`.
  - `team_members.max_jobs_per_day` (technician capacity, already used by
    20260925000000_technician_capacity_locking.sql) — utilization.

  This migration does NOT add a new analysis pipeline and does NOT
  duplicate any of the above. All aggregation happens client-side in
  `src/lib/technicianPerformance.ts`, exactly like
  `src/lib/coachingReports.ts` aggregates `calls` for Coaching Reports.
  It adds one table so an owner can SAVE a computed scorecard (a specific
  technician + period's aggregated metrics, plus the rule-based AI
  coaching notes generated for that period) as a named snapshot that
  survives past the current date-range view — the exact same shape as
  `coaching_reports`.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project (see `coaching_reports`,
  `underpriced_job_alerts`, etc.).
*/

CREATE TABLE IF NOT EXISTS technician_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,

  period_start date NOT NULL,
  period_end date NOT NULL,

  jobs_completed integer NOT NULL DEFAULT 0,
  first_time_fix_rate numeric(5,2),
  callback_rate numeric(5,2),
  avg_job_duration_minutes numeric(7,2),
  revenue_cents bigint NOT NULL DEFAULT 0,
  csat_avg numeric(3,2),
  csat_responses integer NOT NULL DEFAULT 0,
  utilization_rate numeric(5,2),

  /* Each: [{ "serviceType": string, "reason": string, "severity": "low"|"medium"|"high" }] */
  training_gaps jsonb NOT NULL DEFAULT '[]',
  /* Each: [{ "tip": string, "basis": string }] — rule-based, not an LLM call */
  ai_coaching_notes jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_technician_scorecards_user_period
  ON technician_scorecards(user_id, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_technician_scorecards_technician
  ON technician_scorecards(technician_id, period_start DESC);

ALTER TABLE technician_scorecards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_technician_scorecards" ON technician_scorecards
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_technician_scorecards" ON technician_scorecards
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "delete_own_technician_scorecards" ON technician_scorecards
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
