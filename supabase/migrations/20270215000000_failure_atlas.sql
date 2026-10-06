/*
  # Vireek Global Failure Atlas

  A cross-network, anonymous knowledge graph of how equipment models really fail
  and which repairs really hold, built from jobs of accounts that opted in.

  Layers (all additive; nothing existing is altered):
  1. failure_atlas_participation : per-account opt-in. DEFAULT OFF. Only the owner
     or a member with can_edit_business_profile may change it (trigger-enforced).
  2. atlas_normalize_label()     : canonical failure key from free text (mirror of
     src/lib/failureAtlas.ts normalizeFailureLabel — keep the two identical).
  3. failure_atlas_cells         : aggregated cells per OEM model at four scopes:
       model   - units, callback rate, median age
       failure - a symptom/cause on a model
       part    - a part number installed on a model (any failure)
       repair  - a part installed for a specific failure
     Contains NO tenant identifier, job id or equipment id.
  4. refresh_failure_atlas()     : service-role only (nightly pg_cron when available).

  ## Privacy rules (enforced inside refresh_failure_atlas, not in the client)
  - Opt-in only: only accounts with contribute = true are read.
  - A cell is published only if contributors >= 5, observations >= 10, and no single
    account supplies more than 40% of its observations (dominance rule).
  - Cells below the thresholds are removed on the next refresh (re-computed from scratch).
  - Counts are floored to multiples of 5; rates are whole percents.
  - Only jobs completed 30+ days ago are counted, so callbacks have had time to occur
    (otherwise success rates would be inflated).
  - Callback = a root-cause analysis exists for the job, excluding root causes that are
    not the original repair's fault (customer_misuse, pre_existing_unrelated).
  This is k-anonymity plus a dominance rule and coarsening. It is NOT formal
  differential privacy and must not be described as certified DP.

  ## What is deliberately not stored
  - Diagnostic-test text: not captured as structured data today.
  - Per-technician or per-company success numbers: would identify individuals/companies.

  Requires: jobs, job_equipment, equipment, equipment_oem_link, oem_equipment_models,
  job_parts_required, inventory_parts, diagnosis_sessions, callback_root_cause_analyses,
  team_members, public.get_account_owner_id().
*/

-- =============================================================
-- 1. PARTICIPATION (opt-in, default off)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.failure_atlas_participation (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  contribute boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.failure_atlas_participation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_atlas_participation" ON public.failure_atlas_participation;
CREATE POLICY "select_own_atlas_participation" ON public.failure_atlas_participation
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_atlas_participation" ON public.failure_atlas_participation;
CREATE POLICY "insert_own_atlas_participation" ON public.failure_atlas_participation
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_atlas_participation" ON public.failure_atlas_participation;
CREATE POLICY "update_own_atlas_participation" ON public.failure_atlas_participation
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.failure_atlas_participation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_ok boolean;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No account for this user' USING ERRCODE = '42501';
  END IF;

  v_ok := auth.uid() = v_owner OR EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.account_owner_id = v_owner
      AND tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
      AND coalesce((tm.permissions ->> 'can_edit_business_profile')::boolean, false)
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Only the account owner or a member who can edit the business profile may change Atlas participation'
      USING ERRCODE = '42501';
  END IF;

  NEW.user_id := v_owner;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_failure_atlas_participation_guard ON public.failure_atlas_participation;
CREATE TRIGGER trg_failure_atlas_participation_guard
  BEFORE INSERT OR UPDATE ON public.failure_atlas_participation
  FOR EACH ROW EXECUTE FUNCTION public.failure_atlas_participation_guard();

-- =============================================================
-- 2. CANONICAL FAILURE KEY
-- =============================================================

CREATE OR REPLACE FUNCTION public.atlas_normalize_label(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(string_agg(tok, ' ' ORDER BY tok), '')
  FROM (
    SELECT stem AS tok
    FROM (
      SELECT DISTINCT regexp_replace(w, '(ing|ed|es|s)$', '') AS stem
      FROM regexp_split_to_table(lower(coalesce(p_text, '')), '[^a-z]+') AS w
      WHERE length(w) >= 4
        AND w <> ALL (ARRAY['with','from','that','this','unit','system','issue','problem','likely','probable',
                            'caused','cause','failed','failure','bad','faulty','broken','needs','need','replace'])
    ) s
    WHERE length(stem) >= 3
    ORDER BY stem
    LIMIT 4
  ) t
$$;

-- =============================================================
-- 3. ATLAS CELLS (aggregates only — no tenant / job / equipment ids)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.failure_atlas_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('model', 'failure', 'part', 'repair')),
  model_id uuid NOT NULL REFERENCES public.oem_equipment_models(id) ON DELETE CASCADE,
  failure_key text NOT NULL DEFAULT '',
  part_number text NOT NULL DEFAULT '',
  contributors integer NOT NULL CHECK (contributors >= 5),
  observations integer NOT NULL CHECK (observations >= 10),
  units integer NOT NULL,
  success_rate_pct smallint NOT NULL CHECK (success_rate_pct BETWEEN 0 AND 100),
  callback_rate_pct smallint NOT NULL CHECK (callback_rate_pct BETWEEN 0 AND 100),
  median_age_months integer,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, model_id, failure_key, part_number)
);

CREATE INDEX IF NOT EXISTS idx_failure_atlas_cells_model ON public.failure_atlas_cells (model_id, scope);

ALTER TABLE public.failure_atlas_cells ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_failure_atlas_cells" ON public.failure_atlas_cells;
CREATE POLICY "read_failure_atlas_cells" ON public.failure_atlas_cells
  FOR SELECT TO authenticated USING (true);
-- No INSERT / UPDATE / DELETE policy: only refresh_failure_atlas() (SECURITY DEFINER) writes.

-- =============================================================
-- 4. REFRESH
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_failure_atlas(p_lookback_days integer DEFAULT 365)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_min_contributors CONSTANT integer := 5;
  c_min_observations CONSTANT integer := 10;
  c_max_share CONSTANT numeric := 0.4;
  c_min_match CONSTANT numeric := 0.8;
  c_callback_window_days CONSTANT integer := 30;
  v_rows integer := 0;
BEGIN
  IF p_lookback_days < 30 OR p_lookback_days > 1825 THEN
    RAISE EXCEPTION 'p_lookback_days must be between 30 and 1825';
  END IF;

  DROP TABLE IF EXISTS pg_temp._atlas_obs;
  DROP TABLE IF EXISTS pg_temp._atlas_obs_parts;
  DROP TABLE IF EXISTS pg_temp._atlas_rows;

  -- One observation per (job, model) from opted-in accounts, matured past the callback window.
  CREATE TEMP TABLE _atlas_obs ON COMMIT DROP AS
  SELECT DISTINCT ON (j.id, l.model_id)
    j.user_id AS tenant,
    j.id AS job_id,
    je.equipment_id,
    l.model_id,
    coalesce((
      SELECT atlas_normalize_label(ds.ai_result -> 'probable_causes' -> 0 ->> 'cause')
      FROM diagnosis_sessions ds
      WHERE ds.job_id = j.id
      ORDER BY ds.created_at DESC
      LIMIT 1
    ), '') AS failure_key,
    CASE WHEN e.install_date IS NULL THEN NULL
         ELSE greatest(0, round(extract(epoch FROM (coalesce(j.completed_at, j.scheduled_datetime) - e.install_date::timestamptz)) / 2629800))::integer
    END AS age_months,
    EXISTS (
      SELECT 1 FROM callback_root_cause_analyses c
      WHERE c.original_job_id = j.id
        AND c.root_cause_category NOT IN ('customer_misuse', 'pre_existing_unrelated')
    ) AS callback
  FROM jobs j
  JOIN failure_atlas_participation p ON p.user_id = j.user_id AND p.contribute
  JOIN job_equipment je ON je.job_id = j.id
  JOIN equipment e ON e.id = je.equipment_id
  JOIN equipment_oem_link l ON l.equipment_id = je.equipment_id
    AND l.enrichment_status = 'matched'
    AND l.model_id IS NOT NULL
    AND coalesce(l.match_confidence, 0) >= c_min_match
  WHERE j.job_status = 'completed'
    AND coalesce(j.completed_at, j.scheduled_datetime) BETWEEN now() - make_interval(days => p_lookback_days)
                                                            AND now() - make_interval(days => c_callback_window_days)
  ORDER BY j.id, l.model_id, coalesce(l.match_confidence, 0) DESC;

  CREATE TEMP TABLE _atlas_obs_parts ON COMMIT DROP AS
  SELECT DISTINCT o.job_id, o.model_id,
         upper(regexp_replace(ip.part_number, '[^A-Za-z0-9]', '', 'g')) AS part_number
  FROM _atlas_obs o
  JOIN job_parts_required jpr ON jpr.job_id = o.job_id AND jpr.status = 'installed'
  JOIN inventory_parts ip ON ip.id = jpr.part_id
  WHERE length(upper(regexp_replace(coalesce(ip.part_number, ''), '[^A-Za-z0-9]', '', 'g'))) >= 3;

  -- Expand every observation into the four scopes.
  CREATE TEMP TABLE _atlas_rows ON COMMIT DROP AS
  SELECT 'model'::text AS scope, model_id, ''::text AS failure_key, ''::text AS part_number,
         tenant, job_id, equipment_id, callback, age_months
  FROM _atlas_obs
  UNION ALL
  SELECT 'failure', model_id, failure_key, '', tenant, job_id, equipment_id, callback, age_months
  FROM _atlas_obs WHERE failure_key <> ''
  UNION ALL
  SELECT 'part', o.model_id, '', p.part_number, o.tenant, o.job_id, o.equipment_id, o.callback, o.age_months
  FROM _atlas_obs o JOIN _atlas_obs_parts p ON p.job_id = o.job_id AND p.model_id = o.model_id
  UNION ALL
  SELECT 'repair', o.model_id, o.failure_key, p.part_number, o.tenant, o.job_id, o.equipment_id, o.callback, o.age_months
  FROM _atlas_obs o JOIN _atlas_obs_parts p ON p.job_id = o.job_id AND p.model_id = o.model_id
  WHERE o.failure_key <> '';

  DELETE FROM failure_atlas_cells;

  INSERT INTO failure_atlas_cells
    (scope, model_id, failure_key, part_number, contributors, observations, units,
     success_rate_pct, callback_rate_pct, median_age_months, refreshed_at)
  WITH per_tenant AS (
    SELECT scope, model_id, failure_key, part_number, tenant,
           count(*) AS n,
           count(*) FILTER (WHERE callback) AS cb,
           count(DISTINCT equipment_id) AS units
    FROM _atlas_rows
    GROUP BY scope, model_id, failure_key, part_number, tenant
  ),
  agg AS (
    SELECT scope, model_id, failure_key, part_number,
           count(*) AS contributors,
           sum(n) AS observations,
           max(n) AS max_tenant_n,
           sum(cb) AS callbacks,
           sum(units) AS units
    FROM per_tenant
    GROUP BY scope, model_id, failure_key, part_number
  ),
  med AS (
    SELECT scope, model_id, failure_key, part_number,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY age_months) AS median_age
    FROM _atlas_rows
    WHERE age_months IS NOT NULL
    GROUP BY scope, model_id, failure_key, part_number
  )
  SELECT a.scope, a.model_id, a.failure_key, a.part_number,
         a.contributors::integer,
         (floor(a.observations / 5) * 5)::integer,
         (floor(a.units / 5) * 5)::integer,
         round(100.0 * (a.observations - a.callbacks) / a.observations)::smallint,
         round(100.0 * a.callbacks / a.observations)::smallint,
         round(m.median_age)::integer,
         now()
  FROM agg a
  LEFT JOIN med m USING (scope, model_id, failure_key, part_number)
  WHERE a.contributors >= c_min_contributors
    AND a.observations >= c_min_observations
    AND a.max_tenant_n::numeric / a.observations <= c_max_share;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_failure_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_failure_atlas(integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-refresh-failure-atlas');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-refresh-failure-atlas', '45 3 * * *', 'select public.refresh_failure_atlas()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

COMMENT ON TABLE public.failure_atlas_participation IS
  'Per-account opt-in to contribute anonymous aggregates to the Global Failure Atlas. Default off.';
COMMENT ON TABLE public.failure_atlas_cells IS
  'Anonymous aggregated failure/repair statistics per OEM model. k>=5 contributors, >=10 observations, <=40% single-account share. No tenant, job or equipment identifiers.';
COMMENT ON FUNCTION public.refresh_failure_atlas(integer) IS
  'Rebuilds failure_atlas_cells from opted-in accounts. Service role only.';
