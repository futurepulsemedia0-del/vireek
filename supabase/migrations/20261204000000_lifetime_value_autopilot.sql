/*
  # Lifetime Value Autopilot

  ## Why
  CohortLtvSection shows paid LTV computed on the fly for a chart; nothing
  persists a per-customer score, a trend, or a segment a business can act
  on. This migration adds one materialized-by-RPC table —
  customer_ltv_profiles — plus the recompute function that fills it, using
  only paid-invoice data that already exists (jobs.invoice_amount /
  invoice_status, matched to customers the same way
  apply_vip_customer_tags() already does: by customer_id when jobs are
  linked, falling back to phone when they aren't).

  ## Segmentation — disclosed, not a black box
  lifetime_value_cents >= $2,000 is "VIP" (same order of magnitude as the
  existing vip-customer-auto-tag default of $1,000, set slightly higher
  here because this segment additionally drives outreach priority, not
  just a badge). "Declining" = trailing 90 days of paid revenue below 60%
  of the prior 90 days. "Rising" = trailing 90 days above 115% of prior
  90 days. predicted_annual_value_cents = trailing_90d_cents * 4 — a
  disclosed extrapolation, never an ML claim.

  ## The "autopilot" part
  This migration does NOT send messages and does NOT create a new
  messaging channel. Segments map (in the client, src/lib/ltvAutopilot.ts)
  to specific existing Automation Marketplace templates
  (vip-customer-auto-tag, membership-renewal-referral-ask,
  seasonal-maintenance-reminder, post-job-review-request). The dashboard
  page tells the business exactly which template to turn on for which
  segment, and links straight to /dashboard/automation-marketplace to do
  it — reusing the sending infrastructure that already exists instead of
  building a parallel one.

  ## Security
  Same posture as customer_ltv_profiles' siblings: RLS keyed to
  get_account_owner_id(). No client INSERT/DELETE — rows are written only
  by recompute_customer_ltv_profiles() (SECURITY DEFINER). A client CAN
  update action_status/action_note on rows it owns, which is how a human
  marks a segment as handled.

  ## Depends on
  20260918000000_create_customers.sql (customers, jobs.customer_id)
  20260922000000_automation_marketplace.sql (automation_installs — read
    only, from the client, never written by this migration)
*/

-- =============================================================
-- 1. PROFILE TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_ltv_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_phone text,

  lifetime_value_cents integer NOT NULL DEFAULT 0 CHECK (lifetime_value_cents >= 0),
  trailing_90d_cents integer NOT NULL DEFAULT 0 CHECK (trailing_90d_cents >= 0),
  prior_90d_cents integer NOT NULL DEFAULT 0 CHECK (prior_90d_cents >= 0),
  predicted_annual_value_cents integer NOT NULL DEFAULT 0 CHECK (predicted_annual_value_cents >= 0),
  completed_job_count integer NOT NULL DEFAULT 0,
  days_since_last_job integer,

  trend text NOT NULL DEFAULT 'new' CHECK (trend IN ('new', 'rising', 'stable', 'declining')),
  segment text NOT NULL DEFAULT 'new_customer' CHECK (segment IN (
    'new_customer', 'vip_growing', 'vip_at_risk', 'core_stable', 'reactivation_candidate', 'low_value'
  )),

  action_status text NOT NULL DEFAULT 'pending' CHECK (action_status IN ('pending', 'actioned', 'dismissed')),
  action_note text,
  actioned_by uuid,
  actioned_at timestamptz,

  last_computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_ltv_profiles_user_segment
  ON customer_ltv_profiles(user_id, segment);
CREATE INDEX IF NOT EXISTS idx_ltv_profiles_user_value
  ON customer_ltv_profiles(user_id, lifetime_value_cents DESC);
CREATE INDEX IF NOT EXISTS idx_ltv_profiles_pending
  ON customer_ltv_profiles(user_id) WHERE action_status = 'pending';

ALTER TABLE customer_ltv_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ltv_profiles" ON customer_ltv_profiles;
CREATE POLICY "select_own_ltv_profiles" ON customer_ltv_profiles
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_ltv_profiles" ON customer_ltv_profiles;
CREATE POLICY "update_own_ltv_profiles" ON customer_ltv_profiles
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- No client INSERT/DELETE policy — see security note above.

CREATE OR REPLACE FUNCTION public.set_ltv_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ltv_profiles_updated_at ON customer_ltv_profiles;
CREATE TRIGGER trg_ltv_profiles_updated_at
  BEFORE UPDATE ON customer_ltv_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_ltv_profiles_updated_at();

-- =============================================================
-- 2. RECOMPUTE — safe to call repeatedly (upsert), never touches
--    action_status/action_note/actioned_by/actioned_at, which are
--    human-owned state, not recomputed state.
-- =============================================================

CREATE OR REPLACE FUNCTION public.recompute_customer_ltv_profiles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count integer := 0;
BEGIN
  WITH customer_jobs AS (
    SELECT
      c.id AS customer_id,
      c.name AS customer_name,
      c.phone AS customer_phone,
      j.id AS job_id,
      j.created_at,
      j.job_status,
      CASE WHEN j.invoice_status = 'paid' THEN COALESCE(j.invoice_amount, 0) ELSE 0 END AS paid_amount
    FROM customers c
    LEFT JOIN jobs j
      ON j.user_id = c.user_id
     AND (j.customer_id = c.id OR (j.customer_id IS NULL AND c.phone IS NOT NULL AND j.customer_phone = c.phone))
    WHERE c.user_id = v_owner
  ),
  agg AS (
    SELECT
      customer_id, customer_name, customer_phone,
      COALESCE(SUM(paid_amount), 0) AS lifetime_raw,
      COALESCE(SUM(paid_amount) FILTER (WHERE created_at >= now() - interval '90 days'), 0) AS trailing_raw,
      COALESCE(SUM(paid_amount) FILTER (
        WHERE created_at < now() - interval '90 days' AND created_at >= now() - interval '180 days'
      ), 0) AS prior_raw,
      COUNT(job_id) FILTER (WHERE job_status = 'completed') AS completed_jobs,
      MAX(created_at) AS last_job_at,
      MIN(created_at) AS first_job_at
    FROM customer_jobs
    GROUP BY customer_id, customer_name, customer_phone
  )
  INSERT INTO customer_ltv_profiles (
    user_id, customer_id, customer_name, customer_phone,
    lifetime_value_cents, trailing_90d_cents, prior_90d_cents, predicted_annual_value_cents,
    completed_job_count, days_since_last_job, trend, segment, last_computed_at
  )
  SELECT
    v_owner, customer_id, customer_name, customer_phone,
    ROUND(lifetime_raw)::integer,
    ROUND(trailing_raw)::integer,
    ROUND(prior_raw)::integer,
    ROUND(trailing_raw * 4)::integer,
    completed_jobs,
    CASE WHEN last_job_at IS NULL THEN NULL ELSE EXTRACT(DAY FROM now() - last_job_at)::integer END,
    CASE
      WHEN completed_jobs <= 1 OR first_job_at >= now() - interval '90 days' THEN 'new'
      WHEN trailing_raw > prior_raw * 1.15 THEN 'rising'
      WHEN trailing_raw < prior_raw * 0.6 THEN 'declining'
      ELSE 'stable'
    END,
    CASE
      WHEN completed_jobs = 0 THEN 'new_customer'
      WHEN lifetime_raw >= 200000 AND (
        (last_job_at IS NOT NULL AND last_job_at < now() - interval '120 days') OR trailing_raw < prior_raw * 0.6
      ) THEN 'vip_at_risk'
      WHEN lifetime_raw >= 200000 THEN 'vip_growing'
      WHEN (last_job_at IS NOT NULL AND last_job_at < now() - interval '180 days') OR trailing_raw < prior_raw * 0.6
        THEN 'reactivation_candidate'
      WHEN lifetime_raw < 30000 THEN 'low_value'
      ELSE 'core_stable'
    END,
    now()
  FROM agg
  ON CONFLICT (user_id, customer_id) DO UPDATE SET
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    lifetime_value_cents = EXCLUDED.lifetime_value_cents,
    trailing_90d_cents = EXCLUDED.trailing_90d_cents,
    prior_90d_cents = EXCLUDED.prior_90d_cents,
    predicted_annual_value_cents = EXCLUDED.predicted_annual_value_cents,
    completed_job_count = EXCLUDED.completed_job_count,
    days_since_last_job = EXCLUDED.days_since_last_job,
    trend = EXCLUDED.trend,
    segment = EXCLUDED.segment,
    last_computed_at = EXCLUDED.last_computed_at,
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_customer_ltv_profiles() TO authenticated;
