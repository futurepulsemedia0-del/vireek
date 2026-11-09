-- 20281120000000_asset_reality_layer.sql
-- Asset Reality Layer, part 1: canonical measurements, per-asset state read model, shadow-mode decision log.
-- Additive only. Safe on fresh DB and current schema (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- Rollback: DROP TABLE asset_decision_log, asset_state, asset_measurements, asset_reality_flags CASCADE;
--           DROP FUNCTION asset_measurement_record, asset_state_upsert, asset_append_only_guard;
--
-- Tenancy: user_id = account owner (get_account_owner_id() pattern). Writes happen ONLY through
-- SECURITY DEFINER functions granted to service_role (Edge Functions); authenticated users can read their own tenant.

-- 0. Per-tenant rollout flags (shadow first) --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.asset_reality_flags (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shadow boolean NOT NULL DEFAULT true,     -- compute state + log would-be decisions, never change agent behavior
  enforce boolean NOT NULL DEFAULT false,   -- agents must pass the gate
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_flags_enforce_needs_shadow_history CHECK (NOT (enforce AND shadow))
);
ALTER TABLE public.asset_reality_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_flags_select" ON public.asset_reality_flags;
CREATE POLICY "asset_flags_select" ON public.asset_reality_flags FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.asset_reality_flags FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.asset_reality_flags FROM authenticated;

-- 1. Append-only guard (deletes allowed only inside an FK cascade = account erasure) --------------
CREATE OR REPLACE FUNCTION public.asset_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

-- 2. Canonical measurements -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.asset_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  passport_id uuid REFERENCES public.equipment_passports(id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  value double precision NOT NULL CHECK (value = value AND value NOT IN ('Infinity', '-Infinity')),
  unit text NOT NULL CHECK (char_length(unit) <= 12),
  input_value double precision NOT NULL,
  input_unit text NOT NULL CHECK (char_length(input_unit) <= 12),
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL CHECK (method IN ('instrument', 'manual', 'ocr', 'sensor', 'derived')),
  instrument jsonb CHECK (instrument IS NULL OR jsonb_typeof(instrument) = 'object'),
  uncertainty double precision CHECK (uncertainty IS NULL OR uncertainty >= 0),
  quality text[] NOT NULL DEFAULT '{ok}',
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  derived_from uuid[] NOT NULL DEFAULT '{}',
  source_table text CHECK (source_table IS NULL OR char_length(source_table) <= 40),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT asset_measurements_derived_inputs CHECK (method <> 'derived' OR cardinality(derived_from) > 0),
  CONSTRAINT asset_measurements_idem UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_asset_meas_equipment ON public.asset_measurements (equipment_id, kind, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_meas_user_recv ON public.asset_measurements (user_id, received_at DESC);

DROP TRIGGER IF EXISTS trg_asset_measurements_append_only ON public.asset_measurements;
CREATE TRIGGER trg_asset_measurements_append_only BEFORE UPDATE OR DELETE ON public.asset_measurements
  FOR EACH ROW EXECUTE FUNCTION public.asset_append_only_guard();

ALTER TABLE public.asset_measurements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_meas_select" ON public.asset_measurements;
CREATE POLICY "asset_meas_select" ON public.asset_measurements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.asset_measurements FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.asset_measurements FROM authenticated;

-- Idempotent record: replays/out-of-order batches return the existing id; equipment must belong to the tenant.
CREATE OR REPLACE FUNCTION public.asset_measurement_record(p_user uuid, p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_equipment uuid := (p_row ->> 'equipment_id')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM equipment e WHERE e.id = v_equipment AND e.user_id = p_user) THEN
    RAISE EXCEPTION 'equipment does not belong to tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO asset_measurements (user_id, equipment_id, passport_id, kind, value, unit, input_value, input_unit,
    measured_at, received_at, method, instrument, uncertainty, quality, evidence_digest, derived_from, source_table, idempotency_key)
  VALUES (p_user, v_equipment, NULLIF(p_row ->> 'passport_id', '')::uuid, p_row ->> 'kind', (p_row ->> 'value')::float8,
    p_row ->> 'unit', (p_row ->> 'input_value')::float8, p_row ->> 'input_unit', (p_row ->> 'measured_at')::timestamptz,
    COALESCE((p_row ->> 'received_at')::timestamptz, now()), p_row ->> 'method', p_row -> 'instrument',
    NULLIF(p_row ->> 'uncertainty', '')::float8,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'quality')), '{ok}'),
    NULLIF(p_row ->> 'evidence_digest', ''),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row -> 'derived_from'))::uuid[], '{}'),
    p_row ->> 'source_table', p_row ->> 'idempotency_key')
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM asset_measurements WHERE user_id = p_user AND idempotency_key = p_row ->> 'idempotency_key';
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.asset_measurement_record(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.asset_measurement_record(uuid, jsonb) TO service_role;

-- 3. Per-asset STATE read model (one row per attribute; queried by voice/dispatch/agents) ---------
CREATE TABLE IF NOT EXISTS public.asset_state (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  attribute text NOT NULL CHECK (attribute ~ '^[a-z][a-z0-9_]{1,59}$'),
  status text NOT NULL CHECK (status IN ('ok', 'conflict', 'unknown')),
  value jsonb,
  winning_claim_id uuid,                      -- truth_facts.id (Operational Truth)
  confidence numeric(5, 4) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  verified boolean NOT NULL DEFAULT false,
  safety_eligible boolean NOT NULL DEFAULT false,
  conflict_claim_ids uuid[] NOT NULL DEFAULT '{}',
  measured_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (equipment_id, attribute),
  CONSTRAINT asset_state_unknown_has_no_value CHECK (status <> 'unknown' OR (value IS NULL AND winning_claim_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_asset_state_user ON public.asset_state (user_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_state_conflicts ON public.asset_state (user_id) WHERE status = 'conflict';

ALTER TABLE public.asset_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_state_select" ON public.asset_state;
CREATE POLICY "asset_state_select" ON public.asset_state FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.asset_state FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.asset_state FROM authenticated;

-- Incremental refresh: the Edge Function resolves one attribute (state.ts) and upserts the result.
CREATE OR REPLACE FUNCTION public.asset_state_upsert(p_user uuid, p_equipment uuid, p_state jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM equipment e WHERE e.id = p_equipment AND e.user_id = p_user) THEN
    RAISE EXCEPTION 'equipment does not belong to tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO asset_state (user_id, equipment_id, attribute, status, value, winning_claim_id, confidence, verified,
                           safety_eligible, conflict_claim_ids, measured_at, computed_at)
  VALUES (p_user, p_equipment, p_state ->> 'attribute', p_state ->> 'status', p_state -> 'value',
          NULLIF(p_state ->> 'winning_claim_id', '')::uuid, COALESCE((p_state ->> 'confidence')::numeric, 0),
          COALESCE((p_state ->> 'verified')::boolean, false), COALESCE((p_state ->> 'safety_eligible')::boolean, false),
          COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_state -> 'conflict_claim_ids'))::uuid[], '{}'),
          NULLIF(p_state ->> 'measured_at', '')::timestamptz, now())
  ON CONFLICT (equipment_id, attribute) DO UPDATE SET
    status = EXCLUDED.status, value = EXCLUDED.value, winning_claim_id = EXCLUDED.winning_claim_id,
    confidence = EXCLUDED.confidence, verified = EXCLUDED.verified, safety_eligible = EXCLUDED.safety_eligible,
    conflict_claim_ids = EXCLUDED.conflict_claim_ids, measured_at = EXCLUDED.measured_at, computed_at = now()
  WHERE asset_state.user_id = EXCLUDED.user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.asset_state_upsert(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.asset_state_upsert(uuid, uuid, jsonb) TO service_role;

-- 4. Decision log: which claim ids an agent relied on; shadow rows record what WOULD change ---------
CREATE TABLE IF NOT EXISTS public.asset_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  agent text NOT NULL CHECK (char_length(agent) BETWEEN 2 AND 80),
  attribute text NOT NULL,
  claim_ids uuid[] NOT NULL DEFAULT '{}',
  verdict text NOT NULL,
  allowed boolean NOT NULL,
  shadow boolean NOT NULL,
  would_change_behavior boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_decisions_user ON public.asset_decision_log (user_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_asset_decisions_append_only ON public.asset_decision_log;
CREATE TRIGGER trg_asset_decisions_append_only BEFORE UPDATE OR DELETE ON public.asset_decision_log
  FOR EACH ROW EXECUTE FUNCTION public.asset_append_only_guard();
ALTER TABLE public.asset_decision_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_decisions_select" ON public.asset_decision_log;
CREATE POLICY "asset_decisions_select" ON public.asset_decision_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.asset_decision_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.asset_decision_log FROM authenticated;
GRANT SELECT ON public.asset_reality_flags, public.asset_measurements, public.asset_state, public.asset_decision_log TO authenticated;
GRANT ALL ON public.asset_reality_flags, public.asset_measurements, public.asset_state, public.asset_decision_log TO service_role;

-- 5. Decision-log writer (service_role only; tenant-checked) ---------------------------------------
CREATE OR REPLACE FUNCTION public.asset_decision_log_write(
  p_user uuid, p_equipment uuid, p_agent text, p_attribute text, p_claim_ids uuid[],
  p_verdict text, p_allowed boolean, p_shadow boolean, p_would_change boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM equipment e WHERE e.id = p_equipment AND e.user_id = p_user) THEN
    RAISE EXCEPTION 'equipment does not belong to tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO asset_decision_log (user_id, equipment_id, agent, attribute, claim_ids, verdict, allowed, shadow, would_change_behavior)
  VALUES (p_user, p_equipment, left(p_agent, 80), p_attribute, COALESCE(p_claim_ids, '{}'), p_verdict, p_allowed, p_shadow, p_would_change);
END;
$$;
REVOKE ALL ON FUNCTION public.asset_decision_log_write(uuid, uuid, text, text, uuid[], text, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.asset_decision_log_write(uuid, uuid, text, text, uuid[], text, boolean, boolean, boolean) TO service_role;

-- 6. Shadow report: what would enforcement have blocked, per agent/attribute (read by the owner) -----
CREATE OR REPLACE VIEW public.asset_shadow_report WITH (security_invoker = true) AS
SELECT user_id, agent, attribute, count(*) AS decisions,
       count(*) FILTER (WHERE would_change_behavior) AS would_block,
       round(100.0 * count(*) FILTER (WHERE would_change_behavior) / count(*), 1) AS would_block_pct,
       count(*) FILTER (WHERE verdict = 'conflict') AS conflicts,
       count(*) FILTER (WHERE verdict = 'unknown') AS unknown_facts
  FROM public.asset_decision_log WHERE shadow
 GROUP BY user_id, agent, attribute;
GRANT SELECT ON public.asset_shadow_report TO authenticated;
