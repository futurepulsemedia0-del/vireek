/*
  # Terms acceptance evidence + configurable grace (extends 20290306000200_legal_terms_versioning.sql)

  Adds to the existing legal_document_versions / legal_acceptances system (nothing is duplicated):
    1. Evidence on every acceptance: document hash snapshot, IP address (+ which header it came from), user agent,
       account owner, small whitelisted context (plan id, authority confirmation).
    2. New acceptance sources: 'plan_change' and 'msa_click_through' (record_legal_click_through()).
       Click-through events are NOT unique per (user, version): each affirmative click is its own evidence row
       (60 s dedupe for identical double-clicks, 30 rows/hour/user cap).
       Click-throughs never clear the re-acceptance gate (only signup/gate/settings do). [COUNSEL]
    3. Configurable grace: legal_gate_settings.grace_days (default 0 = unchanged behaviour: blocked on the effective date).
       Status JSON gains per-document `blocking` and `deadline`; `decision` = must_accept only when something is blocking.
    4. Gate scope: legal_gate_settings.non_gating_doc_keys (default {msa}) - the MSA binds only customers who signed it,
       so a new MSA version must never lock every account out.
    5. Staff: staff_legal_acceptance_history() (audit-logged read of IP/UA), staff_legal_gate_settings(),
       staff_set_legal_grace_days(), staff_redact_legal_network_data() (retention/erasure; nulls IP/UA only), richer
       staff_legal_documents().
    6. Baseline: msa v1 (date from the "Last updated" line of /msa), not material, no counsel confirmation.

  IP caveat [VERIFY]: the IP is read from the PostgREST request.headers GUC (cf-connecting-ip, x-real-ip, first
  x-forwarded-for hop). Which header your Supabase gateway sets authoritatively has not been verified; ip_source
  records the header used so reliability can be judged per row. Treat IP as supporting evidence, not proof.
  Retention of IP/UA is a privacy decision [COUNSEL]; use staff_redact_legal_network_data().

  Idempotent: safe to run twice. Run AFTER 20290306000200.
*/

-- rollback (manual; acceptances are evidence, keep the columns):
--   DROP FUNCTION IF EXISTS public.record_legal_click_through(text, text[], jsonb), public.staff_legal_acceptance_history(uuid, text, text, integer, timestamptz),
--     public.staff_legal_gate_settings(), public.staff_set_legal_grace_days(integer, text),
--     public.staff_redact_legal_network_data(timestamptz, uuid, text), public.legal_record_acceptances(uuid, uuid[], text, jsonb),
--     public.legal_request_context(), public.legal_clean_context(jsonb), public.legal_grace_days();
--   then re-run 20290306000200_legal_terms_versioning.sql to restore the previous function bodies.

-- 1) evidence columns -----------------------------------------------------------------------------
ALTER TABLE public.legal_acceptances
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS ip_address inet,
  ADD COLUMN IF NOT EXISTS ip_source text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS account_owner_id uuid,   -- deliberately no FK: evidence outlives account deletion and the immutability trigger forbids FK updates
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_sha_chk;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_sha_chk
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_ua_chk;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_ua_chk
  CHECK (user_agent IS NULL OR char_length(user_agent) <= 512);
ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_ip_source_chk;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_ip_source_chk
  CHECK (ip_source IS NULL OR ip_source IN ('cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'));
ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_context_chk;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_context_chk
  CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 1024);

ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_source_check;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_source_check
  CHECK (source IN ('signup', 'gate', 'settings', 'plan_change', 'msa_click_through'));

-- one acceptance per (user, version) for the screen-based sources; click-through events may repeat
ALTER TABLE public.legal_acceptances DROP CONSTRAINT IF EXISTS legal_acceptances_once;
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_once_idx
  ON public.legal_acceptances (user_id, version_id) WHERE source IN ('signup', 'gate', 'settings');
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_owner ON public.legal_acceptances (account_owner_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user_time ON public.legal_acceptances (user_id, accepted_at DESC);

-- append-only trigger: same rules + the retention path (null IP/UA only, inside the staff redaction function)
CREATE OR REPLACE FUNCTION public.legal_acceptances_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('app.legal_redaction', true), '') = 'on'
     AND NEW.ip_address IS NULL AND NEW.user_agent IS NULL AND NEW.ip_source IS NULL
     AND (to_jsonb(NEW) - 'ip_address' - 'user_agent' - 'ip_source') = (to_jsonb(OLD) - 'ip_address' - 'user_agent' - 'ip_source') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legal_acceptances is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- 2) gate settings (singleton) ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_gate_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 90),
  non_gating_doc_keys text[] NOT NULL DEFAULT ARRAY['msa']::text[],
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.legal_gate_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.legal_gate_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legal_gate_settings FROM anon, authenticated;   -- no client policy: read/write only via the functions below

CREATE OR REPLACE FUNCTION public.legal_grace_days()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT grace_days FROM public.legal_gate_settings WHERE id), 0)
$$;
REVOKE ALL ON FUNCTION public.legal_grace_days() FROM PUBLIC, anon, authenticated;

-- 3) request context + context whitelist ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_request_context(OUT ip_address inet, OUT ip_source text, OUT user_agent text)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  h jsonb;
  cand text;
  i integer;
BEGIN
  BEGIN
    h := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    h := NULL;
  END;
  IF h IS NULL OR jsonb_typeof(h) <> 'object' THEN
    RETURN;
  END IF;
  h := (SELECT COALESCE(jsonb_object_agg(lower(t.k), t.v), '{}'::jsonb) FROM jsonb_each(h) AS t(k, v));
  user_agent := NULLIF(left(regexp_replace(coalesce(h->>'user-agent', ''), '[[:cntrl:]]', '', 'g'), 512), '');
  FOR i IN 1..3 LOOP
    cand := CASE i
      WHEN 1 THEN h->>'cf-connecting-ip'
      WHEN 2 THEN h->>'x-real-ip'
      ELSE split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)
    END;
    cand := btrim(coalesce(cand, ''));
    CONTINUE WHEN cand = '' OR position('/' IN cand) > 0;
    BEGIN
      ip_address := cand::inet;
      ip_source := (ARRAY['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'])[i];
      EXIT;
    EXCEPTION WHEN others THEN
      ip_address := NULL;
      ip_source := NULL;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.legal_request_context() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.legal_clean_context(p_ctx jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(t.k, left(btrim(t.v), 120)), '{}'::jsonb)
  FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_ctx) = 'object' THEN p_ctx ELSE '{}'::jsonb END) AS t(k, v)
  WHERE t.k IN ('plan_id', 'from_plan_id', 'billing_interval', 'authority_confirmed', 'signer_title') AND t.v IS NOT NULL
$$;

-- 4) the single writer ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_record_acceptances(p_uid uuid, p_version_ids uuid[], p_source text, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_owner uuid;
  v_n integer;
  v_clean jsonb := public.legal_clean_context(p_context);
BEGIN
  SELECT * INTO v_ctx FROM public.legal_request_context();
  BEGIN
    v_owner := COALESCE(public.get_account_owner_id(), p_uid);
  EXCEPTION WHEN others THEN
    v_owner := p_uid;
  END;

  INSERT INTO legal_acceptances (user_id, version_id, doc_key, version, source, content_sha256, ip_address, ip_source, user_agent, account_owner_id, context)
  SELECT p_uid, v.id, v.doc_key, v.version, p_source, v.content_sha256, v_ctx.ip_address, v_ctx.ip_source, v_ctx.user_agent, v_owner, v_clean
  FROM legal_document_versions v
  WHERE v.id = ANY (p_version_ids)
    AND (
      p_source NOT IN ('plan_change', 'msa_click_through')
      OR NOT EXISTS (
        SELECT 1 FROM legal_acceptances a
        WHERE a.user_id = p_uid AND a.version_id = v.id AND a.source = p_source
          AND a.context = v_clean AND a.accepted_at > now() - interval '60 seconds'
      )
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.legal_record_acceptances(uuid, uuid[], text, jsonb) FROM PUBLIC, anon, authenticated;

-- 5) the gate decision, with grace and gate scope -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_acceptance_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_created timestamptz;
  v_required jsonb;
  v_grace integer := public.legal_grace_days();
  v_skip text[] := COALESCE((SELECT non_gating_doc_keys FROM public.legal_gate_settings WHERE id), ARRAY['msa']::text[]);
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('decision', 'ok', 'required', '[]'::jsonb);
  END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  IF v_created IS NULL THEN
    v_created := now();
  END IF;

  WITH docs AS (
    SELECT DISTINCT doc_key FROM legal_document_versions WHERE status = 'published' AND doc_key <> ALL (v_skip)
  ),
  accepted AS (
    SELECT d.doc_key,
           COALESCE(
             (SELECT max(a.version) FROM legal_acceptances a
               WHERE a.user_id = v_uid AND a.doc_key = d.doc_key AND a.source IN ('signup', 'gate', 'settings')),
             (SELECT max(v.version) FROM legal_document_versions v
               WHERE v.doc_key = d.doc_key AND v.status = 'published' AND v.effective_at <= v_created),
             0
           ) AS accepted_version
    FROM docs d
  ),
  pending AS (
    SELECT v.*, ac.accepted_version
    FROM legal_document_versions v
    JOIN accepted ac ON ac.doc_key = v.doc_key
    WHERE v.status = 'published' AND v.is_material AND v.effective_at <= now() AND v.version > ac.accepted_version
  ),
  per_doc AS (
    SELECT DISTINCT ON (p.doc_key) p.id, p.doc_key, p.version, p.title, p.effective_at, p.content_path, p.accepted_version,
           (SELECT min(q.effective_at) FROM pending q WHERE q.doc_key = p.doc_key) + make_interval(days => v_grace) AS deadline
    FROM pending p ORDER BY p.doc_key, p.version DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'doc_key', l.doc_key, 'version_id', l.id, 'version', l.version, 'title', l.title,
      'effective_at', l.effective_at, 'content_path', l.content_path, 'accepted_version', l.accepted_version,
      'deadline', l.deadline, 'blocking', l.deadline <= now(),
      'versions', (SELECT jsonb_agg(jsonb_build_object('version', p.version, 'effective_at', p.effective_at, 'changes', p.changes) ORDER BY p.version)
                   FROM pending p WHERE p.doc_key = l.doc_key)
    ) ORDER BY l.doc_key), '[]'::jsonb)
  INTO v_required FROM per_doc l;

  RETURN jsonb_build_object(
    'decision', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_required) e WHERE (e->>'blocking')::boolean) THEN 'must_accept' ELSE 'ok' END,
    'required', v_required
  );
END;
$$;
REVOKE ALL ON FUNCTION public.legal_acceptance_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.legal_acceptance_status() TO authenticated;

-- 6) accept (gate screen) and signup, now with evidence ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_legal_versions(p_version_ids uuid[], p_source text DEFAULT 'gate')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found integer;
  v_inserted integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('gate', 'settings') THEN
    RAISE EXCEPTION 'legal_guardrail: invalid source.' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(p_version_ids) AS x WHERE x IS NOT NULL;
  IF coalesce(array_length(v_ids, 1), 0) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'legal_guardrail: between 1 and 10 versions can be accepted at once.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found FROM legal_document_versions WHERE id = ANY (v_ids) AND status = 'published' AND effective_at <= now();
  IF v_found <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'legal_guardrail: unknown, retired or not-yet-effective version.' USING ERRCODE = 'check_violation';
  END IF;

  v_inserted := public.legal_record_acceptances(v_uid, v_ids, p_source, '{}'::jsonb);

  IF v_inserted > 0 THEN
    PERFORM public.log_audit_event(
      v_uid, 'legal_terms_accepted', 'legal_acceptances', NULL,
      jsonb_build_object('source', p_source, 'versions',
        (SELECT jsonb_agg(jsonb_build_object('doc_key', v.doc_key, 'version', v.version) ORDER BY v.doc_key) FROM legal_document_versions v WHERE v.id = ANY (v_ids)))
    );
  END IF;
  RETURN jsonb_build_object('accepted', v_inserted, 'requested', array_length(v_ids, 1));
END;
$$;
REVOKE ALL ON FUNCTION public.accept_legal_versions(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_legal_versions(uuid[], text) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_current_legal_documents(p_source text DEFAULT 'signup')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_created timestamptz;
  v_ids uuid[];
  v_n integer;
  v_skip text[] := COALESCE((SELECT non_gating_doc_keys FROM public.legal_gate_settings WHERE id), ARRAY['msa']::text[]);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_source <> 'signup' THEN
    RAISE EXCEPTION 'legal_guardrail: invalid source.' USING ERRCODE = '22023';
  END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  IF v_created IS NULL OR v_created < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'legal_guardrail: only available right after signup.' USING ERRCODE = '42501';
  END IF;

  -- the signup checkbox covers the documents it links to; click-through-only documents (MSA) are excluded
  SELECT COALESCE(array_agg(l.id), ARRAY[]::uuid[]) INTO v_ids FROM (
    SELECT DISTINCT ON (doc_key) id FROM legal_document_versions
    WHERE status = 'published' AND effective_at <= now() AND doc_key <> ALL (v_skip) ORDER BY doc_key, version DESC
  ) l;
  v_n := public.legal_record_acceptances(v_uid, v_ids, 'signup', '{}'::jsonb);

  IF v_n > 0 THEN
    PERFORM public.log_audit_event(v_uid, 'legal_terms_accepted', 'legal_acceptances', NULL,
                                   jsonb_build_object('source', 'signup', 'documents', v_n));
  END IF;
  RETURN jsonb_build_object('accepted', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_current_legal_documents(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_current_legal_documents(text) TO authenticated;

-- 7) click-through (plan change, MSA) ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_legal_click_through(p_source text, p_doc_keys text[], p_context jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keys text[];
  v_ids uuid[];
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('plan_change', 'msa_click_through') THEN
    RAISE EXCEPTION 'legal_guardrail: invalid source.' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT k), ARRAY[]::text[]) INTO v_keys FROM unnest(p_doc_keys) AS k WHERE k ~ '^[a-z][a-z0-9_-]{1,40}$';
  IF coalesce(array_length(v_keys, 1), 0) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'legal_guardrail: between 1 and 5 valid document keys are required.' USING ERRCODE = '22023';
  END IF;
  IF p_source = 'msa_click_through' AND NOT ('msa' = ANY (v_keys)) THEN
    RAISE EXCEPTION 'legal_guardrail: an MSA click-through must include the msa document.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM legal_acceptances WHERE user_id = v_uid AND source IN ('plan_change', 'msa_click_through')
        AND accepted_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'legal_guardrail: too many acceptance events; try again later.' USING ERRCODE = '54000';
  END IF;

  SELECT COALESCE(array_agg(l.id), ARRAY[]::uuid[]) INTO v_ids FROM (
    SELECT DISTINCT ON (doc_key) id FROM legal_document_versions
    WHERE status = 'published' AND effective_at <= now() AND doc_key = ANY (v_keys) ORDER BY doc_key, version DESC
  ) l;
  IF coalesce(array_length(v_ids, 1), 0) <> array_length(v_keys, 1) THEN
    RAISE EXCEPTION 'legal_guardrail: no effective published version for one of the documents.' USING ERRCODE = 'check_violation';
  END IF;

  v_n := public.legal_record_acceptances(v_uid, v_ids, p_source, p_context);
  IF v_n > 0 THEN
    PERFORM public.log_audit_event(v_uid, 'legal_click_through_recorded', 'legal_acceptances', NULL,
                                   jsonb_build_object('source', p_source, 'documents', to_jsonb(v_keys), 'recorded', v_n));
  END IF;
  RETURN jsonb_build_object('recorded', v_n, 'requested', array_length(v_keys, 1));
END;
$$;
REVOKE ALL ON FUNCTION public.record_legal_click_through(text, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_legal_click_through(text, text[], jsonb) TO authenticated;

-- 8) staff ----------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_legal_acceptance_history(
  p_user_id uuid DEFAULT NULL, p_email text DEFAULT NULL, p_doc_key text DEFAULT NULL,
  p_limit integer DEFAULT 100, p_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target uuid := p_user_id;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_email text := NULLIF(btrim(coalesce(p_email, '')), '');
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF v_target IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_target FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  END IF;
  IF v_target IS NULL AND p_user_id IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'legal_guardrail: give a user id or an email.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.accepted_at DESC), '[]'::jsonb) INTO v_out FROM (
    SELECT a.id, a.accepted_at, a.doc_key, a.version, v.title, a.source, a.content_sha256,
           host(a.ip_address) AS ip_address, a.ip_source, a.user_agent, a.user_id, u.email, a.account_owner_id, a.context
    FROM legal_acceptances a
    JOIN legal_document_versions v ON v.id = a.version_id
    LEFT JOIN auth.users u ON u.id = a.user_id
    WHERE v_target IS NOT NULL AND (a.user_id = v_target OR a.account_owner_id = v_target)
      AND (p_doc_key IS NULL OR a.doc_key = p_doc_key)
      AND (p_before IS NULL OR a.accepted_at < p_before)
    ORDER BY a.accepted_at DESC
    LIMIT v_limit
  ) t;

  PERFORM public.log_audit_event(auth.uid(), 'legal_acceptance_history_viewed', 'legal_acceptances', v_target::text,
                                 jsonb_build_object('doc_key', p_doc_key, 'rows', jsonb_array_length(v_out)));
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_legal_acceptance_history(uuid, text, text, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_legal_acceptance_history(uuid, text, text, integer, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_legal_gate_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT jsonb_build_object('grace_days', grace_days, 'non_gating_doc_keys', to_jsonb(non_gating_doc_keys), 'updated_at', updated_at)
          FROM legal_gate_settings WHERE id);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_legal_gate_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_legal_gate_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_legal_grace_days(p_days integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old integer;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days NOT BETWEEN 0 AND 90 THEN
    RAISE EXCEPTION 'legal_guardrail: grace must be between 0 and 90 days.' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'legal_guardrail: a written reason (>= 10 characters) is required.' USING ERRCODE = '22023';
  END IF;
  SELECT grace_days INTO v_old FROM legal_gate_settings WHERE id FOR UPDATE;
  UPDATE legal_gate_settings SET grace_days = p_days, updated_by = auth.uid(), updated_at = now() WHERE id;
  PERFORM public.log_audit_event(auth.uid(), 'legal_grace_days_changed', 'legal_gate_settings', 'singleton',
                                 jsonb_build_object('from', v_old, 'to', p_days, 'reason', left(v_reason, 500)));
  RETURN jsonb_build_object('grace_days', p_days, 'previous', v_old);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_legal_grace_days(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_legal_grace_days(integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_redact_legal_network_data(p_before timestamptz, p_user_id uuid DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_before IS NULL OR p_before > now() THEN
    RAISE EXCEPTION 'legal_guardrail: p_before must be a past timestamp.' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'legal_guardrail: a written reason (>= 10 characters) is required.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.legal_redaction', 'on', true);
  UPDATE legal_acceptances
     SET ip_address = NULL, ip_source = NULL, user_agent = NULL
   WHERE accepted_at < p_before
     AND (p_user_id IS NULL OR user_id = p_user_id OR account_owner_id = p_user_id)
     AND (ip_address IS NOT NULL OR user_agent IS NOT NULL OR ip_source IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.legal_redaction', 'off', true);
  PERFORM public.log_audit_event(auth.uid(), 'legal_network_data_redacted', 'legal_acceptances', p_user_id::text,
                                 jsonb_build_object('before', p_before, 'rows', v_n, 'reason', left(v_reason, 500)));
  RETURN jsonb_build_object('redacted', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_redact_legal_network_data(timestamptz, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_redact_legal_network_data(timestamptz, uuid, text) TO authenticated;

-- richer overview: gating flag, hash presence, distinct acceptors; pending only for gating documents
CREATE OR REPLACE FUNCTION public.staff_legal_documents()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_skip text[] := COALESCE((SELECT non_gating_doc_keys FROM public.legal_gate_settings WHERE id), ARRAY['msa']::text[]);
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.doc_key, t.version DESC)
    FROM (
      SELECT v.id, v.doc_key, v.version, v.title, v.effective_at, v.is_material, v.status,
             jsonb_array_length(v.changes) AS change_count, v.notice_waiver_reason,
             v.counsel_confirmed_at, v.published_at,
             (v.content_sha256 IS NOT NULL) AS has_hash,
             NOT (v.doc_key = ANY (v_skip)) AS gating,
             (SELECT count(DISTINCT a.user_id) FROM legal_acceptances a WHERE a.version_id = v.id) AS accepted_count,
             CASE WHEN v.doc_key = ANY (v_skip) THEN NULL ELSE
               (SELECT count(*) FROM profiles p
                 WHERE p.created_at < v.effective_at
                   AND NOT EXISTS (SELECT 1 FROM legal_acceptances a
                                    WHERE a.user_id = p.id AND a.doc_key = v.doc_key AND a.version >= v.version
                                      AND a.source IN ('signup', 'gate', 'settings')))
             END AS pending_count
      FROM legal_document_versions v
      ORDER BY v.doc_key, v.version DESC
      LIMIT 200
    ) t
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_legal_documents() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_legal_documents() TO authenticated;

-- 9) baseline: msa v1 (the date comes from the "Last updated: October 8, 2026" line on /msa). Not material; no counsel confirmation. [COUNSEL]
INSERT INTO public.legal_document_versions (doc_key, version, title, effective_at, is_material, changes, content_path)
VALUES ('msa', 1, 'Master Services Agreement', '2026-10-08T00:00:00Z', false, '[]'::jsonb, '/msa')
ON CONFLICT (doc_key, version) DO NOTHING;

/*
  Verification:
    select doc_key, version, is_material, effective_at from public.legal_document_versions order by 1, 2;
    select source, count(*), count(ip_address) as with_ip, count(content_sha256) as with_hash from public.legal_acceptances group by 1;
    select public.staff_legal_gate_settings();   -- as staff
    select public.staff_set_legal_grace_days(7, 'Give customers a week to review the update');   -- as staff
*/
