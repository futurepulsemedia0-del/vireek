/*
  # Repair Outcome Ledger — SHADOW MODE (records and analyses only)

  ## Hypothesis under test (verbatim, also in docs/ledger/README.md)
  "Reliability-weighted repair labels (root cause + part + delayed outcome), using randomized dispatch as an
  unconfounded validation subset, predict first-visit success better than naive labels and better than a
  technician's own baseline."  It may be false. The answer "no" is a valid result.

  ## What this adds
  1. repair_ledger_settings / repair_ledger_secrets   per-account flag (default OFF) and a service-only pseudonym salt
  2. repair_root_cause_taxonomy                        versioned, per trade, hierarchical; unknown / multiple / no_fault_found
  3. repair_cases                                      one row per completed job that a technician classified
  4. repair_outcomes                                   delayed outcome per 14/30/60-day window, right-censored
  5. repair_labels                                     derived, versioned labels (written by the analysis pipeline)
  6. RPCs: repair_ledger_set_enabled, repair_ledger_record_case, repair_ledger_quality   (authenticated)
           repair_ledger_refresh_outcomes, repair_ledger_pseudonym                       (service_role only)
           repair_ledger_pooled_rates                                                    (consent-gated, suppressed)

  ## Guarantees enforced IN THE DATABASE (not only in app code)
  * Tenant isolation: user_id = get_account_owner_id() on every table; clients cannot INSERT/UPDATE/DELETE
    ledger tables directly (only the RPCs above, which re-check ownership).
  * No PII: no names, phones, emails, addresses, prices, notes or free text. Every text column is a code
    matching a strict regex. Technicians appear only as a salted HMAC pseudonym; the salt is unreadable by clients.
  * Censoring is never success: a 'none_observed' outcome with censored = false is rejected by trigger unless
    observed_until covers the whole window; a 'first_visit_success' label is rejected by trigger unless an
    uncensored 'none_observed' outcome exists for the same case and window.
  * Shadow mode: nothing here is read by dispatch, quoting, remote resolution or any customer-facing path. It
    touches no existing table, trigger or policy. The existing jobs.rework trigger is NOT modified.
  * Pooling: only through repair_ledger_pooled_rates(), consent-gated (xtl_contributes) and suppressed.

  ## Known limits (see docs/_audit/ledger-recon.md)
  * "Observable until" is an ACCOUNT-level activity watermark (latest job created in the account). It is not
    proof that a given customer stayed reachable; a stricter per-customer signal can replace it later.
  * "Same problem" requires the same link key (equipment, else site, else customer; salted hash) AND at least
    one shared symptom code. Anything else that the rework trigger links is recorded as repeat_visit_other.

  ## [HUMAN SIGN-OFF] required before any cross-tenant read is enabled
  repair_ledger_pool_min_tenants() = 5, repair_ledger_pool_min_cases() = 20, repair_ledger_pool_max_tenant_share() = 0.5,
  count rounding = down to a multiple of 5, rate rounding = nearest 0.05.
  The flow is registered with sde_domain = NULL, so NOTHING is pooled until counsel maps it:
      UPDATE cross_tenant_flows SET sde_domain = 'outcomes' WHERE flow_key = 'repair_ledger';   -- [COUNSEL]

  ## Rollback (children first; ledger data is derived and may be dropped, jobs are untouched)
  -- rollback: DROP FUNCTION IF EXISTS public.repair_ledger_pooled_rates(text); DROP FUNCTION IF EXISTS public.repair_ledger_refresh_outcomes(uuid, timestamptz, integer); DROP FUNCTION IF EXISTS public.repair_ledger_quality(integer); DROP FUNCTION IF EXISTS public.repair_ledger_record_case(uuid, text, text, text, text, text, text, jsonb, text[], text[]); DROP FUNCTION IF EXISTS public.repair_ledger_set_enabled(boolean); DROP TABLE IF EXISTS public.repair_labels, public.repair_outcomes, public.repair_cases, public.repair_root_cause_taxonomy, public.repair_ledger_secrets, public.repair_ledger_settings CASCADE; DELETE FROM public.cross_tenant_flows WHERE flow_key = 'repair_ledger'; then drop the remaining repair_ledger_* helper functions.
*/
-- =============================================================
-- 0. Pure helpers (IMMUTABLE, no table access)
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_codes_ok(p_arr text[], p_pattern text, p_max integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_arr IS NOT NULL
     AND coalesce(cardinality(p_arr), 0) <= p_max
     AND NOT EXISTS (SELECT 1 FROM unnest(p_arr) AS e WHERE e IS NULL OR e !~ p_pattern);
$$;

CREATE OR REPLACE FUNCTION public.repair_ledger_pool_min_tenants() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 5 $$;          -- [HUMAN SIGN-OFF]
CREATE OR REPLACE FUNCTION public.repair_ledger_pool_min_cases() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 20 $$;           -- [HUMAN SIGN-OFF]
CREATE OR REPLACE FUNCTION public.repair_ledger_pool_max_tenant_share() RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 0.5 $$;   -- [HUMAN SIGN-OFF]

-- =============================================================
-- 1. Settings (flag, default OFF) and secrets (service only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.repair_ledger_settings (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  capture_enabled boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid DEFAULT auth.uid()
);
ALTER TABLE public.repair_ledger_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_ledger_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.repair_ledger_settings TO authenticated;

CREATE TABLE IF NOT EXISTS public.repair_ledger_secrets (
  user_id        uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pseudonym_salt text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.repair_ledger_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_ledger_secrets FROM PUBLIC, anon, authenticated;
-- No policy and no grant: only SECURITY DEFINER code (and service_role) can read the salt.

-- =============================================================
-- 2. Taxonomy (global reference data, versioned, per trade, hierarchical)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.repair_root_cause_taxonomy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version       integer NOT NULL CHECK (version >= 1),
  trade         text NOT NULL CHECK (trade ~ '^[a-z_*]{1,32}$'),           -- '*' = applies to every trade
  code          text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,64}$'),
  parent_code   text CHECK (parent_code IS NULL OR parent_code ~ '^[a-z0-9_]{2,64}$'),
  kind          text NOT NULL DEFAULT 'cause' CHECK (kind IN ('cause', 'unknown', 'multiple', 'no_fault_found')),
  label_key     text NOT NULL CHECK (char_length(label_key) BETWEEN 3 AND 120),
  label_default text NOT NULL CHECK (char_length(label_default) BETWEEN 1 AND 120),
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, trade, code),
  CONSTRAINT repair_taxonomy_not_own_parent CHECK (parent_code IS DISTINCT FROM code),
  CONSTRAINT repair_taxonomy_parent_fk FOREIGN KEY (version, trade, parent_code)
    REFERENCES public.repair_root_cause_taxonomy (version, trade, code)
);
ALTER TABLE public.repair_root_cause_taxonomy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_root_cause_taxonomy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.repair_root_cause_taxonomy TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repair_root_cause_taxonomy' AND policyname = 'repair_taxonomy_read') THEN
    CREATE POLICY repair_taxonomy_read ON public.repair_root_cause_taxonomy FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Starter v1. [DOMAIN REVIEW] by a licensed practitioner per trade before real use; bump `version` for any change.
INSERT INTO public.repair_root_cause_taxonomy (version, trade, code, parent_code, kind, label_key, label_default, sort_order) VALUES
  (1, '*', 'unknown',        NULL, 'unknown',        'ledger.cause.unknown',        'Not sure',                 900),
  (1, '*', 'multiple',       NULL, 'multiple',       'ledger.cause.multiple',       'More than one cause',      910),
  (1, '*', 'no_fault_found', NULL, 'no_fault_found', 'ledger.cause.no_fault_found', 'No fault found',          920),
  (1, 'hvac', 'refrigeration_system',  NULL, 'cause', 'ledger.cause.hvac.refrigeration_system',  'Refrigeration system',  10),
  (1, 'hvac', 'electrical_components', NULL, 'cause', 'ledger.cause.hvac.electrical_components', 'Electrical components', 20),
  (1, 'hvac', 'airflow',               NULL, 'cause', 'ledger.cause.hvac.airflow',               'Airflow',               30),
  (1, 'plumbing', 'supply_side',  NULL, 'cause', 'ledger.cause.plumbing.supply_side',  'Supply side',  10),
  (1, 'plumbing', 'drain_side',   NULL, 'cause', 'ledger.cause.plumbing.drain_side',   'Drain side',   20),
  (1, 'plumbing', 'fixtures',     NULL, 'cause', 'ledger.cause.plumbing.fixtures',     'Fixtures',     30),
  (1, 'electrical', 'protection',  NULL, 'cause', 'ledger.cause.electrical.protection',  'Protection devices', 10),
  (1, 'electrical', 'wiring',      NULL, 'cause', 'ledger.cause.electrical.wiring',      'Wiring',             20),
  (1, 'electrical', 'devices',     NULL, 'cause', 'ledger.cause.electrical.devices',     'Devices and fixtures', 30)
ON CONFLICT (version, trade, code) DO NOTHING;

INSERT INTO public.repair_root_cause_taxonomy (version, trade, code, parent_code, kind, label_key, label_default, sort_order) VALUES
  (1, 'hvac', 'refrigerant_leak',   'refrigeration_system',  'cause', 'ledger.cause.hvac.refrigerant_leak',   'Refrigerant leak',   11),
  (1, 'hvac', 'compressor_failure', 'refrigeration_system',  'cause', 'ledger.cause.hvac.compressor_failure', 'Compressor failure', 12),
  (1, 'hvac', 'capacitor_failure',  'electrical_components', 'cause', 'ledger.cause.hvac.capacitor_failure',  'Capacitor failure',  21),
  (1, 'hvac', 'control_board_fault','electrical_components', 'cause', 'ledger.cause.hvac.control_board_fault','Control board fault',22),
  (1, 'hvac', 'airflow_restriction','airflow',               'cause', 'ledger.cause.hvac.airflow_restriction','Airflow restriction',31),
  (1, 'plumbing', 'fitting_leak',    'supply_side', 'cause', 'ledger.cause.plumbing.fitting_leak',    'Fitting leak',    11),
  (1, 'plumbing', 'valve_failure',   'supply_side', 'cause', 'ledger.cause.plumbing.valve_failure',   'Valve failure',   12),
  (1, 'plumbing', 'drain_blockage',  'drain_side',  'cause', 'ledger.cause.plumbing.drain_blockage',  'Drain blockage',  21),
  (1, 'plumbing', 'fixture_failure', 'fixtures',    'cause', 'ledger.cause.plumbing.fixture_failure', 'Fixture failure', 31),
  (1, 'electrical', 'breaker_fault',    'protection', 'cause', 'ledger.cause.electrical.breaker_fault',    'Breaker fault',    11),
  (1, 'electrical', 'loose_connection', 'wiring',     'cause', 'ledger.cause.electrical.loose_connection', 'Loose connection', 21),
  (1, 'electrical', 'wiring_damage',    'wiring',     'cause', 'ledger.cause.electrical.wiring_damage',    'Wiring damage',    22),
  (1, 'electrical', 'device_failure',   'devices',    'cause', 'ledger.cause.electrical.device_failure',   'Device failure',   31)
ON CONFLICT (version, trade, code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.repair_ledger_current_taxonomy_version()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$ SELECT coalesce(max(version), 1) FROM public.repair_root_cause_taxonomy WHERE is_active $$;

-- =============================================================
-- 3. repair_cases
-- =============================================================
CREATE TABLE IF NOT EXISTS public.repair_cases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id                   uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  trade                    text NOT NULL CHECK (trade ~ '^[a-z_]{2,32}$'),
  equipment_type           text CHECK (equipment_type IS NULL OR equipment_type ~ '^[a-z0-9][a-z0-9 ._/-]{0,59}$'),
  equipment_make           text CHECK (equipment_make IS NULL OR equipment_make ~ '^[a-z0-9][a-z0-9 ._/-]{0,59}$'),
  equipment_model          text CHECK (equipment_model IS NULL OR equipment_model ~ '^[a-z0-9][a-z0-9 ._/-]{0,59}$'),
  equipment_age_band       text NOT NULL DEFAULT 'unknown' CHECK (equipment_age_band IN ('lt_2y', '2_5y', '5_10y', '10_15y', 'gt_15y', 'unknown')),
  symptom_codes            jsonb NOT NULL DEFAULT '[]'::jsonb
                             CHECK (jsonb_typeof(symptom_codes) = 'array' AND jsonb_array_length(symptom_codes) <= 12),
  taxonomy_version         integer NOT NULL CHECK (taxonomy_version >= 1),
  claimed_root_cause_id    uuid NOT NULL REFERENCES public.repair_root_cause_taxonomy(id),
  claim_kind               text NOT NULL CHECK (claim_kind IN ('cause', 'unknown', 'multiple', 'no_fault_found')),
  parts_replaced           text[] NOT NULL DEFAULT '{}'
                             CHECK (public.repair_ledger_codes_ok(parts_replaced, '^[a-z0-9_]{1,48}$', 30)),
  evidence_digest_refs     text[] NOT NULL DEFAULT '{}'
                             CHECK (public.repair_ledger_codes_ok(evidence_digest_refs, '^[0-9a-f]{64}$', 20)),
  technician_pseudonym     text NOT NULL CHECK (technician_pseudonym ~ '^[0-9a-f]{24}$'),
  problem_link_key         text CHECK (problem_link_key IS NULL OR problem_link_key ~ '^[0-9a-f]{24}$'),
  link_scope               text CHECK (link_scope IS NULL OR link_scope IN ('equipment', 'site', 'customer')),
  assignment_decision_id   uuid REFERENCES public.dispatch_decisions(id) ON DELETE SET NULL,
  assignment_arm           text CHECK (assignment_arm IS NULL OR assignment_arm IN ('explore', 'exploit')),
  assignment_propensity    numeric CHECK (assignment_propensity IS NULL OR (assignment_propensity > 0 AND assignment_propensity <= 1)),
  completed_at             timestamptz NOT NULL,
  capture_source           text NOT NULL DEFAULT 'technician_app' CHECK (capture_source IN ('technician_app', 'import', 'backfill')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repair_cases_link_pair CHECK ((problem_link_key IS NULL) = (link_scope IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_repair_cases_user_completed ON public.repair_cases (user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_repair_cases_link ON public.repair_cases (user_id, problem_link_key) WHERE problem_link_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repair_cases_tech ON public.repair_cases (user_id, technician_pseudonym);
CREATE INDEX IF NOT EXISTS idx_repair_cases_decision ON public.repair_cases (assignment_decision_id) WHERE assignment_decision_id IS NOT NULL;

ALTER TABLE public.repair_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_cases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.repair_cases TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repair_cases' AND policyname = 'repair_cases_select') THEN
    CREATE POLICY repair_cases_select ON public.repair_cases FOR SELECT TO authenticated
      USING (user_id = (SELECT public.get_account_owner_id()));
  END IF;
END $$;

-- Append-only for every role: a case is what the technician said at completion time.
CREATE OR REPLACE FUNCTION public.repair_cases_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'repair_cases is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_repair_cases_append_only ON public.repair_cases;
CREATE TRIGGER trg_repair_cases_append_only BEFORE UPDATE ON public.repair_cases
  FOR EACH ROW EXECUTE FUNCTION public.repair_cases_append_only();

-- =============================================================
-- 4. repair_outcomes (right-censored)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.repair_outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  case_id         uuid NOT NULL REFERENCES public.repair_cases(id) ON DELETE CASCADE,
  window_days     integer NOT NULL CHECK (window_days IN (14, 30, 60)),
  event           text NOT NULL CHECK (event IN ('repeat_visit_same_problem', 'repeat_visit_other', 'none_observed')),
  censored        boolean NOT NULL,
  observed_until  timestamptz NOT NULL,
  link_basis      text NOT NULL CHECK (link_basis IN ('none', 'rework_trigger_only', 'symptom_match')),
  repeat_job_id   uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, window_days),
  -- censored means "nothing seen YET": it can only describe the absence of an event.
  CONSTRAINT repair_outcomes_censored_means_none CHECK (NOT censored OR event = 'none_observed'),
  CONSTRAINT repair_outcomes_basis_matches_event CHECK (
    (event = 'none_observed' AND link_basis = 'none')
    OR (event = 'repeat_visit_same_problem' AND link_basis = 'symptom_match')
    OR (event = 'repeat_visit_other' AND link_basis IN ('rework_trigger_only', 'symptom_match'))
  )
);
CREATE INDEX IF NOT EXISTS idx_repair_outcomes_user_case ON public.repair_outcomes (user_id, case_id);
CREATE INDEX IF NOT EXISTS idx_repair_outcomes_open ON public.repair_outcomes (user_id, window_days) WHERE censored;

ALTER TABLE public.repair_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.repair_outcomes TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repair_outcomes' AND policyname = 'repair_outcomes_select') THEN
    CREATE POLICY repair_outcomes_select ON public.repair_outcomes FOR SELECT TO authenticated
      USING (user_id = (SELECT public.get_account_owner_id()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.repair_outcomes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_case_user uuid;
  v_completed timestamptz;
BEGIN
  SELECT user_id, completed_at INTO v_case_user, v_completed FROM public.repair_cases WHERE id = NEW.case_id;
  IF v_case_user IS NULL OR v_case_user <> NEW.user_id THEN
    RAISE EXCEPTION 'repair_outcomes: case does not belong to this account' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.censored = false THEN
    RAISE EXCEPTION 'repair_outcomes: a final (uncensored) outcome is immutable' USING ERRCODE = '55000';
  END IF;
  -- Censoring is never converted to success: "no event" is final only if the whole window was observed.
  IF NEW.event = 'none_observed' AND NEW.censored = false
     AND NEW.observed_until < v_completed + make_interval(days => NEW.window_days) THEN
    RAISE EXCEPTION 'repair_outcomes: window not fully observed, outcome must stay censored' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_repair_outcomes_guard ON public.repair_outcomes;
CREATE TRIGGER trg_repair_outcomes_guard BEFORE INSERT OR UPDATE ON public.repair_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.repair_outcomes_guard();

-- =============================================================
-- 5. repair_labels (derived, versioned, append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.repair_labels (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  case_id              uuid NOT NULL REFERENCES public.repair_cases(id) ON DELETE CASCADE,
  window_days          integer NOT NULL CHECK (window_days IN (14, 30, 60)),
  label                text NOT NULL CHECK (label IN ('first_visit_success', 'first_visit_failure', 'indeterminate')),
  confidence           numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  insufficient_data    boolean NOT NULL DEFAULT false,
  n_support            integer CHECK (n_support IS NULL OR n_support >= 0),
  method_version       text NOT NULL CHECK (method_version ~ '^[a-z0-9_.-]{1,40}$'),
  reason_codes         text[] NOT NULL DEFAULT '{}' CHECK (public.repair_ledger_codes_ok(reason_codes, '^[a-z0-9_]{1,48}$', 12)),
  reliability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reliability_snapshot) = 'object'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, window_days, method_version),
  CONSTRAINT repair_labels_conf_required CHECK (label = 'indeterminate' OR (confidence IS NOT NULL AND NOT insufficient_data))
);
CREATE INDEX IF NOT EXISTS idx_repair_labels_user_method ON public.repair_labels (user_id, method_version, window_days);

ALTER TABLE public.repair_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_labels FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.repair_labels TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repair_labels' AND policyname = 'repair_labels_select') THEN
    CREATE POLICY repair_labels_select ON public.repair_labels FOR SELECT TO authenticated
      USING (user_id = (SELECT public.get_account_owner_id()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.repair_labels_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_case_user uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'repair_labels is append-only (write a new method_version instead)' USING ERRCODE = '55000';
  END IF;
  SELECT user_id INTO v_case_user FROM public.repair_cases WHERE id = NEW.case_id;
  IF v_case_user IS NULL OR v_case_user <> NEW.user_id THEN
    RAISE EXCEPTION 'repair_labels: case does not belong to this account' USING ERRCODE = '23514';
  END IF;
  -- A success label needs an UNCENSORED "nothing happened" outcome for the same window.
  IF NEW.label = 'first_visit_success' AND NOT EXISTS (
    SELECT 1 FROM public.repair_outcomes o
    WHERE o.case_id = NEW.case_id AND o.window_days = NEW.window_days
      AND o.event = 'none_observed' AND o.censored = false
  ) THEN
    RAISE EXCEPTION 'repair_labels: success requires an uncensored none_observed outcome' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_repair_labels_guard ON public.repair_labels;
CREATE TRIGGER trg_repair_labels_guard BEFORE INSERT OR UPDATE ON public.repair_labels
  FOR EACH ROW EXECUTE FUNCTION public.repair_labels_guard();

-- =============================================================
-- 6. Pseudonym (service only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_pseudonym(p_owner uuid, p_subject text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_salt text;
BEGIN
  IF p_owner IS NULL OR p_subject IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.repair_ledger_secrets (user_id) VALUES (p_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT pseudonym_salt INTO v_salt FROM public.repair_ledger_secrets WHERE user_id = p_owner;
  RETURN substr(encode(extensions.hmac(p_subject, v_salt, 'sha256'), 'hex'), 1, 24);
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_pseudonym(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_ledger_pseudonym(uuid, text) TO service_role;

-- =============================================================
-- 7. Flag RPC (owner only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_set_enabled(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.repair_ledger_settings (user_id, capture_enabled, updated_at, updated_by)
  VALUES (v_owner, coalesce(p_enabled, false), now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET capture_enabled = excluded.capture_enabled, updated_at = now(), updated_by = auth.uid();
  RETURN coalesce(p_enabled, false);
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_set_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_ledger_set_enabled(boolean) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repair_ledger_settings' AND policyname = 'repair_ledger_settings_select') THEN
    CREATE POLICY repair_ledger_settings_select ON public.repair_ledger_settings FOR SELECT TO authenticated
      USING (user_id = (SELECT public.get_account_owner_id()));
  END IF;
END $$;

-- =============================================================
-- 8. Capture RPC (idempotent on job_id; server derives technician, link key, provenance)
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_record_case(
  p_job_id            uuid,
  p_trade             text,
  p_root_cause_code   text,
  p_equipment_type    text DEFAULT NULL,
  p_equipment_make    text DEFAULT NULL,
  p_equipment_model   text DEFAULT NULL,
  p_equipment_age     text DEFAULT 'unknown',
  p_symptoms          jsonb DEFAULT '[]'::jsonb,
  p_parts             text[] DEFAULT '{}',
  p_evidence_digests  text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner     uuid := public.get_account_owner_id();
  v_job       public.jobs%ROWTYPE;
  v_enabled   boolean;
  v_trade     text := lower(btrim(coalesce(p_trade, '')));
  v_code      text := lower(btrim(coalesce(p_root_cause_code, '')));
  v_ver       integer := public.repair_ledger_current_taxonomy_version();
  v_tax       public.repair_root_cause_taxonomy%ROWTYPE;
  v_tech_ok   boolean;
  v_pseudo    text;
  v_scope     text;
  v_link_src  text;
  v_link      text;
  v_equip     uuid;
  v_dec       record;
  v_sym       jsonb;
  v_id        uuid;
  v_parts     text[] := coalesce(p_parts, '{}');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT capture_enabled INTO v_enabled FROM public.repair_ledger_settings WHERE user_id = v_owner;
  IF NOT coalesce(v_enabled, false) THEN
    RAISE EXCEPTION 'ledger_disabled' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = '42501';         -- same answer for "not yours" and "not there"
  END IF;
  IF v_job.completed_at IS NULL THEN
    RAISE EXCEPTION 'job_not_completed' USING ERRCODE = '23514';
  END IF;

  -- Owner, or the technician the job is assigned to (matched the same way get_account_owner_id() matches members).
  IF auth.uid() <> v_owner THEN
    SELECT EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = v_job.assigned_technician_id
        AND tm.account_owner_id = v_owner
        AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
    ) INTO v_tech_ok;
    IF NOT coalesce(v_tech_ok, false) THEN
      RAISE EXCEPTION 'not_assigned_technician' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Input validation (the table CHECKs repeat these as a second line of defence).
  IF v_trade !~ '^[a-z_]{2,32}$' THEN RAISE EXCEPTION 'invalid_trade' USING ERRCODE = '22023'; END IF;
  IF v_code !~ '^[a-z0-9_]{2,64}$' THEN RAISE EXCEPTION 'invalid_root_cause' USING ERRCODE = '22023'; END IF;
  IF NOT public.repair_ledger_codes_ok(v_parts, '^[a-z0-9_]{1,48}$', 30) THEN RAISE EXCEPTION 'invalid_parts' USING ERRCODE = '22023'; END IF;
  IF NOT public.repair_ledger_codes_ok(coalesce(p_evidence_digests, '{}'), '^[0-9a-f]{64}$', 20) THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE = '22023'; END IF;
  IF coalesce(p_equipment_age, 'unknown') NOT IN ('lt_2y', '2_5y', '5_10y', '10_15y', 'gt_15y', 'unknown') THEN RAISE EXCEPTION 'invalid_age_band' USING ERRCODE = '22023'; END IF;

  p_symptoms := coalesce(p_symptoms, '[]'::jsonb);
  IF jsonb_typeof(p_symptoms) <> 'array' OR jsonb_array_length(p_symptoms) > 12 THEN
    RAISE EXCEPTION 'invalid_symptoms' USING ERRCODE = '22023';
  END IF;
  FOR v_sym IN SELECT * FROM jsonb_array_elements(p_symptoms) LOOP
    IF jsonb_typeof(v_sym) <> 'object'
       OR (v_sym ->> 'code') IS NULL OR (v_sym ->> 'code') !~ '^[a-z0-9_]{2,48}$'
       OR coalesce(v_sym ->> 'source', '') NOT IN ('customer', 'fault_code', 'technician')
       OR (SELECT count(*) FROM jsonb_object_keys(v_sym)) > 2 THEN
      RAISE EXCEPTION 'invalid_symptoms' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT * INTO v_tax FROM public.repair_root_cause_taxonomy
   WHERE version = v_ver AND code = v_code AND is_active AND trade IN (v_trade, '*')
   ORDER BY (trade = v_trade) DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_root_cause' USING ERRCODE = '22023';
  END IF;

  -- Technician pseudonym (server-derived; the client never supplies or sees a technician id).
  IF v_job.assigned_technician_id IS NULL THEN
    RAISE EXCEPTION 'job_has_no_technician' USING ERRCODE = '23514';
  END IF;
  v_pseudo := public.repair_ledger_pseudonym(v_owner, 'tech:' || v_job.assigned_technician_id::text);

  -- Problem link key: equipment (via a logged failure event on this job) > site > customer.
  SELECT e.equipment_id INTO v_equip FROM public.equipment_failure_events e
   WHERE e.job_id = p_job_id AND e.user_id = v_owner ORDER BY e.created_at DESC LIMIT 1;
  IF v_equip IS NOT NULL THEN v_scope := 'equipment'; v_link_src := v_equip::text;
  ELSIF v_job.site_id IS NOT NULL THEN v_scope := 'site'; v_link_src := v_job.site_id::text;
  ELSIF v_job.customer_id IS NOT NULL THEN v_scope := 'customer'; v_link_src := v_job.customer_id::text;
  END IF;
  IF v_scope IS NOT NULL THEN
    v_link := public.repair_ledger_pseudonym(v_owner, 'link:' || v_scope || ':' || v_link_src);
  END IF;

  -- Assignment provenance: the dispatch decision that picked THIS technician, with its logged propensity.
  SELECT dd.id, dd.arm, dd.propensity INTO v_dec FROM public.dispatch_decisions dd
   WHERE dd.job_id = p_job_id AND dd.user_id = v_owner AND dd.technician_id = v_job.assigned_technician_id AND dd.arm IS NOT NULL
   ORDER BY dd.created_at DESC LIMIT 1;

  INSERT INTO public.repair_cases (
    user_id, job_id, trade, equipment_type, equipment_make, equipment_model, equipment_age_band, symptom_codes,
    taxonomy_version, claimed_root_cause_id, claim_kind, parts_replaced, evidence_digest_refs, technician_pseudonym,
    problem_link_key, link_scope, assignment_decision_id, assignment_arm, assignment_propensity, completed_at
  ) VALUES (
    v_owner, p_job_id, v_trade,
    nullif(lower(btrim(coalesce(p_equipment_type, ''))), ''), nullif(lower(btrim(coalesce(p_equipment_make, ''))), ''),
    nullif(lower(btrim(coalesce(p_equipment_model, ''))), ''), coalesce(p_equipment_age, 'unknown'), p_symptoms,
    v_ver, v_tax.id, v_tax.kind, v_parts, coalesce(p_evidence_digests, '{}'), v_pseudo,
    v_link, v_scope, v_dec.id, v_dec.arm, v_dec.propensity, v_job.completed_at
  )
  ON CONFLICT (job_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.repair_cases WHERE job_id = p_job_id AND user_id = v_owner;
    RETURN jsonb_build_object('case_id', v_id, 'created', false);
  END IF;
  RETURN jsonb_build_object('case_id', v_id, 'created', true);
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_record_case(uuid, text, text, text, text, text, text, jsonb, text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_ledger_record_case(uuid, text, text, text, text, text, text, jsonb, text[], text[]) TO authenticated, service_role;

-- =============================================================
-- 9. Outcome refresh (service role). Idempotent; only censored rows can change.
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_refresh_outcomes(
  p_owner uuid,
  p_now   timestamptz DEFAULT now(),
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_watermark timestamptz;
  v_touched   integer := 0;
  v_final     integer := 0;
  w           integer;
  r           record;
  v_repeat    record;
  v_basis     text;
  v_event     text;
  v_end       timestamptz;
  v_known     boolean;
BEGIN
  IF p_owner IS NULL THEN RAISE EXCEPTION 'owner_required' USING ERRCODE = '22023'; END IF;
  p_limit := least(greatest(coalesce(p_limit, 5000), 1), 20000);

  -- ACCOUNT-level observability watermark: the account was demonstrably live up to its newest job.
  SELECT max(created_at) INTO v_watermark FROM public.jobs WHERE user_id = p_owner;
  v_watermark := least(p_now, coalesce(v_watermark, '-infinity'::timestamptz));

  FOREACH w IN ARRAY ARRAY[14, 30, 60] LOOP
    FOR r IN
      SELECT c.id AS case_id, c.job_id, c.completed_at, c.problem_link_key, c.symptom_codes, j.customer_id
      FROM public.repair_cases c
      JOIN public.jobs j ON j.id = c.job_id
      LEFT JOIN public.repair_outcomes o ON o.case_id = c.id AND o.window_days = w
      WHERE c.user_id = p_owner AND (o.id IS NULL OR o.censored)
      ORDER BY c.completed_at
      LIMIT p_limit
    LOOP
      v_end := r.completed_at + make_interval(days => w);

      SELECT rj.id AS job_id, rj.created_at INTO v_repeat
      FROM public.jobs rj
      WHERE rj.user_id = p_owner AND rj.rework_of_job_id = r.job_id
        AND rj.created_at >= r.completed_at AND rj.created_at <= v_end AND rj.created_at <= p_now
      ORDER BY rj.created_at LIMIT 1;

      IF v_repeat.job_id IS NOT NULL THEN
        -- Same problem only with the same link key AND a shared symptom code on the repeat visit's own case.
        v_basis := 'rework_trigger_only';
        IF r.problem_link_key IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.repair_cases c2
          WHERE c2.job_id = v_repeat.job_id AND c2.user_id = p_owner AND c2.problem_link_key = r.problem_link_key
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(c2.symptom_codes) a(x), jsonb_array_elements(r.symptom_codes) b(x)
              WHERE a.x ->> 'code' = b.x ->> 'code')
        ) THEN
          v_basis := 'symptom_match';
        END IF;
        v_event := CASE WHEN v_basis = 'symptom_match' THEN 'repeat_visit_same_problem' ELSE 'repeat_visit_other' END;

        INSERT INTO public.repair_outcomes (user_id, case_id, window_days, event, censored, observed_until, link_basis, repeat_job_id, computed_at)
        VALUES (p_owner, r.case_id, w, v_event, false, v_repeat.created_at, v_basis, v_repeat.job_id, p_now)
        ON CONFLICT (case_id, window_days) DO UPDATE
          SET event = excluded.event, censored = false, observed_until = excluded.observed_until,
              link_basis = excluded.link_basis, repeat_job_id = excluded.repeat_job_id, computed_at = excluded.computed_at
          WHERE public.repair_outcomes.censored;
        v_touched := v_touched + 1; v_final := v_final + 1;
        CONTINUE;
      END IF;

      -- No repeat seen. It is a real "none" only if the window is over, the account was live through it,
      -- and the customer is still a known record (customer_id is SET NULL when a customer is erased).
      v_known := r.customer_id IS NOT NULL;
      IF v_known AND p_now >= v_end AND v_watermark >= v_end THEN
        INSERT INTO public.repair_outcomes (user_id, case_id, window_days, event, censored, observed_until, link_basis, computed_at)
        VALUES (p_owner, r.case_id, w, 'none_observed', false, v_end, 'none', p_now)
        ON CONFLICT (case_id, window_days) DO UPDATE
          SET event = 'none_observed', censored = false, observed_until = excluded.observed_until, link_basis = 'none', computed_at = excluded.computed_at
          WHERE public.repair_outcomes.censored;
        v_final := v_final + 1;
      ELSE
        INSERT INTO public.repair_outcomes (user_id, case_id, window_days, event, censored, observed_until, link_basis, computed_at)
        VALUES (p_owner, r.case_id, w, 'none_observed', true,
                greatest(r.completed_at, least(v_end, p_now, v_watermark)), 'none', p_now)
        ON CONFLICT (case_id, window_days) DO UPDATE
          SET observed_until = excluded.observed_until, computed_at = excluded.computed_at
          WHERE public.repair_outcomes.censored;
      END IF;
      v_touched := v_touched + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('rows_touched', v_touched, 'rows_final', v_final);
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_refresh_outcomes(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_ledger_refresh_outcomes(uuid, timestamptz, integer) TO service_role;

-- =============================================================
-- 10. Quality (admin page). Honest nulls instead of invented numbers.
-- =============================================================
CREATE OR REPLACE FUNCTION public.repair_ledger_quality(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid := public.get_account_owner_id();
  v_since   timestamptz;
  v_jobs    integer;
  v_cases   integer;
  v_unknown integer;
  v_out     integer;
  v_cens    integer;
  v_both    integer;
  v_agree   integer;
  v_min     constant integer := 30;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  p_days := least(greatest(coalesce(p_days, 90), 7), 365);
  v_since := now() - make_interval(days => p_days);

  SELECT count(*) INTO v_jobs FROM public.jobs WHERE user_id = v_owner AND job_status = 'completed' AND completed_at >= v_since;
  SELECT count(*), count(*) FILTER (WHERE claim_kind = 'unknown') INTO v_cases, v_unknown
    FROM public.repair_cases WHERE user_id = v_owner AND completed_at >= v_since;
  SELECT count(*), count(*) FILTER (WHERE o.censored) INTO v_out, v_cens
    FROM public.repair_outcomes o JOIN public.repair_cases c ON c.id = o.case_id
   WHERE o.user_id = v_owner AND o.window_days = 30 AND c.completed_at >= v_since;
  SELECT count(*), count(*) FILTER (WHERE a.label = b.label) INTO v_both, v_agree
    FROM public.repair_labels a
    JOIN public.repair_labels b ON b.case_id = a.case_id AND b.window_days = a.window_days
                               AND b.method_version = 'weighted_v1' AND a.method_version = 'naive_v1'
    JOIN public.repair_cases c ON c.id = a.case_id
   WHERE a.user_id = v_owner AND a.window_days = 30 AND c.completed_at >= v_since;

  RETURN jsonb_build_object(
    'window_days', p_days,
    'min_n', v_min,
    'completed_jobs', v_jobs,
    'cases', v_cases,
    'coverage_pct', CASE WHEN v_jobs >= v_min THEN round(100.0 * v_cases / v_jobs, 1) END,
    'unknown_rate', CASE WHEN v_cases >= v_min THEN round(v_unknown::numeric / v_cases, 3) END,
    'outcomes_30d', v_out,
    'censored_share_30d', CASE WHEN v_out >= v_min THEN round(v_cens::numeric / v_out, 3) END,
    'label_pairs', v_both,
    'label_agreement', CASE WHEN v_both >= v_min THEN round(v_agree::numeric / v_both, 3) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_quality(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_ledger_quality(integer) TO authenticated, service_role;

-- =============================================================
-- 11. Consent-gated, suppressed pooled view
-- =============================================================
INSERT INTO public.cross_tenant_flows (flow_key, sde_domain, description, wording_fit)
VALUES ('repair_ledger', NULL,
        'Repair Outcome Ledger pooled first-visit success rates by trade, equipment type and root cause. Suppressed cells only.',
        'none')
ON CONFLICT (flow_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.repair_ledger_pooled_rates(p_trade text DEFAULT NULL)
RETURNS TABLE (
  trade                       text,
  equipment_type              text,
  root_cause_code             text,
  n_cases_floor               integer,
  n_tenants                   integer,
  first_visit_success_rate_30d numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  -- Give-to-get and fail-closed: a tenant that has not consented gets nothing back.
  IF NOT public.xtl_contributes(v_owner, 'repair_ledger') THEN RETURN; END IF;

  RETURN QUERY
  WITH base AS (
    SELECT c.user_id, c.trade AS t, coalesce(c.equipment_type, 'unspecified') AS et, x.code AS cc,
           (o.event = 'none_observed') AS ok
    FROM public.repair_cases c
    JOIN public.repair_outcomes o ON o.case_id = c.id AND o.window_days = 30 AND NOT o.censored
    JOIN public.repair_root_cause_taxonomy x ON x.id = c.claimed_root_cause_id
    WHERE c.user_id IN (SELECT public.xtl_contributors('repair_ledger'))
      AND x.kind = 'cause'
      AND (p_trade IS NULL OR c.trade = lower(p_trade))
  ), per_tenant AS (
    SELECT t, et, cc, user_id, count(*) AS n FROM base GROUP BY t, et, cc, user_id
  ), cells AS (
    SELECT b.t, b.et, b.cc, count(*) AS n, count(DISTINCT b.user_id) AS k, avg(b.ok::int) AS rate
    FROM base b GROUP BY b.t, b.et, b.cc
  )
  SELECT ce.t, ce.et, ce.cc,
         (floor(ce.n / 5.0) * 5)::integer,
         ce.k::integer,
         (round(ce.rate * 20) / 20)::numeric
  FROM cells ce
  WHERE ce.k >= public.repair_ledger_pool_min_tenants()
    AND ce.n >= public.repair_ledger_pool_min_cases()
    -- dominance guard: no single tenant may be more than the allowed share of the cell
    AND (SELECT max(p.n) FROM per_tenant p WHERE p.t = ce.t AND p.et = ce.et AND p.cc = ce.cc)::numeric / ce.n
        <= public.repair_ledger_pool_max_tenant_share();
END;
$$;
REVOKE ALL ON FUNCTION public.repair_ledger_pooled_rates(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_ledger_pooled_rates(text) TO authenticated, service_role;
