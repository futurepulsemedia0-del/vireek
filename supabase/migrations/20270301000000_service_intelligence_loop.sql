/*
  # VIREEK Service Intelligence Loop

  CALL -> SYMPTOM -> ADAPTIVE DIAGNOSIS -> TECHNICIAN ACTION -> PART / REPAIR
       -> VERIFIED OUTCOME -> GLOBAL LEARNING -> BETTER NEXT DIAGNOSIS

  This migration is the connective tissue between tables that already exist:
    - diagnosis_sessions        (the diagnosis that was shown)
    - job_outcomes              (root cause, parts, resolution, callback flag)
    - trade playbook catalog    (code: playbook slug -> job type key -> cause keys;
                                 this IS the controlled vocabulary, so nothing
                                 new has to be curated to make data comparable)

  Adds:
    1. job_outcomes.verification_status / verify_after / verified_at
       A fix is only "verified" after the verification window (30 days) passes
       with no callback. A callback flips it to "refuted".
    2. service_cases            what the copilot PREDICTED for a job, so it can
                                be scored against the verified outcome later.
    3. service_loop_settings    per-tenant opt-out of the shared network.
    4. service_loop_global_priors / _totals
                                k-anonymous cross-tenant cause statistics.
    5. sil_get_priors()         local + global priors for one job type.
    6. sil_loop_metrics()       loop health for the dashboard.
    7. verification sweep + nightly global refresh (pg_cron, guarded).

  Privacy: a global cell is published only when >= 5 distinct tenants contributed
  to it and the job type has >= 20 weighted cases. Only counts/shares leave a
  tenant - never customers, addresses, notes or free text. This is k-anonymity,
  NOT formal differential privacy.

  Idempotent. Rename the timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 0. CONSTANTS (single source of truth)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sil_min_contributors()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

CREATE OR REPLACE FUNCTION public.sil_verification_window()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '30 days' $$;

-- How much one outcome counts as evidence for "this was the cause".
CREATE OR REPLACE FUNCTION public.sil_outcome_weight(p_status text, p_resolution text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_status = 'verified' THEN 1.0
    WHEN p_status = 'pending' THEN 0.5
    WHEN p_status = 'inconclusive' AND p_resolution IN ('parts_pending', 'quote_declined') THEN 0.5
    ELSE 0
  END::numeric
$$;

-- =============================================================
-- 1. VERIFIED OUTCOME columns on job_outcomes
-- =============================================================

ALTER TABLE job_outcomes
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verify_after timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_outcomes_verification_status_check') THEN
    ALTER TABLE job_outcomes
      ADD CONSTRAINT job_outcomes_verification_status_check
      CHECK (verification_status IN ('pending', 'verified', 'refuted', 'inconclusive'));
  END IF;
END $$;

-- Backfill history once (rows that never got a verify_after).
UPDATE job_outcomes
   SET verify_after = recorded_at + public.sil_verification_window(),
       verification_status = CASE
         WHEN resolution NOT IN ('fixed_first_visit', 'fixed_followup') THEN 'inconclusive'
         WHEN caused_callback THEN 'refuted'
         WHEN recorded_at + public.sil_verification_window() <= now() THEN 'verified'
         ELSE 'pending'
       END,
       verified_at = CASE
         WHEN resolution IN ('fixed_first_visit', 'fixed_followup') AND NOT caused_callback
              AND recorded_at + public.sil_verification_window() <= now()
           THEN recorded_at + public.sil_verification_window()
         ELSE NULL
       END
 WHERE verify_after IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_outcomes_verify_due
  ON job_outcomes(verify_after) WHERE verification_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_job_outcomes_cause
  ON job_outcomes(playbook_slug, job_type_key, root_cause_key) WHERE root_cause_key IS NOT NULL;

-- Runs after trg_job_outcomes_callback_flag (same event fires alphabetically),
-- so NEW.caused_callback is already final here.
CREATE OR REPLACE FUNCTION public.sil_job_outcomes_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.verify_after := COALESCE(NEW.recorded_at, now()) + public.sil_verification_window();
  IF NEW.resolution NOT IN ('fixed_first_visit', 'fixed_followup') THEN
    NEW.verification_status := 'inconclusive';
  ELSIF NEW.caused_callback THEN
    NEW.verification_status := 'refuted';
    NEW.verified_at := now();
  ELSE
    NEW.verification_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_outcomes_sil_verify ON job_outcomes;
CREATE TRIGGER trg_job_outcomes_sil_verify
  BEFORE INSERT ON job_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.sil_job_outcomes_before_insert();

-- A rework job linked later flips caused_callback (flag_outcome_callback_from_rework).
CREATE OR REPLACE FUNCTION public.sil_job_outcomes_refute_on_callback()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.caused_callback AND NOT OLD.caused_callback
     AND NEW.verification_status IN ('pending', 'verified') THEN
    NEW.verification_status := 'refuted';
    NEW.verified_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_outcomes_sil_refute ON job_outcomes;
CREATE TRIGGER trg_job_outcomes_sil_refute
  BEFORE UPDATE OF caused_callback ON job_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.sil_job_outcomes_refute_on_callback();


-- Clients may update their own outcomes (RLS allows it), but must never be able
-- to hand themselves a "verified" status. Only this migration's SECURITY DEFINER
-- sweeps (which set the flag below) or the refute trigger may change it.
CREATE OR REPLACE FUNCTION public.sil_job_outcomes_guard_verification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('vireek.sil_internal', true) IS DISTINCT FROM '1' THEN
    NEW.verification_status := OLD.verification_status;
    NEW.verify_after := OLD.verify_after;
    NEW.verified_at := OLD.verified_at;
  END IF;
  RETURN NEW;
END;
$$;

-- Name sorts BEFORE trg_job_outcomes_sil_refute, so the guard runs first and the
-- legitimate refute (callback detected) is applied afterwards and kept.
DROP TRIGGER IF EXISTS trg_job_outcomes_sil_guard ON job_outcomes;
CREATE TRIGGER trg_job_outcomes_sil_guard
  BEFORE UPDATE ON job_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.sil_job_outcomes_guard_verification();

-- =============================================================
-- 2. service_cases - what the copilot predicted (scored later)
-- =============================================================

CREATE TABLE IF NOT EXISTS service_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  diagnosis_session_id uuid REFERENCES diagnosis_sessions(id) ON DELETE SET NULL,
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  top_cause_keys text[] NOT NULL DEFAULT '{}',
  predicted jsonb NOT NULL DEFAULT '[]'::jsonb,
  priors_used boolean NOT NULL DEFAULT false,
  prior_n integer NOT NULL DEFAULT 0 CHECK (prior_n >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagnosis_session_id)
);

CREATE INDEX IF NOT EXISTS idx_service_cases_user_job ON service_cases(user_id, job_id);
CREATE INDEX IF NOT EXISTS idx_service_cases_user_created ON service_cases(user_id, created_at DESC);

ALTER TABLE service_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_own_service_cases ON service_cases;
CREATE POLICY select_own_service_cases ON service_cases
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: only the diagnosis-copilot function (service
-- role) writes, so a client can never forge its own accuracy record.

-- =============================================================
-- 3. Tenant setting - share anonymous statistics with the network
-- =============================================================

CREATE TABLE IF NOT EXISTS service_loop_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  share_global boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE service_loop_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_service_loop_settings ON service_loop_settings;
CREATE POLICY select_own_service_loop_settings ON service_loop_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_service_loop_settings ON service_loop_settings;
CREATE POLICY insert_own_service_loop_settings ON service_loop_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS update_own_service_loop_settings ON service_loop_settings;
CREATE POLICY update_own_service_loop_settings ON service_loop_settings
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- =============================================================
-- 4. Global (k-anonymous) knowledge
-- =============================================================

CREATE TABLE IF NOT EXISTS service_loop_global_totals (
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  contributors integer NOT NULL,
  effective_n numeric(12, 1) NOT NULL,
  verified_n integer NOT NULL,
  total_cases integer NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playbook_slug, job_type_key)
);

CREATE TABLE IF NOT EXISTS service_loop_global_priors (
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  cause_key text NOT NULL,
  contributors integer NOT NULL,
  effective_n numeric(12, 1) NOT NULL,
  verified_n integer NOT NULL,
  share numeric(5, 4) NOT NULL CHECK (share BETWEEN 0 AND 1),
  fix_rate numeric(5, 4) NOT NULL CHECK (fix_rate BETWEEN 0 AND 1),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playbook_slug, job_type_key, cause_key)
);

ALTER TABLE service_loop_global_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_loop_global_priors ENABLE ROW LEVEL SECURITY;

-- Every row already cleared k-anonymity before it was written.
DROP POLICY IF EXISTS read_service_loop_global_totals ON service_loop_global_totals;
CREATE POLICY read_service_loop_global_totals ON service_loop_global_totals
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS read_service_loop_global_priors ON service_loop_global_priors;
CREATE POLICY read_service_loop_global_priors ON service_loop_global_priors
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.refresh_service_loop_global_priors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  DROP TABLE IF EXISTS _sil_base;
  DROP TABLE IF EXISTS _sil_totals;
  DROP TABLE IF EXISTS _sil_cells;

  CREATE TEMP TABLE _sil_base ON COMMIT DROP AS
  SELECT o.user_id, o.playbook_slug, o.job_type_key, o.root_cause_key AS cause_key,
         o.verification_status AS vstatus,
         public.sil_outcome_weight(o.verification_status, o.resolution) AS w
    FROM job_outcomes o
    LEFT JOIN service_loop_settings s ON s.user_id = o.user_id
   WHERE o.root_cause_key IS NOT NULL
     AND COALESCE(s.share_global, true)
     AND o.playbook_slug ~ '^[a-z0-9-]{2,40}$'
     AND o.job_type_key ~ '^[a-z0-9-]{2,48}$'
     AND o.root_cause_key ~ '^[a-z0-9-]{2,48}$';

  CREATE TEMP TABLE _sil_totals ON COMMIT DROP AS
  SELECT playbook_slug, job_type_key,
         COUNT(DISTINCT user_id)::int AS contributors,
         ROUND(SUM(w), 1) AS effective_n,
         COUNT(*) FILTER (WHERE vstatus = 'verified')::int AS verified_n,
         COUNT(*)::int AS total_cases
    FROM _sil_base
   WHERE w > 0
   GROUP BY playbook_slug, job_type_key
  HAVING COUNT(DISTINCT user_id) >= public.sil_min_contributors() AND SUM(w) >= 20;

  CREATE TEMP TABLE _sil_cells ON COMMIT DROP AS
  SELECT b.playbook_slug, b.job_type_key, b.cause_key,
         (COUNT(DISTINCT b.user_id) FILTER (WHERE b.w > 0))::int AS contributors,
         SUM(b.w) AS eff,
         (COUNT(*) FILTER (WHERE b.vstatus = 'verified'))::int AS verified_n,
         (COUNT(*) FILTER (WHERE b.vstatus = 'refuted'))::int AS refuted_n
    FROM _sil_base b
    JOIN _sil_totals t ON t.playbook_slug = b.playbook_slug AND t.job_type_key = b.job_type_key
   GROUP BY b.playbook_slug, b.job_type_key, b.cause_key
  HAVING COUNT(DISTINCT b.user_id) FILTER (WHERE b.w > 0) >= public.sil_min_contributors();

  INSERT INTO service_loop_global_totals AS g
         (playbook_slug, job_type_key, contributors, effective_n, verified_n, total_cases, refreshed_at)
  SELECT playbook_slug, job_type_key, contributors, effective_n, verified_n, total_cases, now()
    FROM _sil_totals
  ON CONFLICT (playbook_slug, job_type_key) DO UPDATE
     SET contributors = EXCLUDED.contributors, effective_n = EXCLUDED.effective_n,
         verified_n = EXCLUDED.verified_n, total_cases = EXCLUDED.total_cases,
         refreshed_at = EXCLUDED.refreshed_at;

  INSERT INTO service_loop_global_priors AS g
         (playbook_slug, job_type_key, cause_key, contributors, effective_n, verified_n, share, fix_rate, refreshed_at)
  SELECT c.playbook_slug, c.job_type_key, c.cause_key, c.contributors, ROUND(c.eff, 1), c.verified_n,
         LEAST(1, ROUND(c.eff / NULLIF(t.effective_n, 0), 4)),
         ROUND((c.verified_n + 1)::numeric / (c.verified_n + c.refuted_n + 2), 4),
         now()
    FROM _sil_cells c
    JOIN _sil_totals t ON t.playbook_slug = c.playbook_slug AND t.job_type_key = c.job_type_key
  ON CONFLICT (playbook_slug, job_type_key, cause_key) DO UPDATE
     SET contributors = EXCLUDED.contributors, effective_n = EXCLUDED.effective_n,
         verified_n = EXCLUDED.verified_n, share = EXCLUDED.share,
         fix_rate = EXCLUDED.fix_rate, refreshed_at = EXCLUDED.refreshed_at;

  -- Anything that no longer clears k-anonymity (or whose tenants opted out) is removed.
  DELETE FROM service_loop_global_priors p
   WHERE NOT EXISTS (SELECT 1 FROM _sil_cells c
                      WHERE c.playbook_slug = p.playbook_slug
                        AND c.job_type_key = p.job_type_key
                        AND c.cause_key = p.cause_key);
  DELETE FROM service_loop_global_totals g
   WHERE NOT EXISTS (SELECT 1 FROM _sil_totals t
                      WHERE t.playbook_slug = g.playbook_slug AND t.job_type_key = g.job_type_key);

  SELECT COUNT(*) INTO v_rows FROM service_loop_global_priors;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_service_loop_global_priors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_service_loop_global_priors() TO service_role;

-- =============================================================
-- 5. Verification sweep
-- =============================================================

CREATE OR REPLACE FUNCTION public.sil_verify_due_outcomes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('vireek.sil_internal', '1', true);
  UPDATE job_outcomes
     SET verification_status = 'verified', verified_at = now()
   WHERE verification_status = 'pending'
     AND verify_after <= now()
     AND caused_callback = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.sil_verify_due_outcomes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sil_verify_due_outcomes() TO service_role;

-- Same sweep, limited to the caller's own account (dashboard "verify now" button).
CREATE OR REPLACE FUNCTION public.sil_verify_my_due_outcomes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL THEN RETURN 0; END IF;
  PERFORM set_config('vireek.sil_internal', '1', true);
  UPDATE job_outcomes
     SET verification_status = 'verified', verified_at = now()
   WHERE user_id = v_owner
     AND verification_status = 'pending'
     AND verify_after <= now()
     AND caused_callback = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.sil_verify_my_due_outcomes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sil_verify_my_due_outcomes() TO authenticated;

-- =============================================================
-- 6. Priors for ONE job type: local evidence shrunk toward the network
-- =============================================================

CREATE OR REPLACE FUNCTION public.sil_get_priors(p_playbook text, p_job_type text)
RETURNS TABLE (
  cause_key text,
  local_n numeric,
  local_share numeric,
  global_n numeric,
  global_share numeric,
  global_contributors integer,
  blended_share numeric,
  fix_rate numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_share boolean;
  v_local_total numeric;
  v_has_global boolean;
  v_w numeric;
BEGIN
  IF v_owner IS NULL
     OR p_playbook !~ '^[a-z0-9-]{2,40}$'
     OR p_job_type !~ '^[a-z0-9-]{2,48}$' THEN
    RETURN;
  END IF;

  SELECT COALESCE((SELECT s.share_global FROM service_loop_settings s WHERE s.user_id = v_owner), true)
    INTO v_share;

  SELECT COALESCE(SUM(public.sil_outcome_weight(o.verification_status, o.resolution)), 0)
    INTO v_local_total
    FROM job_outcomes o
   WHERE o.user_id = v_owner AND o.playbook_slug = p_playbook
     AND o.job_type_key = p_job_type AND o.root_cause_key IS NOT NULL;

  -- Tenants that opt out of contributing do not receive network priors (fair exchange).
  v_has_global := v_share AND EXISTS (
    SELECT 1 FROM service_loop_global_priors g
     WHERE g.playbook_slug = p_playbook AND g.job_type_key = p_job_type);

  -- Local weight grows with the tenant's own evidence: 10 cases = 50 / 50.
  v_w := v_local_total / (v_local_total + 10);

  RETURN QUERY
  WITH loc AS (
    SELECT o.root_cause_key AS ck,
           SUM(public.sil_outcome_weight(o.verification_status, o.resolution)) AS n
      FROM job_outcomes o
     WHERE o.user_id = v_owner AND o.playbook_slug = p_playbook
       AND o.job_type_key = p_job_type AND o.root_cause_key IS NOT NULL
     GROUP BY o.root_cause_key
    HAVING SUM(public.sil_outcome_weight(o.verification_status, o.resolution)) > 0
  ),
  glo AS (
    SELECT g.cause_key AS ck, g.effective_n, g.share, g.contributors, g.fix_rate
      FROM service_loop_global_priors g
     WHERE v_has_global AND g.playbook_slug = p_playbook AND g.job_type_key = p_job_type
  ),
  joined AS (
    SELECT COALESCE(l.ck, g.ck) AS ck,
           l.n AS ln,
           CASE WHEN v_local_total > 0 THEN COALESCE(l.n, 0) / v_local_total END AS ls,
           g.effective_n AS gn,
           CASE WHEN v_has_global THEN COALESCE(g.share, 0) END AS gs,
           g.contributors AS gc,
           g.fix_rate AS fr
      FROM loc l FULL OUTER JOIN glo g ON g.ck = l.ck
  )
  SELECT j.ck,
         ROUND(COALESCE(j.ln, 0), 1),
         ROUND(j.ls, 4),
         ROUND(j.gn, 1),
         ROUND(j.gs, 4),
         j.gc,
         ROUND(CASE
                 WHEN j.ls IS NULL AND j.gs IS NULL THEN NULL
                 WHEN j.ls IS NULL THEN j.gs
                 WHEN j.gs IS NULL THEN j.ls
                 ELSE v_w * j.ls + (1 - v_w) * j.gs
               END, 4),
         j.fr
    FROM joined j
   ORDER BY 7 DESC NULLS LAST, 1
   LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION public.sil_get_priors(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sil_get_priors(text, text) TO authenticated;

-- =============================================================
-- 7. Loop health for the dashboard
-- =============================================================

CREATE OR REPLACE FUNCTION public.sil_loop_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_own jsonb;
  v_pred jsonb;
  v_net jsonb;
  v_share boolean;
BEGIN
  IF v_owner IS NULL THEN RETURN '{}'::jsonb; END IF;

  SELECT COALESCE((SELECT s.share_global FROM service_loop_settings s WHERE s.user_id = v_owner), true)
    INTO v_share;

  SELECT jsonb_build_object(
           'outcomes', COUNT(*),
           'with_cause', COUNT(*) FILTER (WHERE root_cause_key IS NOT NULL),
           'verified', COUNT(*) FILTER (WHERE verification_status = 'verified'),
           'pending', COUNT(*) FILTER (WHERE verification_status = 'pending'),
           'refuted', COUNT(*) FILTER (WHERE verification_status = 'refuted'),
           'first_visit_fixed', COUNT(*) FILTER (WHERE resolution = 'fixed_first_visit'),
           'callbacks', COUNT(*) FILTER (WHERE caused_callback)
         )
    INTO v_own
    FROM job_outcomes WHERE user_id = v_owner;

  -- Prediction accuracy: latest copilot case per job vs. the recorded root cause.
  SELECT jsonb_build_object(
           'cases', (SELECT COUNT(DISTINCT job_id) FROM service_cases WHERE user_id = v_owner AND job_id IS NOT NULL),
           'scored', COUNT(*),
           'top1', COUNT(*) FILTER (WHERE s.top1),
           'top3', COUNT(*) FILTER (WHERE s.top3),
           'with_priors_scored', COUNT(*) FILTER (WHERE s.priors_used),
           'with_priors_top1', COUNT(*) FILTER (WHERE s.priors_used AND s.top1),
           'without_priors_scored', COUNT(*) FILTER (WHERE NOT s.priors_used),
           'without_priors_top1', COUNT(*) FILTER (WHERE NOT s.priors_used AND s.top1)
         )
    INTO v_pred
    FROM (
      SELECT l.priors_used,
             (l.top_cause_keys[1] = o.root_cause_key) AS top1,
             (o.root_cause_key = ANY (l.top_cause_keys)) AS top3
        FROM (
          SELECT DISTINCT ON (c.job_id) c.job_id, c.priors_used, c.top_cause_keys
            FROM service_cases c
           WHERE c.user_id = v_owner AND c.job_id IS NOT NULL
           ORDER BY c.job_id, c.created_at DESC
        ) l
        JOIN job_outcomes o ON o.job_id = l.job_id AND o.user_id = v_owner
       WHERE o.root_cause_key IS NOT NULL AND cardinality(l.top_cause_keys) > 0
    ) s;

  SELECT jsonb_build_object(
           'job_types', COUNT(*),
           'cases', COALESCE(SUM(total_cases), 0),
           'verified', COALESCE(SUM(verified_n), 0),
           'max_contributors', COALESCE(MAX(contributors), 0)
         )
    INTO v_net
    FROM service_loop_global_totals;

  RETURN jsonb_build_object('own', v_own, 'predictions', v_pred, 'network', v_net, 'sharing', v_share);
END;
$$;

REVOKE ALL ON FUNCTION public.sil_loop_metrics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sil_loop_metrics() TO authenticated;

-- =============================================================
-- 8. Schedules (only when pg_cron exists; otherwise call the two functions
--    from any scheduler as service_role)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('vireek-sil-verify'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('vireek-sil-global-refresh'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('vireek-sil-verify', '15 2 * * *', $cmd$SELECT public.sil_verify_due_outcomes();$cmd$);
    PERFORM cron.schedule('vireek-sil-global-refresh', '45 2 * * *', $cmd$SELECT public.refresh_service_loop_global_priors();$cmd$);
  END IF;
END $$;
