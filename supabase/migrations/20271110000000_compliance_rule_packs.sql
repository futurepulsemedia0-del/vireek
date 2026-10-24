-- =============================================================
-- Regulation-as-code compliance engine — rule packs, versions, staff review
--
-- NOT LEGAL ADVICE. Rules are a compliance aid and must be reviewed by
-- qualified counsel before they are approved.
--
-- * Global catalog: packs (one per jurisdiction) -> rules -> immutable,
--   effective-dated VERSIONS with source references and an owner-facing
--   explanation. Only status = 'approved' versions are ever enforced.
-- * Staff review workflow: draft -> in_review -> approved | rejected -> retired.
--   Approval needs notes + a named legal reviewer + sources. Authors cannot
--   approve their own work unless they are an 'admin' (solo-founder case);
--   self-approvals are flagged in the event log.
-- * Approved versions are frozen by a trigger (only retirement / shortening
--   effective_to is possible); every transition is an append-only event.
-- * Per-account: compliance_profiles (business state + license numbers),
--   compliance_evaluations (decision log), consent-ledger RPCs over the
--   existing append-only consent_records table.
--
-- Depends on: get_account_owner_id(), audit_log, consent_records,
--   customers, profiles, team_members, custom_roles.
--
-- Make yourself staff (run once in the SQL editor with YOUR login email):
--   INSERT INTO public.compliance_staff (user_id, role)
--   SELECT id, 'admin' FROM auth.users WHERE email = 'you@example.com'
--   ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.consent_records') IS NULL OR to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'consent_records / audit_log are missing — run the earlier migrations first.';
  END IF;
END $$;

-- 1. Widen consent types (ledger stays append-only) -------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.consent_records'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%consent_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.consent_records DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.consent_records ADD CONSTRAINT consent_records_consent_type_check
    CHECK (consent_type IN ('call_recording', 'marketing_sms', 'marketing_email', 'data_processing', 'marketing_call', 'ai_voice'));
END $$;

-- 2. Tables -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_staff (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('author', 'reviewer', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^US(-[A-Z]{2})?$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id    uuid NOT NULL REFERENCES public.compliance_packs(id) ON DELETE RESTRICT,
  rule_key   text NOT NULL CHECK (rule_key ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  kind       text NOT NULL CHECK (kind IN ('recording_consent', 'ai_disclosure', 'quiet_hours', 'consent_required',
                                           'license_display', 'rescission', 'required_notice', 'price_cap')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, rule_key)
);

CREATE TABLE IF NOT EXISTS public.compliance_rule_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            uuid NOT NULL REFERENCES public.compliance_rules(id) ON DELETE RESTRICT,
  version            integer NOT NULL CHECK (version >= 1),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'retired')),
  severity           text NOT NULL CHECK (severity IN ('block', 'require', 'warn', 'info')),
  applies_to         text[] NOT NULL CHECK (cardinality(applies_to) >= 1),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  owner_explanation  text NOT NULL CHECK (char_length(owner_explanation) BETWEEN 20 AND 2000),
  params             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  source_refs        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array'),
  effective_from     date NOT NULL,
  effective_to       date,                       -- exclusive: first day it NO LONGER applies
  authored_by        uuid,
  authored_by_email  text,
  submitted_at       timestamptz,
  reviewed_by        uuid,
  reviewed_by_email  text,
  reviewed_at        timestamptz,
  review_notes       text CHECK (review_notes IS NULL OR char_length(review_notes) <= 2000),
  legal_reviewer     text CHECK (legal_reviewer IS NULL OR char_length(legal_reviewer) BETWEEN 3 AND 120),
  legal_reviewed_at  timestamptz,
  retired_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status NOT IN ('approved', 'retired')
         OR (legal_reviewer IS NOT NULL AND legal_reviewed_at IS NOT NULL AND jsonb_array_length(source_refs) > 0))
);
CREATE INDEX IF NOT EXISTS idx_compliance_versions_status ON public.compliance_rule_versions (status);
CREATE INDEX IF NOT EXISTS idx_compliance_versions_rule ON public.compliance_rule_versions (rule_id, version DESC);

CREATE TABLE IF NOT EXISTS public.compliance_review_events (
  id          bigserial PRIMARY KEY,
  version_id  uuid NOT NULL REFERENCES public.compliance_rule_versions(id) ON DELETE CASCADE,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  notes       text,
  actor_id    uuid,
  actor_email text,
  self_review boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_events_version ON public.compliance_review_events (version_id, id);

CREATE TABLE IF NOT EXISTS public.compliance_profiles (
  user_id         uuid PRIMARY KEY,
  business_state  text CHECK (business_state IS NULL OR business_state ~ '^[A-Z]{2}$'),
  licenses        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(licenses) = 'array' AND jsonb_array_length(licenses) <= 20),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

CREATE TABLE IF NOT EXISTS public.compliance_evaluations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  surface            text NOT NULL CHECK (surface IN ('call', 'sms', 'email', 'quote', 'contract')),
  purpose            text,
  outcome            text NOT NULL CHECK (outcome IN ('allow', 'allow_with_actions', 'block')),
  subject_type       text,
  subject_id         text,
  business_state     text,
  counterparty_state text,
  summary            jsonb NOT NULL DEFAULT '[]'::jsonb,
  version_ids        uuid[] NOT NULL DEFAULT '{}',
  source             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_evaluations_user ON public.compliance_evaluations (user_id, created_at DESC);

ALTER TABLE public.compliance_staff         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_packs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_evaluations   ENABLE ROW LEVEL SECURITY;

-- Catalog + workflow tables are RPC-only (no client policies). Per-account
-- tables are readable by the account's team; writes go through RPCs / edge.
DROP POLICY IF EXISTS select_own_compliance_profile ON public.compliance_profiles;
CREATE POLICY select_own_compliance_profile ON public.compliance_profiles
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS select_own_compliance_evaluations ON public.compliance_evaluations;
CREATE POLICY select_own_compliance_evaluations ON public.compliance_evaluations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- 3. Immutability guards -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_versions_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'compliance_immutable: only drafts can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  NEW.updated_at := now();
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'compliance_immutable: retired versions cannot change';
  END IF;
  IF OLD.status IN ('approved', 'retired', 'in_review') THEN
    IF (NEW.rule_id, NEW.version, NEW.severity, NEW.applies_to, NEW.title, NEW.owner_explanation, NEW.params, NEW.source_refs, NEW.effective_from)
       IS DISTINCT FROM
       (OLD.rule_id, OLD.version, OLD.severity, OLD.applies_to, OLD.title, OLD.owner_explanation, OLD.params, OLD.source_refs, OLD.effective_from)
    THEN
      RAISE EXCEPTION 'compliance_immutable: content of a version under review or in force cannot be edited — create a new version';
    END IF;
    IF OLD.status = 'approved' AND NEW.status = 'approved'
       AND NEW.effective_to IS DISTINCT FROM OLD.effective_to
       AND (NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to)) THEN
      RAISE EXCEPTION 'compliance_immutable: an approved version can only be shortened';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_versions_guard ON public.compliance_rule_versions;
CREATE TRIGGER trg_compliance_versions_guard
  BEFORE UPDATE OR DELETE ON public.compliance_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.compliance_versions_guard();

CREATE OR REPLACE FUNCTION public.compliance_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'compliance_immutable: review events are append-only';
END $$;

DROP TRIGGER IF EXISTS trg_compliance_events_append_only ON public.compliance_review_events;
CREATE TRIGGER trg_compliance_events_append_only
  BEFORE UPDATE ON public.compliance_review_events
  FOR EACH ROW EXECUTE FUNCTION public.compliance_events_append_only();

-- 4. Permission helpers ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_staff_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.role FROM public.compliance_staff s WHERE s.user_id = auth.uid()
$$;

-- Same gate as the client (src/lib/complianceRules.ts): owner or can_edit_business_profile.
CREATE OR REPLACE FUNCTION public.compliance_can_manage()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE (tm.user_id = auth.uid()
             OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND (COALESCE(tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
             OR COALESCE(cr.permissions ->> 'can_edit_business_profile', 'false') = 'true')
    );
$$;

CREATE OR REPLACE FUNCTION public.compliance_require_staff(p_roles text[] DEFAULT NULL)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text;
BEGIN
  v_role := public.compliance_staff_role();
  IF v_role IS NULL OR (p_roles IS NOT NULL AND NOT (v_role = ANY (p_roles))) THEN
    RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END $$;

CREATE OR REPLACE FUNCTION public.compliance_actor_email()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.email FROM auth.users u WHERE u.id = auth.uid()
$$;

-- 5. Validation (mirror of validateVersionDraft in compliance-rules/engine.ts) -------
CREATE OR REPLACE FUNCTION public.compliance_version_errors(
  p_jurisdiction text, p_kind text, p_severity text, p_applies text[], p_title text, p_explanation text,
  p_params jsonb, p_refs jsonb, p_from date, p_to date
) RETURNS text[] LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  e text[] := '{}';
  v_states text[] := string_to_array(
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY', ' ');
  v_allowed text[];
  s text;
  w jsonb;
  d jsonb;
  x jsonb;
  v_start int;
  v_end int;
  v_num numeric;
BEGIN
  IF p_jurisdiction IS NULL OR p_jurisdiction !~ '^US(-[A-Z]{2})?$' THEN
    e := array_append(e, 'jurisdiction must be US or US-<state code>');
  ELSIF p_jurisdiction <> 'US' AND NOT (substr(p_jurisdiction, 4) = ANY (v_states)) THEN
    e := array_append(e, 'jurisdiction must be US or US-<state code>');
  END IF;
  v_allowed := CASE p_kind
    WHEN 'recording_consent' THEN ARRAY['call']
    WHEN 'ai_disclosure'     THEN ARRAY['call', 'sms', 'email']
    WHEN 'quiet_hours'       THEN ARRAY['call', 'sms']
    WHEN 'consent_required'  THEN ARRAY['call', 'sms', 'email']
    WHEN 'license_display'   THEN ARRAY['quote', 'contract']
    WHEN 'rescission'        THEN ARRAY['quote', 'contract']
    WHEN 'required_notice'   THEN ARRAY['call', 'sms', 'email', 'quote', 'contract']
    WHEN 'price_cap'         THEN ARRAY['quote', 'contract']
    ELSE NULL END;
  IF v_allowed IS NULL THEN
    RETURN array_append(e, 'unknown rule kind');
  END IF;
  IF COALESCE(p_severity, '') NOT IN ('block', 'require', 'warn', 'info') THEN e := array_append(e, 'severity must be block | require | warn | info'); END IF;
  IF char_length(btrim(COALESCE(p_title, ''))) < 3 THEN e := array_append(e, 'title is required'); END IF;
  IF char_length(btrim(COALESCE(p_explanation, ''))) < 20 THEN e := array_append(e, 'owner explanation must be at least 20 characters'); END IF;
  IF p_applies IS NULL OR cardinality(p_applies) = 0 THEN
    e := array_append(e, 'choose at least one surface');
  ELSE
    FOREACH s IN ARRAY p_applies LOOP
      IF NOT (s = ANY (v_allowed)) THEN e := array_append(e, format('%s cannot apply to %s', p_kind, s)); END IF;
    END LOOP;
  END IF;
  IF p_kind = 'license_display' AND p_jurisdiction = 'US' THEN e := array_append(e, 'license_display needs a state jurisdiction'); END IF;
  IF COALESCE(jsonb_typeof(p_refs), '') <> 'array' OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_refs) = 'array' THEN p_refs END), 0) = 0 THEN
    e := array_append(e, 'at least one source reference with a citation is required');
  ELSE
    FOR d IN SELECT * FROM jsonb_array_elements(p_refs) LOOP
      IF jsonb_typeof(d) <> 'object' THEN e := array_append(e, 'every source reference needs a citation'); EXIT; END IF;
      IF btrim(COALESCE(d ->> 'citation', '')) = '' THEN e := array_append(e, 'every source reference needs a citation'); EXIT; END IF;
    END LOOP;
  END IF;
  IF p_from IS NULL THEN e := array_append(e, 'effective-from is required'); END IF;
  IF p_to IS NOT NULL AND p_from IS NOT NULL AND p_to < p_from THEN e := array_append(e, 'effective-to must be on or after effective-from'); END IF;
  IF COALESCE(jsonb_typeof(p_params), '') <> 'object' THEN RETURN array_append(e, 'params must be an object'); END IF;

  IF p_kind = 'recording_consent' THEN
    IF COALESCE(p_params ->> 'mode', '') NOT IN ('all_party', 'one_party') THEN e := array_append(e, 'mode must be all_party or one_party'); END IF;
    IF p_params ->> 'mode' = 'all_party' AND btrim(COALESCE(p_params ->> 'script', '')) = '' THEN e := array_append(e, 'script is required for all_party'); END IF;
  ELSIF p_kind = 'ai_disclosure' THEN
    IF btrim(COALESCE(p_params ->> 'script', '')) = '' THEN e := array_append(e, 'script is required'); END IF;
  ELSIF p_kind = 'quiet_hours' THEN
    IF COALESCE(jsonb_typeof(p_params -> 'windows'), '') <> 'array' OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_params -> 'windows') = 'array' THEN p_params -> 'windows' END), 0) = 0 THEN
      e := array_append(e, 'windows must be a non-empty list');
    ELSE
      FOR w IN SELECT * FROM jsonb_array_elements(p_params -> 'windows') LOOP
        IF jsonb_typeof(w) <> 'object' THEN e := array_append(e, 'each window must be an object'); EXIT; END IF;
        IF COALESCE(jsonb_typeof(w -> 'days'), '') <> 'array' OR COALESCE(w ->> 'start', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
           OR COALESCE(w ->> 'end', '') !~ '^(([01]?[0-9]|2[0-3]):[0-5][0-9]|24:00)$' THEN
          e := array_append(e, 'each window needs days [0-6] and start/end as HH:MM'); EXIT;
        END IF;
        IF jsonb_array_length(w -> 'days') = 0 THEN e := array_append(e, 'each window needs at least one day'); EXIT; END IF;
        FOR x IN SELECT * FROM jsonb_array_elements(w -> 'days') LOOP
          IF jsonb_typeof(x) <> 'number' THEN e := array_append(e, 'days must be numbers 0-6'); EXIT; END IF;
          v_num := (x #>> '{}')::numeric;
          IF v_num <> trunc(v_num) OR v_num < 0 OR v_num > 6 THEN e := array_append(e, 'days must be numbers 0-6'); EXIT; END IF;
        END LOOP;
        v_start := split_part(w ->> 'start', ':', 1)::int * 60 + split_part(w ->> 'start', ':', 2)::int;
        v_end   := split_part(w ->> 'end', ':', 1)::int * 60 + split_part(w ->> 'end', ':', 2)::int;
        IF v_start >= v_end THEN e := array_append(e, 'window start must be before end'); EXIT; END IF;
      END LOOP;
    END IF;

  ELSIF p_kind = 'consent_required' THEN
    IF COALESCE(p_params ->> 'consentType', '') NOT IN ('call_recording', 'marketing_sms', 'marketing_email', 'data_processing', 'marketing_call', 'ai_voice') THEN
      e := array_append(e, 'consentType is not a known consent type');
    END IF;

  ELSIF p_kind = 'license_display' THEN
    IF btrim(COALESCE(p_params ->> 'licenseLabel', '')) = '' THEN e := array_append(e, 'licenseLabel is required'); END IF;
  ELSIF p_kind = 'rescission' THEN
    IF COALESCE(jsonb_typeof(p_params -> 'days'), '') <> 'number' THEN
      e := array_append(e, 'days must be an integer 1-30');
    ELSE
      v_num := (p_params ->> 'days')::numeric;
      IF v_num <> trunc(v_num) OR v_num < 1 OR v_num > 30 THEN e := array_append(e, 'days must be an integer 1-30'); END IF;
    END IF;
    IF COALESCE(jsonb_typeof(p_params -> 'minAmountCents'), '') <> 'number' THEN
      e := array_append(e, 'minAmountCents must be an integer >= 0');
    ELSE
      v_num := (p_params ->> 'minAmountCents')::numeric;
      IF v_num <> trunc(v_num) OR v_num < 0 THEN e := array_append(e, 'minAmountCents must be an integer >= 0'); END IF;
    END IF;
    IF COALESCE(jsonb_typeof(p_params -> 'saleLocations'), '') <> 'array' THEN
      e := array_append(e, 'saleLocations must be a non-empty list of known locations');
    ELSIF jsonb_array_length(p_params -> 'saleLocations') = 0
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_params -> 'saleLocations') l
                  WHERE jsonb_typeof(l) <> 'string' OR (l #>> '{}') NOT IN ('customer_home', 'business_premises', 'phone', 'online', 'other')) THEN
      e := array_append(e, 'saleLocations must be a non-empty list of known locations');
    END IF;

  ELSIF p_kind = 'required_notice' THEN
    IF COALESCE(p_params ->> 'noticeId', '') !~ '^[a-z0-9_-]{2,60}$' THEN e := array_append(e, 'noticeId must match [a-z0-9_-]{2,60}'); END IF;
    IF btrim(COALESCE(p_params ->> 'text', '')) = '' THEN e := array_append(e, 'text is required'); END IF;
  ELSIF p_kind = 'price_cap' THEN
    IF COALESCE(p_params ->> 'condition', '') <> 'emergency_declared' THEN e := array_append(e, 'condition must be emergency_declared'); END IF;
    IF COALESCE(jsonb_typeof(p_params -> 'maxIncreasePercent'), '') <> 'number' THEN
      e := array_append(e, 'maxIncreasePercent must be a number > 0 and <= 100');
    ELSE
      v_num := (p_params ->> 'maxIncreasePercent')::numeric;
      IF v_num <= 0 OR v_num > 100 THEN e := array_append(e, 'maxIncreasePercent must be a number > 0 and <= 100'); END IF;
    END IF;
  END IF;
  RETURN e;
END $$;

-- 6. Owner-facing: catalog of approved / retired versions (engine input) ---------------
CREATE OR REPLACE FUNCTION public.compliance_catalog()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'packSlug', p.slug, 'packName', p.name, 'ruleKey', r.rule_key, 'version', v.version,
    'jurisdiction', p.jurisdiction, 'kind', r.kind, 'severity', v.severity, 'appliesTo', to_jsonb(v.applies_to),
    'title', v.title, 'ownerExplanation', v.owner_explanation, 'params', v.params, 'sourceRefs', v.source_refs,
    'status', v.status, 'effectiveFrom', to_char(v.effective_from, 'YYYY-MM-DD'),
    'effectiveTo', to_char(v.effective_to, 'YYYY-MM-DD'),
    'legalReviewed', true, 'legalReviewer', v.legal_reviewer, 'legalReviewedAt', v.legal_reviewed_at
  ) ORDER BY p.jurisdiction, r.rule_key, v.version DESC), '[]'::jsonb)
  FROM public.compliance_rule_versions v
  JOIN public.compliance_rules r ON r.id = v.rule_id
  JOIN public.compliance_packs p ON p.id = r.pack_id
  WHERE v.status IN ('approved', 'retired')
$$;

-- 7. Owner-facing: business profile (state + licenses) ----------------------------------
CREATE OR REPLACE FUNCTION public.compliance_save_profile(p_state text, p_licenses jsonb, p_acknowledge boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_state text := NULLIF(upper(btrim(COALESCE(p_state, ''))), '');
  v_valid text[] := string_to_array(
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY', ' ');
  v_clean jsonb := '[]'::jsonb;
  l jsonb;
  v_ls text;
  v_exp text;
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN
    RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_state IS NOT NULL AND NOT (v_state = ANY (v_valid)) THEN
    RAISE EXCEPTION 'compliance_invalid: business state must be a US state code';
  END IF;
  IF p_licenses IS NULL OR jsonb_typeof(p_licenses) <> 'array' OR jsonb_array_length(p_licenses) > 20 THEN
    RAISE EXCEPTION 'compliance_invalid: licenses must be a list of up to 20 entries';
  END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(p_licenses) LOOP
    IF jsonb_typeof(l) <> 'object' THEN
      RAISE EXCEPTION 'compliance_invalid: each license needs a state and a number (max 40 characters)';
    END IF;
    v_ls := upper(btrim(COALESCE(l ->> 'state', '')));
    IF NOT (v_ls = ANY (v_valid)) OR btrim(COALESCE(l ->> 'number', '')) = '' OR char_length(l ->> 'number') > 40 THEN
      RAISE EXCEPTION 'compliance_invalid: each license needs a state and a number (max 40 characters)';
    END IF;
    v_exp := NULLIF(btrim(COALESCE(l ->> 'expiresOn', '')), '');
    IF v_exp IS NOT NULL AND v_exp !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'compliance_invalid: expiry must be YYYY-MM-DD';
    END IF;
    v_clean := v_clean || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'state', v_ls, 'number', btrim(l ->> 'number'),
      'trade', NULLIF(left(btrim(COALESCE(l ->> 'trade', '')), 60), ''), 'expiresOn', v_exp)));
  END LOOP;

  INSERT INTO public.compliance_profiles (user_id, business_state, licenses, acknowledged_at, acknowledged_by, updated_by)
  VALUES (v_owner, v_state, v_clean, CASE WHEN p_acknowledge THEN now() END, CASE WHEN p_acknowledge THEN auth.uid() END, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    business_state = EXCLUDED.business_state,
    licenses = EXCLUDED.licenses,
    acknowledged_at = CASE WHEN p_acknowledge THEN now() ELSE public.compliance_profiles.acknowledged_at END,
    acknowledged_by = CASE WHEN p_acknowledge THEN auth.uid() ELSE public.compliance_profiles.acknowledged_by END,
    updated_at = now(), updated_by = auth.uid();

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.compliance_actor_email(), 'compliance.profile.save', 'compliance_profiles', v_owner::text);
END $$;

-- 8. Owner-facing: consent ledger (append-only consent_records) --------------------------
CREATE OR REPLACE FUNCTION public.compliance_norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(d) = 10 THEN '+1' || d
    WHEN length(d) = 11 AND left(d, 1) = '1' THEN '+' || d
    WHEN length(d) BETWEEN 8 AND 15 THEN '+' || d
    ELSE NULL END
  FROM (SELECT regexp_replace(COALESCE(p, ''), '\D', '', 'g') AS d) x
$$;

CREATE OR REPLACE FUNCTION public.compliance_record_consent(
  p_type text, p_granted boolean, p_phone text DEFAULT NULL, p_email text DEFAULT NULL,
  p_source text DEFAULT 'manual', p_notes text DEFAULT NULL, p_customer_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_phone text := public.compliance_norm_phone(p_phone);
  v_email text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN
    RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_type NOT IN ('call_recording', 'marketing_sms', 'marketing_email', 'data_processing', 'marketing_call', 'ai_voice') THEN
    RAISE EXCEPTION 'compliance_invalid: unknown consent type';
  END IF;
  IF p_granted IS NULL THEN RAISE EXCEPTION 'compliance_invalid: granted is required'; END IF;
  IF p_source NOT IN ('ivr_verbal', 'web_form', 'manual', 'import', 'sms_reply') THEN
    RAISE EXCEPTION 'compliance_invalid: unknown source';
  END IF;
  IF v_phone IS NULL AND (v_email IS NULL OR v_email NOT LIKE '%_@_%') THEN
    RAISE EXCEPTION 'compliance_invalid: a valid phone number or email is required';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 500 THEN
    RAISE EXCEPTION 'compliance_invalid: notes are limited to 500 characters';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.user_id = v_owner) THEN
    RAISE EXCEPTION 'compliance_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.consent_records (user_id, customer_id, contact_phone, contact_email, consent_type, granted, source, recorded_by, notes)
  VALUES (v_owner, p_customer_id, v_phone, v_email, p_type, p_granted, p_source, auth.uid(), NULLIF(btrim(COALESCE(p_notes, '')), ''))
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.compliance_actor_email(),
          CASE WHEN p_granted THEN 'compliance.consent.grant' ELSE 'compliance.consent.revoke' END, 'consent_records', v_id::text);
  RETURN v_id;
END $$;

-- Latest row per (contact, type); the engine loader below maps expired grants to "none".
CREATE OR REPLACE FUNCTION public.compliance_consent_current(
  p_type text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_q text := NULLIF(lower(btrim(COALESCE(p_search, ''))), '');
  v_digits text := NULLIF(regexp_replace(COALESCE(p_search, ''), '\D', '', 'g'), '');
  v_total integer;
  v_rows jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN
    RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
  END IF;
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);

  WITH latest AS (
    SELECT DISTINCT ON (COALESCE(right(regexp_replace(cr.contact_phone, '\D', '', 'g'), 10), lower(cr.contact_email)), cr.consent_type)
           cr.id, cr.contact_phone, cr.contact_email, cr.consent_type, cr.granted, cr.source, cr.notes, cr.expires_at, cr.created_at
    FROM public.consent_records cr
    WHERE cr.user_id = v_owner
      AND (p_type IS NULL OR cr.consent_type = p_type)
    ORDER BY COALESCE(right(regexp_replace(cr.contact_phone, '\D', '', 'g'), 10), lower(cr.contact_email)),
             cr.consent_type, cr.created_at DESC, cr.id DESC
  ), filtered AS (
    SELECT * FROM latest l
    WHERE v_q IS NULL
       OR lower(COALESCE(l.contact_email, '')) LIKE '%' || v_q || '%'
       OR (v_digits IS NOT NULL AND regexp_replace(COALESCE(l.contact_phone, ''), '\D', '', 'g') LIKE '%' || v_digits || '%')
  )
  SELECT (SELECT count(*) FROM filtered),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', t.id, 'contact_phone', t.contact_phone, 'contact_email', t.contact_email,
                     'consent_type', t.consent_type, 'granted', t.granted, 'source', t.source, 'notes', t.notes,
                     'expires_at', t.expires_at, 'created_at', t.created_at,
                     'expired', (t.expires_at IS NOT NULL AND t.expires_at < now())) ORDER BY t.created_at DESC, t.id DESC)
                   FROM (SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT p_limit OFFSET p_offset) t), '[]'::jsonb)
  INTO v_total, v_rows;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.compliance_consent_history(p_type text, p_phone text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_ten text := right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 10);
  v_email text := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN
    RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
  END IF;
  IF length(v_ten) < 7 AND v_email IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', cr.id, 'granted', cr.granted, 'source', cr.source, 'notes', cr.notes, 'created_at', cr.created_at)
                     ORDER BY cr.created_at DESC, cr.id DESC)
    FROM public.consent_records cr
    WHERE cr.user_id = v_owner AND cr.consent_type = p_type
      AND ((length(v_ten) >= 7 AND right(regexp_replace(COALESCE(cr.contact_phone, ''), '\D', '', 'g'), 10) = v_ten)
           OR (v_email IS NOT NULL AND lower(COALESCE(cr.contact_email, '')) = v_email))
  ), '[]'::jsonb);
END $$;

-- Edge-function loader (service role only): current consent state per type for one contact.
CREATE OR REPLACE FUNCTION public.compliance_consent_states(p_user uuid, p_phone text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_object_agg(t.consent_type, t.state), '{}'::jsonb) FROM (
    SELECT DISTINCT ON (cr.consent_type) cr.consent_type,
           CASE WHEN NOT cr.granted THEN 'revoked'
                WHEN cr.expires_at IS NOT NULL AND cr.expires_at < now() THEN 'none'
                ELSE 'granted' END AS state
    FROM public.consent_records cr
    WHERE cr.user_id = p_user
      AND ((length(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g')) >= 7
            AND right(regexp_replace(COALESCE(cr.contact_phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
           OR (NULLIF(btrim(COALESCE(p_email, '')), '') IS NOT NULL AND lower(COALESCE(cr.contact_email, '')) = lower(btrim(p_email))))
    ORDER BY cr.consent_type, cr.created_at DESC, cr.id DESC
  ) t
$$;

-- 9. Staff workflow -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_staff_versions()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.compliance_require_staff();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', v.id, 'packSlug', p.slug, 'packName', p.name, 'ruleKey', r.rule_key, 'version', v.version,
      'jurisdiction', p.jurisdiction, 'kind', r.kind, 'severity', v.severity, 'appliesTo', to_jsonb(v.applies_to),
      'title', v.title, 'ownerExplanation', v.owner_explanation, 'params', v.params, 'sourceRefs', v.source_refs,
      'status', v.status, 'effectiveFrom', to_char(v.effective_from, 'YYYY-MM-DD'), 'effectiveTo', to_char(v.effective_to, 'YYYY-MM-DD'),
      'legalReviewed', v.legal_reviewer IS NOT NULL, 'legalReviewer', v.legal_reviewer, 'legalReviewedAt', v.legal_reviewed_at,
      'authoredByEmail', v.authored_by_email, 'authoredBy', v.authored_by, 'submittedAt', v.submitted_at,
      'reviewedByEmail', v.reviewed_by_email, 'reviewedAt', v.reviewed_at, 'reviewNotes', v.review_notes, 'createdAt', v.created_at
    ) ORDER BY CASE v.status WHEN 'in_review' THEN 0 WHEN 'draft' THEN 1 WHEN 'rejected' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END,
               p.jurisdiction, r.rule_key, v.version DESC)
    FROM public.compliance_rule_versions v
    JOIN public.compliance_rules r ON r.id = v.rule_id
    JOIN public.compliance_packs p ON p.id = r.pack_id
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.compliance_staff_events(p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.compliance_require_staff();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', e.id, 'action', e.action, 'fromStatus', e.from_status, 'toStatus', e.to_status,
                                        'notes', e.notes, 'actorEmail', e.actor_email, 'selfReview', e.self_review, 'createdAt', e.created_at)
                     ORDER BY e.id)
    FROM public.compliance_review_events e WHERE e.version_id = p_version_id
  ), '[]'::jsonb);
END $$;

-- p: {versionId?, packSlug, packName?, jurisdiction, ruleKey, kind, severity, appliesTo[], title,
--     ownerExplanation, params, sourceRefs[], effectiveFrom, effectiveTo?}
CREATE OR REPLACE FUNCTION public.compliance_staff_save_draft(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := public.compliance_actor_email();
  v_pack public.compliance_packs%ROWTYPE;
  v_rule public.compliance_rules%ROWTYPE;
  v_ver public.compliance_rule_versions%ROWTYPE;
  v_applies text[];
  v_to date := NULLIF(p ->> 'effectiveTo', '')::date;
  v_from date := NULLIF(p ->> 'effectiveFrom', '')::date;
  v_next int;
BEGIN
  PERFORM public.compliance_require_staff();
  SELECT COALESCE(array_agg(x), '{}') INTO v_applies FROM jsonb_array_elements_text(COALESCE(p -> 'appliesTo', '[]'::jsonb)) x;

  IF NULLIF(p ->> 'versionId', '') IS NOT NULL THEN
    SELECT * INTO v_ver FROM public.compliance_rule_versions WHERE id = (p ->> 'versionId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'compliance_not_found' USING ERRCODE = 'P0002'; END IF;
    IF v_ver.status NOT IN ('draft', 'rejected') THEN
      RAISE EXCEPTION 'compliance_invalid: only drafts and rejected versions can be edited';
    END IF;
    UPDATE public.compliance_rule_versions SET
      status = 'draft', severity = p ->> 'severity', applies_to = v_applies, title = btrim(p ->> 'title'),
      owner_explanation = btrim(p ->> 'ownerExplanation'), params = p -> 'params', source_refs = COALESCE(p -> 'sourceRefs', '[]'::jsonb),
      effective_from = v_from, effective_to = v_to
    WHERE id = v_ver.id;
    INSERT INTO public.compliance_review_events (version_id, action, from_status, to_status, actor_id, actor_email)
    VALUES (v_ver.id, 'edited', v_ver.status, 'draft', auth.uid(), v_email);
    RETURN v_ver.id;
  END IF;

  SELECT * INTO v_pack FROM public.compliance_packs WHERE slug = p ->> 'packSlug';
  IF NOT FOUND THEN
    INSERT INTO public.compliance_packs (slug, name, jurisdiction)
    VALUES (p ->> 'packSlug', COALESCE(NULLIF(btrim(p ->> 'packName'), ''), p ->> 'packSlug'), p ->> 'jurisdiction')
    RETURNING * INTO v_pack;
  ELSIF v_pack.jurisdiction <> COALESCE(p ->> 'jurisdiction', '') THEN
    RAISE EXCEPTION 'compliance_invalid: pack % belongs to %', v_pack.slug, v_pack.jurisdiction;
  END IF;

  SELECT * INTO v_rule FROM public.compliance_rules WHERE pack_id = v_pack.id AND rule_key = p ->> 'ruleKey';
  IF NOT FOUND THEN
    INSERT INTO public.compliance_rules (pack_id, rule_key, kind) VALUES (v_pack.id, p ->> 'ruleKey', p ->> 'kind') RETURNING * INTO v_rule;
  ELSIF v_rule.kind <> COALESCE(p ->> 'kind', '') THEN
    RAISE EXCEPTION 'compliance_invalid: rule % is a % rule', v_rule.rule_key, v_rule.kind;
  END IF;

  IF EXISTS (SELECT 1 FROM public.compliance_rule_versions WHERE rule_id = v_rule.id AND status IN ('draft', 'in_review', 'rejected')) THEN
    RAISE EXCEPTION 'compliance_open_version_exists: finish or discard the open version of this rule first';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v_next FROM public.compliance_rule_versions WHERE rule_id = v_rule.id;

  INSERT INTO public.compliance_rule_versions
    (rule_id, version, status, severity, applies_to, title, owner_explanation, params, source_refs, effective_from, effective_to, authored_by, authored_by_email)
  VALUES (v_rule.id, v_next, 'draft', p ->> 'severity', v_applies, btrim(p ->> 'title'), btrim(p ->> 'ownerExplanation'),
          p -> 'params', COALESCE(p -> 'sourceRefs', '[]'::jsonb), v_from, v_to, auth.uid(), v_email)
  RETURNING * INTO v_ver;
  INSERT INTO public.compliance_review_events (version_id, action, to_status, actor_id, actor_email)
  VALUES (v_ver.id, 'created', 'draft', auth.uid(), v_email);
  RETURN v_ver.id;
END $$;

CREATE OR REPLACE FUNCTION public.compliance_staff_transition(
  p_version_id uuid, p_action text, p_notes text DEFAULT NULL, p_legal_reviewer text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.compliance_require_staff();
  v_email text := public.compliance_actor_email();
  v public.compliance_rule_versions%ROWTYPE;
  v_rule public.compliance_rules%ROWTYPE;
  v_pack public.compliance_packs%ROWTYPE;
  v_errs text[];
  v_prev public.compliance_rule_versions%ROWTYPE;
  v_self boolean := false;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_to text;
BEGIN
  SELECT * INTO v FROM public.compliance_rule_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_rule FROM public.compliance_rules WHERE id = v.rule_id;
  SELECT * INTO v_pack FROM public.compliance_packs WHERE id = v_rule.pack_id;

  IF p_action IN ('submit', 'approve') THEN
    v_errs := public.compliance_version_errors(v_pack.jurisdiction, v_rule.kind, v.severity, v.applies_to, v.title,
                                               v.owner_explanation, v.params, v.source_refs, v.effective_from, v.effective_to);
    IF cardinality(v_errs) > 0 THEN
      RAISE EXCEPTION 'compliance_invalid: %', array_to_string(v_errs, '; ');
    END IF;
  END IF;

  IF p_action = 'submit' THEN
    IF v.status NOT IN ('draft', 'rejected') THEN RAISE EXCEPTION 'compliance_invalid: only drafts can be submitted'; END IF;
    UPDATE public.compliance_rule_versions SET status = 'in_review', submitted_at = now() WHERE id = v.id;
    v_to := 'in_review';

  ELSIF p_action = 'withdraw' THEN
    IF v.status <> 'in_review' THEN RAISE EXCEPTION 'compliance_invalid: only versions in review can be withdrawn'; END IF;
    UPDATE public.compliance_rule_versions SET status = 'draft', submitted_at = NULL WHERE id = v.id;
    v_to := 'draft';

  ELSIF p_action = 'approve' THEN
    PERFORM public.compliance_require_staff(ARRAY['reviewer', 'admin']);
    IF v.status <> 'in_review' THEN RAISE EXCEPTION 'compliance_invalid: only versions in review can be approved'; END IF;
    IF v_notes IS NULL OR char_length(v_notes) < 10 THEN RAISE EXCEPTION 'compliance_invalid: review notes (min 10 characters) are required'; END IF;
    IF char_length(btrim(COALESCE(p_legal_reviewer, ''))) < 3 THEN
      RAISE EXCEPTION 'compliance_invalid: name the legal reviewer (attorney or firm) who confirmed this rule';
    END IF;
    IF v.authored_by IS NOT NULL AND v.authored_by = auth.uid() THEN
      IF v_role <> 'admin' THEN RAISE EXCEPTION 'compliance_self_review: a different reviewer must approve your draft'; END IF;
      v_self := true;
    END IF;
    SELECT * INTO v_prev FROM public.compliance_rule_versions
     WHERE rule_id = v.rule_id AND status = 'approved' AND id <> v.id ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF v_prev.effective_from >= v.effective_from THEN
        RAISE EXCEPTION 'compliance_effective_conflict: effective-from must be after the current version''s (%)', v_prev.effective_from;
      END IF;
      IF v_prev.effective_to IS NULL OR v_prev.effective_to > v.effective_from THEN
        UPDATE public.compliance_rule_versions SET effective_to = v.effective_from WHERE id = v_prev.id;
      END IF;
    END IF;
    UPDATE public.compliance_rule_versions SET
      status = 'approved', reviewed_by = auth.uid(), reviewed_by_email = v_email, reviewed_at = now(),
      review_notes = v_notes, legal_reviewer = btrim(p_legal_reviewer), legal_reviewed_at = now()
    WHERE id = v.id;
    v_to := 'approved';

  ELSIF p_action = 'reject' THEN
    PERFORM public.compliance_require_staff(ARRAY['reviewer', 'admin']);
    IF v.status <> 'in_review' THEN RAISE EXCEPTION 'compliance_invalid: only versions in review can be rejected'; END IF;
    IF v_notes IS NULL OR char_length(v_notes) < 10 THEN RAISE EXCEPTION 'compliance_invalid: explain what must change (min 10 characters)'; END IF;
    UPDATE public.compliance_rule_versions SET
      status = 'rejected', reviewed_by = auth.uid(), reviewed_by_email = v_email, reviewed_at = now(), review_notes = v_notes
    WHERE id = v.id;
    v_to := 'rejected';

  ELSIF p_action = 'retire' THEN
    PERFORM public.compliance_require_staff(ARRAY['reviewer', 'admin']);
    IF v.status <> 'approved' THEN RAISE EXCEPTION 'compliance_invalid: only approved versions can be retired'; END IF;
    IF v_notes IS NULL OR char_length(v_notes) < 10 THEN RAISE EXCEPTION 'compliance_invalid: say why it is retired (min 10 characters)'; END IF;
    UPDATE public.compliance_rule_versions SET
      status = 'retired', retired_at = now(),
      effective_to = GREATEST(v.effective_from, LEAST(COALESCE(v.effective_to, current_date), current_date))
    WHERE id = v.id;
    v_to := 'retired';

  ELSIF p_action = 'discard' THEN
    IF v.status <> 'draft' THEN RAISE EXCEPTION 'compliance_invalid: only drafts can be discarded'; END IF;
    IF v.authored_by IS DISTINCT FROM auth.uid() AND v_role <> 'admin' THEN
      RAISE EXCEPTION 'compliance_forbidden' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
    VALUES (auth.uid(), auth.uid(), v_email, 'compliance.rule.discard', 'compliance_rule_versions', v.id::text);
    DELETE FROM public.compliance_rule_versions WHERE id = v.id;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_rule_versions WHERE rule_id = v_rule.id) THEN
      DELETE FROM public.compliance_rules WHERE id = v_rule.id;
    END IF;
    RETURN 'discarded';

  ELSE
    RAISE EXCEPTION 'compliance_invalid: unknown action';
  END IF;

  INSERT INTO public.compliance_review_events (version_id, action, from_status, to_status, notes, actor_id, actor_email, self_review)
  VALUES (v.id, p_action, v.status, v_to, v_notes, auth.uid(), v_email, v_self);
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (auth.uid(), auth.uid(), v_email, 'compliance.rule.' || p_action, 'compliance_rule_versions', v.id::text);
  RETURN v_to;
END $$;

-- 10. Grants ----------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.compliance_staff_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_require_staff(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_actor_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_catalog() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_save_profile(text, jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_record_consent(text, boolean, text, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_consent_current(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_consent_history(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_consent_states(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_staff_versions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_staff_events(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_staff_save_draft(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compliance_staff_transition(uuid, text, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.compliance_staff_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_can_manage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_catalog() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compliance_save_profile(text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_record_consent(text, boolean, text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_consent_current(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_consent_history(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_consent_states(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_staff_versions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_staff_events(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_staff_save_draft(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_staff_transition(uuid, text, text, text) TO authenticated;

COMMENT ON TABLE public.compliance_rule_versions IS
  'Immutable, effective-dated rule versions. Only status=approved is enforced. Not legal advice: every version needs counsel review before approval.';
