/*
  # Vireek Outcome Clearinghouse

  The trusted verification + settlement layer for real-world service outcomes.
  Connects what already exists - Evidence (job_evidence_chain), Payments (payment_requests),
  Warranties (service_guarantees), Insurance (insurance_claims), Reputation (technicians) - through ONE
  verifiable outcome record per job with a confidence score, provenance, disputes and an
  immutable, SHA-256 hash-chained audit trail.

      claimed -> verified | partially_verified | unverified -> (dispute window) -> settled
                                    \-> disputed (freezes settlement) -> upheld | rejected | withdrawn

  ## Objects
  - outcome_clearing_settings : per-account policy (min confidence, dispute window, auto-settle / auto-open).
  - outcome_records           : the outcome record (one per job). Server-computed status + confidence.
  - outcome_measurements      : append-only before / after / monitor readings with expected range.
  - outcome_clearing_events   : append-only, per-record, hash-chained ledger (anchors the evidence-chain head hash).
  - outcome_settlements       : settlement legs (payment / warranty / insurance) cleared by the engine.
  - outcome_disputes          : disputes; opening one automatically holds every un-executed leg.

  ## Integrity rules
  - Clients get SELECT only. Every write goes through SECURITY DEFINER RPCs that re-check access.
  - Confidence / status are computed by occ_assess() on the server - never accepted from a client.
  - A broken evidence chain, an out-of-spec "after" reading, a callback, an upheld dispute or a
    customer-disputed job are adverse signals: the outcome can never be "verified" while one exists.
  - The ledger stores hashes of free text (claim, dispute description), never the text -> the immutable
    log carries no personal data.
  - The clearinghouse CLEARS settlement legs (decision + audit). It does not move money and never edits
    payment_requests / service_guarantees / insurance_claims. Downstream flows may read the decision via
    outcome_clearing_overview() / record detail; executing a leg is a manager action with a reference.
  - Public pages: verify_token (read-only proof for insurers / buyers) and customer_token (customer may
    confirm or dispute). Both are opt-in per record (public_enabled) and rotatable. Tokens are never
    returned to non-managers (column-level grants).

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), public.get_my_team_member_id(),
  jobs, team_members, profiles, job_outcomes, service_guarantees, payment_requests, insurance_claims,
  job_evidence_chain_report(uuid), job_evidence_chain_verify(uuid).

  ## Scheduling (run once, after applying this migration)
    select cron.schedule('outcome-clearing-sweep', '*/15 * * * *', $$ select public.outcome_clearing_sweep(200); $$);
*/

-- =============================================================
-- 0. HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.occ_new_token()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

CREATE OR REPLACE FUNCTION public.occ_band(p_confidence integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_confidence >= 85 THEN 'high'
    WHEN p_confidence >= 70 THEN 'moderate'
    WHEN p_confidence >= 40 THEN 'low'
    ELSE 'insufficient'
  END;
$$;

-- =============================================================
-- 1. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.outcome_clearing_settings (
  user_id uuid PRIMARY KEY,
  min_release_confidence smallint NOT NULL DEFAULT 70 CHECK (min_release_confidence BETWEEN 50 AND 100),
  dispute_window_days smallint NOT NULL DEFAULT 14 CHECK (dispute_window_days BETWEEN 0 AND 90),
  auto_settle boolean NOT NULL DEFAULT false,
  auto_open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.outcome_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  outcome_type text NOT NULL DEFAULT 'repair_restored'
    CHECK (outcome_type IN ('repair_restored', 'install_commissioned', 'maintenance_completed', 'inspection_completed', 'other')),
  claim_statement text NOT NULL CHECK (char_length(btrim(claim_statement)) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'verified', 'partially_verified', 'unverified', 'disputed', 'settled', 'voided')),
  status_before_dispute text
    CHECK (status_before_dispute IS NULL OR status_before_dispute IN ('claimed', 'verified', 'partially_verified', 'unverified', 'settled')),
  confidence smallint NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  confidence_band text NOT NULL DEFAULT 'insufficient' CHECK (confidence_band IN ('high', 'moderate', 'low', 'insufficient')),
  assessment jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(assessment) = 'object'),
  assessed_at timestamptz,
  evidence_head_hash text,
  evidence_entries integer NOT NULL DEFAULT 0 CHECK (evidence_entries >= 0),
  verified_at timestamptz,
  dispute_window_ends_at timestamptz,
  settled_at timestamptz,
  settle_override_note text CHECK (settle_override_note IS NULL OR char_length(settle_override_note) <= 500),
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  customer_confirmed_at timestamptz,
  verify_token text NOT NULL UNIQUE DEFAULT public.occ_new_token(),
  customer_token text NOT NULL UNIQUE DEFAULT public.occ_new_token(),
  public_enabled boolean NOT NULL DEFAULT false,
  opened_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_occ_records_owner ON public.outcome_records (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_occ_records_tech ON public.outcome_records (technician_id) WHERE technician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_occ_records_sweep ON public.outcome_records (assessed_at NULLS FIRST)
  WHERE status IN ('claimed', 'verified', 'partially_verified', 'unverified', 'disputed');

CREATE TABLE IF NOT EXISTS public.outcome_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES public.outcome_records(id) ON DELETE CASCADE,
  metric_key text NOT NULL CHECK (metric_key ~ '^[a-z0-9_]{2,48}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 16),
  phase text NOT NULL CHECK (phase IN ('before', 'after', 'monitor')),
  value numeric NOT NULL CHECK (value <> 'NaN'::numeric),
  expected_min numeric CHECK (expected_min IS NULL OR expected_min <> 'NaN'::numeric),
  expected_max numeric CHECK (expected_max IS NULL OR expected_max <> 'NaN'::numeric),
  source text NOT NULL DEFAULT 'technician' CHECK (source IN ('technician', 'device', 'telemetry', 'customer', 'third_party')),
  device_ref text CHECK (device_ref IS NULL OR char_length(device_ref) <= 80),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid,
  within_spec boolean,
  CONSTRAINT occ_meas_range CHECK (expected_min IS NULL OR expected_max IS NULL OR expected_min <= expected_max)
);
CREATE INDEX IF NOT EXISTS idx_occ_meas_record ON public.outcome_measurements (record_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.outcome_clearing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES public.outcome_records(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'measurement_recorded', 'assessed', 'verified', 'customer_confirmed',
    'dispute_opened', 'dispute_resolved', 'settlement_cleared', 'settlement_executed',
    'voided', 'public_link_changed', 'tokens_rotated'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('technician', 'staff', 'customer', 'system', 'external')),
  actor_user_id uuid,
  actor_name text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash text,
  entry_hash text NOT NULL DEFAULT '',
  UNIQUE (record_id, seq)
);

CREATE TABLE IF NOT EXISTS public.outcome_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES public.outcome_records(id) ON DELETE CASCADE,
  opened_by_type text NOT NULL CHECK (opened_by_type IN ('customer', 'staff', 'insurer', 'system')),
  reported_by_user uuid,
  reason_code text NOT NULL CHECK (reason_code IN ('not_fixed', 'recurred', 'work_not_done', 'quality', 'overcharge', 'damage', 'other')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_upheld', 'resolved_rejected', 'withdrawn')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);
CREATE INDEX IF NOT EXISTS idx_occ_disputes_record ON public.outcome_disputes (record_id, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_occ_one_open_dispute ON public.outcome_disputes (record_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.outcome_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES public.outcome_records(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('payment', 'warranty', 'insurance')),
  leg_key text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'cleared', 'held', 'executed', 'cancelled')),
  held_from text CHECK (held_from IS NULL OR held_from IN ('planned', 'cleared')),
  hold_reason text CHECK (hold_reason IS NULL OR char_length(hold_reason) <= 300),
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  payment_request_id uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  service_guarantee_id uuid REFERENCES public.service_guarantees(id) ON DELETE SET NULL,
  insurance_claim_id uuid REFERENCES public.insurance_claims(id) ON DELETE SET NULL,
  cleared_at timestamptz,
  executed_at timestamptz,
  executed_ref text CHECK (executed_ref IS NULL OR char_length(executed_ref) <= 120),
  executed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, kind, leg_key)
);
CREATE INDEX IF NOT EXISTS idx_occ_settlements_record ON public.outcome_settlements (record_id);
CREATE INDEX IF NOT EXISTS idx_occ_settlements_owner ON public.outcome_settlements (user_id, status);

-- =============================================================
-- 2. LEDGER: seal + immutability
-- =============================================================
CREATE OR REPLACE FUNCTION public.occ_event_hash(e public.outcome_clearing_events)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    coalesce(e.prev_hash, 'GENESIS'),
    e.record_id::text,
    e.seq::text,
    e.event_type,
    e.payload::text,
    e.actor_type,
    coalesce(e.actor_user_id::text, ''),
    coalesce(e.actor_name, ''),
    to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

-- Actor attribution is derived on the server: vireek.clearing_actor = system | customer | external,
-- otherwise the authenticated team member. A client can never choose who an event is attributed to.
CREATE OR REPLACE FUNCTION public.occ_seal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_last_seq integer;
  v_last_hash text;
  v_mode text := coalesce(current_setting('vireek.clearing_actor', true), '');
  v_name text;
  v_role text;
BEGIN
  SELECT user_id INTO v_owner FROM public.outcome_records WHERE id = NEW.record_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown record' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:outcome-clearing:' || NEW.record_id::text, 0));

  SELECT seq, entry_hash INTO v_last_seq, v_last_hash
  FROM public.outcome_clearing_events
  WHERE record_id = NEW.record_id
  ORDER BY seq DESC
  LIMIT 1;

  NEW.user_id := v_owner;
  NEW.seq := coalesce(v_last_seq, 0) + 1;
  NEW.prev_hash := v_last_hash;
  NEW.recorded_at := clock_timestamp();

  IF v_mode = 'customer' THEN
    NEW.actor_type := 'customer'; NEW.actor_user_id := NULL; NEW.actor_name := 'Customer (verified link)';
  ELSIF v_mode = 'external' THEN
    NEW.actor_type := 'external'; NEW.actor_user_id := NULL; NEW.actor_name := 'External source';
  ELSIF v_mode = 'system' OR auth.uid() IS NULL THEN
    NEW.actor_type := 'system'; NEW.actor_user_id := NULL; NEW.actor_name := 'Vireek Clearinghouse';
  ELSE
    SELECT tm.member_name, tm.role INTO v_name, v_role FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1;
    NEW.actor_user_id := auth.uid();
    NEW.actor_type := CASE WHEN v_role = 'technician' THEN 'technician' ELSE 'staff' END;
    NEW.actor_name := coalesce(v_name, 'Account owner');
  END IF;

  NEW.entry_hash := public.occ_event_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_occ_seal_event ON public.outcome_clearing_events;
CREATE TRIGGER trg_occ_seal_event
  BEFORE INSERT ON public.outcome_clearing_events
  FOR EACH ROW EXECUTE FUNCTION public.occ_seal_event();

-- Deleting a whole record (FK cascade from a deleted job) is the only permitted delete.
CREATE OR REPLACE FUNCTION public.occ_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.outcome_records WHERE id = OLD.record_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'OUTCOME_CLEARING_IMMUTABLE: % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_occ_events_immutable ON public.outcome_clearing_events;
CREATE TRIGGER trg_occ_events_immutable
  BEFORE UPDATE OR DELETE ON public.outcome_clearing_events
  FOR EACH ROW EXECUTE FUNCTION public.occ_block_mutation();

DROP TRIGGER IF EXISTS trg_occ_measurements_immutable ON public.outcome_measurements;
CREATE TRIGGER trg_occ_measurements_immutable
  BEFORE UPDATE OR DELETE ON public.outcome_measurements
  FOR EACH ROW EXECUTE FUNCTION public.occ_block_mutation();

CREATE OR REPLACE FUNCTION public.occ_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OUTCOME_CLEARING_IMMUTABLE: % cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_occ_events_no_truncate ON public.outcome_clearing_events;
CREATE TRIGGER trg_occ_events_no_truncate
  BEFORE TRUNCATE ON public.outcome_clearing_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.occ_block_truncate();

DROP TRIGGER IF EXISTS trg_occ_measurements_no_truncate ON public.outcome_measurements;
CREATE TRIGGER trg_occ_measurements_no_truncate
  BEFORE TRUNCATE ON public.outcome_measurements
  FOR EACH STATEMENT EXECUTE FUNCTION public.occ_block_truncate();

-- Recomputes the whole hash chain of one record.
CREATE OR REPLACE FUNCTION public.occ_verify_chain(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_clearing_events;
  v_expected integer := 1;
  v_prev text := NULL;
  v_count integer := 0;
  v_broken integer;
  v_reason text;
BEGIN
  FOR r IN SELECT * FROM public.outcome_clearing_events WHERE record_id = p_record_id ORDER BY seq LOOP
    v_count := v_count + 1;
    IF r.seq <> v_expected THEN v_broken := r.seq; v_reason := 'sequence_gap'; EXIT; END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN v_broken := r.seq; v_reason := 'broken_link'; EXIT; END IF;
    IF r.entry_hash <> public.occ_event_hash(r) THEN v_broken := r.seq; v_reason := 'hash_mismatch'; EXIT; END IF;
    v_prev := r.entry_hash;
    v_expected := v_expected + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'valid', v_broken IS NULL,
    'entries', v_count,
    'broken_seq', v_broken,
    'reason', v_reason,
    'head_hash', v_prev
  );
END;
$$;

-- =============================================================
-- 3. ROW LEVEL SECURITY (read-only for clients)
-- =============================================================
ALTER TABLE public.outcome_clearing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_clearing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "occ_settings_select" ON public.outcome_clearing_settings;
CREATE POLICY "occ_settings_select" ON public.outcome_clearing_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "occ_records_select" ON public.outcome_records;
CREATE POLICY "occ_records_select" ON public.outcome_records FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "occ_measurements_select" ON public.outcome_measurements;
CREATE POLICY "occ_measurements_select" ON public.outcome_measurements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "occ_events_select" ON public.outcome_clearing_events;
CREATE POLICY "occ_events_select" ON public.outcome_clearing_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "occ_disputes_select" ON public.outcome_disputes;
CREATE POLICY "occ_disputes_select" ON public.outcome_disputes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Settlement amounts are billing data: managers only.
DROP POLICY IF EXISTS "occ_settlements_select" ON public.outcome_settlements;
CREATE POLICY "occ_settlements_select" ON public.outcome_settlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON public.outcome_clearing_settings, public.outcome_records, public.outcome_measurements,
  public.outcome_clearing_events, public.outcome_disputes, public.outcome_settlements FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.outcome_clearing_settings, public.outcome_measurements, public.outcome_clearing_events,
  public.outcome_disputes, public.outcome_settlements TO authenticated;

-- Column-level: the two share tokens are never readable by clients (managers use outcome_clearing_share_links).
GRANT SELECT (
  id, user_id, job_id, technician_id, outcome_type, claim_statement, status, status_before_dispute,
  confidence, confidence_band, assessment, assessed_at, evidence_head_hash, evidence_entries,
  verified_at, dispute_window_ends_at, settled_at, settle_override_note, void_reason,
  customer_confirmed_at, public_enabled, opened_by, created_at, updated_at
) ON public.outcome_records TO authenticated;

-- =============================================================
-- 4. INTERNAL FUNCTIONS (not callable by clients)
-- =============================================================
CREATE OR REPLACE FUNCTION public.occ_settings(p_owner uuid)
RETURNS public.outcome_clearing_settings
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.outcome_clearing_settings;
BEGIN
  SELECT * INTO s FROM public.outcome_clearing_settings WHERE user_id = p_owner;
  IF NOT FOUND THEN
    s.user_id := p_owner;
    s.min_release_confidence := 70;
    s.dispute_window_days := 14;
    s.auto_settle := false;
    s.auto_open := false;
  END IF;
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION public.occ_log(p_record_id uuid, p_type text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.outcome_clearing_events (record_id, event_type, payload)
  VALUES (p_record_id, p_type, coalesce(p_payload, '{}'::jsonb));
$$;

-- Read access (account member) without locking.
CREATE OR REPLACE FUNCTION public.occ_load(p_record_id uuid)
RETURNS public.outcome_records
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  SELECT * INTO r FROM public.outcome_records
  WHERE id = p_record_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  RETURN r;
END;
$$;

-- Write access: ALWAYS take the record row lock first (before the ledger advisory lock) -> no deadlocks.
CREATE OR REPLACE FUNCTION public.occ_lock_record(p_record_id uuid)
RETURNS public.outcome_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  SELECT * INTO r FROM public.outcome_records
  WHERE id = p_record_id AND user_id = public.get_account_owner_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  RETURN r;
END;
$$;

-- ---- The engine --------------------------------------------------------------------------
-- confidence = 30 evidence + 25 measurements + 15 customer + 20 durability + 10 commercial
CREATE OR REPLACE FUNCTION public.occ_assess(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  s public.outcome_clearing_settings;
  v_prev_mode text := coalesce(current_setting('vireek.clearing_actor', true), '');
  v_job jsonb;
  v_rep jsonb;
  v_valid boolean;
  v_entries integer;
  v_head text;
  v_job_done boolean;
  v_test_passed boolean;
  v_ev_ratio numeric;
  v_meas_total integer := 0;
  v_after_any integer := 0;
  v_after_ok integer := 0;
  v_after_bad integer := 0;
  v_paired integer := 0;
  v_corr numeric := 0;
  v_meas_score numeric := 0;
  v_confirmed boolean;
  v_rating smallint;
  v_callback boolean;
  v_job_disputed boolean;
  v_cust_score numeric := 0;
  v_g_status text;
  v_dur_score numeric := 0;
  v_paid boolean;
  v_com_score numeric := 0;
  v_upheld boolean;
  v_open_dispute boolean;
  v_adverse boolean;
  v_result_proof boolean;
  v_conf numeric;
  v_conf_int integer;
  v_verdict text;
  v_old_status text;
  v_new_status text;
  v_verified_at timestamptz;
  v_window timestamptz;
  v_flags text[] := '{}';
  v_components jsonb;
  v_assessment jsonb;
  v_changed boolean;
BEGIN
  SELECT * INTO r FROM public.outcome_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  IF r.status IN ('settled', 'voided') THEN
    RETURN jsonb_build_object('record_id', r.id, 'status', r.status, 'confidence', r.confidence,
      'band', r.confidence_band, 'assessment', r.assessment, 'skipped', true);
  END IF;

  s := public.occ_settings(r.user_id);

  -- Job facts (to_jsonb: does not depend on exact column set)
  SELECT to_jsonb(j) INTO v_job FROM public.jobs j WHERE j.id = r.job_id;
  v_job_done := coalesce(v_job->>'job_status', '') = 'completed';
  v_job_disputed := coalesce((v_job->>'customer_disputed')::boolean, false);

  -- 1) Evidence chain (existing Job Evidence Chain)
  v_rep := public.job_evidence_chain_report(r.job_id);
  v_valid := coalesce((v_rep->'integrity'->>'valid')::boolean, true);
  v_entries := coalesce((v_rep->'integrity'->>'entries')::integer, 0);
  v_head := v_rep->'integrity'->>'head_hash';
  v_test_passed := coalesce((v_rep->'stats'->>'post_repair_test_passed')::boolean, false);
  v_ev_ratio := CASE WHEN v_entries = 0 THEN 0 ELSE coalesce((v_rep->>'score')::numeric, 0) / 100.0 END;

  -- 2) Measurements: the LATEST "after" reading per metric governs
  SELECT count(*) INTO v_meas_total FROM public.outcome_measurements WHERE record_id = r.id;

  WITH latest AS (
    SELECT DISTINCT ON (m.metric_key) m.metric_key, m.within_spec, m.source
    FROM public.outcome_measurements m
    WHERE m.record_id = r.id AND m.phase = 'after'
    ORDER BY m.metric_key, m.captured_at DESC, m.recorded_at DESC
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE within_spec IS TRUE),
    count(*) FILTER (WHERE within_spec IS FALSE),
    coalesce(max(CASE source
      WHEN 'telemetry' THEN 1.0 WHEN 'third_party' THEN 1.0 WHEN 'customer' THEN 0.8
      WHEN 'device' THEN 0.7 ELSE 0.4 END) FILTER (WHERE within_spec IS TRUE), 0)
  INTO v_after_any, v_after_ok, v_after_bad, v_corr
  FROM latest;

  SELECT count(*) INTO v_paired
  FROM (
    SELECT DISTINCT ON (m.metric_key) m.metric_key, m.within_spec
    FROM public.outcome_measurements m
    WHERE m.record_id = r.id AND m.phase = 'after'
    ORDER BY m.metric_key, m.captured_at DESC, m.recorded_at DESC
  ) l
  WHERE l.within_spec IS TRUE
    AND EXISTS (SELECT 1 FROM public.outcome_measurements b
                WHERE b.record_id = r.id AND b.phase = 'before' AND b.metric_key = l.metric_key);

  IF v_after_bad > 0 THEN
    v_meas_score := 0;
  ELSIF v_after_ok > 0 THEN
    v_meas_score := least(1, 0.55 + CASE WHEN v_paired > 0 THEN 0.20 ELSE 0 END + 0.25 * v_corr);
  ELSIF v_after_any > 0 THEN
    v_meas_score := 0.25; -- readings without an expected range prove little
  END IF;

  -- 3) Customer
  v_confirmed := r.customer_confirmed_at IS NOT NULL;
  SELECT jo.customer_rating, coalesce(jo.caused_callback, false)
  INTO v_rating, v_callback
  FROM public.job_outcomes jo WHERE jo.job_id = r.job_id;
  v_callback := coalesce(v_callback, false);
  v_cust_score := CASE
    WHEN v_job_disputed THEN 0
    WHEN v_confirmed THEN 1
    WHEN v_rating >= 4 THEN 0.8
    WHEN v_rating = 3 THEN 0.4
    ELSE 0 END;

  -- 4) Durability (existing Service Outcome Guarantee)
  SELECT sg.status INTO v_g_status FROM public.service_guarantees sg WHERE sg.job_id = r.job_id;
  v_dur_score := CASE coalesce(v_g_status, 'none')
    WHEN 'verified' THEN 1 WHEN 'expired' THEN 1 WHEN 'verifying' THEN 0.5 WHEN 'recovered' THEN 0.25 ELSE 0 END;
  IF v_callback THEN v_dur_score := 0; END IF;

  -- 5) Commercial signal: the customer paid
  v_paid := coalesce(v_job->>'invoice_status', '') = 'paid'
    OR EXISTS (SELECT 1 FROM public.payment_requests pr WHERE pr.job_id = r.job_id AND pr.status = 'paid');
  v_com_score := CASE WHEN v_paid THEN 1 ELSE 0 END;

  -- Adverse signals / hard checks
  v_upheld := EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'resolved_upheld');
  v_open_dispute := EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'open');
  v_adverse := v_after_bad > 0 OR v_job_disputed OR v_callback OR v_upheld
    OR coalesce(v_g_status, '') IN ('claim_open', 'recovering');
  v_result_proof := v_after_ok > 0 OR v_test_passed;

  IF v_entries = 0 THEN v_flags := array_append(v_flags, 'no_evidence'); END IF;
  IF NOT v_valid THEN v_flags := array_append(v_flags, 'evidence_chain_broken'); END IF;
  IF NOT v_job_done THEN v_flags := array_append(v_flags, 'job_not_completed'); END IF;
  IF NOT v_result_proof THEN v_flags := array_append(v_flags, 'no_result_proof'); END IF;
  IF v_after_bad > 0 THEN v_flags := array_append(v_flags, 'measurement_out_of_spec'); END IF;
  IF v_job_disputed THEN v_flags := array_append(v_flags, 'customer_disputed_job'); END IF;
  IF v_callback THEN v_flags := array_append(v_flags, 'callback_recorded'); END IF;
  IF v_upheld THEN v_flags := array_append(v_flags, 'dispute_upheld'); END IF;
  IF coalesce(v_g_status, '') IN ('claim_open', 'recovering') THEN v_flags := array_append(v_flags, 'guarantee_claim_open'); END IF;
  IF v_g_status IS NULL THEN v_flags := array_append(v_flags, 'no_durability_signal'); END IF;
  IF NOT v_confirmed AND v_rating IS NULL THEN v_flags := array_append(v_flags, 'no_customer_confirmation'); END IF;

  -- Confidence
  v_conf := 30 * v_ev_ratio + 25 * v_meas_score + 15 * v_cust_score + 20 * v_dur_score + 10 * v_com_score;
  IF NOT v_valid THEN
    v_conf := least(v_conf, 20);
  ELSIF v_adverse THEN
    v_conf := least(v_conf, 39);
  END IF;
  v_conf_int := greatest(0, least(100, round(v_conf)::integer));

  v_verdict := CASE
    WHEN NOT v_job_done THEN 'claimed'
    WHEN NOT v_valid OR v_adverse THEN 'unverified'
    WHEN v_result_proof AND v_conf_int >= s.min_release_confidence THEN 'verified'
    WHEN v_conf_int >= 40 THEN 'partially_verified'
    ELSE 'unverified'
  END;

  v_old_status := r.status;
  v_new_status := CASE WHEN r.status = 'disputed' THEN 'disputed' ELSE v_verdict END;

  v_verified_at := r.verified_at;
  v_window := r.dispute_window_ends_at;
  IF v_new_status = 'verified' AND r.verified_at IS NULL THEN
    v_verified_at := now();
    v_window := now() + make_interval(days => s.dispute_window_days);
  ELSIF v_new_status NOT IN ('verified', 'disputed') THEN
    v_verified_at := NULL;
    v_window := NULL;
  END IF;

  v_components := jsonb_build_array(
    jsonb_build_object('key', 'evidence', 'label', 'Evidence chain', 'weight', 30,
      'score', round(v_ev_ratio, 3), 'points', round(30 * v_ev_ratio, 1),
      'detail', format('Chain score %s, level %s, %s entries, hash chain %s',
        coalesce(v_rep->>'score', '0'), coalesce(v_rep->>'level', 'not_started'), v_entries,
        CASE WHEN v_valid THEN 'intact' ELSE 'BROKEN' END)),
    jsonb_build_object('key', 'measurements', 'label', 'Measurements', 'weight', 25,
      'score', round(v_meas_score, 3), 'points', round(25 * v_meas_score, 1),
      'detail', format('%s readings; latest after-readings: %s in spec, %s out of spec, %s paired with a before-reading',
        v_meas_total, v_after_ok, v_after_bad, v_paired)),
    jsonb_build_object('key', 'customer', 'label', 'Customer confirmation', 'weight', 15,
      'score', round(v_cust_score, 3), 'points', round(15 * v_cust_score, 1),
      'detail', CASE
        WHEN v_job_disputed THEN 'Customer disputed this job'
        WHEN v_confirmed THEN 'Confirmed by the customer through a verified link'
        WHEN v_rating IS NOT NULL THEN format('Customer rating %s of 5', v_rating)
        ELSE 'No customer confirmation yet' END),
    jsonb_build_object('key', 'durability', 'label', 'Durability', 'weight', 20,
      'score', round(v_dur_score, 3), 'points', round(20 * v_dur_score, 1),
      'detail', CASE
        WHEN v_callback THEN 'A callback was recorded for this job'
        WHEN v_g_status IS NULL THEN 'No outcome guarantee is tracking this job'
        ELSE format('Outcome guarantee status: %s', v_g_status) END),
    jsonb_build_object('key', 'commercial', 'label', 'Payment', 'weight', 10,
      'score', round(v_com_score, 3), 'points', round(10 * v_com_score, 1),
      'detail', CASE WHEN v_paid THEN 'Customer has paid' ELSE 'Not paid yet' END)
  );

  v_assessment := jsonb_build_object(
    'engine_version', 1,
    'components', v_components,
    'flags', to_jsonb(v_flags),
    'hard_checks', jsonb_build_object(
      'job_completed', v_job_done,
      'chain_intact', v_valid,
      'result_proof', v_result_proof,
      'no_adverse_signal', NOT v_adverse,
      'no_open_dispute', NOT v_open_dispute,
      'meets_threshold', v_conf_int >= s.min_release_confidence),
    'verdict', v_verdict,
    'threshold', s.min_release_confidence,
    'provenance', jsonb_build_object(
      'evidence_head_hash', v_head,
      'evidence_entries', v_entries,
      'measurements', v_meas_total,
      'measurement_sources', (SELECT coalesce(jsonb_agg(DISTINCT m.source), '[]'::jsonb)
                              FROM public.outcome_measurements m WHERE m.record_id = r.id),
      'guarantee_status', v_g_status),
    'assessed_at', now()
  );

  UPDATE public.outcome_records SET
    status = v_new_status,
    confidence = v_conf_int,
    confidence_band = public.occ_band(v_conf_int),
    assessment = v_assessment,
    assessed_at = now(),
    evidence_head_hash = v_head,
    evidence_entries = v_entries,
    verified_at = v_verified_at,
    dispute_window_ends_at = v_window,
    updated_at = now()
  WHERE id = r.id;

  v_changed := r.assessed_at IS NULL
    OR r.confidence <> v_conf_int
    OR r.status <> v_new_status
    OR r.evidence_head_hash IS DISTINCT FROM v_head;

  IF v_changed THEN
    -- Engine decisions are attributed to the engine, whoever triggered the recalculation.
    PERFORM set_config('vireek.clearing_actor', 'system', true);
    PERFORM public.occ_log(r.id, 'assessed', jsonb_build_object(
      'confidence', v_conf_int,
      'band', public.occ_band(v_conf_int),
      'status', v_new_status,
      'previous_status', v_old_status,
      'verdict', v_verdict,
      'engine_version', 1,
      'evidence_head_hash', v_head,
      'evidence_entries', v_entries,
      'measurements', v_meas_total,
      'flags', to_jsonb(v_flags),
      'assessment_sha256', encode(sha256(convert_to(v_components::text, 'UTF8')), 'hex')));
    IF v_new_status = 'verified' AND v_old_status <> 'verified' THEN
      PERFORM public.occ_log(r.id, 'verified', jsonb_build_object(
        'confidence', v_conf_int, 'dispute_window_ends_at', v_window));
    END IF;
    PERFORM set_config('vireek.clearing_actor', v_prev_mode, true);
  END IF;

  RETURN jsonb_build_object(
    'record_id', r.id, 'status', v_new_status, 'previous_status', v_old_status,
    'confidence', v_conf_int, 'band', public.occ_band(v_conf_int), 'assessment', v_assessment);
END;
$$;

CREATE OR REPLACE FUNCTION public.occ_open(p_job_id uuid, p_type text, p_claim text, p_opened_by uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_tech uuid;
  v_svc text;
  v_claim text;
  v_id uuid;
BEGIN
  SELECT j.user_id, j.assigned_technician_id, j.service_type
  INTO v_owner, v_tech, v_svc
  FROM public.jobs j WHERE j.id = p_job_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown job' USING ERRCODE = 'P0001';
  END IF;
  IF p_type NOT IN ('repair_restored', 'install_commissioned', 'maintenance_completed', 'inspection_completed', 'other') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown outcome type' USING ERRCODE = 'P0001';
  END IF;

  v_claim := left(coalesce(nullif(btrim(p_claim), ''), 'Outcome of ' || coalesce(nullif(btrim(v_svc), ''), 'service job')), 500);

  INSERT INTO public.outcome_records (user_id, job_id, technician_id, outcome_type, claim_statement, opened_by)
  VALUES (v_owner, p_job_id, v_tech, p_type, v_claim, p_opened_by)
  ON CONFLICT (job_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.outcome_records WHERE job_id = p_job_id;
    RETURN v_id;
  END IF;

  PERFORM public.occ_log(v_id, 'opened', jsonb_build_object(
    'job_id', p_job_id,
    'outcome_type', p_type,
    'claim_sha256', encode(sha256(convert_to(v_claim, 'UTF8')), 'hex')));
  PERFORM public.occ_assess(v_id);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.occ_add_measurement(
  p_record_id uuid, p_metric_key text, p_label text, p_unit text, p_phase text,
  p_value numeric, p_expected_min numeric, p_expected_max numeric,
  p_source text, p_device_ref text, p_captured_at timestamptz, p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_key text := lower(btrim(coalesce(p_metric_key, '')));
  v_at timestamptz := coalesce(p_captured_at, now());
  v_within boolean;
  v_id uuid;
  v_res jsonb;
BEGIN
  SELECT * INTO r FROM public.outcome_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  IF r.status IN ('settled', 'voided') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: record is % - readings can no longer be added', r.status USING ERRCODE = 'P0001';
  END IF;
  IF v_key !~ '^[a-z0-9_]{2,48}$' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: metric key must be 2-48 characters (a-z, 0-9, _)' USING ERRCODE = 'P0001';
  END IF;
  IF p_phase NOT IN ('before', 'after', 'monitor') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown phase' USING ERRCODE = 'P0001';
  END IF;
  IF p_value IS NULL OR p_value = 'NaN'::numeric THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: a numeric value is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_min IS NOT NULL AND p_expected_max IS NOT NULL AND p_expected_min > p_expected_max THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: expected minimum is above expected maximum' USING ERRCODE = 'P0001';
  END IF;
  IF p_source = 'device' AND coalesce(btrim(p_device_ref), '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: a device reading needs a device / instrument reference' USING ERRCODE = 'P0001';
  END IF;
  IF v_at > now() + interval '5 minutes' OR v_at < now() - interval '400 days' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: capture time is outside the allowed range' USING ERRCODE = 'P0001';
  END IF;

  v_within := CASE
    WHEN p_expected_min IS NULL AND p_expected_max IS NULL THEN NULL
    ELSE (p_expected_min IS NULL OR p_value >= p_expected_min) AND (p_expected_max IS NULL OR p_value <= p_expected_max)
  END;

  INSERT INTO public.outcome_measurements (
    user_id, record_id, metric_key, label, unit, phase, value, expected_min, expected_max,
    source, device_ref, captured_at, recorded_by, within_spec
  ) VALUES (
    r.user_id, r.id, v_key, left(btrim(p_label), 80), nullif(left(btrim(coalesce(p_unit, '')), 16), ''), p_phase,
    p_value, p_expected_min, p_expected_max, p_source, nullif(left(btrim(coalesce(p_device_ref, '')), 80), ''),
    v_at, p_actor, v_within
  ) RETURNING id INTO v_id;

  PERFORM public.occ_log(r.id, 'measurement_recorded', jsonb_build_object(
    'measurement_id', v_id, 'metric_key', v_key, 'phase', p_phase, 'value', p_value,
    'unit', nullif(btrim(coalesce(p_unit, '')), ''), 'expected_min', p_expected_min, 'expected_max', p_expected_max,
    'within_spec', v_within, 'source', p_source, 'device_ref', nullif(btrim(coalesce(p_device_ref, '')), ''),
    'captured_at', v_at));

  v_res := public.occ_assess(r.id);
  RETURN v_res || jsonb_build_object('measurement_id', v_id, 'within_spec', v_within);
END;
$$;

CREATE OR REPLACE FUNCTION public.occ_open_dispute(
  p_record_id uuid, p_by text, p_reason text, p_description text, p_reported_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_desc text := btrim(coalesce(p_description, ''));
  v_id uuid;
  v_held integer;
BEGIN
  SELECT * INTO r FROM public.outcome_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  IF r.status = 'voided' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: record is voided' USING ERRCODE = 'P0001';
  END IF;
  IF p_by NOT IN ('customer', 'staff', 'insurer') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown dispute source' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason NOT IN ('not_fixed', 'recurred', 'work_not_done', 'quality', 'overcharge', 'damage', 'other') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown reason' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_desc) NOT BETWEEN 5 AND 2000 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: describe the problem in 5-2000 characters' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'open') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_DISPUTE_OPEN: a dispute is already open on this outcome' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.outcome_disputes (user_id, record_id, opened_by_type, reported_by_user, reason_code, description)
  VALUES (r.user_id, r.id, p_by, p_reported_by, p_reason, v_desc)
  RETURNING id INTO v_id;

  UPDATE public.outcome_records
  SET status_before_dispute = r.status, status = 'disputed', updated_at = now()
  WHERE id = r.id;

  UPDATE public.outcome_settlements
  SET held_from = status, status = 'held', hold_reason = 'Dispute opened', updated_at = now()
  WHERE record_id = r.id AND status IN ('planned', 'cleared');
  GET DIAGNOSTICS v_held = ROW_COUNT;

  PERFORM public.occ_log(r.id, 'dispute_opened', jsonb_build_object(
    'dispute_id', v_id, 'opened_by', p_by, 'reason_code', p_reason,
    'description_sha256', encode(sha256(convert_to(v_desc, 'UTF8')), 'hex'),
    'held_legs', v_held, 'status_before', r.status));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.occ_settle(p_record_id uuid, p_override_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_note text := btrim(coalesce(p_override_note, ''));
  v_override boolean;
  v_legs integer := 0;
  n integer;
BEGIN
  v_override := char_length(v_note) >= 10;

  SELECT * INTO r FROM public.outcome_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: outcome record not found' USING ERRCODE = 'P0001';
  END IF;
  IF r.status = 'settled' THEN
    RETURN jsonb_build_object('record_id', r.id, 'status', 'settled', 'already_settled', true);
  END IF;
  IF r.status IN ('voided', 'disputed') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: record is %', r.status USING ERRCODE = 'P0001';
  END IF;

  -- Never settle on a stale confidence.
  PERFORM public.occ_assess(r.id);
  SELECT * INTO r FROM public.outcome_records WHERE id = p_record_id;

  IF r.status = 'verified' THEN
    NULL;
  ELSIF r.status = 'partially_verified' AND v_override THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: outcome is % (confidence %) - it must be verified first', r.status, r.confidence
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_override AND (r.dispute_window_ends_at IS NULL OR r.dispute_window_ends_at > now()) THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_WINDOW_OPEN: the dispute window is still open until %', r.dispute_window_ends_at
      USING ERRCODE = 'P0001';
  END IF;

  -- Payment legs
  INSERT INTO public.outcome_settlements (user_id, record_id, kind, leg_key, status, amount_cents, payment_request_id, cleared_at)
  SELECT r.user_id, r.id, 'payment', pr.id::text, 'cleared', greatest(0, round(pr.amount * 100))::bigint, pr.id, now()
  FROM public.payment_requests pr
  WHERE pr.job_id = r.job_id AND pr.status IN ('pending', 'sent', 'paid', 'overdue')
  ON CONFLICT (record_id, kind, leg_key) DO UPDATE SET
    status = CASE WHEN public.outcome_settlements.status = 'executed' THEN 'executed' ELSE 'cleared' END,
    held_from = NULL, hold_reason = NULL,
    cleared_at = coalesce(public.outcome_settlements.cleared_at, now()), updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT; v_legs := v_legs + n;

  -- Warranty leg (outcome guarantee coverage)
  INSERT INTO public.outcome_settlements (user_id, record_id, kind, leg_key, status, amount_cents, service_guarantee_id, cleared_at)
  SELECT r.user_id, r.id, 'warranty', sg.id::text, 'cleared', sg.coverage_cap_cents, sg.id, now()
  FROM public.service_guarantees sg
  WHERE sg.job_id = r.job_id AND sg.status <> 'voided'
  ON CONFLICT (record_id, kind, leg_key) DO UPDATE SET
    status = CASE WHEN public.outcome_settlements.status = 'executed' THEN 'executed' ELSE 'cleared' END,
    held_from = NULL, hold_reason = NULL,
    cleared_at = coalesce(public.outcome_settlements.cleared_at, now()), updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT; v_legs := v_legs + n;

  -- Insurance legs (evidence cleared for submission)
  INSERT INTO public.outcome_settlements (user_id, record_id, kind, leg_key, status, insurance_claim_id, cleared_at)
  SELECT r.user_id, r.id, 'insurance', ic.id::text, 'cleared', ic.id, now()
  FROM public.insurance_claims ic
  WHERE ic.job_id = r.job_id AND ic.status <> 'denied'
  ON CONFLICT (record_id, kind, leg_key) DO UPDATE SET
    status = CASE WHEN public.outcome_settlements.status = 'executed' THEN 'executed' ELSE 'cleared' END,
    held_from = NULL, hold_reason = NULL,
    cleared_at = coalesce(public.outcome_settlements.cleared_at, now()), updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT; v_legs := v_legs + n;

  UPDATE public.outcome_records
  SET status = 'settled', settled_at = now(),
      settle_override_note = CASE WHEN v_override THEN left(v_note, 500) ELSE NULL END,
      updated_at = now()
  WHERE id = r.id;

  PERFORM public.occ_log(r.id, 'settlement_cleared', jsonb_build_object(
    'legs', v_legs, 'confidence', r.confidence, 'override', v_override,
    'override_note_sha256', CASE WHEN v_override THEN encode(sha256(convert_to(v_note, 'UTF8')), 'hex') END,
    'evidence_head_hash', r.evidence_head_hash));

  RETURN jsonb_build_object('record_id', r.id, 'status', 'settled', 'legs', v_legs, 'override', v_override);
END;
$$;

REVOKE ALL ON FUNCTION public.occ_settings(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_log(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_load(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_lock_record(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_assess(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_open(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_add_measurement(uuid, text, text, text, text, numeric, numeric, numeric, text, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_open_dispute(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_settle(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_verify_chain(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_seal_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.occ_block_mutation() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. RPCs - staff (authenticated)
-- =============================================================
CREATE OR REPLACE FUNCTION public.outcome_clearing_open(
  p_job_id uuid,
  p_outcome_type text DEFAULT 'repair_restored',
  p_claim text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_account_owner_id() IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: sign in required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = public.get_account_owner_id()) THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: job not found' USING ERRCODE = 'P0001';
  END IF;
  RETURN public.occ_open(p_job_id, p_outcome_type, p_claim, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_assess_now(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  r := public.occ_lock_record(p_record_id);
  RETURN public.occ_assess(r.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_add_measurement(
  p_record_id uuid,
  p_metric_key text,
  p_label text,
  p_unit text,
  p_phase text,
  p_value numeric,
  p_expected_min numeric DEFAULT NULL,
  p_expected_max numeric DEFAULT NULL,
  p_source text DEFAULT 'technician',
  p_device_ref text DEFAULT NULL,
  p_captured_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  r := public.occ_lock_record(p_record_id);
  IF p_source NOT IN ('technician', 'device') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: staff can record technician or device readings only' USING ERRCODE = 'P0001';
  END IF;
  RETURN public.occ_add_measurement(r.id, p_metric_key, p_label, p_unit, p_phase, p_value,
    p_expected_min, p_expected_max, p_source, p_device_ref, p_captured_at, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_open_dispute(
  p_record_id uuid,
  p_reason text,
  p_description text,
  p_reported_by text DEFAULT 'staff'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  r := public.occ_lock_record(p_record_id);
  RETURN public.occ_open_dispute(r.id, p_reported_by, p_reason, p_description, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_resolve_dispute(
  p_dispute_id uuid,
  p_resolution text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.outcome_disputes;
  r public.outcome_records;
  v_note text := btrim(coalesce(p_note, ''));
  v_prev text;
  v_executed integer := 0;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can resolve disputes' USING ERRCODE = 'P0001';
  END IF;
  IF p_resolution NOT IN ('upheld', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown resolution' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_note) < 10 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: write a resolution note of at least 10 characters' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO d FROM public.outcome_disputes WHERE id = p_dispute_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: dispute not found' USING ERRCODE = 'P0001';
  END IF;

  r := public.occ_lock_record(d.record_id);
  SELECT * INTO d FROM public.outcome_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF d.status <> 'open' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: this dispute is already resolved' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.outcome_disputes
  SET status = CASE p_resolution WHEN 'upheld' THEN 'resolved_upheld' WHEN 'rejected' THEN 'resolved_rejected' ELSE 'withdrawn' END,
      resolution_note = left(v_note, 1000), resolved_at = now(), resolved_by = auth.uid()
  WHERE id = d.id;

  IF p_resolution = 'upheld' THEN
    UPDATE public.outcome_records
    SET status = 'unverified', status_before_dispute = NULL, verified_at = NULL, dispute_window_ends_at = NULL, updated_at = now()
    WHERE id = r.id;
    UPDATE public.outcome_settlements
    SET status = 'cancelled', hold_reason = 'Dispute upheld', updated_at = now()
    WHERE record_id = r.id AND status IN ('planned', 'cleared', 'held');
    SELECT count(*) INTO v_executed FROM public.outcome_settlements WHERE record_id = r.id AND status = 'executed';
  ELSE
    UPDATE public.outcome_settlements
    SET status = coalesce(held_from, 'cleared'), held_from = NULL, hold_reason = NULL, updated_at = now()
    WHERE record_id = r.id AND status = 'held';
    v_prev := coalesce(r.status_before_dispute, 'claimed');
    UPDATE public.outcome_records
    SET status = v_prev, status_before_dispute = NULL, updated_at = now()
    WHERE id = r.id;
  END IF;

  PERFORM public.occ_log(r.id, 'dispute_resolved', jsonb_build_object(
    'dispute_id', d.id, 'resolution', p_resolution,
    'note_sha256', encode(sha256(convert_to(v_note, 'UTF8')), 'hex'),
    'executed_legs_needing_review', v_executed));

  IF p_resolution <> 'upheld' AND v_prev <> 'settled' THEN
    PERFORM public.occ_assess(r.id);
  END IF;

  RETURN jsonb_build_object('record_id', r.id, 'resolution', p_resolution, 'executed_legs_needing_review', v_executed);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_settle(p_record_id uuid, p_override_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can settle' USING ERRCODE = 'P0001';
  END IF;
  r := public.occ_lock_record(p_record_id);
  RETURN public.occ_settle(r.id, p_override_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_execute_leg(p_leg_id uuid, p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.outcome_settlements;
  r public.outcome_records;
  v_ref text := btrim(coalesce(p_reference, ''));
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can execute settlement legs' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_ref) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: enter a reference (3-120 characters), e.g. invoice, payout or claim number' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO l FROM public.outcome_settlements WHERE id = p_leg_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: settlement leg not found' USING ERRCODE = 'P0001';
  END IF;

  r := public.occ_lock_record(l.record_id);
  SELECT * INTO l FROM public.outcome_settlements WHERE id = p_leg_id FOR UPDATE;
  IF r.status <> 'settled' OR l.status <> 'cleared' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: only cleared legs of a settled outcome can be executed (leg is %, outcome is %)', l.status, r.status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.outcome_settlements
  SET status = 'executed', executed_at = now(), executed_ref = v_ref, executed_by = auth.uid(), updated_at = now()
  WHERE id = l.id;

  PERFORM public.occ_log(r.id, 'settlement_executed', jsonb_build_object(
    'leg_id', l.id, 'kind', l.kind, 'amount_cents', l.amount_cents, 'reference', v_ref));
  RETURN jsonb_build_object('leg_id', l.id, 'status', 'executed');
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_void(p_record_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can void an outcome' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: write a reason of at least 10 characters' USING ERRCODE = 'P0001';
  END IF;
  r := public.occ_lock_record(p_record_id);
  IF r.status = 'voided' THEN
    RETURN jsonb_build_object('record_id', r.id, 'status', 'voided');
  END IF;
  IF EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'open') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: resolve the open dispute first' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.outcome_settlements s WHERE s.record_id = r.id AND s.status = 'executed') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: a settlement leg was already executed - an outcome with executed legs cannot be voided' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.outcome_settlements SET status = 'cancelled', hold_reason = 'Outcome voided', updated_at = now()
  WHERE record_id = r.id AND status IN ('planned', 'cleared', 'held');
  UPDATE public.outcome_records
  SET status = 'voided', void_reason = left(v_reason, 500), public_enabled = false, updated_at = now()
  WHERE id = r.id;

  PERFORM public.occ_log(r.id, 'voided', jsonb_build_object(
    'reason_sha256', encode(sha256(convert_to(v_reason, 'UTF8')), 'hex'), 'status_before', r.status));
  RETURN jsonb_build_object('record_id', r.id, 'status', 'voided');
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_set_public(p_record_id uuid, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can share an outcome' USING ERRCODE = 'P0001';
  END IF;
  r := public.occ_lock_record(p_record_id);
  IF r.status = 'voided' AND p_enabled THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: a voided outcome cannot be shared' USING ERRCODE = 'P0001';
  END IF;
  IF r.public_enabled IS DISTINCT FROM p_enabled THEN
    UPDATE public.outcome_records SET public_enabled = p_enabled, updated_at = now() WHERE id = r.id;
    PERFORM public.occ_log(r.id, 'public_link_changed', jsonb_build_object('public_enabled', p_enabled));
  END IF;
  RETURN jsonb_build_object('record_id', r.id, 'public_enabled', p_enabled);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_share_links(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can see share links' USING ERRCODE = 'P0001';
  END IF;
  r := public.occ_load(p_record_id);
  RETURN jsonb_build_object('public_enabled', r.public_enabled, 'verify_token', r.verify_token, 'customer_token', r.customer_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_rotate_tokens(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_verify text := public.occ_new_token();
  v_customer text := public.occ_new_token();
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can rotate share links' USING ERRCODE = 'P0001';
  END IF;
  r := public.occ_lock_record(p_record_id);
  UPDATE public.outcome_records SET verify_token = v_verify, customer_token = v_customer, updated_at = now() WHERE id = r.id;
  PERFORM public.occ_log(r.id, 'tokens_rotated', '{}'::jsonb);
  RETURN jsonb_build_object('public_enabled', r.public_enabled, 'verify_token', v_verify, 'customer_token', v_customer);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_save_settings(
  p_min_confidence integer,
  p_dispute_window_days integer,
  p_auto_settle boolean,
  p_auto_open boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: only owners, admins and billing managers can change clearing policy' USING ERRCODE = 'P0001';
  END IF;
  IF p_min_confidence NOT BETWEEN 50 AND 100 OR p_dispute_window_days NOT BETWEEN 0 AND 90 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: confidence must be 50-100 and the dispute window 0-90 days' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.outcome_clearing_settings (user_id, min_release_confidence, dispute_window_days, auto_settle, auto_open, updated_at)
  VALUES (v_owner, p_min_confidence, p_dispute_window_days, coalesce(p_auto_settle, false), coalesce(p_auto_open, false), now())
  ON CONFLICT (user_id) DO UPDATE SET
    min_release_confidence = EXCLUDED.min_release_confidence,
    dispute_window_days = EXCLUDED.dispute_window_days,
    auto_settle = EXCLUDED.auto_settle,
    auto_open = EXCLUDED.auto_open,
    updated_at = now();
END;
$$;

-- ---- Reads --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outcome_clearing_verify(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  r := public.occ_load(p_record_id);
  RETURN public.occ_verify_chain(r.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_overview(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_mgr boolean := public.identity_is_manager();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: sign in required' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'is_manager', v_mgr,
    'settings', to_jsonb(public.occ_settings(v_owner)),
    'totals', (
      SELECT jsonb_build_object(
        'records', count(*),
        'claimed', count(*) FILTER (WHERE o.status = 'claimed'),
        'verified', count(*) FILTER (WHERE o.status = 'verified'),
        'partially_verified', count(*) FILTER (WHERE o.status = 'partially_verified'),
        'unverified', count(*) FILTER (WHERE o.status = 'unverified'),
        'disputed', count(*) FILTER (WHERE o.status = 'disputed'),
        'settled', count(*) FILTER (WHERE o.status = 'settled'),
        'avg_confidence', round(avg(o.confidence) FILTER (WHERE o.status <> 'claimed')::numeric, 1))
      FROM public.outcome_records o WHERE o.user_id = v_owner AND o.status <> 'voided'),
    'money', CASE WHEN v_mgr THEN (
      SELECT jsonb_build_object(
        'cleared_cents', coalesce(sum(s.amount_cents) FILTER (WHERE s.kind = 'payment' AND s.status = 'cleared'), 0),
        'held_cents', coalesce(sum(s.amount_cents) FILTER (WHERE s.kind = 'payment' AND s.status = 'held'), 0),
        'executed_cents', coalesce(sum(s.amount_cents) FILTER (WHERE s.kind = 'payment' AND s.status = 'executed'), 0))
      FROM public.outcome_settlements s WHERE s.user_id = v_owner) END,
    'records', (
      SELECT coalesce(jsonb_agg(t.item ORDER BY t.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT o.created_at, jsonb_build_object(
          'id', o.id, 'job_id', o.job_id, 'status', o.status, 'confidence', o.confidence, 'band', o.confidence_band,
          'outcome_type', o.outcome_type, 'claim_statement', o.claim_statement,
          'verified_at', o.verified_at, 'dispute_window_ends_at', o.dispute_window_ends_at, 'settled_at', o.settled_at,
          'customer_confirmed', o.customer_confirmed_at IS NOT NULL, 'public_enabled', o.public_enabled,
          'open_dispute', EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = o.id AND d.status = 'open'),
          'customer_name', j.customer_name, 'service_type', j.service_type,
          'technician_name', tm.member_name, 'created_at', o.created_at) AS item
        FROM public.outcome_records o
        JOIN public.jobs j ON j.id = o.job_id
        LEFT JOIN public.team_members tm ON tm.id = o.technician_id
        WHERE o.user_id = v_owner
        ORDER BY o.created_at DESC
        LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
      ) t),
    'candidates', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'job_id', c.id, 'customer_name', c.customer_name, 'service_type', c.service_type, 'address', c.address,
        'completed_at', to_jsonb(c)->'completed_at', 'technician_name', tm.member_name) ORDER BY c.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT jj.* FROM public.jobs jj
        WHERE jj.user_id = v_owner AND jj.job_status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM public.outcome_records o WHERE o.job_id = jj.id)
        ORDER BY jj.created_at DESC LIMIT 25
      ) c
      LEFT JOIN public.team_members tm ON tm.id = c.assigned_technician_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_record_detail(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_mgr boolean := public.identity_is_manager();
BEGIN
  r := public.occ_load(p_record_id);

  RETURN jsonb_build_object(
    'is_manager', v_mgr,
    'record', to_jsonb(r) - 'verify_token' - 'customer_token',
    'job', (
      SELECT jsonb_build_object(
        'id', j.id, 'customer_name', j.customer_name, 'service_type', j.service_type, 'address', j.address,
        'job_status', j.job_status, 'completed_at', to_jsonb(j)->'completed_at',
        'invoice_amount', CASE WHEN v_mgr THEN j.invoice_amount END, 'technician_name', tm.member_name)
      FROM public.jobs j LEFT JOIN public.team_members tm ON tm.id = j.assigned_technician_id
      WHERE j.id = r.job_id),
    'chain', public.occ_verify_chain(r.id),
    'events', (
      SELECT coalesce(jsonb_agg(to_jsonb(e) - 'user_id' ORDER BY e.seq), '[]'::jsonb)
      FROM (SELECT * FROM public.outcome_clearing_events WHERE record_id = r.id ORDER BY seq DESC LIMIT 500) e),
    'measurements', (
      SELECT coalesce(jsonb_agg(to_jsonb(m) - 'user_id' ORDER BY m.captured_at DESC), '[]'::jsonb)
      FROM public.outcome_measurements m WHERE m.record_id = r.id),
    'disputes', (
      SELECT coalesce(jsonb_agg(to_jsonb(d) - 'user_id' ORDER BY d.opened_at DESC), '[]'::jsonb)
      FROM public.outcome_disputes d WHERE d.record_id = r.id),
    'settlements', CASE WHEN v_mgr THEN (
      SELECT coalesce(jsonb_agg(to_jsonb(s) - 'user_id' ORDER BY s.created_at), '[]'::jsonb)
      FROM public.outcome_settlements s WHERE s.record_id = r.id) ELSE '[]'::jsonb END
  );
END;
$$;

-- Reputation: confidence-weighted, Bayesian-shrunk toward 60 (prior of 5 outcomes), minus upheld disputes.
CREATE OR REPLACE FUNCTION public.outcome_clearing_reputation()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_mgr boolean := public.identity_is_manager();
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_FORBIDDEN: sign in required' USING ERRCODE = 'P0001';
  END IF;

  RETURN (
    WITH base AS (
      SELECT o.technician_id, o.confidence, o.status,
        EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = o.id AND d.status = 'resolved_upheld') AS upheld,
        EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = o.id) AS any_dispute
      FROM public.outcome_records o
      WHERE o.user_id = v_owner AND o.status NOT IN ('claimed', 'voided')
        AND (v_mgr OR o.technician_id IS NOT DISTINCT FROM v_me)
    ), agg AS (
      SELECT technician_id,
        count(*) AS n,
        count(*) FILTER (WHERE status IN ('verified', 'settled')) AS verified,
        sum(confidence)::numeric AS sum_conf,
        count(*) FILTER (WHERE upheld) AS upheld,
        count(*) FILTER (WHERE any_dispute) AS disputed
      FROM base GROUP BY technician_id
    ), scored AS (
      SELECT a.*, greatest(0, round(((a.sum_conf + 5 * 60) / (a.n + 5)) - (50.0 * a.upheld / (a.n + 5))))::integer AS score
      FROM agg a
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'team_member_id', s.technician_id,
      'name', coalesce(tm.member_name, 'Unassigned'),
      'outcomes', s.n,
      'verified', s.verified,
      'verified_rate', round(s.verified::numeric / s.n, 3),
      'avg_confidence', round(s.sum_conf / s.n, 1),
      'disputes', s.disputed,
      'disputes_upheld', s.upheld,
      'score', s.score,
      'provisional', s.n < 5) ORDER BY s.score DESC, s.n DESC), '[]'::jsonb)
    FROM scored s LEFT JOIN public.team_members tm ON tm.id = s.technician_id
  );
END;
$$;

-- =============================================================
-- 6. RPCs - public (token only, no personal data)
-- =============================================================
CREATE OR REPLACE FUNCTION public.outcome_clearing_public_view(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
  v_role text;
  v_open boolean;
  v_company text;
  v_completed text;
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 32 AND 128 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO r FROM public.outcome_records
  WHERE (verify_token = p_token OR customer_token = p_token) AND public_enabled = true;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_role := CASE WHEN r.customer_token = p_token THEN 'customer' ELSE 'verifier' END;
  v_open := EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'open');
  SELECT p.company_name INTO v_company FROM public.profiles p WHERE p.id = r.user_id;
  SELECT left(to_jsonb(j)->>'completed_at', 10) INTO v_completed FROM public.jobs j WHERE j.id = r.job_id;

  RETURN jsonb_build_object(
    'role', v_role,
    'business_name', v_company,
    'outcome_type', r.outcome_type,
    'claim_statement', r.claim_statement,
    'status', r.status,
    'confidence', r.confidence,
    'band', r.confidence_band,
    'completed_on', v_completed,
    'verified_at', r.verified_at,
    'settled_at', r.settled_at,
    'customer_confirmed', r.customer_confirmed_at IS NOT NULL,
    'open_dispute', v_open,
    'can_respond', v_role = 'customer' AND r.status <> 'voided' AND NOT v_open AND r.customer_confirmed_at IS NULL,
    'can_dispute', v_role = 'customer' AND r.status <> 'voided' AND NOT v_open
      AND (SELECT count(*) FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.opened_by_type = 'customer') < 3,
    'components', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'key', c->>'key', 'label', c->>'label', 'weight', c->'weight', 'points', c->'points')), '[]'::jsonb)
      FROM jsonb_array_elements(coalesce(r.assessment->'components', '[]'::jsonb)) c),
    'measurements', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'label', m.label, 'phase', m.phase, 'value', m.value, 'unit', m.unit,
        'expected_min', m.expected_min, 'expected_max', m.expected_max, 'within_spec', m.within_spec,
        'source', m.source, 'captured_at', m.captured_at) ORDER BY m.label, m.phase), '[]'::jsonb)
      FROM (SELECT DISTINCT ON (x.metric_key, x.phase) x.*
            FROM public.outcome_measurements x WHERE x.record_id = r.id
            ORDER BY x.metric_key, x.phase, x.captured_at DESC, x.recorded_at DESC) m),
    'proof', jsonb_build_object(
      'ledger', public.occ_verify_chain(r.id),
      'evidence_head_hash', r.evidence_head_hash,
      'evidence_entries', r.evidence_entries,
      'assessed_at', r.assessed_at),
    'generated_at', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_public_respond(
  p_token text,
  p_action text,
  p_reason text DEFAULT NULL,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.outcome_records;
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 32 AND 128 THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: this link is not valid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM public.outcome_records
  WHERE customer_token = p_token AND public_enabled = true
  FOR UPDATE;
  IF NOT FOUND OR r.status = 'voided' THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_NOT_FOUND: this link is not valid' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'confirm' THEN
    IF EXISTS (SELECT 1 FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.status = 'open') THEN
      RAISE EXCEPTION 'OUTCOME_CLEARING_DISPUTE_OPEN: a dispute is open - it must be resolved first' USING ERRCODE = 'P0001';
    END IF;
    IF r.customer_confirmed_at IS NULL THEN
      PERFORM set_config('vireek.clearing_actor', 'customer', true);
      UPDATE public.outcome_records SET customer_confirmed_at = now(), updated_at = now() WHERE id = r.id;
      PERFORM public.occ_log(r.id, 'customer_confirmed', jsonb_build_object('via', 'customer_link'));
      PERFORM set_config('vireek.clearing_actor', 'system', true);
      PERFORM public.occ_assess(r.id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'confirm');

  ELSIF p_action = 'dispute' THEN
    IF (SELECT count(*) FROM public.outcome_disputes d WHERE d.record_id = r.id AND d.opened_by_type = 'customer') >= 3 THEN
      RAISE EXCEPTION 'OUTCOME_CLEARING_BLOCKED: the dispute limit for this outcome was reached - please contact the business' USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('vireek.clearing_actor', 'customer', true);
    PERFORM public.occ_open_dispute(r.id, 'customer', coalesce(p_reason, ''), coalesce(p_description, ''), NULL);
    PERFORM set_config('vireek.clearing_actor', 'system', true);
    RETURN jsonb_build_object('ok', true, 'action', 'dispute');
  END IF;

  RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: unknown action' USING ERRCODE = 'P0001';
END;
$$;

-- =============================================================
-- 7. RPCs - service role (cron + ingest)
-- =============================================================
CREATE OR REPLACE FUNCTION public.outcome_clearing_ingest_measurement(
  p_record_id uuid,
  p_metric_key text,
  p_label text,
  p_unit text,
  p_phase text,
  p_value numeric,
  p_expected_min numeric DEFAULT NULL,
  p_expected_max numeric DEFAULT NULL,
  p_source text DEFAULT 'telemetry',
  p_device_ref text DEFAULT NULL,
  p_captured_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_source NOT IN ('telemetry', 'third_party', 'device') THEN
    RAISE EXCEPTION 'OUTCOME_CLEARING_INVALID: ingest sources are telemetry, third_party or device' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('vireek.clearing_actor', 'external', true);
  RETURN public.occ_add_measurement(p_record_id, p_metric_key, p_label, p_unit, p_phase, p_value,
    p_expected_min, p_expected_max, p_source, p_device_ref, p_captured_at, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.outcome_clearing_sweep(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_opened integer := 0;
  v_assessed integer := 0;
  v_settled integer := 0;
  v_errors integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 1000));
BEGIN
  PERFORM set_config('vireek.clearing_actor', 'system', true);

  -- 1) Auto-open records for recently completed jobs (opt-in per account)
  FOR rec IN
    SELECT j.id FROM public.jobs j
    JOIN public.outcome_clearing_settings cs ON cs.user_id = j.user_id AND cs.auto_open
    WHERE j.job_status = 'completed'
      AND coalesce((to_jsonb(j)->>'completed_at')::timestamptz, j.created_at) > now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM public.outcome_records o WHERE o.job_id = j.id)
    LIMIT v_limit
  LOOP
    BEGIN
      PERFORM public.occ_open(rec.id, 'repair_restored', NULL, NULL);
      v_opened := v_opened + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
    END;
  END LOOP;

  -- 2) Refresh open records (durability, payments and evidence change over time)
  FOR rec IN
    SELECT o.id FROM public.outcome_records o
    WHERE o.status IN ('claimed', 'verified', 'partially_verified', 'unverified', 'disputed')
      AND (o.assessed_at IS NULL OR o.assessed_at < now() - interval '6 hours')
    ORDER BY o.assessed_at NULLS FIRST
    LIMIT v_limit
  LOOP
    BEGIN
      PERFORM public.occ_assess(rec.id);
      v_assessed := v_assessed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
    END;
  END LOOP;

  -- 3) Auto-settle verified outcomes whose dispute window has passed (opt-in per account)
  FOR rec IN
    SELECT o.id FROM public.outcome_records o
    JOIN public.outcome_clearing_settings cs ON cs.user_id = o.user_id AND cs.auto_settle
    WHERE o.status = 'verified' AND o.dispute_window_ends_at IS NOT NULL AND o.dispute_window_ends_at <= now()
    LIMIT v_limit
  LOOP
    BEGIN
      PERFORM public.occ_settle(rec.id, NULL);
      v_settled := v_settled + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('opened', v_opened, 'assessed', v_assessed, 'settled', v_settled, 'errors', v_errors);
END;
$$;

-- =============================================================
-- 8. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.outcome_clearing_open(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_assess_now(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_add_measurement(uuid, text, text, text, text, numeric, numeric, numeric, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_open_dispute(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_resolve_dispute(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_settle(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_execute_leg(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_void(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_set_public(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_share_links(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_rotate_tokens(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_save_settings(integer, integer, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_verify(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_overview(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_record_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_clearing_reputation() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.outcome_clearing_open(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_assess_now(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_add_measurement(uuid, text, text, text, text, numeric, numeric, numeric, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_open_dispute(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_resolve_dispute(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_settle(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_execute_leg(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_void(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_set_public(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_share_links(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_rotate_tokens(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_save_settings(integer, integer, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_verify(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_overview(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_record_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_reputation() TO authenticated;

REVOKE ALL ON FUNCTION public.outcome_clearing_public_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outcome_clearing_public_respond(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_public_view(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_public_respond(text, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.outcome_clearing_ingest_measurement(uuid, text, text, text, text, numeric, numeric, numeric, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outcome_clearing_sweep(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_ingest_measurement(uuid, text, text, text, text, numeric, numeric, numeric, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.outcome_clearing_sweep(integer) TO service_role;

COMMENT ON TABLE public.outcome_records IS 'Verifiable outcome record per job: server-computed status + confidence, provenance, settlement gate.';
COMMENT ON TABLE public.outcome_clearing_events IS 'Append-only SHA-256 hash-chained audit ledger per outcome record. Stores hashes of free text, never the text.';
COMMENT ON TABLE public.outcome_measurements IS 'Append-only before/after/monitor readings with expected range and server-computed within_spec.';
