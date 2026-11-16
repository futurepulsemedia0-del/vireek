/*
  Vireek ML Model Registry

  One platform-level registry for every probabilistic engine Vireek ships
  (first_time_fix, resolution_probability, remote_resolution, ...).

  Adds
    model_registry          one row per (name, version): status, metrics snapshot, lineage,
                            promoted_by / promoted_at. At most ONE 'active' row per name.
    model_registry_events   append-only audit trail (register / promote / rollback).
    RPCs                    register_model_version, promote_model_version,
                            rollback_model_version (staff only) and
                            model_registry_active_version (read-only helper).
    Engine links            nullable model_registry_id on ftf_predictions, rpe_assessments and
                            remote_resolution_cases, stamped by a BEFORE trigger that can never
                            block the original write (errors become a WARNING).

  Access: registry rows are INTERNAL. Only Vireek staff (profiles.is_staff via is_vireek_staff)
  can read them or call the write RPCs; there are no INSERT / UPDATE / DELETE policies.

  Deliberately NOT done
    - No backfill of old prediction rows: touching ftf_predictions would risk its updated_at,
      which the Intelligence Evaluation Plane uses as its leakage guard (prediction BEFORE outcome).
      Old rows keep model_registry_id = NULL; join on (name, 'v' || model_version) if needed.
    - Evaluation-plane decisions (eval_plane_decisions) stay per-tenant and untouched; the registry
      is the platform-level promote / rollback record. Metrics are supplied by the promoter.

  Idempotent. NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- rollback: DROP TRIGGER trg_model_registry_stamp on ftf_predictions, rpe_assessments and remote_resolution_cases (the nullable
-- model_registry_id columns, the registry tables and the functions are inert and may stay). Never drop the tables once rows are promoted.

-- 1) Registry ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.model_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,59}$'),
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$'),
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'retired', 'rolled_back')),
  metrics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metrics_snapshot) = 'object' AND octet_length(metrics_snapshot::text) <= 20000),
  lineage jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(lineage) = 'object' AND octet_length(lineage::text) <= 20000),
  parent_id uuid REFERENCES public.model_registry(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_by uuid,
  promoted_at timestamptz,
  retired_at timestamptz,
  UNIQUE (name, version),
  CONSTRAINT model_registry_active_has_promoted_at CHECK (status <> 'active' OR promoted_at IS NOT NULL),
  CONSTRAINT model_registry_closed_has_retired_at CHECK (status NOT IN ('retired', 'rolled_back') OR retired_at IS NOT NULL)
);

-- Exactly one active version per model name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_registry_one_active
  ON public.model_registry (name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_model_registry_name_status
  ON public.model_registry (name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.model_registry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  action text NOT NULL CHECK (action IN ('register', 'promote', 'rollback')),
  from_version text,
  to_version text,
  reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 10 AND 1000),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_registry_events_name
  ON public.model_registry_events (name, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_model_registry_event_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model_registry_events is append-only';
END;
$$;

-- BEFORE UPDATE only: a DELETE trigger would block account-level cascades.
DROP TRIGGER IF EXISTS trg_model_registry_events_immutable ON public.model_registry_events;
CREATE TRIGGER trg_model_registry_events_immutable
  BEFORE UPDATE ON public.model_registry_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_model_registry_event_update();

-- 2) RLS: staff read only, writes through RPCs -----------------------------------------
ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_registry_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.model_registry, public.model_registry_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.model_registry, public.model_registry_events TO authenticated;

DROP POLICY IF EXISTS "model_registry_staff_read" ON public.model_registry;
CREATE POLICY "model_registry_staff_read" ON public.model_registry FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "model_registry_events_staff_read" ON public.model_registry_events;
CREATE POLICY "model_registry_events_staff_read" ON public.model_registry_events FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

-- 3) Internal staff gate ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.model_registry_assert_staff()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'model registry is restricted to Vireek staff' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.model_registry_assert_staff() FROM PUBLIC, anon, authenticated;

-- 4) register_model_version ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_model_version(
  p_name text,
  p_version text,
  p_metrics jsonb DEFAULT '{}'::jsonb,
  p_lineage jsonb DEFAULT '{}'::jsonb,
  p_parent_version text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := public.model_registry_assert_staff();
  v_parent uuid;
  v_id uuid;
BEGIN
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics) <> 'object' THEN
    RAISE EXCEPTION 'p_metrics must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_lineage IS NULL OR jsonb_typeof(p_lineage) <> 'object' THEN
    RAISE EXCEPTION 'p_lineage must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF p_parent_version IS NOT NULL THEN
    SELECT id INTO v_parent FROM model_registry WHERE name = p_name AND version = p_parent_version;
    IF v_parent IS NULL THEN
      RAISE EXCEPTION 'parent version % of % does not exist', p_parent_version, p_name USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO model_registry (name, version, status, metrics_snapshot, lineage, parent_id, created_by)
  VALUES (p_name, p_version, 'candidate', p_metrics, p_lineage, v_parent, v_actor)
  RETURNING id INTO v_id;

  INSERT INTO model_registry_events (name, action, to_version, metrics, actor_id)
  VALUES (p_name, 'register', p_version, p_metrics, v_actor);

  RETURN v_id;
END;
$$;

-- 5) promote_model_version -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.promote_model_version(
  p_name text,
  p_version text,
  p_reason text,
  p_metrics jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := public.model_registry_assert_staff();
  v_target model_registry%ROWTYPE;
  v_prev model_registry%ROWTYPE;
  v_metrics jsonb;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'a reason of 10-1000 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_metrics IS NOT NULL AND jsonb_typeof(p_metrics) <> 'object' THEN
    RAISE EXCEPTION 'p_metrics must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('model_registry:' || p_name));

  SELECT * INTO v_target FROM model_registry WHERE name = p_name AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown model version % of %', p_version, p_name USING ERRCODE = '22023';
  END IF;
  IF v_target.status <> 'candidate' THEN
    RAISE EXCEPTION 'only a candidate can be promoted (% is %); use rollback to restore an older version',
      p_version, v_target.status USING ERRCODE = '55000';
  END IF;

  v_metrics := COALESCE(p_metrics, v_target.metrics_snapshot);
  IF v_metrics = '{}'::jsonb THEN
    RAISE EXCEPTION 'a non-empty metrics snapshot is required to promote' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_prev FROM model_registry WHERE name = p_name AND status = 'active' FOR UPDATE;
  IF FOUND THEN
    UPDATE model_registry SET status = 'retired', retired_at = now() WHERE id = v_prev.id;
  END IF;

  UPDATE model_registry
     SET status = 'active', metrics_snapshot = v_metrics, promoted_by = v_actor, promoted_at = now(),
         retired_at = NULL
   WHERE id = v_target.id;

  INSERT INTO model_registry_events (name, action, from_version, to_version, reason, metrics, actor_id)
  VALUES (p_name, 'promote', v_prev.version, p_version, btrim(p_reason), v_metrics, v_actor);

  RETURN jsonb_build_object('name', p_name, 'promoted', p_version, 'demoted', v_prev.version);
END;
$$;

-- 6) rollback_model_version ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollback_model_version(
  p_name text,
  p_reason text,
  p_target_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := public.model_registry_assert_staff();
  v_cur model_registry%ROWTYPE;
  v_target model_registry%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'a reason of 10-1000 characters is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('model_registry:' || p_name));

  SELECT * INTO v_cur FROM model_registry WHERE name = p_name AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active version of % to roll back', p_name USING ERRCODE = '55000';
  END IF;

  IF p_target_version IS NOT NULL THEN
    SELECT * INTO v_target FROM model_registry
     WHERE name = p_name AND version = p_target_version FOR UPDATE;
  ELSE
    SELECT * INTO v_target FROM model_registry
     WHERE name = p_name AND status = 'retired' AND promoted_at IS NOT NULL
     ORDER BY retired_at DESC, promoted_at DESC
     LIMIT 1 FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no previous version of % to roll back to', p_name USING ERRCODE = '55000';
  END IF;
  IF v_target.status <> 'retired' OR v_target.promoted_at IS NULL THEN
    RAISE EXCEPTION 'rollback target % must be a previously promoted, retired version (is %)',
      v_target.version, v_target.status USING ERRCODE = '55000';
  END IF;

  UPDATE model_registry SET status = 'rolled_back', retired_at = now() WHERE id = v_cur.id;
  UPDATE model_registry
     SET status = 'active', promoted_by = v_actor, promoted_at = now(), retired_at = NULL
   WHERE id = v_target.id;

  INSERT INTO model_registry_events (name, action, from_version, to_version, reason, metrics, actor_id)
  VALUES (p_name, 'rollback', v_cur.version, v_target.version, btrim(p_reason), v_target.metrics_snapshot, v_actor);

  RETURN jsonb_build_object('name', p_name, 'active', v_target.version, 'rolled_back', v_cur.version);
END;
$$;

-- 7) Read helper for engines (returns only the version label) ----------------------------------
CREATE OR REPLACE FUNCTION public.model_registry_active_version(p_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT version FROM model_registry WHERE name = p_name AND status = 'active';
$$;

REVOKE ALL ON FUNCTION public.register_model_version(text, text, jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promote_model_version(text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rollback_model_version(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.model_registry_active_version(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_model_version(text, text, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_model_version(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_model_version(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.model_registry_active_version(text) TO authenticated, service_role;

-- 8) Engine links -----------------------------------------------------------------------------
-- Stamp function. Args: registry name, version column on the row ('' if none), version prefix.
-- With a version column the row links to the registry version it declares; without one it links to
-- the version active at INSERT time and never changes afterwards. Never blocks the original write.
CREATE OR REPLACE FUNCTION public.model_registry_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := TG_ARGV[0];
  v_col text := NULLIF(TG_ARGV[1], '');
  v_prefix text := COALESCE(TG_ARGV[2], '');
  v_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND v_col IS NULL THEN
    NEW.model_registry_id := OLD.model_registry_id;   -- immutable lineage for unversioned rows
    RETURN NEW;
  END IF;

  BEGIN
    IF v_col IS NOT NULL THEN
      SELECT id INTO v_id FROM model_registry
       WHERE name = v_name AND version = v_prefix || (to_jsonb(NEW) ->> v_col);
    END IF;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM model_registry WHERE name = v_name AND status = 'active';
    END IF;
    NEW.model_registry_id := v_id;                    -- ignores any client-supplied value
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'model_registry_stamp(%) skipped: %', v_name, SQLERRM;
    NEW.model_registry_id := NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.model_registry_stamp() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ftf_predictions',          'first_time_fix',         'model_version', 'v'),
      ('rpe_assessments',          'resolution_probability', 'model_version', 'v'),
      ('remote_resolution_cases',  'remote_resolution',      '',              '')
    ) AS t(tbl, model_name, ver_col, ver_prefix)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE 'model_registry: % not found, link skipped', r.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS model_registry_id uuid REFERENCES public.model_registry(id) ON DELETE SET NULL', r.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_model_registry_stamp ON public.%I', r.tbl);
    EXECUTE format('CREATE TRIGGER trg_model_registry_stamp BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.model_registry_stamp(%L, %L, %L)',
                   r.tbl, r.model_name, r.ver_col, r.ver_prefix);
  END LOOP;
END $$;

-- 9) Baseline rows: the versions the shipped code already uses (no invented metrics) ---------------
INSERT INTO public.model_registry (name, version, status, lineage, promoted_at)
VALUES
  ('first_time_fix',         'v1',       'active', '{"source":"migration_baseline","note":"ftf_predictions.model_version = 1"}'::jsonb, now()),
  ('resolution_probability', 'v1',       'active', '{"source":"migration_baseline","note":"rpe_assessments.model_version = 1"}'::jsonb, now()),
  ('remote_resolution',      'baseline', 'active', '{"source":"migration_baseline","note":"remote_resolution_cases has no version column; links to the active version at insert"}'::jsonb, now())
ON CONFLICT (name, version) DO NOTHING;

COMMENT ON TABLE public.model_registry IS
  'Platform ML model registry. Staff-only; writes via register_/promote_/rollback_model_version.';
