/*
  # ML feature snapshots — point-in-time feature log (PILOT: Predictive Failure Network only)

  Decision record: docs/adr/0001-feature-store-pilot.md

  ## What this is
  An append-only log of the exact feature vector an ML/statistical engine saw when it produced a decision,
  keyed by (tenant, engine, feature-set version, entity, as_of). It lets us
    - replay a past decision byte-for-byte (debugging, audits, regression tests),
    - build training / back-test sets WITHOUT label leakage (only rows with as_of <= the decision time),
    - detect feature drift per feature-set version.

  ## What this is NOT
  Not a feature store: no serving layer, no registry, no backfill, no cross-engine feature sharing yet.
  Only the PFN engine writes here (supabase/functions/predictive-failure). Other engines are untouched.

  ## Design rules
  - Tenant isolation follows the PFN pattern: SELECT only, scoped by public.get_account_owner_id().
    Clients can NEVER insert/update/delete (privileges revoked + no policies): features cannot be forged.
  - Append-only: a trigger rejects every UPDATE (service_role included). A correction is a NEW row with a
    later as_of. Deletion is possible only for service_role (retention purge) and by account deletion cascade.
  - as_of is the moment the features describe. A guard trigger rejects as_of more than 5 minutes in the future
    (clock-skew tolerance) so a snapshot can never be "pre-dated from the future".
  - Idempotent writers: the unique point index makes retries safe (INSERT ... ON CONFLICT DO NOTHING).
  - No customer identity is stored in features (entity_id is the only link). Retention period is a policy
    decision: [COUNSEL] — ml_feature_snapshots_purge() exists but NOTHING calls it on a schedule yet.

  Depends on: auth.users, public.get_account_owner_id().
  Safe to re-run: every statement is idempotent.
*/

-- rollback: DROP TABLE IF EXISTS public.ml_feature_snapshots CASCADE; DROP FUNCTION IF EXISTS public.ml_feature_snapshot_as_of(uuid, text, text, text, uuid, timestamptz); DROP FUNCTION IF EXISTS public.ml_feature_snapshots_purge(timestamptz, uuid, integer); DROP FUNCTION IF EXISTS public.ml_feature_snapshots_guard();  (no other table depends on it; snapshots are derived data)

-- =============================================================
-- 1) Table
-- =============================================================
CREATE TABLE IF NOT EXISTS public.ml_feature_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engine text NOT NULL CHECK (engine ~ '^[a-z][a-z0-9_]{1,47}$'),
  engine_version text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  feature_set_version text NOT NULL CHECK (feature_set_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  entity_id uuid NOT NULL,
  as_of timestamptz NOT NULL,
  features jsonb NOT NULL
    CHECK (jsonb_typeof(features) = 'object' AND octet_length(features::text) <= 262144),
  features_hash text NOT NULL CHECK (features_hash ~ '^[0-9a-f]{32}$'),
  source_table text CHECK (source_table IS NULL OR source_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ml_feature_snapshots_source_pair CHECK ((source_table IS NULL) = (source_id IS NULL))
);

COMMENT ON TABLE public.ml_feature_snapshots IS
  'Append-only point-in-time feature vectors per engine decision (feature-store pilot, PFN only). See docs/adr/0001-feature-store-pilot.md';
COMMENT ON COLUMN public.ml_feature_snapshots.as_of IS
  'Instant the features describe. Training/back-test reads must use as_of <= decision time.';
COMMENT ON COLUMN public.ml_feature_snapshots.features_hash IS
  '128-bit NON-cryptographic fingerprint of canonical features JSON: change detection / dedupe only.';

-- one snapshot per (tenant, engine, feature set, entity, instant); also serves the backward "latest as_of <= t" scan
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_feature_snapshots_point
  ON public.ml_feature_snapshots (user_id, engine, feature_set_version, entity_type, entity_id, as_of);

-- "which snapshot fed forecast X" (training-set joins)
CREATE INDEX IF NOT EXISTS idx_ml_feature_snapshots_source
  ON public.ml_feature_snapshots (source_table, source_id) WHERE source_id IS NOT NULL;

-- =============================================================
-- 2) Integrity guard: append-only + no future-dated as_of
-- =============================================================
CREATE OR REPLACE FUNCTION public.ml_feature_snapshots_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ml_feature_snapshots is append-only (snapshot %): insert a new snapshot instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.as_of > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'ml_feature_snapshots.as_of must not be in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ml_feature_snapshots_guard ON public.ml_feature_snapshots;
CREATE TRIGGER trg_ml_feature_snapshots_guard
  BEFORE INSERT OR UPDATE ON public.ml_feature_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.ml_feature_snapshots_guard();

-- =============================================================
-- 3) RLS + privileges (read-only for clients)
-- =============================================================
ALTER TABLE public.ml_feature_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ml_feature_snapshots_select" ON public.ml_feature_snapshots;
CREATE POLICY "ml_feature_snapshots_select" ON public.ml_feature_snapshots FOR SELECT TO authenticated
  USING (user_id = (select public.get_account_owner_id()));
-- no client INSERT/UPDATE/DELETE policies: features cannot be forged or rewritten from the browser.

REVOKE ALL ON public.ml_feature_snapshots FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ml_feature_snapshots FROM authenticated;
GRANT SELECT ON public.ml_feature_snapshots TO authenticated;
-- Supabase default privileges already give service_role ALL on new tables, so UPDATE/TRUNCATE must be revoked explicitly.
REVOKE UPDATE, TRUNCATE ON public.ml_feature_snapshots FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.ml_feature_snapshots TO service_role;   -- deliberately no UPDATE

-- =============================================================
-- 4) Point-in-time read (service_role only; leakage-safe by construction)
-- =============================================================
-- Newest snapshot with as_of <= p_as_of. Never returns a row from the future of the decision being replayed.
CREATE OR REPLACE FUNCTION public.ml_feature_snapshot_as_of(
  p_user uuid,
  p_engine text,
  p_feature_set_version text,
  p_entity_type text,
  p_entity_id uuid,
  p_as_of timestamptz
)
RETURNS SETOF public.ml_feature_snapshots
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT s.*
  FROM public.ml_feature_snapshots s
  WHERE s.user_id = p_user
    AND s.engine = p_engine
    AND s.feature_set_version = p_feature_set_version
    AND s.entity_type = p_entity_type
    AND s.entity_id = p_entity_id
    AND s.as_of <= p_as_of
  ORDER BY s.as_of DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.ml_feature_snapshot_as_of(uuid, text, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_feature_snapshot_as_of(uuid, text, text, text, uuid, timestamptz) TO service_role;

-- =============================================================
-- 5) Retention purge (service_role only; NOT scheduled — retention period is a policy decision [COUNSEL])
-- =============================================================
-- Deletes at most p_limit rows (oldest first) with as_of < p_before. Accident guard: the cutoff must be >= 1 day old.
CREATE OR REPLACE FUNCTION public.ml_feature_snapshots_purge(
  p_before timestamptz,
  p_owner uuid DEFAULT NULL,
  p_limit integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'p_before is required' USING ERRCODE = '22023';
  END IF;
  IF p_before > now() - interval '1 day' THEN
    RAISE EXCEPTION 'p_before must be at least 1 day in the past' USING ERRCODE = '22023';
  END IF;

  WITH doomed AS (
    SELECT s.id
    FROM public.ml_feature_snapshots s
    WHERE s.as_of < p_before
      AND (p_owner IS NULL OR s.user_id = p_owner)
    ORDER BY s.as_of
    LIMIT greatest(1, least(coalesce(p_limit, 10000), 100000))
  ), d AS (
    DELETE FROM public.ml_feature_snapshots t
    USING doomed
    WHERE t.id = doomed.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM d;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.ml_feature_snapshots_purge(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_feature_snapshots_purge(timestamptz, uuid, integer) TO service_role;
