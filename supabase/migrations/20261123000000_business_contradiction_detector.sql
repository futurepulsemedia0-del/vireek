/*
  # Business Contradiction Detector

  Finds five specific, high-value contradictions using data that already
  exists (jobs.is_rework, technician performance, marketing spend,
  memberships churn, franchise locations) plus three small additive
  columns this migration introduces:

    - business_profile.monthly_revenue_goal_cents  (pattern 1)
    - quotes.discount_percent / quotes.decline_reason  (pattern 2)
    - jobs.refund_amount_cents / jobs.refunded_at  (pattern 4/5 margin proxy)

  Detections are stored (not just computed on the fly) so they can be
  acknowledged/dismissed and so re-running detection auto-resolves a flag
  once the underlying condition stops being true — same idea as
  capacity_demand_events, but this is a persistent, actionable list
  instead of an audit log.
*/

-- =============================================================
-- Additive columns this detector needs
-- =============================================================
ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS monthly_revenue_goal_cents bigint;

ALTER TABLE quotes
ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
ADD COLUMN IF NOT EXISTS decline_reason text CHECK (decline_reason IS NULL OR decline_reason IN ('price', 'timing', 'went_competitor', 'no_response', 'scope_mismatch', 'other'));

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS refund_amount_cents bigint NOT NULL DEFAULT 0 CHECK (refund_amount_cents >= 0),
ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- =============================================================
-- BUSINESS_CONTRADICTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS business_contradictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  contradiction_type text NOT NULL CHECK (contradiction_type IN (
    'growth_vs_capacity', 'discount_not_the_reason', 'marketing_vs_followup',
    'branch_revenue_vs_margin_churn', 'technician_revenue_vs_quality'
  )),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  title text NOT NULL,
  detail text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'dismissed', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bc_open_dedupe ON business_contradictions(user_id, dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bc_user_status ON business_contradictions(user_id, status, severity DESC);

ALTER TABLE business_contradictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_contradictions" ON business_contradictions;
CREATE POLICY "select_own_contradictions" ON business_contradictions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_contradictions" ON business_contradictions;
CREATE POLICY "update_own_contradictions" ON business_contradictions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
-- No client INSERT policy: rows are only ever created by run_contradiction_detection() below.

-- =============================================================
-- Helper: upsert a detection, remembering it was "seen" this run
-- =============================================================
CREATE OR REPLACE FUNCTION public._upsert_contradiction(
  p_user_id uuid, p_type text, p_severity text, p_title text, p_detail text, p_evidence jsonb, p_dedupe_key text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO business_contradictions (user_id, contradiction_type, severity, title, detail, evidence, dedupe_key, status)
  VALUES (p_user_id, p_type, p_severity, p_title, p_detail, p_evidence, p_dedupe_key, 'open')
  ON CONFLICT (user_id, dedupe_key) WHERE status = 'open'
  DO UPDATE SET severity = p_severity, title = p_title, detail = p_detail, evidence = p_evidence, detected_at = now();

  INSERT INTO pg_temp.seen_contradiction_keys (dedupe_key) VALUES (p_dedupe_key);
END;
$$;

-- =============================================================
-- Main detector
-- =============================================================
CREATE OR REPLACE FUNCTION public.run_contradiction_detection(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_goal_cents bigint;
  v_avg_ticket_cents bigint;
  v_capacity_jobs_month numeric;
  v_required_jobs_month numeric;
  v_crew_size integer;

  v_avg_discount_declined numeric;
  v_avg_discount_accepted numeric;
  v_declined_with_reason integer;
  v_declined_price_reason integer;

  v_leads_period integer;
  v_stale_leads integer;
  v_spend_cents bigint;

  v_group_id uuid;
  v_loc record;
  v_loc_revenue numeric;
  v_loc_refund_rate numeric;
  v_loc_churn_rate numeric;
  v_avg_refund_rate numeric;
  v_avg_churn_rate numeric;
  v_revenue_p75 numeric;

  v_tech record;
  v_avg_callback_rate numeric;
  v_avg_refund_rate_tech numeric;
  v_revenue_p75_tech numeric;

  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS seen_contradiction_keys (dedupe_key text) ON COMMIT DROP;
  DELETE FROM seen_contradiction_keys;

  -- ============================================================
  -- PATTERN 1: growth goal vs real capacity
  -- ============================================================
  SELECT monthly_revenue_goal_cents INTO v_goal_cents FROM business_profile WHERE user_id = p_user_id;

  IF v_goal_cents IS NOT NULL AND v_goal_cents > 0 THEN
    SELECT COALESCE(avg(invoice_amount) * 100, 0) INTO v_avg_ticket_cents
    FROM jobs WHERE user_id = p_user_id AND invoice_status = 'paid' AND created_at > now() - interval '90 days';

    SELECT count(*) INTO v_crew_size FROM team_members
    WHERE account_owner_id = p_user_id AND invite_status = 'accepted' AND max_jobs_per_day IS NOT NULL;

    SELECT COALESCE(sum(max_jobs_per_day), 0) * 22 INTO v_capacity_jobs_month
    FROM team_members WHERE account_owner_id = p_user_id AND invite_status = 'accepted';

    IF v_avg_ticket_cents > 0 AND v_capacity_jobs_month > 0 THEN
      v_required_jobs_month := v_goal_cents::numeric / v_avg_ticket_cents;

      IF v_required_jobs_month > v_capacity_jobs_month * 1.15 THEN
        PERFORM public._upsert_contradiction(
          p_user_id, 'growth_vs_capacity',
          CASE WHEN v_required_jobs_month > v_capacity_jobs_month * 1.5 THEN 'high' ELSE 'medium' END,
          'Growth goal exceeds real crew capacity',
          format('Hitting the $%s/mo goal needs about %s jobs/month at your current average ticket, but %s active technician(s) can only deliver about %s jobs/month.',
            round(v_goal_cents / 100.0)::text, round(v_required_jobs_month)::text, v_crew_size::text, round(v_capacity_jobs_month)::text),
          jsonb_build_object('goal_cents', v_goal_cents, 'required_jobs_month', round(v_required_jobs_month), 'capacity_jobs_month', round(v_capacity_jobs_month), 'crew_size', v_crew_size),
          'growth_vs_capacity'
        );
      END IF;
    END IF;
  END IF;

  -- ============================================================
  -- PATTERN 2: discounting isn't the reason quotes are won/lost
  -- ============================================================
  SELECT count(*) FILTER (WHERE decline_reason IS NOT NULL) INTO v_declined_with_reason
  FROM quotes WHERE user_id = p_user_id AND status = 'declined' AND updated_at > now() - interval '90 days';

  IF v_declined_with_reason >= 5 THEN
    SELECT count(*) FILTER (WHERE decline_reason = 'price') INTO v_declined_price_reason
    FROM quotes WHERE user_id = p_user_id AND status = 'declined' AND updated_at > now() - interval '90 days';

    SELECT COALESCE(avg(discount_percent), 0) INTO v_avg_discount_declined
    FROM quotes WHERE user_id = p_user_id AND status = 'declined' AND updated_at > now() - interval '90 days' AND discount_percent > 0;

    SELECT COALESCE(avg(discount_percent), 0) INTO v_avg_discount_accepted
    FROM quotes WHERE user_id = p_user_id AND status = 'accepted' AND updated_at > now() - interval '90 days' AND discount_percent > 0;

    IF (v_avg_discount_declined > 0 OR v_avg_discount_accepted > 0)
       AND (v_declined_price_reason::numeric / v_declined_with_reason) < 0.5 THEN
      PERFORM public._upsert_contradiction(
        p_user_id, 'discount_not_the_reason', 'medium',
        'Discounting quotes without fixing the real loss reason',
        format('Only %s%% of lost quotes with a reason cite price, yet declined quotes carry an average %s%% discount (vs %s%% on accepted ones). The discount isn''t addressing why you''re actually losing.',
          round(100.0 * v_declined_price_reason / v_declined_with_reason)::text, round(v_avg_discount_declined)::text, round(v_avg_discount_accepted)::text),
        jsonb_build_object('declined_with_reason', v_declined_with_reason, 'declined_price_pct', round(100.0 * v_declined_price_reason / v_declined_with_reason), 'avg_discount_declined', v_avg_discount_declined, 'avg_discount_accepted', v_avg_discount_accepted),
        'discount_not_the_reason'
      );
    END IF;
  END IF;

  -- ============================================================
  -- PATTERN 3: marketing brings leads, follow-up doesn't happen
  -- ============================================================
  SELECT COALESCE(sum(spend_cents), 0) INTO v_spend_cents
  FROM marketing_channel_spend WHERE user_id = p_user_id AND period_start > now() - interval '30 days';

  SELECT count(*) INTO v_leads_period FROM leads WHERE user_id = p_user_id AND created_at > now() - interval '30 days';

  SELECT count(*) INTO v_stale_leads FROM leads
  WHERE user_id = p_user_id AND created_at > now() - interval '30 days'
    AND follow_up_count = 0 AND created_at < now() - interval '24 hours';

  IF v_spend_cents > 0 AND v_leads_period >= 5 AND (v_stale_leads::numeric / v_leads_period) > 0.3 THEN
    PERFORM public._upsert_contradiction(
      p_user_id, 'marketing_vs_followup',
      CASE WHEN (v_stale_leads::numeric / v_leads_period) > 0.5 THEN 'high' ELSE 'medium' END,
      'Marketing spend is being wasted on slow follow-up',
      format('You spent $%s on marketing this month generating %s leads, but %s%% (%s of %s) went 24+ hours with zero follow-up.',
        round(v_spend_cents / 100.0)::text, v_leads_period::text, round(100.0 * v_stale_leads / v_leads_period)::text, v_stale_leads::text, v_leads_period::text),
      jsonb_build_object('spend_cents', v_spend_cents, 'leads_period', v_leads_period, 'stale_leads', v_stale_leads),
      'marketing_vs_followup'
    );
  END IF;

  -- ============================================================
  -- PATTERN 4: best-revenue branch has worst margin + highest churn
  -- (only applies if this account runs a franchise group)
  -- ============================================================
  SELECT id INTO v_group_id FROM franchise_groups WHERE owner_id = p_user_id;

  IF v_group_id IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS tmp_branch_stats (location_id uuid, label text, revenue numeric, refund_rate numeric, churn_rate numeric) ON COMMIT DROP;
    DELETE FROM tmp_branch_stats;

    FOR v_loc IN SELECT id, label, location_profile_id FROM franchise_locations WHERE franchise_group_id = v_group_id AND status = 'active' AND location_profile_id IS NOT NULL
    LOOP
      SELECT COALESCE(sum(invoice_amount), 0) INTO v_loc_revenue FROM jobs
        WHERE user_id = v_loc.location_profile_id AND invoice_status = 'paid' AND created_at > now() - interval '90 days';

      SELECT CASE WHEN COALESCE(sum(invoice_amount), 0) = 0 THEN 0 ELSE COALESCE(sum(refund_amount_cents), 0) / 100.0 / sum(invoice_amount) END INTO v_loc_refund_rate
        FROM jobs WHERE user_id = v_loc.location_profile_id AND created_at > now() - interval '90 days';

      SELECT CASE WHEN count(*) = 0 THEN 0 ELSE count(*) FILTER (WHERE status IN ('churned', 'cancelled'))::numeric / count(*) END INTO v_loc_churn_rate
        FROM memberships WHERE user_id = v_loc.location_profile_id AND created_at > now() - interval '365 days';

      INSERT INTO tmp_branch_stats VALUES (v_loc.id, v_loc.label, v_loc_revenue, v_loc_refund_rate, v_loc_churn_rate);
    END LOOP;

    SELECT avg(refund_rate), avg(churn_rate) INTO v_avg_refund_rate, v_avg_churn_rate FROM tmp_branch_stats;
    SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY revenue) INTO v_revenue_p75 FROM tmp_branch_stats;

    FOR v_loc IN SELECT * FROM tmp_branch_stats
    LOOP
      IF v_loc.revenue >= v_revenue_p75 AND v_loc.revenue > 0
         AND v_loc.refund_rate > v_avg_refund_rate * 1.5
         AND v_loc.churn_rate > v_avg_churn_rate * 1.5 THEN
        PERFORM public._upsert_contradiction(
          p_user_id, 'branch_revenue_vs_margin_churn', 'high',
          format('%s: top revenue, but weakest margin and churn', v_loc.label),
          format('%s brings in $%s (top quartile of the group) but its refund rate is %s%% (group avg %s%%) and membership churn is %s%% (group avg %s%%) — this branch may be buying revenue with margin and retention.',
            v_loc.label, round(v_loc.revenue)::text, round(v_loc.refund_rate * 100, 1)::text, round(v_avg_refund_rate * 100, 1)::text, round(v_loc.churn_rate * 100, 1)::text, round(v_avg_churn_rate * 100, 1)::text),
          jsonb_build_object('location_id', v_loc.location_id, 'revenue', v_loc.revenue, 'refund_rate', v_loc.refund_rate, 'churn_rate', v_loc.churn_rate),
          'branch_revenue_vs_margin_churn:' || v_loc.location_id::text
        );
      END IF;
    END LOOP;
  END IF;

  -- ============================================================
  -- PATTERN 5: top-revenue technician has high callback/refund
  -- ============================================================
  CREATE TEMP TABLE IF NOT EXISTS tmp_tech_stats (technician_id uuid, name text, revenue numeric, callback_rate numeric, refund_rate numeric) ON COMMIT DROP;
  DELETE FROM tmp_tech_stats;

  INSERT INTO tmp_tech_stats
  SELECT
    tm.id, tm.member_name,
    COALESCE(sum(j.invoice_amount) FILTER (WHERE j.invoice_status = 'paid'), 0),
    CASE WHEN count(j.id) FILTER (WHERE j.job_status = 'completed') = 0 THEN 0
      ELSE count(j.id) FILTER (WHERE j.is_rework)::numeric / count(j.id) FILTER (WHERE j.job_status = 'completed') END,
    CASE WHEN COALESCE(sum(j.invoice_amount) FILTER (WHERE j.invoice_status = 'paid'), 0) = 0 THEN 0
      ELSE COALESCE(sum(j.refund_amount_cents), 0) / 100.0 / sum(j.invoice_amount) FILTER (WHERE j.invoice_status = 'paid') END
  FROM team_members tm
  LEFT JOIN jobs j ON j.assigned_technician_id = tm.id AND j.user_id = p_user_id AND j.created_at > now() - interval '90 days'
  WHERE tm.account_owner_id = p_user_id AND tm.invite_status = 'accepted'
  GROUP BY tm.id, tm.member_name;

  SELECT avg(callback_rate), avg(refund_rate) INTO v_avg_callback_rate, v_avg_refund_rate_tech FROM tmp_tech_stats WHERE revenue > 0;
  SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY revenue) INTO v_revenue_p75_tech FROM tmp_tech_stats WHERE revenue > 0;

  FOR v_tech IN SELECT * FROM tmp_tech_stats WHERE revenue > 0
  LOOP
    IF v_tech.revenue >= v_revenue_p75_tech
       AND (v_tech.callback_rate > GREATEST(v_avg_callback_rate * 1.5, 0.1) OR v_tech.refund_rate > GREATEST(v_avg_refund_rate_tech * 1.5, 0.03)) THEN
      PERFORM public._upsert_contradiction(
        p_user_id, 'technician_revenue_vs_quality', 'medium',
        format('%s: top revenue, but quality drag', COALESCE(v_tech.name, 'Unnamed technician')),
        format('%s generated $%s in the last 90 days (top quartile) but has a %s%% callback rate and %s%% refund rate (team avg %s%% / %s%%) — high sales may be coming from overselling or rushed work.',
          COALESCE(v_tech.name, 'This technician'), round(v_tech.revenue)::text, round(v_tech.callback_rate * 100, 1)::text, round(v_tech.refund_rate * 100, 1)::text, round(v_avg_callback_rate * 100, 1)::text, round(v_avg_refund_rate_tech * 100, 1)::text),
        jsonb_build_object('technician_id', v_tech.technician_id, 'revenue', v_tech.revenue, 'callback_rate', v_tech.callback_rate, 'refund_rate', v_tech.refund_rate),
        'technician_revenue_vs_quality:' || v_tech.technician_id::text
      );
    END IF;
  END LOOP;

  -- ============================================================
  -- Auto-resolve anything open that wasn't re-detected this run
  -- ============================================================
  UPDATE business_contradictions SET status = 'resolved', resolved_at = now()
  WHERE user_id = p_user_id AND status = 'open'
    AND dedupe_key NOT IN (SELECT dedupe_key FROM seen_contradiction_keys);

  SELECT count(*) INTO v_count FROM business_contradictions WHERE user_id = p_user_id AND status = 'open';
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_contradiction_detection(uuid) TO authenticated;
