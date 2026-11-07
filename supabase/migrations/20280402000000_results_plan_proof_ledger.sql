/*
  # Results Plan — Phase 1: rule versions, per-account settings, tamper-evident Proof Ledger

  ## Scope of THIS migration (no prices, no Stripe changes)
  - results_plan_rule_versions : published, versioned definition of a "verified booked job"
  - results_plan_accounts      : per-account opt-in + configurable windows (service-role writes only)
  - proof_ledger               : append-only, hash-chained evidence ledger (one chain per account)
  - proof_ledger_append()      : idempotent writer (service_role only)
  - proof_ledger_verify()      : recomputes the whole chain and reports the first broken seq

  ## Integrity
  - UPDATE / DELETE / TRUNCATE are blocked by triggers (account deletion cascade is the only allowed delete).
  - Per-account advisory lock serializes writers so seq and prev_hash can never fork.
  - UNIQUE (user_id, idempotency_key): re-delivered events are silent no-ops.
  - Authenticated users can only SELECT their own rows; no write privileges are granted to them.

  ## Rollback (only if nothing has been written yet)
    DROP FUNCTION IF EXISTS public.proof_ledger_verify(uuid);
    DROP FUNCTION IF EXISTS public.proof_ledger_append(uuid, uuid, text, text, text, jsonb);
    DROP TABLE IF EXISTS proof_ledger;
    DROP TABLE IF EXISTS results_plan_accounts;
    DROP TABLE IF EXISTS results_plan_rule_versions;
    DROP FUNCTION IF EXISTS public.proof_ledger_chain();
    DROP FUNCTION IF EXISTS public.proof_ledger_guard();

  ## Requires
  profiles, get_account_owner_id(), is_vireek_staff(auth.uid())
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =============================================================
-- 1. Published rule versions
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_rule_versions (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE results_plan_rule_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_published_rule_versions" ON results_plan_rule_versions;
CREATE POLICY "read_published_rule_versions" ON results_plan_rule_versions
  FOR SELECT TO authenticated, anon USING (published_at IS NOT NULL);
DROP POLICY IF EXISTS "staff_read_rule_versions" ON results_plan_rule_versions;
CREATE POLICY "staff_read_rule_versions" ON results_plan_rule_versions
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_rule_versions FROM anon, authenticated;

-- Unpublished until the owner approves the numbers (published_at stays NULL).
INSERT INTO results_plan_rule_versions (version, definition)
VALUES ('rp-rules-v1', jsonb_build_object(
  'status', 'DRAFT - numbers are placeholders pending approval',
  'billing_level_default', 'completed',
  'existing_work_window_days', 30,
  'duplicate_window_hours', 24,
  'cancel_window_hours', 72,
  'levels', jsonb_build_array('booked', 'confirmed', 'completed', 'paid')
))
ON CONFLICT (version) DO NOTHING;

-- =============================================================
-- 2. Per-account settings (opt-in only)
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_accounts (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  billing_level text NOT NULL DEFAULT 'completed' CHECK (billing_level IN ('booked', 'confirmed', 'completed', 'paid')),
  existing_work_window_days integer NOT NULL DEFAULT 30 CHECK (existing_work_window_days BETWEEN 0 AND 365),
  duplicate_window_hours integer NOT NULL DEFAULT 24 CHECK (duplicate_window_hours BETWEEN 0 AND 720),
  cancel_window_hours integer NOT NULL DEFAULT 72 CHECK (cancel_window_hours BETWEEN 0 AND 720),
  monthly_cap_cents integer CHECK (monthly_cap_cents IS NULL OR (monthly_cap_cents > 0 AND monthly_cap_cents <= 100000000)),
  rule_version text NOT NULL DEFAULT 'rp-rules-v1' REFERENCES results_plan_rule_versions(version),
  opted_in_at timestamptz,
  opted_in_by uuid,
  paused_reason text CHECK (paused_reason IS NULL OR char_length(paused_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_active_requires_optin CHECK (status <> 'active' OR opted_in_at IS NOT NULL)
);

ALTER TABLE results_plan_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_results_plan_account" ON results_plan_accounts;
CREATE POLICY "select_own_results_plan_account" ON results_plan_accounts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_results_plan_accounts" ON results_plan_accounts;
CREATE POLICY "staff_select_results_plan_accounts" ON results_plan_accounts
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_accounts FROM anon, authenticated;

-- =============================================================
-- 3. Proof Ledger (append-only, hash-chained per account)
-- =============================================================
CREATE TABLE IF NOT EXISTS proof_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  job_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'qualified', 'confirmed', 'completed', 'paid', 'voided',
    'charge_posted', 'credited', 'disputed', 'dispute_resolved'
  )),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  rule_version text NOT NULL REFERENCES results_plan_rule_versions(version),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 32768),
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT proof_ledger_unique_seq UNIQUE (user_id, seq),
  CONSTRAINT proof_ledger_unique_idem UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_proof_ledger_job ON proof_ledger(user_id, job_id, seq);
CREATE INDEX IF NOT EXISTS idx_proof_ledger_created ON proof_ledger(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.proof_ledger_hash_input(
  p_prev text, p_seq bigint, p_job uuid, p_event text, p_key text, p_rule text, p_evidence jsonb, p_at timestamptz
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT p_prev || '|' || p_seq || '|' || COALESCE(p_job::text, '') || '|' || p_event || '|' || p_key || '|' ||
         p_rule || '|' || p_evidence::text || '|' || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US');
$$;

CREATE OR REPLACE FUNCTION public.proof_ledger_chain()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_prev text; v_seq bigint;
BEGIN
  -- One writer at a time per account: seq and prev_hash can never fork.
  PERFORM pg_advisory_xact_lock(hashtextextended('proof_ledger:' || NEW.user_id::text, 0));
  SELECT l.hash, l.seq INTO v_prev, v_seq FROM proof_ledger l WHERE l.user_id = NEW.user_id ORDER BY l.seq DESC LIMIT 1;
  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_prev, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.hash := encode(extensions.digest(
    public.proof_ledger_hash_input(NEW.prev_hash, NEW.seq, NEW.job_id, NEW.event_type, NEW.idempotency_key, NEW.rule_version, NEW.evidence, NEW.created_at),
    'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_proof_ledger_chain ON proof_ledger;
CREATE TRIGGER trg_proof_ledger_chain BEFORE INSERT ON proof_ledger
  FOR EACH ROW EXECUTE FUNCTION public.proof_ledger_chain();

CREATE OR REPLACE FUNCTION public.proof_ledger_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deleting an account cascades through the foreign key at trigger depth > 1 (GDPR erasure).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'proof_ledger is append-only (% is not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS trg_proof_ledger_append_only ON proof_ledger;
CREATE TRIGGER trg_proof_ledger_append_only BEFORE UPDATE OR DELETE ON proof_ledger
  FOR EACH ROW EXECUTE FUNCTION public.proof_ledger_guard();
DROP TRIGGER IF EXISTS trg_proof_ledger_no_truncate ON proof_ledger;
CREATE TRIGGER trg_proof_ledger_no_truncate BEFORE TRUNCATE ON proof_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.proof_ledger_guard();

ALTER TABLE proof_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_proof_ledger" ON proof_ledger;
CREATE POLICY "select_own_proof_ledger" ON proof_ledger
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_proof_ledger" ON proof_ledger;
CREATE POLICY "staff_select_proof_ledger" ON proof_ledger
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON proof_ledger FROM anon, authenticated;

-- =============================================================
-- 4. Idempotent writer (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.proof_ledger_append(
  p_user uuid, p_job uuid, p_event text, p_key text, p_rule text, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (o_inserted boolean, o_seq bigint, o_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE r proof_ledger%ROWTYPE;
BEGIN
  INSERT INTO proof_ledger (user_id, job_id, event_type, idempotency_key, rule_version, evidence, seq, prev_hash, hash)
  VALUES (p_user, p_job, p_event, p_key, p_rule, COALESCE(p_evidence, '{}'::jsonb), 0, '', '')
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING * INTO r;
  IF r.id IS NOT NULL THEN
    RETURN QUERY SELECT true, r.seq, r.hash;
  ELSE
    SELECT * INTO r FROM proof_ledger WHERE user_id = p_user AND idempotency_key = p_key;
    RETURN QUERY SELECT false, r.seq, r.hash;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.proof_ledger_append(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.proof_ledger_append(uuid, uuid, text, text, text, jsonb) TO service_role;

-- =============================================================
-- 5. Chain verification
-- =============================================================
CREATE OR REPLACE FUNCTION public.proof_ledger_verify(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  r record; v_prev text := repeat('0', 64); v_expected text; v_n bigint := 0; v_expected_seq bigint := 1;
BEGIN
  IF NOT (auth.role() = 'service_role' OR p_user = public.get_account_owner_id() OR public.is_vireek_staff(auth.uid())) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  FOR r IN SELECT * FROM proof_ledger WHERE user_id = p_user ORDER BY seq LOOP
    v_n := v_n + 1;
    v_expected := encode(extensions.digest(
      public.proof_ledger_hash_input(v_prev, r.seq, r.job_id, r.event_type, r.idempotency_key, r.rule_version, r.evidence, r.created_at),
      'sha256'), 'hex');
    IF r.seq <> v_expected_seq OR r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      RETURN jsonb_build_object('ok', false, 'checked', v_n, 'first_bad_seq', r.seq);
    END IF;
    v_prev := r.hash;
    v_expected_seq := v_expected_seq + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'checked', v_n, 'first_bad_seq', NULL);
END $$;

REVOKE ALL ON FUNCTION public.proof_ledger_verify(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proof_ledger_verify(uuid) TO authenticated, service_role;
