/*
  # AI Coaching Reports

  ## Why
  Call Intelligence (20260917000000_call_intelligence.sql and
  20260922000000_call_intelligence_2_upsell_objection.sql) already scores
  every call and writes a `coaching_tip`, `objections_raised`,
  `objections_resolved` and `upsell_opportunities` onto each row in
  `calls`. That data is per-call and disappears into the Call History
  list — there's no digest that rolls it up into "here's what's actually
  worth coaching on this month."

  This does NOT add a new analysis pipeline. It adds one table to let the
  dashboard SAVE a computed digest (a specific date range's aggregated
  metrics) as a named snapshot, so an owner can look back at "Q3 coaching
  report" later instead of the live view always only showing "right now."
  The aggregation itself happens client-side in `lib/coachingReports.ts`
  from the `calls` table Call Intelligence already populates.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project.
*/

CREATE TABLE IF NOT EXISTS coaching_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  period_start date NOT NULL,
  period_end date NOT NULL,

  calls_analyzed integer NOT NULL DEFAULT 0,
  avg_call_score numeric(5,2),
  booking_rate numeric(5,2),
  objection_resolution_rate numeric(5,2),

  /* Each: [{ "text": string, "count": integer, "resolvedCount": integer }] */
  top_objections jsonb NOT NULL DEFAULT '[]',
  /* Each: [{ "text": string, "count": integer }] */
  top_missed_upsells jsonb NOT NULL DEFAULT '[]',
  /* Each: [{ "tip": string, "count": integer }] */
  recurring_themes jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_reports_user_period
  ON coaching_reports(user_id, period_start DESC);

ALTER TABLE coaching_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_coaching_reports" ON coaching_reports
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_coaching_reports" ON coaching_reports
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "delete_own_coaching_reports" ON coaching_reports
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
