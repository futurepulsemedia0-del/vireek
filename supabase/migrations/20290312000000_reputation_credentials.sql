/*
  # Portable reputation credentials (signed, revocable, expiring, consent-gated)

  A technician or contractor can hold an Ed25519-signed credential stating - from Vireek's own records - verified jobs,
  outcomes and license checks. Anyone can verify it at /verify/reputation/:id or via an embeddable static SVG badge.
  Builds on the technician passport (technician_passport_shares, build_technician_identity_payload) and the TrustBadge
  verify pattern, but adds what those do not have: an asymmetric signature a third party can check offline, key rotation,
  explicit per-scope consent, and revocation that takes effect immediately (read live; the signature itself is immutable).

  ## Objects
  - reputation_signing_keys            : PUBLIC keys only (kid, public JWK, active|retired|revoked). The private key lives in the
                                         edge-function secret REPUTATION_SIGNING_KEY_JWK, never in the database.
  - reputation_consents                : who agreed to publish which scopes (technician = self only; contractor = owner/admin).
  - reputation_license_checks          : a manager's attestation that a license was checked (without it a license is "self_reported").
  - reputation_credentials             : the credential (envelope jsonb, exact signed payload text, signature, revocation fields).
  - reputation_overview()              : authenticated - everything the dashboard needs in one call.
  - reputation_consent_set()           : authenticated - grant / narrow / withdraw (withdrawing revokes affected credentials).
  - reputation_prepare_credential()    : authenticated - authorises, checks consent, builds claims server-side, stores a PENDING row.
  - reputation_attach_signature()      : service_role  - edge function attaches the signature; DB verifies the payload equals the envelope.
  - reputation_revoke_credential()     : authenticated - manager or the technician themself.
  - reputation_record_license_check()  : authenticated managers.
  - reputation_public_lookup() / reputation_active_keys() : service_role - for the public verify function.

  ## Security
  - Tables are read through RLS only; every write goes through SECURITY DEFINER functions with explicit authorisation.
  - Claims are built here from jobs / credentials, never taken from the client. They contain no customer data, no contact data
    and no license / policy numbers (the edge function re-checks this before signing).
  - A pending row is only promoted if the signed payload is JSON-equal to the envelope the database built.
  - Removing a technician, withdrawing consent, or revoking a license auto-revokes the affected credentials.

  Requires: profiles, team_members, jobs, job_outcomes, review_requests, technician_credentials, audit_log,
            public.get_account_owner_id(), public.get_my_team_member_id(), public.identity_is_manager() (20270106000000),
            public.build_technician_identity_payload() (20270106000000), public.log_audit_event().

  Rollback: DROP TRIGGER trg_reputation_* ON team_members / technician_credentials; DROP the reputation_* functions and tables.
            No existing data is modified.
*/

-- 1) Signing keys (public material only) -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reputation_signing_keys (
  kid text PRIMARY KEY,
  public_jwk jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rsk_kid CHECK (kid ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT rsk_status CHECK (status IN ('active', 'retired', 'revoked')),
  CONSTRAINT rsk_jwk CHECK (public_jwk ->> 'kty' = 'OKP' AND public_jwk ->> 'crv' = 'Ed25519' AND NOT (public_jwk ? 'd'))
);
ALTER TABLE public.reputation_signing_keys ENABLE ROW LEVEL SECURITY; -- no policies: service role / SQL editor only
REVOKE ALL ON public.reputation_signing_keys FROM PUBLIC, anon, authenticated;

-- 2) Consent ----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reputation_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  granted_by uuid DEFAULT auth.uid(),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT rc_subject CHECK (subject_type IN ('technician', 'contractor')),
  CONSTRAINT rc_subject_shape CHECK ((subject_type = 'technician') = (technician_id IS NOT NULL)),
  CONSTRAINT rc_scopes CHECK (scopes <@ ARRAY['verified_jobs', 'outcomes', 'license_checks']::text[] AND cardinality(scopes) >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_active_subject ON public.reputation_consents
  (account_owner_id, subject_type, (coalesce(technician_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE revoked_at IS NULL;
ALTER TABLE public.reputation_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rc_select ON public.reputation_consents;
CREATE POLICY rc_select ON public.reputation_consents FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id()
         AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id()));
REVOKE ALL ON public.reputation_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reputation_consents TO authenticated;

-- 3) License checks (manager attestation) -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reputation_license_checks (
  credential_id uuid PRIMARY KEY REFERENCES public.technician_credentials(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  checked_by uuid DEFAULT auth.uid(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  CONSTRAINT rlc_method CHECK (method IN ('licensing_authority_lookup', 'document_review'))
);
ALTER TABLE public.reputation_license_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rlc_select ON public.reputation_license_checks;
CREATE POLICY rlc_select ON public.reputation_license_checks FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE ALL ON public.reputation_license_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reputation_license_checks TO authenticated;

-- 4) Credentials ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reputation_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  subject_name text NOT NULL,
  label text,
  scopes text[] NOT NULL,
  envelope jsonb NOT NULL,
  payload text,
  signature text,
  kid text NOT NULL REFERENCES public.reputation_signing_keys(kid),
  status text NOT NULL DEFAULT 'pending',
  issued_by uuid DEFAULT auth.uid(),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text,
  CONSTRAINT rcr_subject CHECK (subject_type IN ('technician', 'contractor')),
  CONSTRAINT rcr_status CHECK (status IN ('pending', 'active')),
  CONSTRAINT rcr_label CHECK (label IS NULL OR char_length(label) <= 80),
  CONSTRAINT rcr_reason CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 200),
  CONSTRAINT rcr_signed CHECK ((status = 'active') = (payload IS NOT NULL AND signature IS NOT NULL)),
  CONSTRAINT rcr_scopes CHECK (scopes <@ ARRAY['verified_jobs', 'outcomes', 'license_checks']::text[] AND cardinality(scopes) >= 1),
  CONSTRAINT rcr_term CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '366 days')
);
CREATE INDEX IF NOT EXISTS idx_rcr_account ON public.reputation_credentials (account_owner_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_rcr_technician ON public.reputation_credentials (technician_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.rcr_guard_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_owner_id <> OLD.account_owner_id OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_name <> OLD.subject_name OR NEW.scopes <> OLD.scopes OR NEW.envelope <> OLD.envelope
     OR NEW.kid <> OLD.kid OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.label IS DISTINCT FROM OLD.label
     OR (NEW.technician_id IS DISTINCT FROM OLD.technician_id AND NEW.technician_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Issued credentials are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'active' AND (NEW.status <> 'active' OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.signature IS DISTINCT FROM OLD.signature) THEN
    RAISE EXCEPTION 'A signed credential cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'Credential is already revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_rcr_guard_immutable ON public.reputation_credentials;
CREATE TRIGGER trg_rcr_guard_immutable BEFORE UPDATE ON public.reputation_credentials
  FOR EACH ROW EXECUTE FUNCTION public.rcr_guard_immutable();

ALTER TABLE public.reputation_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rcr_select ON public.reputation_credentials;
CREATE POLICY rcr_select ON public.reputation_credentials FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND status = 'active'
         AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id()));
REVOKE ALL ON public.reputation_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, account_owner_id, subject_type, technician_id, subject_name, label, scopes, kid, status, issued_at, expires_at, revoked_at, revoked_reason)
  ON public.reputation_credentials TO authenticated;

-- 5) Auto-revocation triggers -----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_on_team_member_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE reputation_credentials SET revoked_at = now(), revoked_reason = 'technician_removed'
   WHERE technician_id = OLD.id AND revoked_at IS NULL;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_reputation_team_member_delete ON public.team_members;
CREATE TRIGGER trg_reputation_team_member_delete BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.reputation_on_team_member_delete();

CREATE OR REPLACE FUNCTION public.reputation_on_license_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tech uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.technician_id ELSE NEW.technician_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.credential_type, NEW.credential_name, NEW.issuing_authority, NEW.credential_number, NEW.issued_at, NEW.expires_at, NEW.status)
       IS DISTINCT FROM (OLD.credential_type, OLD.credential_name, OLD.issuing_authority, OLD.credential_number, OLD.issued_at, OLD.expires_at, OLD.status) THEN
    DELETE FROM reputation_license_checks WHERE credential_id = OLD.id; -- an edited license is no longer the one that was checked
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.status = 'revoked' AND OLD.status <> 'revoked') THEN
    UPDATE reputation_credentials SET revoked_at = now(), revoked_reason = 'license_changed'
     WHERE technician_id = v_tech AND revoked_at IS NULL AND 'license_checks' = ANY (scopes);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_reputation_license_change ON public.technician_credentials;
CREATE TRIGGER trg_reputation_license_change AFTER UPDATE OR DELETE ON public.technician_credentials
  FOR EACH ROW EXECUTE FUNCTION public.reputation_on_license_change();

-- 6) Consent ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_consent_set(p_technician_id uuid, p_scopes text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_type text := CASE WHEN p_technician_id IS NULL THEN 'contractor' ELSE 'technician' END;
  v_scopes text[];
  v_tm team_members%ROWTYPE;
  v_id uuid;
  v_revoked integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  SELECT coalesce(array_agg(DISTINCT s ORDER BY s), ARRAY[]::text[]) INTO v_scopes FROM unnest(coalesce(p_scopes, ARRAY[]::text[])) s;
  IF NOT (v_scopes <@ ARRAY['verified_jobs', 'outcomes', 'license_checks']::text[]) THEN RAISE EXCEPTION 'Unknown scope' USING ERRCODE = '22023'; END IF;

  IF v_type = 'technician' THEN
    SELECT * INTO v_tm FROM team_members WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002'; END IF;
    IF v_tm.user_id IS NULL OR v_tm.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Only the technician can give or withdraw their own consent.' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only an owner or admin can consent for the business.' USING ERRCODE = '42501';
  END IF;

  UPDATE reputation_consents SET revoked_at = now()
   WHERE account_owner_id = v_owner AND subject_type = v_type AND technician_id IS NOT DISTINCT FROM p_technician_id AND revoked_at IS NULL;
  IF cardinality(v_scopes) > 0 THEN
    INSERT INTO reputation_consents (account_owner_id, subject_type, technician_id, scopes)
    VALUES (v_owner, v_type, p_technician_id, v_scopes) RETURNING id INTO v_id;
  END IF;

  UPDATE reputation_credentials SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = 'consent_changed'
   WHERE account_owner_id = v_owner AND subject_type = v_type AND technician_id IS NOT DISTINCT FROM p_technician_id
     AND revoked_at IS NULL AND NOT (scopes <@ v_scopes);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  PERFORM public.log_audit_event(v_owner, 'reputation.consent_set', 'reputation_consents', coalesce(v_id::text, p_technician_id::text),
    jsonb_build_object('subject_type', v_type, 'scopes', to_jsonb(v_scopes), 'credentials_revoked', v_revoked));
  RETURN jsonb_build_object('scopes', to_jsonb(v_scopes), 'credentials_revoked', v_revoked);
END;
$$;

-- 7) License check ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_record_license_check(p_credential_id uuid, p_method text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'Only an owner or admin can record a license check.' USING ERRCODE = '42501'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('licensing_authority_lookup', 'document_review') THEN RAISE EXCEPTION 'Unknown method' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM technician_credentials c JOIN team_members m ON m.id = c.technician_id
                  WHERE c.id = p_credential_id AND m.account_owner_id = v_owner AND c.status = 'active') THEN
    RAISE EXCEPTION 'License not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO reputation_license_checks (credential_id, account_owner_id, method)
  VALUES (p_credential_id, v_owner, p_method)
  ON CONFLICT (credential_id) DO UPDATE SET method = EXCLUDED.method, checked_at = now(), checked_by = auth.uid();
  PERFORM public.log_audit_event(v_owner, 'reputation.license_checked', 'technician_credentials', p_credential_id::text, jsonb_build_object('method', p_method));
END;
$$;

-- 8) Prepare (authorise + build claims + pending row) -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_prepare_credential(
  p_technician_id uuid, p_scopes text[], p_valid_days integer, p_label text, p_kid text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_type text := CASE WHEN p_technician_id IS NULL THEN 'contractor' ELSE 'technician' END;
  v_scopes text[];
  v_tm team_members%ROWTYPE;
  v_name text;
  v_company text;
  v_manager boolean := public.identity_is_manager();
  v_claims jsonb := '{}'::jsonb;
  v_m jsonb;
  v_jobs integer;
  v_part jsonb;
  v_id uuid := gen_random_uuid();
  v_iat bigint := floor(extract(epoch FROM now()));
  v_exp bigint;
  v_env jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  SELECT coalesce(array_agg(DISTINCT s ORDER BY s), ARRAY[]::text[]) INTO v_scopes FROM unnest(coalesce(p_scopes, ARRAY[]::text[])) s;
  IF cardinality(v_scopes) = 0 OR NOT (v_scopes <@ ARRAY['verified_jobs', 'outcomes', 'license_checks']::text[]) THEN
    RAISE EXCEPTION 'Choose at least one valid scope' USING ERRCODE = '22023';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 365 THEN RAISE EXCEPTION 'Validity must be 1-365 days' USING ERRCODE = '22023'; END IF;
  IF p_label IS NOT NULL AND char_length(p_label) > 80 THEN RAISE EXCEPTION 'Label is too long' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM reputation_signing_keys WHERE kid = p_kid AND status = 'active') THEN
    RAISE EXCEPTION 'Credential signing is not configured.' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(nullif(btrim(company_name), ''), 'Unnamed business') INTO v_company FROM profiles WHERE id = v_owner;
  IF v_type = 'technician' THEN
    SELECT * INTO v_tm FROM team_members WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002'; END IF;
    IF NOT (v_manager OR (v_tm.user_id IS NOT NULL AND v_tm.user_id = auth.uid())) THEN
      RAISE EXCEPTION 'Only the technician or a manager can issue this credential.' USING ERRCODE = '42501';
    END IF;
    v_name := left(coalesce(nullif(btrim(v_tm.member_name), ''), 'Technician'), 80);
  ELSE
    IF NOT v_manager THEN RAISE EXCEPTION 'Only an owner or admin can issue a business credential.' USING ERRCODE = '42501'; END IF;
    v_name := left(v_company, 80);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM reputation_consents c
                  WHERE c.account_owner_id = v_owner AND c.subject_type = v_type AND c.technician_id IS NOT DISTINCT FROM p_technician_id
                    AND c.revoked_at IS NULL AND v_scopes <@ c.scopes) THEN
    RAISE EXCEPTION 'Consent is missing for one or more of the selected items.' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM reputation_credentials r WHERE r.account_owner_id = v_owner AND r.subject_type = v_type
        AND r.technician_id IS NOT DISTINCT FROM p_technician_id AND r.status = 'active' AND r.revoked_at IS NULL AND r.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'Too many active credentials - revoke one first.' USING ERRCODE = '54000';
  END IF;
  DELETE FROM reputation_credentials WHERE account_owner_id = v_owner AND status = 'pending' AND issued_at < now() - interval '1 hour';

  -- Claims (server-built; counts and rates only) ------------------------------------------------------------------
  IF v_type = 'technician' THEN
    v_m := coalesce(public.build_technician_identity_payload(p_technician_id, 365) -> 'metrics', '{}'::jsonb);
  ELSE
    WITH done AS (
      SELECT j.evidence_verified_at,
             (EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = j.user_id AND r.is_rework = true AND r.rework_of_job_id = j.id)
              OR coalesce(o.caused_callback, false)) AS reworked,
             (SELECT avg(rv.rating)::numeric FROM review_requests rv WHERE rv.job_id = j.id AND rv.rating IS NOT NULL) AS rating
        FROM jobs j LEFT JOIN job_outcomes o ON o.job_id = j.id
       WHERE j.user_id = v_owner AND j.job_status = 'completed'
         AND coalesce(j.completed_at, j.scheduled_datetime) >= now() - interval '365 days'
    )
    SELECT jsonb_build_object(
      'jobs_completed', count(*),
      'verified_jobs', count(*) FILTER (WHERE evidence_verified_at IS NOT NULL),
      'first_time_fix_rate', round(100.0 * count(*) FILTER (WHERE NOT reworked) / nullif(count(*), 0), 1),
      'callback_rate', round(100.0 * count(*) FILTER (WHERE reworked) / nullif(count(*), 0), 1),
      'rated_jobs', count(rating),
      'customer_rating_avg', round(avg(rating), 2))
    INTO v_m FROM done;
  END IF;
  v_jobs := coalesce((v_m ->> 'jobs_completed')::integer, 0);

  IF 'verified_jobs' = ANY (v_scopes) THEN
    v_part := jsonb_build_object('window_days', 365, 'jobs_completed', v_jobs, 'verified_jobs', coalesce((v_m ->> 'verified_jobs')::integer, 0));
    IF v_type = 'technician' THEN
      v_part := v_part || jsonb_build_object('lifetime_jobs', coalesce((v_m ->> 'lifetime_jobs')::integer, 0),
                                             'lifetime_verified_jobs', coalesce((v_m ->> 'lifetime_verified_jobs')::integer, 0));
    END IF;
    v_claims := v_claims || jsonb_build_object('verified_jobs', v_part);
  END IF;

  IF 'outcomes' = ANY (v_scopes) THEN
    IF v_jobs < 10 THEN
      v_part := jsonb_build_object('insufficient_sample', true, 'min_sample', 10);
    ELSE
      v_part := jsonb_strip_nulls(jsonb_build_object(
        'insufficient_sample', false,
        'first_time_fix_rate', v_m -> 'first_time_fix_rate',
        'callback_rate', v_m -> 'callback_rate',
        'rated_jobs', v_m -> 'rated_jobs',
        'customer_rating_avg', CASE WHEN coalesce((v_m ->> 'rated_jobs')::integer, 0) >= 10 THEN v_m -> 'customer_rating_avg' END,
        'response_reliability', CASE WHEN coalesce((v_m ->> 'timed_jobs')::integer, 0) >= 10 THEN v_m -> 'response_reliability' END));
    END IF;
    v_claims := v_claims || jsonb_build_object('outcomes', v_part);
  END IF;

  IF 'license_checks' = ANY (v_scopes) THEN
    IF v_type = 'technician' THEN
      SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'type', left(c.credential_type, 60),
          'name', left(c.credential_name, 80),
          'issuer', left(c.issuing_authority, 80),
          'expires_at', c.expires_at,
          'check', CASE WHEN lc.credential_id IS NOT NULL THEN 'issuer_checked' ELSE 'self_reported' END,
          'checked_at', lc.checked_at::date,
          'check_method', lc.method)) ORDER BY c.credential_type), '[]'::jsonb)
        INTO v_part
        FROM technician_credentials c LEFT JOIN reputation_license_checks lc ON lc.credential_id = c.id
       WHERE c.technician_id = p_technician_id AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at >= current_date);
    ELSE
      SELECT jsonb_build_object(
          'technicians_total', count(*),
          'technicians_with_checked_license', count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM technician_credentials c JOIN reputation_license_checks lc ON lc.credential_id = c.id
              WHERE c.technician_id = m.id AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at >= current_date))))
        INTO v_part
        FROM team_members m WHERE m.account_owner_id = v_owner AND m.role = 'technician' AND m.invite_status = 'active';
    END IF;
    v_claims := v_claims || jsonb_build_object('license_checks', v_part);
  END IF;

  v_exp := v_iat + p_valid_days::bigint * 86400;
  v_env := jsonb_build_object(
    'v', 1, 'schema', 'vireek.reputation.v1', 'iss', 'vireek', 'id', v_id, 'kid', p_kid,
    'sub', jsonb_build_object('type', v_type, 'name', v_name, 'company', left(v_company, 80)),
    'scopes', to_jsonb(v_scopes), 'claims', v_claims, 'iat', v_iat, 'exp', v_exp);

  INSERT INTO reputation_credentials (id, account_owner_id, subject_type, technician_id, subject_name, label, scopes, envelope, kid, status, issued_at, expires_at)
  VALUES (v_id, v_owner, v_type, p_technician_id, v_name, left(nullif(btrim(p_label), ''), 80), v_scopes, v_env, p_kid, 'pending',
          to_timestamp(v_iat), to_timestamp(v_exp));
  RETURN jsonb_build_object('id', v_id, 'envelope', v_env);
END;
$$;

-- 9) Attach signature (edge function, service role) -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_attach_signature(p_id uuid, p_payload text, p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r reputation_credentials%ROWTYPE;
  v_json jsonb;
BEGIN
  IF p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9_-]{86}$' THEN RAISE EXCEPTION 'Bad signature format' USING ERRCODE = '22023'; END IF;
  BEGIN v_json := p_payload::jsonb; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Payload is not JSON' USING ERRCODE = '22023'; END;
  SELECT * INTO r FROM reputation_credentials WHERE id = p_id AND status = 'pending' AND issued_at > now() - interval '1 hour' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No pending credential' USING ERRCODE = 'P0002'; END IF;
  IF v_json <> r.envelope THEN RAISE EXCEPTION 'Signed payload does not match the prepared credential' USING ERRCODE = '22023'; END IF;
  UPDATE reputation_credentials SET status = 'active', payload = p_payload, signature = p_signature WHERE id = p_id;
  PERFORM public.log_audit_event(r.account_owner_id, 'reputation.credential_issued', 'reputation_credentials', p_id::text,
    jsonb_build_object('subject_type', r.subject_type, 'scopes', to_jsonb(r.scopes), 'kid', r.kid, 'issued_by', r.issued_by, 'expires_at', r.expires_at));
  RETURN jsonb_build_object('id', p_id, 'expires_at', r.expires_at);
END;
$$;

-- 10) Revoke ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_revoke_credential(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r reputation_credentials%ROWTYPE;
  v_self boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  SELECT * INTO r FROM reputation_credentials WHERE id = p_id AND account_owner_id = v_owner AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credential not found' USING ERRCODE = 'P0002'; END IF;
  v_self := r.technician_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members m WHERE m.id = r.technician_id AND m.user_id = auth.uid());
  IF NOT (public.identity_is_manager() OR v_self) THEN RAISE EXCEPTION 'You cannot revoke this credential.' USING ERRCODE = '42501'; END IF;
  IF r.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('id', p_id, 'revoked_at', r.revoked_at, 'already', true); END IF;
  UPDATE reputation_credentials SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = left(coalesce(nullif(btrim(p_reason), ''), 'revoked_by_issuer'), 200)
   WHERE id = p_id RETURNING revoked_at INTO r.revoked_at;
  PERFORM public.log_audit_event(v_owner, 'reputation.credential_revoked', 'reputation_credentials', p_id::text,
    jsonb_build_object('reason', left(coalesce(nullif(btrim(p_reason), ''), 'revoked_by_issuer'), 200)));
  RETURN jsonb_build_object('id', p_id, 'revoked_at', r.revoked_at, 'already', false);
END;
$$;

-- 11) Public lookups (service role) -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_public_lookup(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((
    SELECT jsonb_build_object('found', true, 'payload', c.payload, 'signature', c.signature, 'kid', c.kid,
                              'revoked_at', c.revoked_at, 'public_jwk', k.public_jwk, 'key_status', k.status)
      FROM reputation_credentials c JOIN reputation_signing_keys k ON k.kid = c.kid
     WHERE c.id = p_id AND c.status = 'active'
  ), jsonb_build_object('found', false));
$$;

CREATE OR REPLACE FUNCTION public.reputation_active_keys()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('kid', kid, 'publicJwk', public_jwk, 'status', status) ORDER BY created_at), '[]'::jsonb)
    FROM reputation_signing_keys;
$$;

-- 12) Dashboard overview ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reputation_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean := public.identity_is_manager();
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  RETURN jsonb_build_object(
    'is_manager', v_manager,
    'self_technician_id', v_me,
    'company', (SELECT coalesce(nullif(btrim(company_name), ''), 'Unnamed business') FROM profiles WHERE id = v_owner),
    'technicians', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', coalesce(nullif(btrim(m.member_name), ''), 'Technician')) ORDER BY m.member_name)
        FROM team_members m WHERE m.account_owner_id = v_owner AND m.role = 'technician' AND m.invite_status = 'active' AND (v_manager OR m.id = v_me)), '[]'::jsonb),
    'consents', coalesce((SELECT jsonb_agg(jsonb_build_object('technician_id', c.technician_id, 'subject_type', c.subject_type, 'scopes', to_jsonb(c.scopes), 'granted_at', c.granted_at))
        FROM reputation_consents c WHERE c.account_owner_id = v_owner AND c.revoked_at IS NULL AND (v_manager OR c.technician_id = v_me)), '[]'::jsonb),
    'credentials', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.issued_at DESC) FROM (
        SELECT r.id, r.subject_type, r.technician_id, r.subject_name, r.label, r.scopes, r.issued_at, r.expires_at, r.revoked_at, r.revoked_reason
          FROM reputation_credentials r
         WHERE r.account_owner_id = v_owner AND r.status = 'active' AND (v_manager OR r.technician_id = v_me)
         ORDER BY r.issued_at DESC LIMIT 100) x), '[]'::jsonb),
    'licenses', CASE WHEN v_manager THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'technician_id', c.technician_id, 'type', c.credential_type, 'name', c.credential_name, 'issuer', c.issuing_authority,
        'expires_at', c.expires_at, 'checked_at', lc.checked_at, 'method', lc.method) ORDER BY c.expires_at NULLS LAST)
        FROM technician_credentials c JOIN team_members m ON m.id = c.technician_id AND m.account_owner_id = v_owner
        LEFT JOIN reputation_license_checks lc ON lc.credential_id = c.id
        WHERE c.status = 'active'), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END;
$$;

-- 13) Grants ----------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.rcr_guard_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reputation_on_team_member_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reputation_on_license_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reputation_attach_signature(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reputation_public_lookup(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reputation_active_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reputation_attach_signature(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reputation_public_lookup(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reputation_active_keys() TO service_role;

REVOKE ALL ON FUNCTION public.reputation_consent_set(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reputation_record_license_check(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reputation_prepare_credential(uuid, text[], integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reputation_revoke_credential(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reputation_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reputation_consent_set(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reputation_record_license_check(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reputation_prepare_credential(uuid, text[], integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reputation_revoke_credential(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reputation_overview() TO authenticated;
