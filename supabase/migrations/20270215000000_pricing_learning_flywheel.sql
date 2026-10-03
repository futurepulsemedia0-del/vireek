/*
  # Vireek Pricing Learning Flywheel

  Job Profitability Autopsy -> Learn price -> Owner approves -> Apply -> Measure
  -> next lap learns only from jobs completed at the NEW price.

  ## Why
  job_profitability knows what every job really earned; the Price Book decides
  what the next job will be charged. This closes the gap between them: realized
  margin per Price Book item becomes a bounded, evidence-backed price proposal,
  and every approved change is later judged on real jobs.

  ## Honesty rules
  - Only itemized-cost jobs count (cost_entry_count > 0) and rework is excluded.
  - A job is linked to a Price Book item only by explicit link or EXACT name match
    (no fuzzy keyword guessing).
  - Only 'flat' items get proposals; only price INCREASES are ever proposed.
  - Discounting (charging below book price) is reported, never "fixed" by a price rise.
  - Results are observational before/after; a demand warning is shown when job
    volume drops sharply after an increase.
  - A price change is never applied without the account OWNER approving it.
  - Revert refuses to overwrite a price the owner edited manually afterwards.

  ## Tables / functions
  pricing_flywheel_settings, pricing_adjustments, view pricing_flywheel_facts,
  record_pricing_proposals(), decide_pricing_adjustment(),
  set_pricing_flywheel_settings(), get_pricing_adjustment_results().
  Every approved / reverted / superseded change is also written to
  ops_policy_changes (Autonomous Operations Loop).

  ## Depends on
  jobs, job_profitability, price_book_items, public.get_account_owner_id(),
  20270210000000_autonomous_operations_loop.sql (run that one FIRST).
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS pricing_flywheel_settings (
  user_id uuid PRIMARY KEY,
  target_margin_pct numeric(5, 2) NOT NULL DEFAULT 35 CHECK (target_margin_pct BETWEEN 5 AND 80),
  max_step_pct numeric(5, 2) NOT NULL DEFAULT 10 CHECK (max_step_pct BETWEEN 1 AND 25),
  min_samples integer NOT NULL DEFAULT 5 CHECK (min_samples BETWEEN 3 AND 50),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  price_book_item_id uuid NOT NULL REFERENCES price_book_items(id) ON DELETE CASCADE,
  service_name text NOT NULL CHECK (char_length(service_name) <= 200),
  price_before_cents integer NOT NULL CHECK (price_before_cents > 0),
  price_max_before_cents integer,
  price_proposed_cents integer NOT NULL,
  applied_price_cents integer,
  applied_price_max_cents integer,
  target_margin_pct numeric(5, 2) NOT NULL,
  observed_margin_pct numeric(7, 2) NOT NULL,
  avg_cost_cents integer NOT NULL CHECK (avg_cost_cents >= 0),
  avg_revenue_cents integer NOT NULL CHECK (avg_revenue_cents >= 0),
  sample_size integer NOT NULL CHECK (sample_size >= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'superseded', 'reverted', 'dismissed')),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  activated_at timestamptz,
  deactivated_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  CONSTRAINT pricing_adjustments_increase_only CHECK (price_proposed_cents > price_before_cents),
  CONSTRAINT pricing_adjustments_hard_cap CHECK (price_proposed_cents <= price_before_cents * 1.25)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_adj_proposed_item
  ON pricing_adjustments(price_book_item_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_adj_active_item
  ON pricing_adjustments(price_book_item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pricing_adj_user_status
  ON pricing_adjustments(user_id, status, proposed_at DESC);

-- =============================================================
-- RLS (read-only for clients; every write goes through a function)
-- =============================================================

ALTER TABLE pricing_flywheel_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_pricing_flywheel_settings" ON pricing_flywheel_settings;
CREATE POLICY "select_own_pricing_flywheel_settings" ON pricing_flywheel_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_pricing_adjustments" ON pricing_adjustments;
CREATE POLICY "select_own_pricing_adjustments" ON pricing_adjustments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FACTS VIEW: one row per completed job linked to a Price Book item
-- =============================================================

CREATE OR REPLACE VIEW pricing_flywheel_facts
WITH (security_invoker = true) AS
SELECT
  j.id AS job_id,
  j.user_id,
  pbi.id AS price_book_item_id,
  j.completed_at,
  jp.revenue_cents,
  jp.total_cost_cents,
  (COALESCE(jp.cost_entry_count, 0) > 0) AS has_cost,
  COALESCE(j.is_rework, false) AS is_rework
FROM jobs j
JOIN job_profitability jp ON jp.job_id = j.id
JOIN LATERAL (
  SELECT p.id
  FROM price_book_items p
  WHERE p.user_id = j.user_id
    AND (
      p.id = j.price_book_item_id
      OR (j.price_book_item_id IS NULL AND j.service_type IS NOT NULL
          AND lower(p.service_name) = lower(j.service_type))
    )
  ORDER BY (p.id = j.price_book_item_id) DESC, p.active DESC
  LIMIT 1
) pbi ON true
WHERE j.job_status = 'completed'
  AND j.completed_at IS NOT NULL
  AND jp.revenue_cents > 0;

-- =============================================================
-- SETTINGS (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_pricing_flywheel_settings(
  p_target_margin_pct numeric,
  p_max_step_pct numeric,
  p_min_samples integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change pricing settings';
  END IF;
  IF p_target_margin_pct NOT BETWEEN 5 AND 80 OR p_max_step_pct NOT BETWEEN 1 AND 25
     OR p_min_samples NOT BETWEEN 3 AND 50 THEN
    RAISE EXCEPTION 'Pricing settings out of range';
  END IF;
  INSERT INTO pricing_flywheel_settings (user_id, target_margin_pct, max_step_pct, min_samples, updated_at)
  VALUES (v_owner, p_target_margin_pct, p_max_step_pct, p_min_samples, now())
  ON CONFLICT (user_id) DO UPDATE SET
    target_margin_pct = EXCLUDED.target_margin_pct,
    max_step_pct = EXCLUDED.max_step_pct,
    min_samples = EXCLUDED.min_samples,
    updated_at = now();
END;
$$;

-- =============================================================
-- RECORD PROPOSALS (validated server-side; client numbers are never trusted)
-- =============================================================

/*
  p_proposals: jsonb array of
    { price_book_item_id, proposed_price_cents, observed_margin_pct, target_margin_pct,
      avg_cost_cents, avg_revenue_cents, sample_size, evidence }
  Returns the number of proposals newly created or refreshed.
*/
CREATE OR REPLACE FUNCTION public.record_pricing_proposals(p_proposals jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_set pricing_flywheel_settings;
  v_item jsonb;
  v_pbi price_book_items;
  v_proposed integer;
  v_n integer;
  v_obs numeric;
  v_count integer := 0;
  v_existing uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_proposals IS NULL OR jsonb_typeof(p_proposals) <> 'array' THEN
    RAISE EXCEPTION 'p_proposals must be a JSON array';
  END IF;
  IF jsonb_array_length(p_proposals) > 100 THEN
    RAISE EXCEPTION 'Too many proposals in one call (max 100)';
  END IF;

  SELECT * INTO v_set FROM pricing_flywheel_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN
    v_set.target_margin_pct := 35; v_set.max_step_pct := 10; v_set.min_samples := 5;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    SELECT * INTO v_pbi FROM price_book_items
    WHERE id = (v_item->>'price_book_item_id')::uuid AND user_id = v_owner;
    IF NOT FOUND OR v_pbi.pricing_model <> 'flat' OR NOT v_pbi.active THEN
      CONTINUE;
    END IF;

    v_proposed := (v_item->>'proposed_price_cents')::integer;
    v_n := (v_item->>'sample_size')::integer;
    v_obs := (v_item->>'observed_margin_pct')::numeric;

    -- Hard server-side guards.
    IF v_proposed IS NULL OR v_n IS NULL OR v_obs IS NULL
       OR v_n < v_set.min_samples
       OR v_obs >= v_set.target_margin_pct
       OR v_proposed <= v_pbi.price_cents
       OR v_proposed > ceil(v_pbi.price_cents * (1 + v_set.max_step_pct / 100.0) + 1) THEN
      CONTINUE;
    END IF;

    -- Cooldown: let an applied change be measured; respect a recent dismissal.
    IF EXISTS (
      SELECT 1 FROM pricing_adjustments a
      WHERE a.price_book_item_id = v_pbi.id
        AND ((a.status = 'active' AND a.activated_at > now() - interval '30 days')
          OR (a.status IN ('dismissed', 'reverted') AND a.decided_at > now() - interval '30 days'))
    ) THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_existing FROM pricing_adjustments
    WHERE price_book_item_id = v_pbi.id AND status = 'proposed';

    IF v_existing IS NOT NULL THEN
      UPDATE pricing_adjustments SET
        service_name = v_pbi.service_name,
        price_before_cents = v_pbi.price_cents,
        price_max_before_cents = v_pbi.price_max_cents,
        price_proposed_cents = v_proposed,
        target_margin_pct = v_set.target_margin_pct,
        observed_margin_pct = round(v_obs, 2),
        avg_cost_cents = (v_item->>'avg_cost_cents')::integer,
        avg_revenue_cents = (v_item->>'avg_revenue_cents')::integer,
        sample_size = v_n,
        evidence = COALESCE(v_item->'evidence', '{}'::jsonb),
        proposed_at = now()
      WHERE id = v_existing;
    ELSE
      INSERT INTO pricing_adjustments (
        user_id, price_book_item_id, service_name, price_before_cents, price_max_before_cents,
        price_proposed_cents, target_margin_pct, observed_margin_pct,
        avg_cost_cents, avg_revenue_cents, sample_size, evidence
      ) VALUES (
        v_owner, v_pbi.id, left(v_pbi.service_name, 200), v_pbi.price_cents, v_pbi.price_max_cents,
        v_proposed, v_set.target_margin_pct, round(v_obs, 2),
        (v_item->>'avg_cost_cents')::integer, (v_item->>'avg_revenue_cents')::integer, v_n,
        COALESCE(v_item->'evidence', '{}'::jsonb)
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- =============================================================
-- HUMAN DECISION (owner only): approve / dismiss / revert
-- =============================================================

CREATE OR REPLACE FUNCTION public.decide_pricing_adjustment(
  p_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row pricing_adjustments;
  v_pbi price_book_items;
  v_new_max integer;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can decide on a price change';
  END IF;
  IF p_decision NOT IN ('approve', 'dismiss', 'revert') THEN
    RAISE EXCEPTION 'Unknown decision';
  END IF;

  SELECT * INTO v_row FROM pricing_adjustments
  WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Price change not found';
  END IF;

  SELECT * INTO v_pbi FROM price_book_items
  WHERE id = v_row.price_book_item_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Price Book item no longer exists';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed price change can be approved';
    END IF;
    IF v_pbi.price_cents <> v_row.price_before_cents THEN
      RAISE EXCEPTION 'The Price Book price changed since this proposal. Refresh to get a new one.';
    END IF;

    v_new_max := CASE WHEN v_pbi.price_max_cents IS NULL THEN NULL
                      ELSE GREATEST(v_row.price_proposed_cents,
                        round(v_pbi.price_max_cents * v_row.price_proposed_cents::numeric / v_row.price_before_cents)::integer)
                 END;

    UPDATE pricing_adjustments
    SET status = 'superseded', deactivated_at = now()
    WHERE price_book_item_id = v_row.price_book_item_id AND status = 'active';

    UPDATE price_book_items
    SET price_cents = v_row.price_proposed_cents, price_max_cents = v_new_max
    WHERE id = v_pbi.id;

    UPDATE pricing_adjustments
    SET status = 'active', activated_at = now(), decided_at = now(), decided_by = auth.uid(),
        applied_price_cents = v_row.price_proposed_cents, applied_price_max_cents = v_new_max,
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;

  ELSIF p_decision = 'dismiss' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed price change can be dismissed';
    END IF;
    UPDATE pricing_adjustments
    SET status = 'dismissed', decided_at = now(), decided_by = auth.uid(),
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;

  ELSE
    IF v_row.status <> 'active' THEN
      RAISE EXCEPTION 'Only an active price change can be reverted';
    END IF;
    IF v_pbi.price_cents <> v_row.applied_price_cents THEN
      RAISE EXCEPTION 'The price was edited manually after this change. Revert it in the Price Book instead.';
    END IF;
    UPDATE price_book_items
    SET price_cents = v_row.price_before_cents, price_max_cents = v_row.price_max_before_cents
    WHERE id = v_pbi.id;
    UPDATE pricing_adjustments
    SET status = 'reverted', deactivated_at = now(), decided_at = now(), decided_by = auth.uid(),
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;
  END IF;
END;
$$;

-- =============================================================
-- UPDATE POLICY ledger (Autonomous Operations Loop)
-- =============================================================

ALTER TABLE ops_policy_changes DROP CONSTRAINT IF EXISTS ops_policy_changes_policy_kind_check;
ALTER TABLE ops_policy_changes ADD CONSTRAINT ops_policy_changes_policy_kind_check
  CHECK (policy_kind IN ('duration_correction', 'pricing_adjustment'));

CREATE OR REPLACE FUNCTION public.capture_pricing_policy_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_epoch bigint;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'active' THEN
    v_type := 'activated';
  ELSIF OLD.status = 'active' AND NEW.status = 'reverted' THEN
    v_type := 'reverted';
  ELSIF OLD.status = 'active' AND NEW.status = 'superseded' THEN
    v_type := 'superseded';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ops_policy:' || NEW.user_id::text, 0));
  SELECT COALESCE(MAX(epoch), 0) + 1 INTO v_epoch FROM ops_policy_changes WHERE user_id = NEW.user_id;

  INSERT INTO ops_policy_changes (
    user_id, epoch, policy_kind, change_type, source_table, source_id, summary, params, decided_by
  ) VALUES (
    NEW.user_id, v_epoch, 'pricing_adjustment', v_type, 'pricing_adjustments', NEW.id,
    left('Price of ' || NEW.service_name || ' ' || (NEW.price_before_cents / 100.0)::numeric(10, 2)::text
      || ' -> ' || (NEW.price_proposed_cents / 100.0)::numeric(10, 2)::text || ' ' || v_type, 300),
    jsonb_build_object(
      'price_book_item_id', NEW.price_book_item_id, 'before_cents', NEW.price_before_cents,
      'after_cents', NEW.price_proposed_cents, 'sample_size', NEW.sample_size
    ),
    NEW.decided_by
  )
  ON CONFLICT (source_table, source_id, change_type) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_pricing_policy_change ON pricing_adjustments;
CREATE TRIGGER trg_capture_pricing_policy_change
  AFTER UPDATE OF status ON pricing_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.capture_pricing_policy_change();

-- =============================================================
-- MEASURE: 30 days before vs. after each applied change
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_pricing_adjustment_results()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_min integer;
  v_result jsonb;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  SELECT COALESCE((SELECT min_samples FROM pricing_flywheel_settings WHERE user_id = v_owner), 5) INTO v_min;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.activated_at DESC), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      a.id AS adjustment_id, a.price_book_item_id, a.service_name, a.status, a.activated_at,
      a.price_before_cents, a.applied_price_cents,
      w.days_after, pre.jobs AS jobs_before, post.jobs AS jobs_after,
      pre.costed AS costed_before, post.costed AS costed_after,
      CASE WHEN pre.costed >= v_min AND post.costed >= v_min THEN round(pre.margin, 1) END AS margin_before,
      CASE WHEN pre.costed >= v_min AND post.costed >= v_min THEN round(post.margin, 1) END AS margin_after,
      CASE
        WHEN pre.costed < v_min OR post.costed < v_min THEN 'insufficient'
        WHEN post.margin >= pre.margin + 2 THEN 'improved'
        WHEN post.margin <= pre.margin - 2 THEN 'worsened'
        ELSE 'flat'
      END AS verdict,
      (w.days_after >= 14 AND pre.jobs >= v_min
        AND (post.jobs::numeric / GREATEST(w.days_after, 1)) < 0.75 * (pre.jobs::numeric / 30)) AS demand_warning
    FROM pricing_adjustments a
    CROSS JOIN LATERAL (
      SELECT GREATEST(1, LEAST(30, ceil(extract(epoch FROM (
        LEAST(COALESCE(a.deactivated_at, now()), a.activated_at + interval '30 days') - a.activated_at)) / 86400.0)::int)) AS days_after
    ) w
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS jobs,
             count(*) FILTER (WHERE f.has_cost AND NOT f.is_rework)::int AS costed,
             COALESCE(100.0 * (sum(f.revenue_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework)
               - sum(f.total_cost_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework))
               / NULLIF(sum(f.revenue_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework), 0), 0) AS margin
      FROM pricing_flywheel_facts f
      WHERE f.user_id = v_owner AND f.price_book_item_id = a.price_book_item_id
        AND f.completed_at < a.activated_at AND f.completed_at >= a.activated_at - interval '30 days'
    ) pre
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS jobs,
             count(*) FILTER (WHERE f.has_cost AND NOT f.is_rework)::int AS costed,
             COALESCE(100.0 * (sum(f.revenue_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework)
               - sum(f.total_cost_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework))
               / NULLIF(sum(f.revenue_cents) FILTER (WHERE f.has_cost AND NOT f.is_rework), 0), 0) AS margin
      FROM pricing_flywheel_facts f
      WHERE f.user_id = v_owner AND f.price_book_item_id = a.price_book_item_id
        AND f.completed_at >= a.activated_at
        AND f.completed_at < LEAST(COALESCE(a.deactivated_at, now()), a.activated_at + interval '30 days')
    ) post
    WHERE a.user_id = v_owner AND a.activated_at IS NOT NULL
    ORDER BY a.activated_at DESC
    LIMIT 30
  ) t;

  RETURN v_result;
END;
$$;

-- =============================================================
-- Ops Loop snapshot: duration-error impact must only judge duration policies.
-- (Same function as 20270210000000, one added filter: policy_kind.)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_ops_loop_snapshot(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 90), 1), 365);
  v_since timestamptz := now() - make_interval(days => v_days);
  v_stages jsonb;
  v_totals jsonb;
  v_impact jsonb;
  v_recent jsonb;
  v_last_sync timestamptz;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT max(synced_at) INTO v_last_sync FROM ops_loop_events WHERE user_id = v_owner;

  SELECT jsonb_build_object(
    'jobs', count(*),
    'completed', count(*) FILTER (WHERE acted),
    'closed_loop', count(*) FILTER (WHERE stages_reached = 7),
    'training_events', count(*) FILTER (WHERE training_value >= 80),
    'avg_training_value', COALESCE(round(avg(training_value)::numeric, 1), 0),
    'observed', count(*) FILTER (WHERE observed),
    'understood', count(*) FILTER (WHERE understood),
    'predicted', count(*) FILTER (WHERE predicted),
    'decided', count(*) FILTER (WHERE decided),
    'acted', count(*) FILTER (WHERE acted),
    'measured', count(*) FILTER (WHERE measured),
    'learned', count(*) FILTER (WHERE learned)
  ) INTO v_totals
  FROM ops_loop_events
  WHERE user_id = v_owner AND COALESCE(job_completed_at, synced_at) >= v_since;

  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'created_at') DESC), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT jsonb_build_object(
      'job_id', e.job_id, 'customer_name', j.customer_name, 'job_type_key', e.job_type_key,
      'stages_reached', e.stages_reached, 'training_value', e.training_value,
      'observed', e.observed, 'understood', e.understood, 'predicted', e.predicted,
      'decided', e.decided, 'acted', e.acted, 'measured', e.measured, 'learned', e.learned,
      'primary_cause', e.primary_cause, 'created_at', COALESCE(e.job_completed_at, e.synced_at)
    ) AS r
    FROM ops_loop_events e JOIN jobs j ON j.id = e.job_id
    WHERE e.user_id = v_owner AND COALESCE(e.job_completed_at, e.synced_at) >= v_since
    ORDER BY COALESCE(e.job_completed_at, e.synced_at) DESC
    LIMIT 40
  ) q;

  -- Policy impact: mean absolute duration error (minutes) of variances recorded
  -- 30 days before vs 30 days after each change. Observational only; >= 8 per side.
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.effective_at DESC), '[]'::jsonb) INTO v_impact
  FROM (
    SELECT
      p.id, p.epoch, p.change_type, p.summary, p.effective_at, p.params,
      pre.n AS n_before, post.n AS n_after,
      CASE WHEN pre.n >= 8 AND post.n >= 8 THEN round(pre.mae, 1) END AS mae_before,
      CASE WHEN pre.n >= 8 AND post.n >= 8 THEN round(post.mae, 1) END AS mae_after,
      CASE
        WHEN pre.n < 8 OR post.n < 8 THEN 'insufficient'
        WHEN post.mae <= pre.mae * 0.95 THEN 'improved'
        WHEN post.mae >= pre.mae * 1.05 THEN 'worsened'
        ELSE 'flat'
      END AS verdict
    FROM ops_policy_changes p
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, COALESCE(avg(abs(v.error_value)), 0) AS mae
      FROM improvement_variances v
      WHERE v.user_id = v_owner AND v.metric = 'duration'
        AND v.created_at < p.effective_at AND v.created_at >= p.effective_at - interval '30 days'
    ) pre
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, COALESCE(avg(abs(v.error_value)), 0) AS mae
      FROM improvement_variances v
      WHERE v.user_id = v_owner AND v.metric = 'duration'
        AND v.created_at >= p.effective_at AND v.created_at < p.effective_at + interval '30 days'
    ) post
    WHERE p.user_id = v_owner AND p.change_type = 'activated' AND p.policy_kind = 'duration_correction'
    ORDER BY p.effective_at DESC
    LIMIT 20
  ) t;

  SELECT jsonb_build_object(
    'policy_changes_total', (SELECT count(*) FROM ops_policy_changes WHERE user_id = v_owner),
    'policy_changes_window', (SELECT count(*) FROM ops_policy_changes WHERE user_id = v_owner AND effective_at >= v_since),
    'pending_proposals', (SELECT count(*) FROM improvement_corrections WHERE user_id = v_owner AND status = 'proposed'),
    'active_policies', (SELECT count(*) FROM improvement_corrections WHERE user_id = v_owner AND status = 'active')
  ) INTO v_stages;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'last_sync', v_last_sync,
    'totals', v_totals,
    'policy', v_stages,
    'impact', v_impact,
    'recent', v_recent
  );
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.set_pricing_flywheel_settings(numeric, numeric, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_pricing_proposals(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_pricing_adjustment(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pricing_adjustment_results() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.capture_pricing_policy_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_ops_loop_snapshot(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_pricing_flywheel_settings(numeric, numeric, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_pricing_proposals(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_pricing_adjustment(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pricing_adjustment_results() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ops_loop_snapshot(integer) TO authenticated;
