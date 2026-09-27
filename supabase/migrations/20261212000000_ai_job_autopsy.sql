/*
  # AI Job Autopsy

  ## Why
  job_profitability already knows a job's ACTUAL cost. underpriced_jobs
  already knows the Price Book's EXPECTED price. Neither explains *why* a
  specific completed job blew past what it should have cost, or lets an
  owner see the pattern across every job that did.

  This adds one companion table, `job_autopsy_reports`, and a read-only
  `job_autopsy_candidates` view that assembles — from data that already
  exists — every signal needed to explain a cost overrun:
    - expected vs actual cost (Price Book match, same logic as
      underpriced_jobs, + job_profitability's real cost roll-up)
    - reschedule count / total schedule shift (job_schedule_changes)
    - parts that went backordered on this job (job_parts_required)
    - whether this job is itself a redo (jobs.is_rework)
  The AI layer (supabase/functions/analyze-job-autopsy) turns those FACTS
  into a percentage-weighted root-cause breakdown + a "what if scheduled/
  dispatched differently" counterfactual — never inventing a fact that
  isn't in this view. Reports accumulate into a factual dataset the
  client pattern-mines across every completed job (deterministic,
  client-side — same approach as computeRootCausePatterns in
  callbackRootCause.ts).

  ## Security
  Same posture as callback_root_cause_analyses: RLS keyed to
  get_account_owner_id(); job_autopsy_candidates is security_invoker so
  it always applies the querying user's own RLS.

  ## Depends on
  20260916_job_cost_entries.sql (job_profitability)
  20260925000000_underpriced_job_detection.sql (price_book match logic)
  20261124000000_business_counterfactual_library.sql (job_schedule_changes)
  20260928000000_parts_inventory_availability.sql (job_parts_required)
  20260923000000_rework_intelligence.sql (jobs.is_rework)
*/

-- =============================================================
-- 1. REPORTS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS job_autopsy_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,

  expected_cost_cents integer NOT NULL DEFAULT 0,
  actual_cost_cents integer NOT NULL DEFAULT 0,
  variance_cents integer NOT NULL DEFAULT 0,
  variance_pct numeric,

  root_causes jsonb NOT NULL DEFAULT '[]',
  ai_summary text,
  counterfactual_summary text,
  recommended_prevention_action text,
  estimated_recoverable_cents integer NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),

  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_autopsy_reports_user ON job_autopsy_reports(user_id, created_at DESC);

ALTER TABLE job_autopsy_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_autopsy_reports" ON job_autopsy_reports;
CREATE POLICY "select_own_job_autopsy_reports" ON job_autopsy_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_job_autopsy_reports" ON job_autopsy_reports;
CREATE POLICY "insert_own_job_autopsy_reports" ON job_autopsy_reports FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_job_autopsy_reports" ON job_autopsy_reports;
CREATE POLICY "update_own_job_autopsy_reports" ON job_autopsy_reports FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_job_autopsy_reports" ON job_autopsy_reports;
CREATE POLICY "delete_own_job_autopsy_reports" ON job_autopsy_reports FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.set_job_autopsy_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_autopsy_updated_at ON job_autopsy_reports;
CREATE TRIGGER trg_job_autopsy_updated_at
  BEFORE UPDATE ON job_autopsy_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_job_autopsy_updated_at();

-- =============================================================
-- 2. CANDIDATES VIEW — every completed, invoiced job matched to a Price
--    Book entry, with every raw fact needed to explain a cost overrun.
--    Returns EVERYTHING that matches (over or under budget) — same
--    "view returns everything, page decides the threshold" pattern as
--    underpriced_jobs. Does not filter out jobs that already have a
--    report; the client merges this with job_autopsy_reports.
-- =============================================================

CREATE OR REPLACE VIEW job_autopsy_candidates
WITH (security_invoker = true) AS
SELECT
  j.id AS job_id,
  j.user_id,
  j.customer_name,
  j.service_type,
  j.completed_at,
  j.scheduled_datetime,
  j.duration_minutes,
  j.assigned_technician_id,
  tm.member_name AS technician_name,
  j.is_rework,
  j.rework_of_job_id,
  j.technician_diagnosis,
  CASE WHEN COALESCE(jp.cost_entry_count, 0) > 0 THEN 'itemized_cost' ELSE 'invoice_amount' END AS cost_basis,
  CASE
    WHEN COALESCE(jp.cost_entry_count, 0) > 0 THEN jp.total_cost_cents
    ELSE COALESCE(ROUND(j.invoice_amount * 100), 0)::integer
  END AS actual_cost_cents,
  match.price_cents AS expected_cost_cents,
  match.match_type,
  COALESCE(resched.reschedule_count, 0) AS reschedule_count,
  COALESCE(resched.schedule_shift_hours, 0) AS schedule_shift_hours,
  COALESCE(parts.backordered_count, 0) AS parts_backordered_count
FROM jobs j
LEFT JOIN team_members tm ON tm.id = j.assigned_technician_id
LEFT JOIN job_profitability jp ON jp.job_id = j.id
LEFT JOIN LATERAL (
  SELECT pbi.price_cents,
    CASE
      WHEN pbi.id = j.price_book_item_id THEN 'linked'
      WHEN lower(pbi.service_name) = lower(j.service_type) THEN 'exact_name'
      ELSE 'keyword'
    END AS match_type
  FROM price_book_items pbi
  WHERE pbi.user_id = j.user_id
    AND pbi.active = true
    AND (
      pbi.id = j.price_book_item_id
      OR (
        j.price_book_item_id IS NULL
        AND j.service_type IS NOT NULL
        AND (
          lower(pbi.service_name) = lower(j.service_type)
          OR j.service_type ILIKE '%' || pbi.service_name || '%'
          OR EXISTS (SELECT 1 FROM unnest(pbi.keywords) kw WHERE j.service_type ILIKE '%' || kw || '%')
        )
      )
    )
  ORDER BY
    (pbi.id = j.price_book_item_id) DESC,
    (lower(pbi.service_name) = lower(j.service_type)) DESC,
    length(pbi.service_name) DESC
  LIMIT 1
) match ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::integer AS reschedule_count,
    COALESCE(SUM(ABS(EXTRACT(EPOCH FROM (sc.new_scheduled_datetime - sc.previous_scheduled_datetime)))) / 3600, 0)::numeric AS schedule_shift_hours
  FROM job_schedule_changes sc
  WHERE sc.job_id = j.id
) resched ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::integer AS backordered_count
  FROM job_parts_required jpr
  WHERE jpr.job_id = j.id AND jpr.status = 'backordered'
) parts ON true
WHERE j.job_status = 'completed'
  AND j.completed_at IS NOT NULL
  AND j.invoice_amount IS NOT NULL
  AND match.price_cents IS NOT NULL;

GRANT SELECT ON job_autopsy_candidates TO authenticated;

COMMENT ON VIEW job_autopsy_candidates IS
  'Every completed, invoiced job matched to a Price Book entry, with the raw facts (expected vs actual cost, reschedules, backordered parts, rework flag) needed to explain a cost/time overrun. security_invoker=true.';
