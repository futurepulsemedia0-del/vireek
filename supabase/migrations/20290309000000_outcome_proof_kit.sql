/*
  # Customer outcome proof kit

  ## Why
  The value ledger (20271121000000_value_scoreboard.sql) already records every recovered-revenue / saved-time / avoided-cost
  figure with an evidence_ref. What was missing for a publishable case study:
    1. a frozen, tamper-evident snapshot of exactly which ledger rows a figure was built from,
    2. per-case written consent that is scoped, versioned, revocable and bound to that snapshot,
    3. an append-only audit trail,
    4. a recorded verification level, so "not independently audited" is the default and only a recorded verifier changes it.
  This migration adds those four things and nothing else. It does NOT change value_events, value_settings or the account-level
  `case_study_consent` flag (that flag stays what it is: a coarse opt-in the staff aggregate view uses).

  ## Tables (all client-read-only; every write goes through a SECURITY DEFINER RPC)
  - outcome_cases           one immutable snapshot per generated case (verification fields are the only mutable part, staff RPC only)
  - outcome_case_sources    every ledger event considered, included or excluded, with the reason
  - outcome_case_consents   append-only: granted / revoked, scope, signer, text version, hash of the snapshot that was approved
  - outcome_case_audit      append-only action log

  ## Method
  Selection rules mirror public.value_effective_events(): a measured event supersedes the estimate it names; the owner's newest
  "not_due_to_vireek" review removes an event. Money in another currency than the case currency is kept but excluded.
  The arithmetic (ROI range, minimum data rules) lives in src/lib/outcomeProof/method.ts and is documented in docs/proof/roi-method.md.
  This SQL only selects, flags and hashes.

  ## Hash
  snapshot_sha256 = sha256 of the canonical string built in outcome_case_canonical() (same format as canonicalString() in method.ts).

  ## Requires
  profiles, value_events, value_event_reviews, value_settings (20271121000000), get_account_owner_id(),
  reports_can_access(uuid) (20270415000000), is_vireek_staff(uuid) (20260913020000).

  ## Rollback
  DROP FUNCTION IF EXISTS public.outcome_case_create(text,date,date,text,bigint), public.outcome_case_set_consent(uuid,text,boolean,boolean,boolean,text,text,text,text,text),
    public.outcome_case_log_export(uuid,text), public.outcome_case_record_verification(uuid,text,text,text), public.outcome_case_canonical(uuid), public.outcome_guard_append_only(), public.outcome_cases_guard();
  DROP TABLE IF EXISTS public.outcome_case_audit, public.outcome_case_consents, public.outcome_case_sources, public.outcome_cases;
  (Dropping deletes consent evidence. Export it first.)
*/

-- =============================================================
-- 1. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS public.outcome_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,       -- account owner
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cost_cents bigint CHECK (cost_cents IS NULL OR (cost_cents > 0 AND cost_cents <= 100000000000)),
  cost_basis text NOT NULL DEFAULT 'none' CHECK (cost_basis IN ('subscription_override', 'owner_entered', 'none')),
  method_version text NOT NULL DEFAULT 'roi-method-v1' CHECK (method_version ~ '^roi-method-v[0-9]+$'),
  source_count integer NOT NULL CHECK (source_count >= 0 AND source_count <= 5000),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  verification_level text NOT NULL DEFAULT 'not_independently_audited'
    CHECK (verification_level IN ('not_independently_audited', 'independently_verified')),
  verifier_name text CHECK (verifier_name IS NULL OR char_length(verifier_name) BETWEEN 2 AND 160),
  verification_evidence_url text CHECK (verification_evidence_url IS NULL OR verification_evidence_url ~ '^https://[^ ]{4,500}$'),
  verified_at timestamptz,
  verified_by uuid,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_cases_period_ok CHECK (period_end >= period_start AND period_end - period_start <= 366),
  CONSTRAINT outcome_cases_verified_has_proof CHECK (
    verification_level = 'not_independently_audited'
    OR (verifier_name IS NOT NULL AND verification_evidence_url IS NOT NULL AND verified_at IS NOT NULL AND verified_by IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_outcome_cases_user ON public.outcome_cases (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.outcome_case_sources (
  case_id uuid NOT NULL REFERENCES public.outcome_cases(id) ON DELETE CASCADE,
  value_event_id uuid NOT NULL,                                                    -- ledger row id; no FK on purpose, so erasing ledger rows is never blocked by a case
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('recovered_revenue', 'saved_hours', 'avoided_cost')),
  amount bigint NOT NULL CHECK (amount > 0),
  unit text NOT NULL CHECK (unit IN ('cents', 'minutes')),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  confidence text NOT NULL CHECK (confidence IN ('measured', 'estimated')),
  evidence_ref text NOT NULL CHECK (char_length(evidence_ref) BETWEEN 3 AND 200),
  source_feature text NOT NULL,
  occurred_ms bigint NOT NULL,
  included boolean NOT NULL,
  exclusion text CHECK (exclusion IN ('owner_review_not_due_to_vireek', 'superseded_by_measured', 'other_currency')),
  PRIMARY KEY (case_id, value_event_id),
  CONSTRAINT outcome_sources_exclusion_matches CHECK ((included AND exclusion IS NULL) OR (NOT included AND exclusion IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_outcome_sources_user ON public.outcome_case_sources (user_id);

CREATE TABLE IF NOT EXISTS public.outcome_case_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.outcome_cases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('granted', 'revoked')),
  allow_business_name boolean NOT NULL DEFAULT false,
  allow_person_name boolean NOT NULL DEFAULT false,
  allow_quote boolean NOT NULL DEFAULT false,
  quote_text text CHECK (quote_text IS NULL OR char_length(quote_text) BETWEEN 1 AND 500),
  signer_name text NOT NULL CHECK (char_length(signer_name) BETWEEN 2 AND 120),
  signer_role text CHECK (signer_role IS NULL OR char_length(signer_role) BETWEEN 2 AND 80),
  consent_text_version text NOT NULL CHECK (char_length(consent_text_version) BETWEEN 1 AND 40),
  consent_text_sha256 text NOT NULL CHECK (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  case_sha256 text NOT NULL CHECK (case_sha256 ~ '^[0-9a-f]{64}$'),
  decided_by uuid NOT NULL DEFAULT auth.uid(),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_consent_quote_needs_flag CHECK (quote_text IS NULL OR allow_quote),
  CONSTRAINT outcome_consent_revoke_grants_nothing CHECK (decision = 'granted' OR (NOT allow_business_name AND NOT allow_person_name AND NOT allow_quote AND quote_text IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_outcome_consents_case ON public.outcome_case_consents (case_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS public.outcome_case_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.outcome_cases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('created', 'consent_granted', 'consent_revoked', 'exported_markdown', 'exported_pdf', 'verification_recorded')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outcome_audit_case ON public.outcome_case_audit (case_id, created_at DESC);

-- =============================================================
-- 2. Immutability guards
-- =============================================================
-- Consents, audit rows and sources can never be changed. Deleting an account cascades (nested delete, trigger depth > 1).
CREATE OR REPLACE FUNCTION public.outcome_guard_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

-- A case is a frozen snapshot. Only the verification fields may change, and only from not_independently_audited -> independently_verified.
CREATE OR REPLACE FUNCTION public.outcome_cases_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'outcome_cases is append-only (DELETE is not allowed)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.title, NEW.period_start, NEW.period_end, NEW.currency, NEW.cost_cents, NEW.cost_basis,
      NEW.method_version, NEW.source_count, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.title, OLD.period_start, OLD.period_end, OLD.currency, OLD.cost_cents, OLD.cost_basis,
      OLD.method_version, OLD.source_count, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'outcome_cases snapshot fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The hash may be written exactly once: replacing the all-zero placeholder that outcome_case_create() inserts.
  IF NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256 AND OLD.snapshot_sha256 <> repeat('0', 64) THEN
    RAISE EXCEPTION 'snapshot_sha256 is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.verification_level = 'independently_verified' THEN
    RAISE EXCEPTION 'a recorded verification cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_outcome_cases_guard ON public.outcome_cases;
CREATE TRIGGER trg_outcome_cases_guard BEFORE UPDATE OR DELETE ON public.outcome_cases
  FOR EACH ROW EXECUTE FUNCTION public.outcome_cases_guard();

DROP TRIGGER IF EXISTS trg_outcome_cases_no_truncate ON public.outcome_cases;
CREATE TRIGGER trg_outcome_cases_no_truncate BEFORE TRUNCATE ON public.outcome_cases
  FOR EACH STATEMENT EXECUTE FUNCTION public.outcome_guard_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outcome_case_sources', 'outcome_case_consents', 'outcome_case_audit'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.outcome_guard_append_only()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_no_truncate ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.outcome_guard_append_only()', t, t);
  END LOOP;
END $$;

-- =============================================================
-- 3. RLS + privileges: read-only for the owner (and team members with can_view_billing); no client DML
-- =============================================================
ALTER TABLE public.outcome_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_case_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_case_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_case_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "outcome_cases_select" ON public.outcome_cases;
CREATE POLICY "outcome_cases_select" ON public.outcome_cases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "outcome_sources_select" ON public.outcome_case_sources;
CREATE POLICY "outcome_sources_select" ON public.outcome_case_sources FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "outcome_consents_select" ON public.outcome_case_consents;
CREATE POLICY "outcome_consents_select" ON public.outcome_case_consents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "outcome_audit_select" ON public.outcome_case_audit;
CREATE POLICY "outcome_audit_select" ON public.outcome_case_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

REVOKE ALL ON public.outcome_cases, public.outcome_case_sources, public.outcome_case_consents, public.outcome_case_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.outcome_cases, public.outcome_case_sources, public.outcome_case_consents, public.outcome_case_audit TO authenticated;

-- =============================================================
-- 4. Canonical string + hash (must match canonicalString() in src/lib/outcomeProof/method.ts)
-- =============================================================
-- Line format:
--   roi-method-v1
--   period|<start>|<end>|<currency>
--   cost|<cents or ->|<basis>
--   src|<event id>|<type>|<amount>|<unit>|<currency or ->|<confidence>|<escaped evidence_ref>|<occurred_ms>|<1|0>|<exclusion or ->
-- Sources are ordered by event id (text). evidence_ref is escaped in this order: % -> %25, | -> %7C, LF -> %0A, CR -> %0D.
CREATE OR REPLACE FUNCTION public.outcome_case_canonical(p_case uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT c.method_version || E'\n'
      || 'period|' || c.period_start::text || '|' || c.period_end::text || '|' || c.currency || E'\n'
      || 'cost|' || COALESCE(c.cost_cents::text, '-') || '|' || c.cost_basis
      || COALESCE((
           SELECT string_agg(
                    E'\n' || 'src|' || s.value_event_id::text || '|' || s.type || '|' || s.amount::text || '|' || s.unit || '|'
                    || COALESCE(s.currency, '-') || '|' || s.confidence || '|'
                    || replace(replace(replace(replace(s.evidence_ref, '%', '%25'), '|', '%7C'), E'\n', '%0A'), E'\r', '%0D')
                    || '|' || s.occurred_ms::text || '|' || CASE WHEN s.included THEN '1' ELSE '0' END || '|' || COALESCE(s.exclusion, '-'),
                    '' ORDER BY s.value_event_id::text)
           FROM outcome_case_sources s WHERE s.case_id = c.id
         ), '')
  FROM outcome_cases c WHERE c.id = p_case;
$$;
REVOKE ALL ON FUNCTION public.outcome_case_canonical(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. RPCs
-- =============================================================
-- Create a case from the caller's own ledger. Tenant is get_account_owner_id(), never an argument.
-- The case row is inserted with an all-zero placeholder hash, the sources are inserted, then the real hash replaces the
-- placeholder inside this same function.
CREATE OR REPLACE FUNCTION public.outcome_case_create(
  p_title text, p_start date, p_end date, p_currency text, p_cost_cents bigint DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_id uuid := gen_random_uuid();
  v_cost bigint;
  v_basis text;
  v_count integer;
  v_override integer;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF NOT public.reports_can_access(v_owner) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 3 AND 120 THEN RAISE EXCEPTION 'Invalid title' USING ERRCODE = '22023'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 366 THEN RAISE EXCEPTION 'Invalid period' USING ERRCODE = '22023'; END IF;
  IF p_end >= (now() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'Period must end before today (UTC)' USING ERRCODE = '22023'; END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid currency' USING ERRCODE = '22023'; END IF;
  IF p_cost_cents IS NOT NULL AND (p_cost_cents <= 0 OR p_cost_cents > 100000000000) THEN RAISE EXCEPTION 'Invalid cost' USING ERRCODE = '22023'; END IF;

  -- Cost: an explicit owner-entered figure wins; otherwise the account's own subscription override; otherwise none (no ROI is shown).
  SELECT s.subscription_cents_override INTO v_override FROM value_settings s WHERE s.user_id = v_owner;
  IF p_cost_cents IS NOT NULL THEN v_cost := p_cost_cents; v_basis := 'owner_entered';
  ELSIF v_override IS NOT NULL AND v_override > 0 THEN v_cost := v_override::bigint; v_basis := 'subscription_override';
  ELSE v_cost := NULL; v_basis := 'none';
  END IF;

  SELECT count(*) INTO v_count FROM value_events e
   WHERE e.user_id = v_owner AND e.occurred_at >= p_start::timestamptz AND e.occurred_at < (p_end + 1)::timestamptz;
  IF v_count > 5000 THEN RAISE EXCEPTION 'Too many events for one case; shorten the period' USING ERRCODE = '54000'; END IF;

  INSERT INTO outcome_cases (id, user_id, title, period_start, period_end, currency, cost_cents, cost_basis, source_count, snapshot_sha256, created_by)
  VALUES (v_id, v_owner, btrim(p_title), p_start, p_end, p_currency, v_cost, v_basis, v_count, repeat('0', 64), v_uid);

  INSERT INTO outcome_case_sources (case_id, value_event_id, user_id, type, amount, unit, currency, confidence, evidence_ref, source_feature, occurred_ms, included, exclusion)
  SELECT v_id, e.id, v_owner, e.type, e.amount, e.unit, e.currency, e.confidence, e.evidence_ref, e.source_feature,
         floor(extract(epoch FROM e.occurred_at) * 1000)::bigint,
         x.reason IS NULL, x.reason
    FROM value_events e
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN COALESCE((SELECT r.decision FROM value_event_reviews r WHERE r.value_event_id = e.id ORDER BY r.decided_at DESC, r.id DESC LIMIT 1), 'restored') = 'not_due_to_vireek'
          THEN 'owner_review_not_due_to_vireek'
        WHEN e.confidence = 'estimated' AND EXISTS (
               SELECT 1 FROM value_events m
                WHERE m.user_id = e.user_id AND m.type = e.type AND m.confidence = 'measured' AND m.supersedes_ref = e.evidence_ref)
          THEN 'superseded_by_measured'
        WHEN e.unit = 'cents' AND e.currency IS DISTINCT FROM p_currency
          THEN 'other_currency'
        ELSE NULL END AS reason
    ) x
   WHERE e.user_id = v_owner AND e.occurred_at >= p_start::timestamptz AND e.occurred_at < (p_end + 1)::timestamptz;

  -- Freeze: replace the placeholder with the real hash (the guard allows this exactly once, see outcome_cases_guard()).
  UPDATE outcome_cases SET snapshot_sha256 = encode(sha256(convert_to(public.outcome_case_canonical(v_id), 'UTF8')), 'hex') WHERE id = v_id;

  INSERT INTO outcome_case_audit (case_id, user_id, actor_id, action, detail)
  VALUES (v_id, v_owner, v_uid, 'created', jsonb_build_object('sources', v_count, 'cost_basis', v_basis));
  RETURN v_id;
END $$;

-- Record a consent decision. Only the account owner themself (not a team member) may consent for their business.
-- The decision is bound to the case's snapshot hash. A revoke grants nothing.
CREATE OR REPLACE FUNCTION public.outcome_case_set_consent(
  p_case uuid, p_decision text, p_allow_business_name boolean, p_allow_person_name boolean, p_allow_quote boolean,
  p_quote text, p_signer_name text, p_signer_role text, p_text_version text, p_text_sha256 text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_case outcome_cases%ROWTYPE;
  v_id uuid;
  v_granted boolean := (p_decision = 'granted');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('granted', 'revoked') THEN RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_case FROM outcome_cases WHERE id = p_case;
  IF NOT FOUND OR v_case.user_id <> v_uid THEN RAISE EXCEPTION 'Case not found' USING ERRCODE = '42501'; END IF;
  IF p_signer_name IS NULL OR char_length(btrim(p_signer_name)) < 2 THEN RAISE EXCEPTION 'Signer name required' USING ERRCODE = '22023'; END IF;
  IF p_text_sha256 IS NULL OR p_text_sha256 !~ '^[0-9a-f]{64}$' OR p_text_version IS NULL THEN RAISE EXCEPTION 'Consent text version required' USING ERRCODE = '22023'; END IF;
  IF v_granted AND COALESCE(p_allow_quote, false) = false AND p_quote IS NOT NULL THEN RAISE EXCEPTION 'Quote not allowed' USING ERRCODE = '22023'; END IF;

  INSERT INTO outcome_case_consents (
    case_id, user_id, decision, allow_business_name, allow_person_name, allow_quote, quote_text,
    signer_name, signer_role, consent_text_version, consent_text_sha256, case_sha256, decided_by)
  VALUES (
    p_case, v_uid, p_decision,
    v_granted AND COALESCE(p_allow_business_name, false), v_granted AND COALESCE(p_allow_person_name, false), v_granted AND COALESCE(p_allow_quote, false),
    CASE WHEN v_granted AND COALESCE(p_allow_quote, false) THEN NULLIF(btrim(p_quote), '') END,
    btrim(p_signer_name), NULLIF(btrim(COALESCE(p_signer_role, '')), ''), p_text_version, p_text_sha256, v_case.snapshot_sha256, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO outcome_case_audit (case_id, user_id, actor_id, action, detail)
  VALUES (p_case, v_uid, v_uid, CASE WHEN v_granted THEN 'consent_granted' ELSE 'consent_revoked' END,
          jsonb_build_object('consent_id', v_id, 'text_version', p_text_version));
  RETURN v_id;
END $$;

-- Log that a case was exported. Owner or a permitted team member of the same account.
CREATE OR REPLACE FUNCTION public.outcome_case_log_export(p_case uuid, p_format text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.reports_can_access(v_owner) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  IF p_format IS NULL OR p_format NOT IN ('markdown', 'pdf') THEN RAISE EXCEPTION 'Invalid format' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM outcome_cases WHERE id = p_case AND user_id = v_owner) THEN RAISE EXCEPTION 'Case not found' USING ERRCODE = '42501'; END IF;
  INSERT INTO outcome_case_audit (case_id, user_id, actor_id, action, detail)
  VALUES (p_case, v_owner, auth.uid(), CASE WHEN p_format = 'pdf' THEN 'exported_pdf' ELSE 'exported_markdown' END,
          jsonb_build_object('consent_state', COALESCE((SELECT c.decision FROM outcome_case_consents c WHERE c.case_id = p_case ORDER BY c.decided_at DESC, c.id DESC LIMIT 1), 'none')));
END $$;

-- Staff only: record that an independent party verified this case. Requires a named verifier and an https evidence link.
-- Vireek staff may not record a verification of their own work as "independent": the caller must state who the verifier is,
-- and the evidence link is the proof. This function stores that, it does not judge it.
CREATE OR REPLACE FUNCTION public.outcome_case_record_verification(p_case uuid, p_verifier text, p_evidence_url text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF p_verifier IS NULL OR char_length(btrim(p_verifier)) NOT BETWEEN 2 AND 160 THEN RAISE EXCEPTION 'Verifier required' USING ERRCODE = '22023'; END IF;
  IF p_evidence_url IS NULL OR p_evidence_url !~ '^https://[^ ]{4,500}$' THEN RAISE EXCEPTION 'Evidence URL (https) required' USING ERRCODE = '22023'; END IF;
  SELECT user_id INTO v_owner FROM outcome_cases WHERE id = p_case;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Case not found' USING ERRCODE = '42501'; END IF;
  UPDATE outcome_cases
     SET verification_level = 'independently_verified', verifier_name = btrim(p_verifier), verification_evidence_url = p_evidence_url,
         verified_at = now(), verified_by = v_uid
   WHERE id = p_case AND verification_level = 'not_independently_audited';
  IF NOT FOUND THEN RAISE EXCEPTION 'Already verified' USING ERRCODE = '23505'; END IF;
  INSERT INTO outcome_case_audit (case_id, user_id, actor_id, action, detail)
  VALUES (p_case, v_owner, v_uid, 'verification_recorded', jsonb_build_object('verifier', btrim(p_verifier), 'note', left(COALESCE(p_note, ''), 300)));
END $$;

REVOKE ALL ON FUNCTION public.outcome_case_create(text, date, date, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_case_set_consent(uuid, text, boolean, boolean, boolean, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_case_log_export(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_case_record_verification(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.outcome_case_create(text, date, date, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_case_set_consent(uuid, text, boolean, boolean, boolean, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_case_log_export(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_case_record_verification(uuid, text, text, text) TO authenticated;
