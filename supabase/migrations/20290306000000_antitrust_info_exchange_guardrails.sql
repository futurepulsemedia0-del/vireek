/*
  # Antitrust information-exchange guardrails (config-driven, fail-closed)

  ## Why
  Vireek pools competitor-adjacent numbers (average ticket, paid-ticket medians, regional call volume,
  procurement volumes) across tenants that compete in the same trade and metro. The k-anonymity floor
  (k = 5) and the consent gate (xtl_contributors) already exist; what was missing is a single, tunable
  place that also controls:
    1. minimum cohort size           (per price-sensitivity tier, not one hard-coded 5)
    2. maximum single-tenant share   (dominance cap, for additive / volume metrics)
    3. data lag                      (newest data a published aggregate may contain)
    4. narrow-geography suppression  (price-adjacent metrics are not published below a geography level)
  and that FAILS CLOSED: an unregistered metric, a missing or malformed config row, an unknown geography
  or an unreviewed price-adjacent metric is never published.

  ## What this adds (reuses, does not replace, cross_tenant_flows / xtl_contributors / sde_*)
  1. ixg_guardrail_config   one row per price-sensitivity tier (0..3) + optional per-flow override.
  2. ixg_metric_registry    every shared metric, its flow, tier, geography granularity, counsel status.
  3. ixg_geo_rank() / ixg_geo_level()   ordered geography levels; unknown text => narrowest (fail closed).
  4. ixg_evaluate()         single evaluator -> (allowed, reasons[]). Used by every gate below.
  5. Write gate   BEFORE INSERT/UPDATE trigger on benchmark_cohort_stats (also protects SECURITY DEFINER
                  readers such as compute_market_intelligence, which bypass RLS).
  6. Read gate    RLS SELECT policy on benchmark_cohort_stats and regional_demand_snapshots that calls the
                  same evaluator, so a config change (e.g. raising k) hides existing rows immediately.
  7. pn_min_cohort()      procurement network k is now config-driven (floor stays at the old value 3).
  8. ixg_regional_segment_shares() / ixg_regional_dominated_segments() / ixg_check_rows()   dominance for regional demand; batch check for edge publishers.
  9. ixg_purge_published() (hourly via pg_cron when available) / ixg_guardrail_audit   purge + append-only decision audit.
 10. Admin read RPC ixg_admin_overview() (platform staff only).

  ## Behaviour change (intentional, read before deploying)
  * Price-adjacent metrics (tier >= 2) are NOT published until counsel_status = 'approved' [COUNSEL].
    Today that hides avg_ticket_cents in benchmark_cohort_stats (BenchmarksPage and quote-truth-engine
    degrade gracefully; the latter already handles an empty cohort).
  * Tier thresholds below are engineering placeholders, NOT legal advice [COUNSEL].
  * Data lag is enforced as a publication gate on period_end. The current builders compute windows ending
    today, so a metric whose tier has lag_days > 0 stays hidden until its builder uses ixg_window_end().
    Defaults keep lag_days = 0 for the tiers whose metrics are currently published.

  ## Not changed
  No builder function is re-created here. Dominance needs per-tenant weights that stored aggregates do not
  carry, so it is computed on demand by ixg_regional_dominated_segments() (regional demand, the only flow
  with raw additive sums) and applied by the purge and by the compute-regional-demand edge function.
  Ranked statistics (percentiles of one number per tenant) are protected by k and jitter instead.

  ## Safety
  Idempotent. No DROP of tenant data. No policy loosened (the old open SELECT policies are replaced by
  stricter ones). Rollback: see the end of this file.
*/

-- =============================================================
-- 1. Config (tunables live here, never in code)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ixg_guardrail_config (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                text NOT NULL CHECK (scope ~ '^(tier:[0-3]|flow:[a-z0-9_]{2,48})$'),
  min_cohort_size      integer NOT NULL CHECK (min_cohort_size >= 3),
  max_single_share_pct numeric NOT NULL CHECK (max_single_share_pct > 0 AND max_single_share_pct <= 100),
  data_lag_days        integer NOT NULL CHECK (data_lag_days >= 0 AND data_lag_days <= 730),
  min_geo_level        text NOT NULL CHECK (min_geo_level IN ('national', 'region', 'state', 'metro', 'locality', 'postal')),
  require_counsel_approval boolean NOT NULL DEFAULT false,
  note                 text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope)
);
COMMENT ON COLUMN public.ixg_guardrail_config.min_geo_level IS
  'FINEST geography a metric of this scope may be published at. national < region < state < metro < locality < postal. A row finer than this is suppressed.';

ALTER TABLE public.ixg_guardrail_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ixg_guardrail_config FROM PUBLIC, anon, authenticated;
-- No client policy: read via ixg_admin_overview() (staff) or service_role.

-- Placeholder defaults [COUNSEL]. DO NOTHING so an operator edit survives a re-run.
INSERT INTO public.ixg_guardrail_config
  (scope, min_cohort_size, max_single_share_pct, data_lag_days, min_geo_level, require_counsel_approval, note) VALUES
  ('tier:0',  5, 100,   0, 'postal',   false, 'Operational quality metrics. [COUNSEL] confirm tier.'),
  ('tier:1',  5,  50,   0, 'locality', false, 'Commercially sensitive, not price (volumes, demand, labor minutes). [COUNSEL]'),
  ('tier:2',  8,  40,   0, 'state',    true,  'Price-adjacent (realized ticket, quote acceptance). Blocked until counsel approves the metric. [COUNSEL]'),
  ('tier:3', 10,  25,   0, 'region',   true,  'Direct price / rate / cost / discount. Blocked until counsel approves. [COUNSEL]'),
  ('flow:procurement_network', 3, 50, 0, 'region', false, 'Keeps the pre-existing pn_min_cohort() = 3 so the co-op keeps working. [COUNSEL] k = 3 is weak; raise here, no deploy needed.')
ON CONFLICT (scope) DO NOTHING;

-- =============================================================
-- 2. Metric registry (the machine-readable twin of the review doc)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ixg_metric_registry (
  flow_key          text NOT NULL CHECK (flow_key ~ '^[a-z0-9_]{2,48}$'),
  metric_key        text NOT NULL CHECK (metric_key ~ '^[a-z0-9_]{2,64}$'),
  price_tier        integer NOT NULL CHECK (price_tier BETWEEN 0 AND 3),
  geo_granularity   text NOT NULL DEFAULT 'national'
                    CHECK (geo_granularity IN ('national', 'region', 'state', 'metro', 'locality', 'postal')),
  additive          boolean NOT NULL DEFAULT false,   -- true => sums/volumes: dominance cap applies
  enabled           boolean NOT NULL DEFAULT true,
  counsel_status    text NOT NULL DEFAULT 'unreviewed' CHECK (counsel_status IN ('unreviewed', 'approved', 'rejected')),
  counsel_reviewed_by text,
  counsel_reviewed_at timestamptz,
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_key, metric_key),
  CONSTRAINT ixg_approved_has_reviewer CHECK (counsel_status <> 'approved' OR (counsel_reviewed_by IS NOT NULL AND counsel_reviewed_at IS NOT NULL))
);
ALTER TABLE public.ixg_metric_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ixg_metric_registry FROM PUBLIC, anon, authenticated;

-- Seed = inventory of docs/compliance/antitrust-info-exchange-review.md. Tiers are PROPOSALS [COUNSEL].
INSERT INTO public.ixg_metric_registry (flow_key, metric_key, price_tier, geo_granularity, additive, description) VALUES
  ('benchmark_cohorts', 'lead_conversion_rate',      1, 'national', false, 'Won leads / leads, per tenant, then cohort percentiles'),
  ('benchmark_cohorts', 'quote_acceptance_rate',     1, 'national', false, 'Accepted / sent quotes; conversion metric, only indirectly price-related [COUNSEL: raise to 2 if preferred]'),
  ('benchmark_cohorts', 'missed_call_rate',          0, 'national', false, 'Missed or voicemail calls / calls'),
  ('benchmark_cohorts', 'avg_call_score',            0, 'national', false, 'Mean AI call score'),
  ('benchmark_cohorts', 'avg_lead_response_hours',   0, 'national', false, 'Mean hours from lead to quote sent'),
  ('benchmark_cohorts', 'avg_ticket_cents',          2, 'national', false, 'Mean paid invoice amount: realized price level'),
  ('regional_demand',   'current_week_calls',        1, 'locality', true,  'Raw call sums per industry x service_area'),
  ('regional_demand',   'prior_week_calls',          1, 'locality', true,  'Raw call sums, prior week'),
  ('regional_demand',   'call_volume_change_pct',    1, 'locality', false, 'Week-over-week call change'),
  ('regional_demand',   'current_week_leads',        1, 'locality', true,  'Raw lead sums per industry x service_area'),
  ('regional_demand',   'emergency_rate_pct',        1, 'locality', false, 'Emergency calls / calls'),
  ('platform_benchmarks', 'avg_invoice_amount',      2, 'national', false, 'Legacy: mean invoice amount'),
  ('platform_benchmarks', 'lead_conversion_rate',    1, 'national', false, 'Legacy'),
  ('platform_benchmarks', 'avg_call_duration_seconds', 0, 'national', false, 'Legacy'),
  ('platform_benchmarks', 'emergency_call_rate',     1, 'national', false, 'Legacy'),
  ('platform_benchmarks', 'job_completion_rate',     0, 'national', false, 'Legacy'),
  ('platform_benchmarks', 'avg_payment_collection_hours', 1, 'national', false, 'Legacy'),
  ('outcome_benchmarks', 'first_time_fix_rate',      0, 'state',    false, 'Trade x US state'),
  ('outcome_benchmarks', 'reservice_rate',           0, 'state',    false, 'Trade x US state'),
  ('outcome_benchmarks', 'median_response_minutes',  0, 'state',    false, 'Trade x US state'),
  ('service_data_exchange', 'median_paid_ticket_cents', 3, 'national', false, 'SDE pricing_intelligence: median paid ticket per trade x service'),
  ('service_data_exchange', 'age_at_failure_years', 0, 'national', false, 'SDE failure_intelligence: equipment age at repair event'),
  ('service_data_exchange', 'service_calls_per_unit', 0, 'national', false, 'SDE oem_intelligence: service burden per unit, per make'),
  ('service_data_exchange', 'rework_rate_pct',       0, 'national', false, 'SDE oem_intelligence: rework rate, per make'),
  ('service_data_exchange', 'median_job_minutes',    1, 'national', false, 'SDE labor_intelligence (labor time, not rate)'),
  ('service_data_exchange', 'first_time_fix_rate_pct', 0, 'national', false, 'SDE labor_intelligence'),
  ('service_data_exchange', 'attach_rate_pct',       1, 'national', false, 'SDE parts_intelligence'),
  ('service_data_exchange', 'demand_momentum_index', 1, 'national', false, 'SDE demand_intelligence'),
  ('procurement_network', 'pooled_cents',            3, 'region',   true,  'Pooled qualifying spend per supplier program'),
  ('procurement_network', 'item_volumes',            3, 'region',   true,  'Ordered/committed quantities per catalog item')
ON CONFLICT (flow_key, metric_key) DO NOTHING;

-- =============================================================
-- 3. Geography ordering (unknown text => finest level => suppressed when a price-adjacent rule applies)
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_geo_rank(p_level text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_level
    WHEN 'national' THEN 0 WHEN 'region' THEN 1 WHEN 'state' THEN 2
    WHEN 'metro' THEN 3 WHEN 'locality' THEN 4 WHEN 'postal' THEN 5
    ELSE 99   -- unknown / NULL: treated as finer than anything allowed (fail closed)
  END
$$;

-- Classifies free-text service areas. Conservative: ONLY exact national / census-region / US-state tokens get a
-- coarse level; anything else is at least 'locality', and anything with a 5-digit code is 'postal'.
CREATE OR REPLACE FUNCTION public.ixg_geo_level(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH t AS (SELECT lower(btrim(COALESCE(p_text, ''))) AS v)
  SELECT CASE
    WHEN v = '' THEN 'postal'
    WHEN v IN ('all', 'national', 'us', 'usa', 'united states') THEN 'national'
    WHEN v IN ('northeast', 'midwest', 'south', 'west', 'northeast region', 'midwest region', 'south region', 'west region') THEN 'region'
    WHEN v ~ '[0-9]{5}' THEN 'postal'
    WHEN v IN ('al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo',
               'mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
               'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho',
               'illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
               'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio',
               'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia',
               'washington','west virginia','wisconsin','wyoming','district of columbia') THEN 'state'
    WHEN v ~ '(metro|county|area|region)' THEN 'metro'
    ELSE 'locality'
  END
  FROM t
$$;

-- =============================================================
-- 4. Evaluator: one function, used by every gate. Never raises on bad input; returns allowed=false.
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_evaluate(
  p_flow          text,
  p_metric        text,
  p_cohort_size   integer,
  p_geo_level     text DEFAULT 'national',
  p_max_share_pct numeric DEFAULT NULL,
  p_data_end      date DEFAULT NULL,
  p_today         date DEFAULT CURRENT_DATE
)
RETURNS TABLE (allowed boolean, reasons text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m   public.ixg_metric_registry%ROWTYPE;
  c   public.ixg_guardrail_config%ROWTYPE;
  r   text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO m FROM public.ixg_metric_registry WHERE flow_key = p_flow AND metric_key = p_metric;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, ARRAY['metric_not_registered']::text[]; RETURN;
  END IF;
  IF NOT m.enabled THEN r := array_append(r, 'metric_disabled'::text); END IF;
  IF m.counsel_status = 'rejected' THEN r := array_append(r, 'counsel_rejected'::text); END IF;

  -- Per-flow override wins; otherwise the metric's tier row. Missing config => closed.
  SELECT * INTO c FROM public.ixg_guardrail_config WHERE scope = 'flow:' || p_flow;
  IF NOT FOUND THEN
    SELECT * INTO c FROM public.ixg_guardrail_config WHERE scope = 'tier:' || m.price_tier;
  END IF;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, array_append(r, 'config_missing'::text); RETURN;
  END IF;

  IF c.require_counsel_approval AND m.counsel_status <> 'approved' THEN r := array_append(r, 'counsel_approval_required'::text); END IF;

  IF p_cohort_size IS NULL OR p_cohort_size < c.min_cohort_size THEN r := array_append(r, 'cohort_below_minimum'::text); END IF;

  -- Narrow-geography suppression: the finer of (row geography, metric granularity) must not be finer than allowed.
  IF public.ixg_geo_rank(p_geo_level) > public.ixg_geo_rank(c.min_geo_level)
     OR public.ixg_geo_rank(m.geo_granularity) > public.ixg_geo_rank(c.min_geo_level) THEN
    r := array_append(r, 'geography_too_narrow'::text);
  END IF;

  -- Dominance applies to additive metrics. Additive metric with no share supplied => cannot prove => closed.
  IF m.additive THEN
    IF p_max_share_pct IS NULL THEN r := array_append(r, 'share_unknown'::text);
    ELSIF p_max_share_pct > c.max_single_share_pct THEN r := array_append(r, 'single_tenant_share_exceeded'::text);
    END IF;
  ELSIF p_max_share_pct IS NOT NULL AND p_max_share_pct > c.max_single_share_pct THEN
    r := array_append(r, 'single_tenant_share_exceeded'::text);
  END IF;

  -- Data lag: newest data in the aggregate must be at least data_lag_days old. Unknown date => closed when lag > 0.
  IF c.data_lag_days > 0 THEN
    IF p_data_end IS NULL OR p_data_end > p_today - c.data_lag_days THEN r := array_append(r, 'data_too_recent'::text); END IF;
  END IF;

  RETURN QUERY SELECT (cardinality(r) = 0), r;
END;
$$;
REVOKE ALL ON FUNCTION public.ixg_evaluate(text, text, integer, text, numeric, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_evaluate(text, text, integer, text, numeric, date, date) TO service_role;

-- Scalar helpers (fail closed). Builders call these instead of hard-coding numbers.
CREATE OR REPLACE FUNCTION public.ixg_min_cohort(p_flow text, p_metric text DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT c.min_cohort_size FROM public.ixg_guardrail_config c WHERE c.scope = 'flow:' || p_flow),
    (SELECT c.min_cohort_size FROM public.ixg_guardrail_config c
       JOIN public.ixg_metric_registry m ON 'tier:' || m.price_tier = c.scope
      WHERE m.flow_key = p_flow AND (p_metric IS NULL OR m.metric_key = p_metric)
      ORDER BY c.min_cohort_size DESC LIMIT 1),
    2147483647)          -- unregistered / unconfigured => no cohort can ever be large enough
$$;

CREATE OR REPLACE FUNCTION public.ixg_window_end(p_flow text, p_metric text, p_today date DEFAULT CURRENT_DATE)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_today - COALESCE(
    (SELECT c.data_lag_days FROM public.ixg_guardrail_config c WHERE c.scope = 'flow:' || p_flow),
    (SELECT c.data_lag_days FROM public.ixg_guardrail_config c
       JOIN public.ixg_metric_registry m ON 'tier:' || m.price_tier = c.scope
      WHERE m.flow_key = p_flow AND m.metric_key = p_metric),
    730)                 -- unconfigured => the oldest window we allow
$$;
REVOKE ALL ON FUNCTION public.ixg_min_cohort(text, text), public.ixg_window_end(text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_min_cohort(text, text), public.ixg_window_end(text, text, date) TO service_role;

-- =============================================================
-- 5. Decision audit (append-only): what the write gate suppressed and why. No tenant identifiers.
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ixg_guardrail_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_key    text NOT NULL,
  metric_key  text NOT NULL,
  cohort_size integer,
  geo_level   text,
  reasons     text[] NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ixg_guardrail_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ixg_guardrail_audit FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ixg_audit_no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ixg_guardrail_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS ixg_audit_immutable ON public.ixg_guardrail_audit;
CREATE TRIGGER ixg_audit_immutable BEFORE UPDATE OR DELETE ON public.ixg_guardrail_audit
  FOR EACH ROW EXECUTE FUNCTION public.ixg_audit_no_mutation();

-- =============================================================
-- 6. Write gate on benchmark_cohort_stats
--    Also covers SECURITY DEFINER readers that bypass RLS. A violating row is skipped, never raised,
--    so the nightly builder keeps running and simply publishes less.
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_gate_benchmark_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_allowed boolean;
  v_reasons text[];
BEGIN
  SELECT e.allowed, e.reasons INTO v_allowed, v_reasons
  FROM public.ixg_evaluate('benchmark_cohorts', NEW.metric, NEW.contributor_count, 'national', NULL, NEW.period_end) e;

  IF v_allowed IS NOT TRUE THEN
    INSERT INTO public.ixg_guardrail_audit (flow_key, metric_key, cohort_size, geo_level, reasons)
    VALUES ('benchmark_cohorts', NEW.metric, NEW.contributor_count, 'national', COALESCE(v_reasons, ARRAY['evaluator_error']));
    RETURN NULL;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;   -- any evaluator failure => closed
END;
$$;
DROP TRIGGER IF EXISTS ixg_gate_benchmark_row ON public.benchmark_cohort_stats;
CREATE TRIGGER ixg_gate_benchmark_row BEFORE INSERT OR UPDATE ON public.benchmark_cohort_stats
  FOR EACH ROW EXECUTE FUNCTION public.ixg_gate_benchmark_row();

-- =============================================================
-- 7. Read gate (RLS): same evaluator, so config changes take effect on already-stored rows
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_row_visible(p_flow text, p_metric text, p_cohort integer, p_geo text, p_end date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT e.allowed FROM public.ixg_evaluate(p_flow, p_metric, p_cohort, p_geo, NULL, p_end) e), false)
$$;
REVOKE ALL ON FUNCTION public.ixg_row_visible(text, text, integer, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ixg_row_visible(text, text, integer, text, date) TO authenticated, service_role;

DROP POLICY IF EXISTS "select_benchmark_cohort_stats" ON public.benchmark_cohort_stats;
CREATE POLICY "select_benchmark_cohort_stats" ON public.benchmark_cohort_stats
  FOR SELECT TO authenticated
  USING (public.ixg_row_visible('benchmark_cohorts', metric, contributor_count, 'national', period_end));

-- regional_demand_snapshots is one wide row per segment; every published metric column is tier 1 and additive
-- for sums. Share is not stored, so the additive metrics cannot be proven under the cap on read: the builder
-- must drop dominated segments (ixg_evaluate with p_max_share). Here we gate k and geography (fail closed).
-- Definer wrapper: authenticated has no privilege on the config table, and RLS expressions run as the caller.
CREATE OR REPLACE FUNCTION public.ixg_regional_visible(p_sample integer, p_region_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    p_sample >= public.ixg_min_cohort('regional_demand')
    AND public.ixg_geo_rank(public.ixg_geo_level(p_region_key))
        <= public.ixg_geo_rank((SELECT c.min_geo_level FROM public.ixg_guardrail_config c WHERE c.scope = 'tier:1')),
    false)
$$;
REVOKE ALL ON FUNCTION public.ixg_regional_visible(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ixg_regional_visible(integer, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "select_regional_demand_snapshots" ON public.regional_demand_snapshots;
CREATE POLICY "select_regional_demand_snapshots" ON public.regional_demand_snapshots
  FOR SELECT TO authenticated
  USING (public.ixg_regional_visible(sample_size, region_key));

-- =============================================================
-- 8. Procurement network k becomes config-driven. Floor stays at the previous hard-coded value (3).
-- =============================================================
CREATE OR REPLACE FUNCTION public.pn_min_cohort()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(3, public.ixg_min_cohort('procurement_network'))
$$;

-- =============================================================
-- 9. Dominance for regional demand (additive volumes) + batch check RPC for edge-function publishers
-- =============================================================
-- Largest single-tenant share of the 14-day call volume per segment (industry x service_area), over the same
-- consenting population and window as compute_regional_demand(). Call volume is the weight; lead sums are not
-- separately weighed. service_role only: a share is derived from per-tenant data and is never shown to clients.
CREATE OR REPLACE FUNCTION public.ixg_regional_segment_shares()
RETURNS TABLE (industry text, region_key text, max_share_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH tenant_calls AS (
    SELECT bp.user_id, lower(trim(bp.service_area)) AS region_key, bp.primary_industry AS industry, COUNT(*) AS n
    FROM public.business_profile bp
    JOIN public.calls c ON c.user_id = bp.user_id AND c.call_datetime >= now() - interval '14 days'
    WHERE bp.service_area IS NOT NULL AND trim(bp.service_area) <> '' AND bp.primary_industry IS NOT NULL
      AND bp.user_id IN (SELECT public.xtl_contributors('regional_demand'))
    GROUP BY bp.user_id, lower(trim(bp.service_area)), bp.primary_industry
  )
  SELECT t.industry, t.region_key, round(100.0 * max(t.n) / NULLIF(sum(t.n), 0), 1)
  FROM tenant_calls t GROUP BY t.industry, t.region_key
$$;
REVOKE ALL ON FUNCTION public.ixg_regional_segment_shares() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_regional_segment_shares() TO service_role;

-- Segments above the configured cap. A missing cap => cap 0 => every segment is dominated (fail closed);
-- an unknown share (NULL) is dominated too.
CREATE OR REPLACE FUNCTION public.ixg_regional_dominated_segments()
RETURNS TABLE (industry text, region_key text, max_share_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cap AS (
    SELECT COALESCE(
      (SELECT c.max_single_share_pct FROM public.ixg_guardrail_config c WHERE c.scope = 'flow:regional_demand'),
      (SELECT min(c.max_single_share_pct) FROM public.ixg_guardrail_config c
         JOIN public.ixg_metric_registry m ON c.scope = 'tier:' || m.price_tier
        WHERE m.flow_key = 'regional_demand' AND m.additive),
      0) AS pct
  )
  SELECT s.industry, s.region_key, s.max_share_pct
  FROM public.ixg_regional_segment_shares() s CROSS JOIN cap
  WHERE s.max_share_pct IS NULL OR s.max_share_pct > cap.pct
$$;
REVOKE ALL ON FUNCTION public.ixg_regional_dominated_segments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_regional_dominated_segments() TO service_role;

-- Batch evaluator for publishers that cannot run SQL gates themselves (edge functions).
-- p_items: [{ "key": any, "metric": text, "cohort_size": int, "geo_text": text?, "geo_level": text?,
--             "max_share_pct": number?, "data_end": "YYYY-MM-DD"? }]
-- Returns [{ "key": any, "allowed": bool, "reasons": [text] }] in the same order. A malformed item is blocked.
CREATE OR REPLACE FUNCTION public.ixg_check_rows(p_flow text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  it jsonb; out jsonb := '[]'::jsonb; v_allowed boolean; v_reasons text[]; v_geo text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_geo := COALESCE(NULLIF(it ->> 'geo_level', ''),
                        CASE WHEN it ? 'geo_text' THEN public.ixg_geo_level(it ->> 'geo_text') ELSE 'national' END);
      SELECT e.allowed, e.reasons INTO v_allowed, v_reasons
      FROM public.ixg_evaluate(
        p_flow, it ->> 'metric', NULLIF(it ->> 'cohort_size', '')::integer, v_geo,
        NULLIF(it ->> 'max_share_pct', '')::numeric, NULLIF(it ->> 'data_end', '')::date) e;
    EXCEPTION WHEN OTHERS THEN
      v_allowed := false; v_reasons := ARRAY['malformed_item']::text[];
    END;
    out := out || jsonb_build_array(jsonb_build_object('key', it -> 'key', 'allowed', COALESCE(v_allowed, false), 'reasons', to_jsonb(COALESCE(v_reasons, ARRAY['evaluator_error']::text[]))));
  END LOOP;
  RETURN out;
END;
$$;
REVOKE ALL ON FUNCTION public.ixg_check_rows(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_check_rows(text, jsonb) TO service_role;

-- =============================================================
-- 10. Purge (service_role, run after the builders): removes already-stored rows that no longer pass
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_purge_published()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0; v_step integer;
BEGIN
  DELETE FROM public.benchmark_cohort_stats b
  WHERE NOT COALESCE((SELECT e.allowed FROM public.ixg_evaluate('benchmark_cohorts', b.metric, b.contributor_count, 'national', NULL, b.period_end) e), false);
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;

  DELETE FROM public.regional_demand_snapshots r
  WHERE NOT public.ixg_regional_visible(r.sample_size, r.region_key);
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;

  DELETE FROM public.regional_demand_snapshots r
  USING public.ixg_regional_dominated_segments() d
  WHERE d.industry = r.industry AND d.region_key = r.region_key;
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.ixg_purge_published() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ixg_purge_published() TO service_role;

-- Hourly purge so a config change or a late-arriving builder row never stays published for long.
-- No-op (not an error) when pg_cron is not enabled, same guard as 20261205000000.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-ixg-purge-published');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-ixg-purge-published', '5 * * * *', 'select public.ixg_purge_published()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

-- =============================================================
-- 11. Staff-only overview for the admin UI (no tenant data; config + registry + recent suppressions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.ixg_admin_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pn_is_staff(), false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'config',   COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'updated_by' ORDER BY c.scope) FROM public.ixg_guardrail_config c), '[]'::jsonb),
    'metrics',  COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.flow_key, m.metric_key) FROM public.ixg_metric_registry m), '[]'::jsonb),
    'recent_suppressions', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id DESC)
                                     FROM (SELECT * FROM public.ixg_guardrail_audit ORDER BY id DESC LIMIT 50) a), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.ixg_admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ixg_admin_overview() TO authenticated;

/*
  ## Rollback (manual)
    DROP TRIGGER IF EXISTS ixg_gate_benchmark_row ON public.benchmark_cohort_stats;
    DROP POLICY IF EXISTS "select_benchmark_cohort_stats" ON public.benchmark_cohort_stats;
    CREATE POLICY "select_benchmark_cohort_stats" ON public.benchmark_cohort_stats FOR SELECT TO authenticated USING (true);
    DROP POLICY IF EXISTS "select_regional_demand_snapshots" ON public.regional_demand_snapshots;
    CREATE POLICY "select_regional_demand_snapshots" ON public.regional_demand_snapshots FOR SELECT TO authenticated USING (sample_size >= 5);
    CREATE OR REPLACE FUNCTION public.pn_min_cohort() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
  (tables and the other ixg_* functions may stay unused.)
*/
