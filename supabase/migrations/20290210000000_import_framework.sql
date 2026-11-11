/*
  # Import Framework (M&A readiness) — generic, idempotent, resumable imports with rollback

  Additive only: no existing table, column, policy or function is changed.
  Module is OFF by default: feature flag `import_framework` is created disabled (enabled=false, rollout 0).
  Entitle ONE account with:  enabled=true, rollout_pct=0 and a tenant override 'on' (staff tools / feature_flag_overrides).

  New tables (all user_id = ACCOUNT OWNER id, same tenancy idiom as data_import_jobs):
    import_fw_runs        one row per run: status, checkpoint, counters, lease, mapping snapshot
    import_fw_items       the idempotency ledger: last applied fingerprint + target id per (scope, entity, source key)
    import_fw_effects     write-ahead effects: exactly what a run created/updated (drives rollback)
    import_fw_row_errors  first 1000 row errors per run (position + code only; NO source values / PII)

  Security
    - RLS on every table. SELECT: can_run_data_imports(). Writes: can_run_data_imports() AND module enabled.
    - Internal RPCs are SECURITY INVOKER-safe or tenant-checked; not callable by anon.
    - The module gate import_framework_enabled() reads the flag with the same semantics as get_my_feature_flags().

  Rollback of this migration (no other data is touched):
    DROP FUNCTION IF EXISTS public.import_fw_save_batch(uuid, text, jsonb, jsonb, jsonb, jsonb, integer);
    DROP FUNCTION IF EXISTS public.import_fw_acquire_lease(uuid, text, integer);
    DROP FUNCTION IF EXISTS public.import_framework_enabled();
    DROP TABLE IF EXISTS public.import_fw_row_errors, public.import_fw_effects, public.import_fw_items, public.import_fw_runs;
    DELETE FROM public.feature_flags WHERE key = 'import_framework';
  (Records already written into customers/jobs by a run are NOT removed by dropping these tables:
   roll the run back through the API first.)
*/

-- rollback: see the block above (drop the 2 RPCs, import_framework_enabled(), the 4 import_fw_* tables and the import_framework flag row; roll runs back through the API first)
DO $$
DECLARE t text; v_missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'feature_flags', 'feature_flag_overrides', 'customers', 'jobs', 'data_import_jobs'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN v_missing := v_missing || t; END IF;
  END LOOP;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'import_framework: missing prerequisite tables: %', array_to_string(v_missing, ', ');
  END IF;
  IF to_regprocedure('public.can_run_data_imports()') IS NULL OR to_regprocedure('public.get_account_owner_id()') IS NULL
     OR to_regprocedure('public.feature_flag_is_on(boolean,integer,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'import_framework: prerequisite functions missing (can_run_data_imports, get_account_owner_id, feature_flag_is_on)';
  END IF;
END $$;

-- 1. Flag (default OFF) ---------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('import_framework', 'Import framework (M&A readiness)',
        'Generic idempotent/resumable import with dry-run and rollback. Entitlement: enabled + rollout 0 + per-tenant override on. Owner: platform. Permanent entitlement flag.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.import_framework_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, public.get_account_owner_id(), f.key)
      FROM feature_flags f
      LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = public.get_account_owner_id()
     WHERE f.key = 'import_framework'
  ), false);
$$;
REVOKE ALL ON FUNCTION public.import_framework_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_framework_enabled() TO authenticated;

-- 2. Tables -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_fw_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 80),
  adapter_id text NOT NULL CHECK (char_length(adapter_id) BETWEEN 1 AND 40),
  adapter_version text NOT NULL,
  source_fingerprint text NOT NULL,
  mapping_hash text NOT NULL,
  mapping jsonb NOT NULL,
  actor_id uuid,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'paused', 'completed', 'completed_with_errors', 'failed', 'rolling_back', 'rolled_back', 'rolled_back_partial')),
  checkpoint jsonb NOT NULL DEFAULT '{"entityIndex":0,"cursor":null}'::jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure text,
  lease_owner text,
  lease_expires_at timestamptz,
  rollback_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- At most ONE open run per (tenant, scope): the DB, not the app, prevents two concurrent imports.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_fw_runs_one_open
  ON import_fw_runs (user_id, scope_key) WHERE status IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS idx_import_fw_runs_scope ON import_fw_runs (user_id, scope_key, created_at DESC);

CREATE TABLE IF NOT EXISTS import_fw_items (
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  scope_key text NOT NULL,
  entity text NOT NULL,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL,
  target_id uuid,
  status text NOT NULL CHECK (status IN ('created', 'updated', 'unchanged', 'error')),
  run_id uuid NOT NULL REFERENCES import_fw_runs(id) ON DELETE CASCADE,
  position integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope_key, entity, source_key)
);
CREATE INDEX IF NOT EXISTS idx_import_fw_items_run ON import_fw_items (run_id);

CREATE TABLE IF NOT EXISTS import_fw_effects (
  run_id uuid NOT NULL REFERENCES import_fw_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  entity text NOT NULL,
  source_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated')),
  target_id uuid NOT NULL,
  before_values jsonb,
  after_values jsonb,
  rollback_state text CHECK (rollback_state IN ('done', 'blocked', 'kept_modified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, entity, source_key)
);
CREATE INDEX IF NOT EXISTS idx_import_fw_effects_pending ON import_fw_effects (run_id, entity) WHERE rollback_state IS NULL;

CREATE TABLE IF NOT EXISTS import_fw_row_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES import_fw_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  entity text NOT NULL,
  source_key text,
  position integer NOT NULL,
  code text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_fw_row_errors_run ON import_fw_row_errors (run_id);

-- 3. RLS ---------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_fw_runs', 'import_fw_items', 'import_fw_effects', 'import_fw_row_errors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports())', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.can_run_data_imports() AND public.import_framework_enabled())', t || '_insert', t);
  END LOOP;
  -- runs / items / effects are updated in place; row_errors is append-only (audit-grade: no UPDATE/DELETE policy).
  FOREACH t IN ARRAY ARRAY['import_fw_runs', 'import_fw_items', 'import_fw_effects'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports() AND public.import_framework_enabled()) WITH CHECK (user_id = public.get_account_owner_id())', t || '_update', t);
  END LOOP;
  -- ledger items must be deletable (rollback invalidates them); effects/runs are never deleted by clients.
  DROP POLICY IF EXISTS import_fw_items_delete ON import_fw_items;
  CREATE POLICY import_fw_items_delete ON import_fw_items FOR DELETE TO authenticated
    USING (user_id = public.get_account_owner_id() AND public.can_run_data_imports() AND public.import_framework_enabled());
END $$;

-- 4. RPCs (called with the CALLER's JWT, so RLS and the permission gate still apply) -------------
CREATE OR REPLACE FUNCTION public.import_fw_acquire_lease(p_run_id uuid, p_owner text, p_ttl_ms integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.import_framework_enabled() THEN RAISE EXCEPTION 'MODULE_DISABLED'; END IF;
  UPDATE import_fw_runs
     SET lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0), updated_at = now()
   WHERE id = p_run_id AND user_id = public.get_account_owner_id()
     AND (lease_owner IS NULL OR lease_owner = p_owner OR lease_expires_at IS NULL OR lease_expires_at <= now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- One transaction: items + row errors + checkpoint + counters + lease extension.
CREATE OR REPLACE FUNCTION public.import_fw_save_batch(
  p_run_id uuid, p_owner text, p_items jsonb, p_errors jsonb, p_checkpoint jsonb, p_counters jsonb, p_ttl_ms integer
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_run import_fw_runs%ROWTYPE; v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.import_framework_enabled() THEN RAISE EXCEPTION 'MODULE_DISABLED'; END IF;
  SELECT * INTO v_run FROM import_fw_runs WHERE id = p_run_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_run.lease_owner IS DISTINCT FROM p_owner OR v_run.lease_expires_at IS NULL OR v_run.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'LEASE_LOST';
  END IF;

  INSERT INTO import_fw_items (user_id, scope_key, entity, source_key, fingerprint, target_id, status, run_id, position)
  SELECT v_owner, v_run.scope_key, i.entity, i.source_key, i.fingerprint, i.target_id, i.status, p_run_id, i.position
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS i(entity text, source_key text, fingerprint text, target_id uuid, status text, position integer)
  ON CONFLICT (user_id, scope_key, entity, source_key) DO UPDATE
    SET fingerprint = EXCLUDED.fingerprint, target_id = EXCLUDED.target_id, status = EXCLUDED.status,
        run_id = EXCLUDED.run_id, position = EXCLUDED.position, updated_at = now();

  INSERT INTO import_fw_row_errors (run_id, user_id, entity, source_key, position, code, message)
  SELECT p_run_id, v_owner, e.entity, e.source_key, e.position, e.code, left(e.message, 300)
    FROM jsonb_to_recordset(COALESCE(p_errors, '[]'::jsonb)) AS e(entity text, source_key text, position integer, code text, message text)
   WHERE (SELECT count(*) FROM import_fw_row_errors x WHERE x.run_id = p_run_id) < 1000;

  UPDATE import_fw_runs
     SET checkpoint = p_checkpoint, counters = p_counters, updated_at = now(),
         lease_expires_at = now() + make_interval(secs => p_ttl_ms / 1000.0)
   WHERE id = p_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.import_fw_acquire_lease(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.import_fw_save_batch(uuid, text, jsonb, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_fw_acquire_lease(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_fw_save_batch(uuid, text, jsonb, jsonb, jsonb, jsonb, integer) TO authenticated;
