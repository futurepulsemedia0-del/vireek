/*
  # Marketing ROI Attribution — Click-to-Cash: spend logging

  ## Why
  Every step of the click-to-cash path this feature needs already exists
  in the data model:
  - `marketing_attribution_touches` (source/medium/campaign/UTM, keyed by
    lead_id/customer_id) — the "click" side for web traffic
    (20261011000000_marketing_automation.sql).
  - `calls.lead_source` / `calls.source_label` — the "click" side for
    phone-in leads.
  - `jobs.booking_channel` — the "click" side for self-serve web bookings
    with no matched UTM touch (20261011000000_online_booking_engine.sql).
  - `jobs.lead_id` / `jobs.customer_id` / `jobs.call_id` — the join keys
    that connect a click to the job it produced.
  - The `job_profitability` view (20260... jobCosting migration) —
    revenue, real cost (labor/material/equipment/subcontractor/permit/
    other) and true gross margin per job. This is deliberately reused
    instead of re-deriving margin from `jobs.invoice_amount` alone, so
    "cash" here means real gross profit, not just revenue.

  All of that is aggregated client-side in
  `src/lib/clickToCashAttribution.ts`, exactly like Technician
  Performance OS and Skill Graph aggregate existing tables rather than
  duplicating a pipeline.

  The ONE thing genuinely missing from the data model is ad/marketing
  SPEND — there is no source of truth anywhere for what was paid per
  channel, and ROI is meaningless without a cost side. This migration
  adds exactly that, and nothing else.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project (see `technician_scorecards`,
  `job_cost_entries`, etc.).
*/

CREATE TABLE IF NOT EXISTS marketing_channel_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  -- Free-text, matched case-insensitively against
  -- marketing_attribution_touches.source / calls.lead_source /
  -- jobs.booking_channel at read time (e.g. "google", "facebook", "phone").
  channel text NOT NULL,
  campaign text,

  period_start date NOT NULL,
  period_end date NOT NULL,
  spend_cents bigint NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_marketing_channel_spend_user_period
  ON marketing_channel_spend(user_id, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_channel_spend_channel
  ON marketing_channel_spend(user_id, channel);

ALTER TABLE marketing_channel_spend ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_marketing_channel_spend" ON marketing_channel_spend
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_marketing_channel_spend" ON marketing_channel_spend
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_marketing_channel_spend" ON marketing_channel_spend
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE POLICY "delete_own_marketing_channel_spend" ON marketing_channel_spend
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.set_marketing_channel_spend_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_channel_spend_updated_at ON marketing_channel_spend;
CREATE TRIGGER trg_marketing_channel_spend_updated_at
  BEFORE UPDATE ON marketing_channel_spend
  FOR EACH ROW EXECUTE FUNCTION public.set_marketing_channel_spend_updated_at();
