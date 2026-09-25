/*
  # Opportunity Cost Ledger

  ## Why
  Every other ledger in this project tracks money ALREADY on the table
  (revenue_recovery_events) or money ALREADY given away (underpriced_jobs,
  margin_guardrail_checks). This one tracks the third, usually invisible
  category: money that was never at risk of being lost, it just never got
  chased — a technician's time spent on the wrong job, a quote nobody
  followed up on, a day with open slots nobody filled. It never recomputes
  margin or job value itself; it reads job_profitability, quotes, and
  capacity_demand_events (all pre-existing) and turns the gap into a
  dollar figure + a plain-English entry, then has AI rank the entries
  that matter most this week (same "candidates -> AI ranks + explains"
  idiom as next-best-actions — never used to invent a number).

  ## Table
  - opportunity_cost_entries — one row per detected opportunity cost,
    keyed uniquely per (entry_type, source row, day) so re-scanning is
    idempotent.

  ## View
  - opportunity_cost_summary — entries rolled up by type, last 30 days.
*/

CREATE TABLE IF NOT EXISTS opportunity_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  entry_type text NOT NULL
    CHECK (entry_type IN ('technician_low_margin_time', 'quote_stalled_followup', 'idle_capacity')),
  source_table text NOT NULL CHECK (source_table IN ('jobs', 'quotes', 'capacity_demand_events')),
  source_id uuid NOT NULL,
  occurred_on date NOT NULL DEFAULT current_date,

  estimated_cost_cents integer NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0),
  detail jsonb NOT NULL DEFAULT '{}',
  headline text NOT NULL,

  ai_narrative text,
  ai_recommended_action text,
  priority_score integer CHECK (priority_score IS NULL OR (priority_score >= 0 AND priority_score <= 100)),

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'dismissed')),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (entry_type, source_table, source_id, occurred_on)
);

CREATE INDEX IF NOT EXISTS idx_oce_user_created ON opportunity_cost_entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oce_user_open ON opportunity_cost_entries(user_id, status) WHERE status = 'open';

ALTER TABLE opportunity_cost_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_opportunity_cost_entries" ON opportunity_cost_entries;
CREATE POLICY "select_own_opportunity_cost_entries" ON opportunity_cost_entries
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_opportunity_cost_entries" ON opportunity_cost_entries;
CREATE POLICY "update_own_opportunity_cost_entries" ON opportunity_cost_entries
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- No client INSERT policy — only the opportunity-cost-scan Edge Function
-- (service role) writes new entries, same posture as capacity_demand_events.

CREATE OR REPLACE VIEW opportunity_cost_summary
WITH (security_invoker = true) AS
SELECT
  user_id,
  entry_type,
  COUNT(*)::integer AS entry_count,
  COALESCE(SUM(estimated_cost_cents), 0)::integer AS total_cost_cents
FROM opportunity_cost_entries
WHERE occurred_on >= current_date - interval '30 days'
  AND status <> 'dismissed'
GROUP BY user_id, entry_type;

GRANT SELECT ON opportunity_cost_summary TO authenticated;

COMMENT ON VIEW opportunity_cost_summary IS
  'opportunity_cost_entries rolled up by type over the last 30 days, excluding dismissed entries. security_invoker=true.';
