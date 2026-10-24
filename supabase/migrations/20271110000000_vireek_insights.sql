/*
  # Vireek Insights — privacy-safe aggregated industry indexes

  Quarterly, publishable indexes (average ticket, close rate, lead response
  time, lead volume, demand growth) by trade and US state, built from the
  businesses that explicitly opted in, and released only after a human
  privacy review.

  ## Reuse (nothing existing is altered)
  - public.compute_tenant_metrics()  per-tenant metric math (20260923000000)
  - public.ob_region_key()           free-text service_area -> US state (20270301000000)
  - public.oin_stable_laplace()      deterministic Laplace noise (20270205000000)
  - public.oin_can_manage()          owner/admin gate for consent (20270205000000)
  - public.is_vireek_staff()         staff gate (20260913020000)
  - same nightly-job pattern (guarded pg_cron) as 20261205000000

  ## Privacy model (enforced in the database, not in the UI)
  1. OPT-IN: a business contributes only after an owner/admin switches it on
     (insights_settings.contribute, default false). Every grant/withdrawal is
     written to an append-only insights_consent_log.
  2. AGGREGATED TWICE: raw rows -> one number per business per metric ->
     cohort percentiles of those numbers. Raw rows never leave the tenant.
  3. K-ANONYMITY: a cell is published only with >= 10 distinct businesses
     (stricter than the private benchmark floor of 5, because this data is
     public) AND >= 3 distinct values (so identical values cannot reveal
     every member). Enforced by the generator, re-checked by
     insights_publish(), and backed by CHECK constraints on the audit table.
  4. NO EXTREMES, NO MEANS: only p25 / median / p75 are stored. Exact
     contributor counts are never public; only a band (10-19, 20-49, ...).
  5. STABLE NOISE: one shared deterministic Laplace shift per cell, scaled by
     IQR / n and seeded by (period, cell), so a re-run cannot be averaged
     away and p25 <= p50 <= p75 always holds. DP-INSPIRED, NOT a formally
     proven epsilon-DP guarantee — do not describe it as certified DP.
  6. IMMUTABLE RELEASES: a published quarter can never be edited or deleted;
     the only allowed transition is published -> retracted (kill switch).
  7. TIERED ACCESS: the public page gets national cells only. State-level
     cells go to contributing businesses (give-to-get) and API subscribers.
  8. SUPPRESSION AUDIT: every cell that failed the gates is logged (reason
     only, never counts or values) for the privacy reviewer.

  Withdrawal takes effect from the next generated quarter. Already published
  aggregates are not recomputed (disclosed in the consent text).

  Operations (SQL editor / service role), see docs/runbooks/vireek-insights-privacy-review.md:
    select public.insights_generate_publication(2027, 4);   -- draft
    select public.insights_publish('<publication id>');       -- after review
    select public.insights_retract('<publication id>', 'reason');
*/

-- =============================================================
-- 0. PURE HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.insights_consent_version()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 1;
$$;

-- Controlled trade vocabulary: the only trade strings that can ever be published.
CREATE OR REPLACE FUNCTION public.insights_trade_key(p_industry text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN t.s = ANY (ARRAY['hvac','plumbing','roofing','electrical','restoration','locksmith','pest-control','lawn-care','cleaning','pool-service','appliance-repair','solar','painting']) THEN t.s
    WHEN t.s ~ 'hvac|heating|cooling|air-?cond|refrig' THEN 'hvac'
    WHEN t.s ~ 'plumb|drain|water-?heater' THEN 'plumbing'
    WHEN t.s ~ 'roof' THEN 'roofing'
    WHEN t.s ~ 'electr' THEN 'electrical'
    WHEN t.s ~ 'restor|water-?damage|mitigation' THEN 'restoration'
    WHEN t.s ~ 'lock' THEN 'locksmith'
    WHEN t.s ~ 'pest|exterminat' THEN 'pest-control'
    WHEN t.s ~ 'lawn|landscap' THEN 'lawn-care'
    WHEN t.s ~ 'clean|janitor|maid' THEN 'cleaning'
    WHEN t.s ~ 'pool' THEN 'pool-service'
    WHEN t.s ~ 'appliance' THEN 'appliance-repair'
    WHEN t.s ~ 'solar' THEN 'solar'
    WHEN t.s ~ 'paint' THEN 'painting'
    ELSE 'other'
  END
  FROM (
    SELECT trim(both '-' FROM regexp_replace(lower(btrim(coalesce(p_industry, ''))), '[^a-z0-9]+', '-', 'g')) AS s
  ) t;
$$;

-- Clamp + round per unit. Monotone, so shaped p25 <= p50 <= p75 is preserved.
CREATE OR REPLACE FUNCTION public.insights_shape(p_value numeric, p_unit text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_unit
    WHEN 'cents' THEN round(greatest(0, p_value), 0)
    WHEN 'count' THEN round(greatest(0, p_value), 0)
    WHEN 'percent' THEN round(least(100, greatest(0, p_value)), 1)
    WHEN 'hours' THEN round(greatest(0, p_value), 2)
    ELSE round(greatest(0, p_value), 1)
  END;
$$;

CREATE OR REPLACE FUNCTION public.insights_quarter_bounds(p_year integer, p_quarter integer)
RETURNS TABLE (period_label text, period_start date, period_end date, prior_start date, prior_end date)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    p_year::text || '-Q' || p_quarter::text,
    q.s,
    (q.s + interval '3 months' - interval '1 day')::date,
    (q.s - interval '3 months')::date,
    (q.s - interval '1 day')::date
  FROM (SELECT make_date(p_year, (p_quarter - 1) * 3 + 1, 1) AS s) q;
$$;

-- =============================================================
-- 1. CONSENT (opt-in, per business, audited)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.insights_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  contribute boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
  consented_at timestamptz,
  consented_by uuid,
  withdrawn_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insights_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_insights_settings" ON public.insights_settings;
CREATE POLICY "select_own_insights_settings" ON public.insights_settings
  FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- No client insert/update/delete: changed only through insights_set_contribution().

CREATE TABLE IF NOT EXISTS public.insights_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  consent_version integer NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_consent_log_owner
  ON public.insights_consent_log (account_owner_id, created_at DESC);

ALTER TABLE public.insights_consent_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_insights_consent_log" ON public.insights_consent_log;
CREATE POLICY "select_own_insights_consent_log" ON public.insights_consent_log
  FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- Append-only: no client write policies at all.

CREATE OR REPLACE FUNCTION public.insights_is_contributing(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT s.contribute FROM public.insights_settings s WHERE s.account_owner_id = p_owner), false);
$$;

CREATE OR REPLACE FUNCTION public.insights_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.insights_is_contributing(public.get_account_owner_id());
$$;

CREATE OR REPLACE FUNCTION public.insights_set_contribution(p_enabled boolean)
RETURNS public.insights_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_prev boolean;
  v_row public.insights_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'INSIGHTS_FORBIDDEN: sign in required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.oin_can_manage() THEN
    RAISE EXCEPTION 'INSIGHTS_FORBIDDEN: only an owner or admin can change data sharing' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: p_enabled is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.contribute INTO v_prev FROM public.insights_settings s WHERE s.account_owner_id = v_owner;
  v_prev := COALESCE(v_prev, false);

  INSERT INTO public.insights_settings AS s (
    account_owner_id, contribute, consent_version, consented_at, consented_by, withdrawn_at, updated_at
  )
  VALUES (
    v_owner,
    p_enabled,
    public.insights_consent_version(),
    CASE WHEN p_enabled THEN now() END,
    CASE WHEN p_enabled THEN auth.uid() END,
    CASE WHEN NOT p_enabled THEN now() END,
    now()
  )
  ON CONFLICT (account_owner_id) DO UPDATE SET
    contribute = EXCLUDED.contribute,
    consent_version = CASE WHEN EXCLUDED.contribute THEN EXCLUDED.consent_version ELSE s.consent_version END,
    consented_at = CASE WHEN EXCLUDED.contribute AND NOT s.contribute THEN now() ELSE s.consented_at END,
    consented_by = CASE WHEN EXCLUDED.contribute AND NOT s.contribute THEN auth.uid() ELSE s.consented_by END,
    withdrawn_at = CASE WHEN NOT EXCLUDED.contribute AND s.contribute THEN now() ELSE s.withdrawn_at END,
    updated_at = now()
  RETURNING * INTO v_row;

  IF v_prev IS DISTINCT FROM p_enabled THEN
    INSERT INTO public.insights_consent_log (account_owner_id, action, consent_version, actor_id)
    VALUES (v_owner, CASE WHEN p_enabled THEN 'granted' ELSE 'withdrawn' END, public.insights_consent_version(), auth.uid());
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_set_contribution(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_set_contribution(boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.insights_is_contributing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_is_contributing(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.insights_can_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_can_read() TO authenticated, service_role;

-- =============================================================
-- 2. PUBLICATIONS + CELLS (the only shareable output)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.insights_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_label text NOT NULL UNIQUE CHECK (period_label ~ '^[0-9]{4}-Q[1-4]$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retracted')),
  methodology_version integer NOT NULL DEFAULT 1,
  k_min integer NOT NULL DEFAULT 10 CHECK (k_min >= 10),
  -- Total contributing businesses, rounded DOWN to the nearest 10 (never exact).
  contributors_rounded integer NOT NULL DEFAULT 0 CHECK (contributors_rounded >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retracted_at timestamptz,
  retraction_reason text,
  CHECK (period_end > period_start),
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK (status <> 'retracted' OR (retracted_at IS NOT NULL AND retraction_reason IS NOT NULL))
);

ALTER TABLE public.insights_publications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_publications" ON public.insights_publications;
CREATE POLICY "staff_select_insights_publications" ON public.insights_publications
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
-- Everyone else reads through insights_public_periods() / insights_public_indexes().

CREATE TABLE IF NOT EXISTS public.insights_index_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.insights_publications(id) ON DELETE CASCADE,
  trade text NOT NULL CHECK (trade = 'all' OR trade ~ '^[a-z]+(-[a-z]+)*$'),
  region_key text NOT NULL CHECK (region_key = 'all' OR region_key ~ '^[a-z]{2}$'),
  metric text NOT NULL CHECK (metric IN ('avg_ticket_cents', 'close_rate_pct', 'response_hours', 'leads_per_business', 'demand_index')),
  unit text NOT NULL CHECK (unit IN ('cents', 'percent', 'hours', 'count', 'index')),
  direction text NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better', 'neutral')),
  contributor_band text NOT NULL CHECK (contributor_band IN ('10-19', '20-49', '50-99', '100+')),
  p25 numeric NOT NULL,
  p50 numeric NOT NULL,
  p75 numeric NOT NULL,
  qoq_change_pct numeric,
  UNIQUE (publication_id, trade, region_key, metric),
  CHECK (p25 <= p50 AND p50 <= p75)
);

CREATE INDEX IF NOT EXISTS idx_insights_cells_lookup
  ON public.insights_index_cells (publication_id, region_key, trade, metric);

ALTER TABLE public.insights_index_cells ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_cells" ON public.insights_index_cells;
CREATE POLICY "staff_select_insights_cells" ON public.insights_index_cells
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
-- No other policy: contributors / the public / subscribers read only via the
-- SECURITY DEFINER functions below, which enforce tiering and published-only.

-- Exact counts live ONLY here (never exposed). The CHECKs are the last line
-- of defence behind the generator and insights_publish().
CREATE TABLE IF NOT EXISTS public.insights_cell_audit (
  cell_id uuid PRIMARY KEY REFERENCES public.insights_index_cells(id) ON DELETE CASCADE,
  contributor_count integer NOT NULL CHECK (contributor_count >= 10),
  distinct_values integer NOT NULL CHECK (distinct_values >= 3),
  noise_scale numeric NOT NULL CHECK (noise_scale >= 0),
  computed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insights_cell_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_cell_audit" ON public.insights_cell_audit;
CREATE POLICY "staff_select_insights_cell_audit" ON public.insights_cell_audit
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

-- Cells that failed a gate. Reason only: no counts, no values.
CREATE TABLE IF NOT EXISTS public.insights_suppression_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.insights_publications(id) ON DELETE CASCADE,
  trade text NOT NULL,
  region_key text NOT NULL,
  metric text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('below_k', 'low_diversity')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_suppression_pub
  ON public.insights_suppression_log (publication_id);

ALTER TABLE public.insights_suppression_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_suppression" ON public.insights_suppression_log;
CREATE POLICY "staff_select_insights_suppression" ON public.insights_suppression_log
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

-- Immutability: published releases cannot change; only published -> retracted.
CREATE OR REPLACE FUNCTION public.insights_guard_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: only draft publications can be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'retracted' THEN
    RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: a retracted publication cannot change' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'retracted'
       OR NEW.period_label IS DISTINCT FROM OLD.period_label
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.contributors_rounded IS DISTINCT FROM OLD.contributors_rounded
       OR NEW.k_min IS DISTINCT FROM OLD.k_min THEN
      RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: a published publication can only be retracted' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insights_guard_publication ON public.insights_publications;
CREATE TRIGGER trg_insights_guard_publication
  BEFORE UPDATE OR DELETE ON public.insights_publications
  FOR EACH ROW EXECUTE FUNCTION public.insights_guard_publication();

CREATE OR REPLACE FUNCTION public.insights_guard_cells()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pub uuid;
  v_status text;
BEGIN
  v_pub := CASE WHEN TG_OP = 'DELETE' THEN OLD.publication_id ELSE NEW.publication_id END;
  SELECT p.status INTO v_status FROM public.insights_publications p WHERE p.id = v_pub;
  -- v_status IS NULL during a cascade from a (draft) publication delete.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: cells of a published or retracted publication cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_insights_guard_cells ON public.insights_index_cells;
CREATE TRIGGER trg_insights_guard_cells
  BEFORE INSERT OR UPDATE OR DELETE ON public.insights_index_cells
  FOR EACH ROW EXECUTE FUNCTION public.insights_guard_cells();

-- =============================================================
-- 3. PER-BUSINESS METRICS (one number per metric, minimum samples)
-- =============================================================

/*
  Reuses compute_tenant_metrics() for the math and adds minimum per-business
  sample sizes so a business with two quotes cannot contribute a noisy or
  identifying value. A metric is simply absent (never a fabricated 0) when
  the sample is too small.

    close_rate_pct      quote_acceptance_rate  (>= 10 quotes sent)
    avg_ticket_cents    avg_ticket_cents       (>= 10 paid jobs)
    response_hours      avg_lead_response_hours (lead -> quote sent; >= 10 leads)
    leads_per_business  leads created in the quarter (>= 10)
    demand_index        100 * leads this quarter / leads prior quarter,
                        clamped 0..300 (prior quarter >= 10 leads)
*/
CREATE OR REPLACE FUNCTION public.insights_tenant_metrics(
  p_user_id uuid, p_start date, p_end date, p_prior_start date, p_prior_end date
)
RETURNS TABLE (metric text, value numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT m.metric AS k, m.value AS v
    FROM public.compute_tenant_metrics(p_user_id, p_start, p_end) m
  ),
  counts AS (
    SELECT
      (SELECT count(*) FROM public.quotes q
        WHERE q.user_id = p_user_id AND q.sent_at IS NOT NULL
          AND q.sent_at::date BETWEEN p_start AND p_end) AS quotes_sent,
      (SELECT count(*) FROM public.jobs j
        WHERE j.user_id = p_user_id AND j.invoice_status = 'paid' AND j.invoice_amount IS NOT NULL
          AND j.created_at::date BETWEEN p_start AND p_end) AS paid_jobs,
      (SELECT count(*) FROM public.leads l
        WHERE l.user_id = p_user_id AND l.quote_sent_at IS NOT NULL AND l.quote_sent_at >= l.created_at
          AND l.created_at::date BETWEEN p_start AND p_end) AS responded_leads,
      (SELECT count(*) FROM public.leads l
        WHERE l.user_id = p_user_id AND l.created_at::date BETWEEN p_start AND p_end) AS leads_cur,
      (SELECT count(*) FROM public.leads l
        WHERE l.user_id = p_user_id AND l.created_at::date BETWEEN p_prior_start AND p_prior_end) AS leads_prior
  )
  SELECT 'close_rate_pct'::text, b.v
  FROM base b CROSS JOIN counts c
  WHERE b.k = 'quote_acceptance_rate' AND c.quotes_sent >= 10
  UNION ALL
  SELECT 'avg_ticket_cents'::text, b.v
  FROM base b CROSS JOIN counts c
  WHERE b.k = 'avg_ticket_cents' AND c.paid_jobs >= 10
  UNION ALL
  SELECT 'response_hours'::text, b.v
  FROM base b CROSS JOIN counts c
  WHERE b.k = 'avg_lead_response_hours' AND c.responded_leads >= 10
  UNION ALL
  SELECT 'leads_per_business'::text, c.leads_cur::numeric
  FROM counts c
  WHERE c.leads_cur >= 10
  UNION ALL
  SELECT 'demand_index'::text, least(300, greatest(0, round(100.0 * c.leads_cur / c.leads_prior, 1)))
  FROM counts c
  WHERE c.leads_prior >= 10;
$$;

REVOKE ALL ON FUNCTION public.insights_tenant_metrics(uuid, date, date, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_tenant_metrics(uuid, date, date, date, date) TO authenticated, service_role;

-- A business can see exactly which of its own numbers would be shared.
CREATE OR REPLACE FUNCTION public.insights_my_preview()
RETURNS TABLE (r_period text, r_trade text, r_region text, r_metric text, r_value numeric)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_last date := (date_trunc('quarter', now())::date - 1);
  v_b record;
  v_trade text;
  v_region text;
BEGIN
  IF v_owner IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_b
  FROM public.insights_quarter_bounds(extract(year FROM v_last)::integer, extract(quarter FROM v_last)::integer);

  SELECT public.insights_trade_key(bp.primary_industry), public.ob_region_key(bp.service_area)
  INTO v_trade, v_region
  FROM public.business_profile bp
  WHERE bp.user_id = v_owner;

  RETURN QUERY
  SELECT v_b.period_label, COALESCE(v_trade, 'other'), COALESCE(v_region, 'all'), m.metric, m.value
  FROM public.insights_tenant_metrics(v_owner, v_b.period_start, v_b.period_end, v_b.prior_start, v_b.prior_end) m;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_my_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_my_preview() TO authenticated, service_role;

-- =============================================================
-- 4. GENERATION (draft only) + PUBLISH / RETRACT
-- =============================================================

CREATE OR REPLACE FUNCTION public.insights_generate_publication(p_year integer, p_quarter integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_k CONSTANT integer := 10;
  c_min_distinct CONSTANT integer := 3;
  v_b record;
  v_pub_id uuid;
  v_status text;
  v_prior_label text;
  v_tenants integer;
BEGIN
  IF p_year IS NULL OR p_quarter IS NULL OR p_year NOT BETWEEN 2024 AND 2100 OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: year or quarter out of range' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_b FROM public.insights_quarter_bounds(p_year, p_quarter);
  IF v_b.period_end >= CURRENT_DATE THEN
    RAISE EXCEPTION 'INSIGHTS_PERIOD_OPEN: quarter % has not ended yet', v_b.period_label USING ERRCODE = 'P0001';
  END IF;
  v_prior_label := to_char(v_b.prior_start, 'YYYY') || '-Q' || to_char(v_b.prior_start, 'Q');

  SELECT p.id, p.status INTO v_pub_id, v_status
  FROM public.insights_publications p
  WHERE p.period_label = v_b.period_label;

  IF FOUND THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: % is already % and cannot be regenerated', v_b.period_label, v_status USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.insights_suppression_log WHERE publication_id = v_pub_id;
    DELETE FROM public.insights_index_cells WHERE publication_id = v_pub_id;
  ELSE
    INSERT INTO public.insights_publications (period_label, period_start, period_end, k_min)
    VALUES (v_b.period_label, v_b.period_start, v_b.period_end, c_k)
    RETURNING id INTO v_pub_id;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS tmp_insights_tenant (
    user_id uuid, trade text, region_key text, metric text, value numeric
  ) ON COMMIT DELETE ROWS;
  CREATE TEMP TABLE IF NOT EXISTS tmp_insights_groups (
    trade text, region_key text, metric text, n integer, d integer, p25 numeric, p50 numeric, p75 numeric
  ) ON COMMIT DELETE ROWS;
  DELETE FROM tmp_insights_tenant WHERE true;
  DELETE FROM tmp_insights_groups WHERE true;

  -- Pass 1: ONE number per opted-in business per metric.
  INSERT INTO tmp_insights_tenant (user_id, trade, region_key, metric, value)
  SELECT p.id, public.insights_trade_key(bp.primary_industry), public.ob_region_key(bp.service_area), m.metric, m.value
  FROM public.profiles p
  JOIN public.insights_settings s ON s.account_owner_id = p.id AND s.contribute
  JOIN public.business_profile bp ON bp.user_id = p.id
  CROSS JOIN LATERAL public.insights_tenant_metrics(p.id, v_b.period_start, v_b.period_end, v_b.prior_start, v_b.prior_end) m
  WHERE p.role = 'owner'
    AND public.insights_trade_key(bp.primary_industry) <> 'other';

  -- Pass 2: cohort statistics of those numbers, three levels.
  INSERT INTO tmp_insights_groups (trade, region_key, metric, n, d, p25, p50, p75)
  SELECT g.trade, g.region_key, g.metric, count(*)::integer, count(DISTINCT g.value)::integer,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY g.value),
         percentile_cont(0.50) WITHIN GROUP (ORDER BY g.value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY g.value)
  FROM (
    SELECT t.trade, t.region_key, t.metric, t.value FROM tmp_insights_tenant t WHERE t.region_key <> 'all'
    UNION ALL
    SELECT t.trade, 'all'::text, t.metric, t.value FROM tmp_insights_tenant t
    UNION ALL
    SELECT 'all'::text, 'all'::text, t.metric, t.value FROM tmp_insights_tenant t
  ) g
  GROUP BY g.trade, g.region_key, g.metric;

  -- Suppression audit (reason only).
  INSERT INTO public.insights_suppression_log (publication_id, trade, region_key, metric, reason)
  SELECT v_pub_id, g.trade, g.region_key, g.metric,
         CASE WHEN g.n < c_k THEN 'below_k' ELSE 'low_diversity' END
  FROM tmp_insights_groups g
  WHERE g.n < c_k OR g.d < c_min_distinct;

  -- Pass 3: gate, add one shared stable noise shift per cell, shape, insert.
  WITH calc AS (
    SELECT
      g.trade, g.region_key, g.metric, g.n, g.d,
      mm.unit, mm.direction,
      CASE WHEN g.n >= 100 THEN '100+' WHEN g.n >= 50 THEN '50-99' WHEN g.n >= 20 THEN '20-49' ELSE '10-19' END AS band,
      greatest(g.p75 - g.p25, abs(g.p50) * 0.02, 0.01) / g.n * 0.5 AS scale,
      public.oin_stable_laplace(
        v_b.period_label || '|' || g.trade || '|' || g.region_key || '|' || g.metric,
        greatest(g.p75 - g.p25, abs(g.p50) * 0.02, 0.01) / g.n * 0.5
      ) AS noise,
      g.p25, g.p50, g.p75
    FROM tmp_insights_groups g
    JOIN (VALUES
      ('avg_ticket_cents', 'cents', 'higher_is_better'),
      ('close_rate_pct', 'percent', 'higher_is_better'),
      ('response_hours', 'hours', 'lower_is_better'),
      ('leads_per_business', 'count', 'neutral'),
      ('demand_index', 'index', 'neutral')
    ) AS mm (metric, unit, direction) ON mm.metric = g.metric
    WHERE g.n >= c_k AND g.d >= c_min_distinct
  ),
  shaped AS (
    SELECT c.*,
           public.insights_shape(c.p25 + c.noise, c.unit) AS s25,
           public.insights_shape(c.p50 + c.noise, c.unit) AS s50,
           public.insights_shape(c.p75 + c.noise, c.unit) AS s75
    FROM calc c
  ),
  ins AS (
    INSERT INTO public.insights_index_cells (
      publication_id, trade, region_key, metric, unit, direction, contributor_band, p25, p50, p75, qoq_change_pct
    )
    SELECT
      v_pub_id, s.trade, s.region_key, s.metric, s.unit, s.direction, s.band, s.s25, s.s50, s.s75,
      CASE
        WHEN s.metric = 'demand_index' OR pr.p50 IS NULL OR pr.p50 = 0 THEN NULL
        ELSE round(((s.s50 - pr.p50) / pr.p50) * 100, 1)
      END
    FROM shaped s
    LEFT JOIN LATERAL (
      SELECT pc.p50
      FROM public.insights_index_cells pc
      JOIN public.insights_publications pp ON pp.id = pc.publication_id
      WHERE pp.status = 'published'
        AND pp.period_label = v_prior_label
        AND pc.trade = s.trade
        AND pc.region_key = s.region_key
        AND pc.metric = s.metric
    ) pr ON true
    RETURNING id, trade, region_key, metric
  )
  INSERT INTO public.insights_cell_audit (cell_id, contributor_count, distinct_values, noise_scale)
  SELECT ins.id, s.n, s.d, s.scale
  FROM ins
  JOIN shaped s ON s.trade = ins.trade AND s.region_key = ins.region_key AND s.metric = ins.metric;

  SELECT count(DISTINCT t.user_id)::integer INTO v_tenants FROM tmp_insights_tenant t;

  UPDATE public.insights_publications
  SET contributors_rounded = (COALESCE(v_tenants, 0) / 10) * 10, generated_at = now()
  WHERE id = v_pub_id;

  -- Raw per-business values must not outlive this call.
  DELETE FROM tmp_insights_tenant WHERE true;
  DELETE FROM tmp_insights_groups WHERE true;

  RETURN v_pub_id;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_generate_publication(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_generate_publication(integer, integer) TO service_role;

-- Publish gate: re-verifies the privacy floor independently of the generator.
CREATE OR REPLACE FUNCTION public.insights_publish(p_publication_id uuid)
RETURNS public.insights_publications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_cells integer;
  v_bad integer;
  v_row public.insights_publications;
BEGIN
  SELECT p.status INTO v_status FROM public.insights_publications p WHERE p.id = p_publication_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_NOT_FOUND: publication not found' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'INSIGHTS_IMMUTABLE: only a draft can be published (status is %)', v_status USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_cells FROM public.insights_index_cells c WHERE c.publication_id = p_publication_id;
  IF v_cells = 0 THEN
    RAISE EXCEPTION 'INSIGHTS_EMPTY: no cell cleared the privacy gates, nothing to publish' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.insights_index_cells c
  LEFT JOIN public.insights_cell_audit a ON a.cell_id = c.id
  WHERE c.publication_id = p_publication_id
    AND (a.cell_id IS NULL OR a.contributor_count < 10 OR a.distinct_values < 3);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'INSIGHTS_PRIVACY_GATE: % cell(s) fail the k-anonymity audit', v_bad USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.insights_publications
  SET status = 'published', published_at = now()
  WHERE id = p_publication_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_publish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_publish(uuid) TO service_role;

-- Kill switch: published -> retracted. Retracted data disappears from every reader.
CREATE OR REPLACE FUNCTION public.insights_retract(p_publication_id uuid, p_reason text)
RETURNS public.insights_publications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.insights_publications;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: a retraction reason of at least 5 characters is required' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.insights_publications
  SET status = 'retracted', retracted_at = now(), retraction_reason = btrim(p_reason)
  WHERE id = p_publication_id AND status = 'published'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_NOT_FOUND: no published publication with that id' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_retract(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_retract(uuid, text) TO service_role;

-- Cron wrapper: previous quarter, draft only, never touches a released quarter.
CREATE OR REPLACE FUNCTION public.insights_generate_previous_quarter()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last date := (date_trunc('quarter', now())::date - 1);
  v_year integer := extract(year FROM v_last)::integer;
  v_quarter integer := extract(quarter FROM v_last)::integer;
  v_status text;
BEGIN
  SELECT p.status INTO v_status
  FROM public.insights_publications p
  WHERE p.period_label = v_year::text || '-Q' || v_quarter::text;
  IF FOUND AND v_status <> 'draft' THEN
    RETURN NULL;
  END IF;
  RETURN public.insights_generate_publication(v_year, v_quarter);
END;
$$;

REVOKE ALL ON FUNCTION public.insights_generate_previous_quarter() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_generate_previous_quarter() TO service_role;

-- =============================================================
-- 5. READERS (tiered access, published-only, no exact counts)
-- =============================================================

-- PUBLIC: released periods (anon + authenticated).
CREATE OR REPLACE FUNCTION public.insights_public_periods()
RETURNS TABLE (period_label text, period_start date, period_end date, published_at timestamptz, contributors_rounded integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.period_label, p.period_start, p.period_end, p.published_at, p.contributors_rounded
  FROM public.insights_publications p
  WHERE p.status = 'published'
  ORDER BY p.period_start DESC
  LIMIT 12;
$$;

-- PUBLIC: national cells only (region 'all'). Latest period when none given.
CREATE OR REPLACE FUNCTION public.insights_public_indexes(p_period text DEFAULT NULL)
RETURNS TABLE (
  period_label text, trade text, metric text, unit text, direction text,
  contributor_band text, p25 numeric, p50 numeric, p75 numeric, qoq_change_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.period_label, c.trade, c.metric, c.unit, c.direction, c.contributor_band, c.p25, c.p50, c.p75, c.qoq_change_pct
  FROM public.insights_publications p
  JOIN public.insights_index_cells c ON c.publication_id = p.id
  WHERE p.status = 'published'
    AND c.region_key = 'all'
    AND p.period_label = COALESCE(
      NULLIF(btrim(p_period), ''),
      (SELECT l.period_label FROM public.insights_publications l WHERE l.status = 'published' ORDER BY l.period_start DESC LIMIT 1)
    )
  ORDER BY (c.trade <> 'all'), c.trade, c.metric;
$$;

REVOKE ALL ON FUNCTION public.insights_public_periods() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insights_public_periods() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.insights_public_indexes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insights_public_indexes(text) TO anon, authenticated, service_role;

-- FULL: every published cell incl. state level. Service role (API) only.
CREATE OR REPLACE FUNCTION public.insights_api_indexes(
  p_period text DEFAULT NULL,
  p_trade text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_metric text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  period_label text, trade text, region_key text, metric text, unit text, direction text,
  contributor_band text, p25 numeric, p50 numeric, p75 numeric, qoq_change_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.period_label, c.trade, c.region_key, c.metric, c.unit, c.direction,
         c.contributor_band, c.p25, c.p50, c.p75, c.qoq_change_pct
  FROM public.insights_publications p
  JOIN public.insights_index_cells c ON c.publication_id = p.id
  WHERE p.status = 'published'
    AND p.period_label = COALESCE(
      NULLIF(btrim(p_period), ''),
      (SELECT l.period_label FROM public.insights_publications l WHERE l.status = 'published' ORDER BY l.period_start DESC LIMIT 1)
    )
    AND (p_trade IS NULL OR c.trade = p_trade)
    AND (p_region IS NULL OR c.region_key = p_region)
    AND (p_metric IS NULL OR c.metric = p_metric)
  ORDER BY c.trade, c.region_key, c.metric
  LIMIT greatest(1, least(COALESCE(p_limit, 200), 500))
  OFFSET greatest(0, COALESCE(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION public.insights_api_indexes(text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_api_indexes(text, text, text, text, integer, integer) TO service_role;

-- MEMBER: same full data, but only for businesses that contribute (give-to-get).
CREATE OR REPLACE FUNCTION public.insights_member_indexes(
  p_period text DEFAULT NULL,
  p_trade text DEFAULT NULL,
  p_region text DEFAULT NULL
)
RETURNS TABLE (
  period_label text, trade text, region_key text, metric text, unit text, direction text,
  contributor_band text, p25 numeric, p50 numeric, p75 numeric, qoq_change_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.period_label, a.trade, a.region_key, a.metric, a.unit, a.direction,
         a.contributor_band, a.p25, a.p50, a.p75, a.qoq_change_pct
  FROM public.insights_api_indexes(p_period, p_trade, p_region, NULL, 500, 0) a
  WHERE public.insights_can_read();
$$;

REVOKE ALL ON FUNCTION public.insights_member_indexes(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_member_indexes(text, text, text) TO authenticated, service_role;

-- =============================================================
-- 6. SUBSCRIBER API (keys, rate limit, request log)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.insights_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  contact_email text NOT NULL CHECK (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'enterprise')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  terms_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insights_subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_subscribers" ON public.insights_subscribers;
CREATE POLICY "staff_select_insights_subscribers" ON public.insights_subscribers
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.insights_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid NOT NULL REFERENCES public.insights_subscribers(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['insights:read']::text[],
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insights_api_keys_valid_scopes CHECK (scopes <@ ARRAY['insights:read']::text[])
);

CREATE INDEX IF NOT EXISTS idx_insights_api_keys_subscriber ON public.insights_api_keys (subscriber_id);

ALTER TABLE public.insights_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_insights_api_keys" ON public.insights_api_keys;
CREATE POLICY "staff_select_insights_api_keys" ON public.insights_api_keys
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.insights_api_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES public.insights_api_keys(id) ON DELETE CASCADE,
  status integer NOT NULL,
  path text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_api_log_key_time
  ON public.insights_api_request_log (key_id, created_at DESC);

ALTER TABLE public.insights_api_request_log ENABLE ROW LEVEL SECURITY;
-- No policies: written/read only by the insights-api edge function (service role).

-- The raw key is returned exactly once; only its SHA-256 is stored.
CREATE OR REPLACE FUNCTION public.insights_issue_api_key(
  p_subscriber_id uuid,
  p_label text,
  p_rate_limit integer DEFAULT 60,
  p_ttl_days integer DEFAULT 365
)
RETURNS TABLE (out_key_id uuid, out_api_key text, out_key_prefix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw text;
  v_id uuid;
BEGIN
  IF p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: label must be 1-80 characters' USING ERRCODE = 'P0001';
  END IF;
  IF p_rate_limit IS NULL OR p_rate_limit NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: rate limit must be 1-600 per minute' USING ERRCODE = 'P0001';
  END IF;
  IF p_ttl_days IS NULL OR p_ttl_days NOT BETWEEN 1 AND 1095 THEN
    RAISE EXCEPTION 'INSIGHTS_INVALID_INPUT: ttl must be 1-1095 days' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.insights_subscribers s WHERE s.id = p_subscriber_id AND s.status = 'active') THEN
    RAISE EXCEPTION 'INSIGHTS_NOT_FOUND: no active subscriber with that id' USING ERRCODE = 'P0001';
  END IF;

  v_raw := 'vrk_ins_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.insights_api_keys (subscriber_id, label, key_prefix, key_hash, rate_limit_per_minute, expires_at)
  VALUES (
    p_subscriber_id,
    btrim(p_label),
    left(v_raw, 16),
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
    p_rate_limit,
    now() + make_interval(days => p_ttl_days)
  )
  RETURNING id INTO v_id;

  out_key_id := v_id;
  out_api_key := v_raw;
  out_key_prefix := left(v_raw, 16);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.insights_revoke_api_key(p_key_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.insights_api_keys SET revoked_at = now() WHERE id = p_key_id AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.insights_api_rate_ok(p_key_id uuid, p_limit integer DEFAULT 60)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) < greatest(COALESCE(p_limit, 60), 1)
  FROM public.insights_api_request_log l
  WHERE l.key_id = p_key_id AND l.created_at > now() - interval '60 seconds' AND l.status <> 429;
$$;

CREATE OR REPLACE FUNCTION public.insights_prune_api_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM public.insights_api_request_log WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.insights_issue_api_key(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_issue_api_key(uuid, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.insights_revoke_api_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_revoke_api_key(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.insights_api_rate_ok(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_api_rate_ok(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.insights_prune_api_logs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_prune_api_logs() TO service_role;

-- =============================================================
-- 7. SCHEDULES — guarded exactly like 20261205000000: a no-op, not an
--    error, when pg_cron is not enabled on this project.
--    The quarterly job only ever creates a DRAFT; a human publishes it.
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-insights-generate-draft');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-insights-generate-draft', '0 4 5 1,4,7,10 *', 'select public.insights_generate_previous_quarter()');

    BEGIN
      PERFORM cron.unschedule('vireek-insights-prune-api-logs');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-insights-prune-api-logs', '15 3 * * 0', 'select public.insights_prune_api_logs()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
