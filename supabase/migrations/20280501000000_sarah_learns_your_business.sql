/*
  # Sarah Learns Your Business

  ## Why
  The manual onboarding wizard asked the owner to type what already exists
  online. "Sarah Learns Your Business" drafts the profile from the owner's own
  website, interviews them only for the gaps, lets them approve everything on
  one screen, and proves readiness with 20 simulated calls before go-live.

  ## What this adds
  1. `sarah_learn_runs`              one learning run per attempt (resumable, re-runnable)
  2. `sarah_learn_sources`           which pages were read (URL, hash, status). NO page text is stored.
  3. `sarah_learn_fields`            extracted facts with citation + confidence + approval state
  4. `sarah_learn_scenario_results`  readiness scorecard rows
  5. `sarah_learn_suggestions`       "Sarah learned" suggestions from real calls
  6. `sarah_learn_events`            time-to-value metrics (no PII: event name, ms, counts only)

  ## Security
  - Tenant scoped with `public.get_account_owner_id()` + `public.can_run_sarah_learn()`.
  - authenticated users get SELECT only. Every write goes through a
    SECURITY DEFINER RPC below (which re-checks tenant + permission) or through
    the edge functions (service role after verifying the caller). A browser can
    never forge `readiness_passed`, `first_draft_at` or `test_call_confirmed_at`.
  - Sensitive items (prices, emergency rules, legal claims, never-book rules)
    cannot go live while `pending`: enforced inside `sarah_learn_go_live`.
  - Retention: `retention_days` per run + `sarah_learn_purge_expired()` (service role).
    Owners can delete a run (`sarah_learn_delete_run`) or everything (`sarah_learn_delete_all`).

  ## Rollback
  DROP FUNCTION sarah_learn_* ; DROP TABLE sarah_learn_events, sarah_learn_suggestions,
  sarah_learn_scenario_results, sarah_learn_fields, sarah_learn_sources, sarah_learn_runs;
  (data already applied to business_profile / knowledge_articles is left in place.)
*/

-- =============================================================
-- 0. Permission helper (same gate as call scripts: owner or can_edit_business_profile)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_run_sarah_learn()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_edit_call_scripts();
$$;

GRANT EXECUTE ON FUNCTION public.can_run_sarah_learn() TO authenticated;

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.sarah_learn_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  status text NOT NULL DEFAULT 'sourcing'
    CHECK (status IN ('sourcing','drafted','interviewing','review','readiness','ready','live','failed')),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','es')),
  own_property_confirmed_at timestamptz NOT NULL,
  website_url text CHECK (website_url IS NULL OR char_length(website_url) <= 500),
  social_url text CHECK (social_url IS NULL OR char_length(social_url) <= 500),
  gbp_url text CHECK (gbp_url IS NULL OR char_length(gbp_url) <= 500),
  parent_run_id uuid REFERENCES public.sarah_learn_runs(id) ON DELETE SET NULL,
  interview_state jsonb NOT NULL DEFAULT '{"asked":[]}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  first_draft_at timestamptz,
  readiness_run_at timestamptz,
  readiness_score numeric(5,4) CHECK (readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 1)),
  readiness_passed boolean NOT NULL DEFAULT false,
  test_call_confirmed_at timestamptz,
  approved_at timestamptz,
  live_at timestamptz,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_runs_user ON public.sarah_learn_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sarah_learn_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.sarah_learn_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('website_page','pasted_text')),
  url text CHECK (url IS NULL OR char_length(url) <= 500),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  status text NOT NULL CHECK (status IN ('fetched','blocked_robots','failed','skipped')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 40),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer,
  injection_flags text[] NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_sources_run ON public.sarah_learn_sources (run_id);

CREATE TABLE IF NOT EXISTS public.sarah_learn_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.sarah_learn_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z_]{2,40}$'),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) <> 'null' AND pg_column_size(value) <= 8000),
  prev_value jsonb CHECK (prev_value IS NULL OR pg_column_size(prev_value) <= 8000),
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  assumed boolean NOT NULL DEFAULT false,
  sensitive boolean NOT NULL DEFAULT false,
  origin text NOT NULL CHECK (origin IN ('source','interview','owner_edit')),
  source_id uuid REFERENCES public.sarah_learn_sources(id) ON DELETE SET NULL,
  citation text CHECK (citation IS NULL OR char_length(citation) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','edited','rejected')),
  edit_count integer NOT NULL DEFAULT 0,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, key)
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_fields_run ON public.sarah_learn_fields (run_id);

CREATE TABLE IF NOT EXISTS public.sarah_learn_scenario_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.sarah_learn_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  scenario_id text NOT NULL CHECK (scenario_id ~ '^[a-z0-9_]{2,60}$'),
  category text NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  caller_text text NOT NULL,
  reply_text text NOT NULL DEFAULT '',
  passed boolean NOT NULL,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  ran_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, scenario_id)
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_results_run ON public.sarah_learn_scenario_results (run_id);

CREATE TABLE IF NOT EXISTS public.sarah_learn_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('unanswered_question','faq','service','website_change')),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) <= 300),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 4000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (user_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_suggestions_user ON public.sarah_learn_suggestions (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sarah_learn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  run_id uuid REFERENCES public.sarah_learn_runs(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('first_draft','field_edit','field_approve','field_reject','readiness_run','test_call_confirmed','go_live')),
  ms bigint CHECK (ms IS NULL OR ms >= 0),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(meta) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sarah_learn_events_user ON public.sarah_learn_events (user_id, created_at DESC);

-- =============================================================
-- 2. RLS: SELECT only for authenticated; writes go through RPCs / service role
-- =============================================================

ALTER TABLE public.sarah_learn_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_learn_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_learn_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_learn_scenario_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_learn_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_learn_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_sarah_learn_runs" ON public.sarah_learn_runs;
CREATE POLICY "select_sarah_learn_runs" ON public.sarah_learn_runs
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

DROP POLICY IF EXISTS "select_sarah_learn_sources" ON public.sarah_learn_sources;
CREATE POLICY "select_sarah_learn_sources" ON public.sarah_learn_sources
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

DROP POLICY IF EXISTS "select_sarah_learn_fields" ON public.sarah_learn_fields;
CREATE POLICY "select_sarah_learn_fields" ON public.sarah_learn_fields
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

DROP POLICY IF EXISTS "select_sarah_learn_scenario_results" ON public.sarah_learn_scenario_results;
CREATE POLICY "select_sarah_learn_scenario_results" ON public.sarah_learn_scenario_results
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

DROP POLICY IF EXISTS "select_sarah_learn_suggestions" ON public.sarah_learn_suggestions;
CREATE POLICY "select_sarah_learn_suggestions" ON public.sarah_learn_suggestions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

DROP POLICY IF EXISTS "select_sarah_learn_events" ON public.sarah_learn_events;
CREATE POLICY "select_sarah_learn_events" ON public.sarah_learn_events
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_run_sarah_learn());

REVOKE INSERT, UPDATE, DELETE ON public.sarah_learn_runs, public.sarah_learn_sources, public.sarah_learn_fields,
  public.sarah_learn_scenario_results, public.sarah_learn_suggestions, public.sarah_learn_events FROM authenticated, anon;

-- =============================================================
-- 3. Shared guards
-- =============================================================

-- Returns the caller's tenant id or raises. Every RPC calls this first.
CREATE OR REPLACE FUNCTION public.sarah_learn_assert_access()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_run_sarah_learn() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_assert_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_assert_access() TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_learn_is_sensitive_key(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key = ANY (ARRAY['never_book','emergency_policy','pricing_signals','diagnostic_fee','financing','licenses_insurance','warranties','escalation_contact']);
$$;

CREATE OR REPLACE FUNCTION public.sarah_learn_is_known_key(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key = ANY (ARRAY[
    'business_name','trade','languages','brand_pronunciation','team_names','tone_samples','tone_preference',
    'services_offered','services_not_offered','never_book','differentiators','service_area','service_area_notes',
    'hours','holiday_hours','emergency_policy','pricing_signals','diagnostic_fee','financing','licenses_insurance',
    'warranties','escalation_contact','faqs'
  ]);
$$;

-- =============================================================
-- 4. Owner actions on fields
-- =============================================================

CREATE OR REPLACE FUNCTION public.sarah_learn_set_field(p_run uuid, p_key text, p_value jsonb, p_action text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_status text;
BEGIN
  IF NOT public.sarah_learn_is_known_key(p_key) THEN
    RAISE EXCEPTION 'unknown_field' USING ERRCODE = '22023';
  END IF;
  IF p_action NOT IN ('approve','edit','reject') THEN
    RAISE EXCEPTION 'bad_action' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status FROM public.sarah_learn_runs
   WHERE id = p_run AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'live' THEN
    RAISE EXCEPTION 'run_locked' USING ERRCODE = '55000';
  END IF;

  IF p_action = 'edit' THEN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' OR pg_column_size(p_value) > 8000 THEN
      RAISE EXCEPTION 'bad_value' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.sarah_learn_fields AS f
      (run_id, user_id, key, value, confidence, assumed, sensitive, origin, status, edit_count, approved_by, approved_at)
    VALUES
      (p_run, v_owner, p_key, p_value, 'high', false, public.sarah_learn_is_sensitive_key(p_key), 'owner_edit', 'edited', 1, auth.uid(), now())
    ON CONFLICT (run_id, key) DO UPDATE SET
      prev_value = COALESCE(f.prev_value, f.value),
      value = EXCLUDED.value,
      confidence = 'high',
      assumed = false,
      origin = 'owner_edit',
      citation = NULL,
      source_id = NULL,
      status = 'edited',
      edit_count = f.edit_count + 1,
      approved_by = auth.uid(),
      approved_at = now(),
      updated_at = now();
    INSERT INTO public.sarah_learn_events (user_id, run_id, event, meta)
      VALUES (v_owner, p_run, 'field_edit', jsonb_build_object('key', p_key));
  ELSE
    UPDATE public.sarah_learn_fields
       SET status = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
           approved_by = CASE WHEN p_action = 'approve' THEN auth.uid() ELSE NULL END,
           approved_at = CASE WHEN p_action = 'approve' THEN now() ELSE NULL END,
           updated_at = now()
     WHERE run_id = p_run AND user_id = v_owner AND key = p_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'field_not_found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.sarah_learn_events (user_id, run_id, event, meta)
      VALUES (v_owner, p_run, CASE WHEN p_action = 'approve' THEN 'field_approve' ELSE 'field_reject' END, jsonb_build_object('key', p_key));
  END IF;

  -- Any change to the profile invalidates a previous readiness proof.
  UPDATE public.sarah_learn_runs
     SET readiness_passed = false,
         status = CASE WHEN status IN ('ready','readiness') THEN 'review' ELSE status END,
         updated_at = now()
   WHERE id = p_run AND user_id = v_owner AND readiness_passed;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_set_field(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_set_field(uuid, text, jsonb, text) TO authenticated;

-- Approve every pending, non-sensitive, non-assumed field in one click.
CREATE OR REPLACE FUNCTION public.sarah_learn_bulk_approve(p_run uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_status text;
  v_count integer;
BEGIN
  SELECT status INTO v_status FROM public.sarah_learn_runs WHERE id = p_run AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_status = 'live' THEN RAISE EXCEPTION 'run_locked' USING ERRCODE = '55000'; END IF;

  UPDATE public.sarah_learn_fields
     SET status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
   WHERE run_id = p_run AND user_id = v_owner AND status = 'pending'
     AND NOT sensitive AND NOT assumed AND confidence <> 'low';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO public.sarah_learn_events (user_id, run_id, event, meta)
      VALUES (v_owner, p_run, 'field_approve', jsonb_build_object('bulk', true, 'count', v_count));
    UPDATE public.sarah_learn_runs
       SET readiness_passed = false,
           status = CASE WHEN status IN ('ready','readiness') THEN 'review' ELSE status END,
           updated_at = now()
     WHERE id = p_run AND user_id = v_owner AND readiness_passed;
  END IF;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_bulk_approve(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_bulk_approve(uuid) TO authenticated;

-- Interview progress (question ids only). The edge function also writes this; the RPC
-- exists so a skipped question is remembered even if the function call fails.
CREATE OR REPLACE FUNCTION public.sarah_learn_mark_asked(p_run uuid, p_question text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
BEGIN
  IF p_question !~ '^[a-z_]{2,30}$' THEN
    RAISE EXCEPTION 'bad_question' USING ERRCODE = '22023';
  END IF;
  UPDATE public.sarah_learn_runs
     SET interview_state = jsonb_set(
           interview_state, '{asked}',
           (CASE WHEN COALESCE(interview_state->'asked', '[]'::jsonb) @> to_jsonb(p_question)
                 THEN COALESCE(interview_state->'asked', '[]'::jsonb)
                 ELSE COALESCE(interview_state->'asked', '[]'::jsonb) || to_jsonb(p_question) END)),
         updated_at = now()
   WHERE id = p_run AND user_id = v_owner AND status <> 'live';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_mark_asked(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_mark_asked(uuid, text) TO authenticated;

-- Owner attests that the real test call reached their phone / worked.
-- Only allowed after the readiness scorecard passed.
CREATE OR REPLACE FUNCTION public.sarah_learn_confirm_test_call(p_run uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_run public.sarah_learn_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.sarah_learn_runs WHERE id = p_run AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_run.status = 'live' THEN RETURN; END IF;
  IF NOT v_run.readiness_passed THEN RAISE EXCEPTION 'readiness_required' USING ERRCODE = '55000'; END IF;
  UPDATE public.sarah_learn_runs
     SET test_call_confirmed_at = COALESCE(test_call_confirmed_at, now()), status = 'ready', updated_at = now()
   WHERE id = p_run;
  INSERT INTO public.sarah_learn_events (user_id, run_id, event) VALUES (v_owner, p_run, 'test_call_confirmed');
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_confirm_test_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_confirm_test_call(uuid) TO authenticated;

-- =============================================================
-- 5. Go live: one atomic, idempotent, gated transaction
-- =============================================================

CREATE OR REPLACE FUNCTION public.sarah_learn_go_live(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_run public.sarah_learn_runs%ROWTYPE;
  v_missing text[];
  v_pending_sensitive text[];
  v_val jsonb;
  v_mode text;
  v_ms bigint;
  r record;
  v_title text;
  v_audience text;
BEGIN
  SELECT * INTO v_run FROM public.sarah_learn_runs WHERE id = p_run AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_run.status = 'live' THEN
    RETURN jsonb_build_object('already_live', true);
  END IF;
  IF NOT v_run.readiness_passed THEN RAISE EXCEPTION 'readiness_required' USING ERRCODE = '55000'; END IF;
  IF v_run.test_call_confirmed_at IS NULL THEN RAISE EXCEPTION 'test_call_required' USING ERRCODE = '55000'; END IF;

  SELECT COALESCE(array_agg(k), '{}') INTO v_missing
    FROM unnest(ARRAY['business_name','services_offered','service_area']) AS k
   WHERE NOT EXISTS (
     SELECT 1 FROM public.sarah_learn_fields f
      WHERE f.run_id = p_run AND f.key = k AND f.status IN ('approved','edited'));
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'required_missing:%', array_to_string(v_missing, ',') USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(array_agg(f.key), '{}') INTO v_pending_sensitive
    FROM public.sarah_learn_fields f
   WHERE f.run_id = p_run AND f.sensitive AND f.status = 'pending';
  IF array_length(v_pending_sensitive, 1) > 0 THEN
    RAISE EXCEPTION 'sensitive_pending:%', array_to_string(v_pending_sensitive, ',') USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.business_profile (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  -- ---- structured business_profile columns (approved/edited fields only) ----
  FOR r IN
    SELECT key, value FROM public.sarah_learn_fields
     WHERE run_id = p_run AND status IN ('approved','edited')
  LOOP
    v_val := r.value;
    IF r.key = 'services_offered' AND jsonb_typeof(v_val) = 'array' THEN
      UPDATE public.business_profile
         SET services_offered = ARRAY(SELECT jsonb_array_elements_text(v_val) LIMIT 30)
       WHERE user_id = v_owner;
    ELSIF r.key = 'service_area' AND jsonb_typeof(v_val) = 'string' THEN
      UPDATE public.business_profile SET service_area = left(v_val #>> '{}', 400) WHERE user_id = v_owner;
    ELSIF r.key = 'trade' AND jsonb_typeof(v_val) = 'string' AND COALESCE((SELECT primary_industry FROM public.business_profile WHERE user_id = v_owner), '') = '' THEN
      -- never overwrite a trade the owner already chose in the old wizard
      UPDATE public.business_profile
         SET primary_industry = CASE
           WHEN lower(v_val #>> '{}') ~ 'hvac|heating|air' THEN 'hvac'
           WHEN lower(v_val #>> '{}') ~ 'plumb' THEN 'plumbing'
           WHEN lower(v_val #>> '{}') ~ 'electric' THEN 'electrical'
           WHEN lower(v_val #>> '{}') ~ 'roof' THEN 'roofing'
           ELSE 'general_home_services' END
       WHERE user_id = v_owner;
    ELSIF r.key = 'hours' AND jsonb_typeof(v_val) = 'object' THEN
      UPDATE public.business_profile SET business_hours = v_val WHERE user_id = v_owner;
    ELSIF r.key = 'emergency_policy' AND jsonb_typeof(v_val) = 'object' THEN
      v_mode := v_val ->> 'mode';
      IF v_mode IN ('yes_premium','yes_same_rate','business_hours_only') THEN
        UPDATE public.business_profile SET handles_emergency_calls = v_mode WHERE user_id = v_owner;
      END IF;
    ELSIF r.key = 'faqs' AND jsonb_typeof(v_val) = 'array' THEN
      -- append only questions the profile does not already have
      UPDATE public.business_profile bp
         SET faqs = COALESCE(bp.faqs, '[]'::jsonb) || COALESCE((
           SELECT jsonb_agg(jsonb_build_object('question', e ->> 'question', 'answer', e ->> 'answer'))
             FROM jsonb_array_elements(v_val) e
            WHERE COALESCE(e ->> 'question', '') <> '' AND COALESCE(e ->> 'answer', '') <> ''
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(bp.faqs, '[]'::jsonb)) x
                 WHERE lower(x ->> 'question') = lower(e ->> 'question'))
         ), '[]'::jsonb)
       WHERE bp.user_id = v_owner;
    END IF;
  END LOOP;

  -- ---- knowledge articles for facts without a structured column ----
  FOR r IN
    SELECT key, value FROM public.sarah_learn_fields
     WHERE run_id = p_run AND status IN ('approved','edited')
       AND key IN ('pricing_signals','diagnostic_fee','financing','licenses_insurance','warranties','never_book',
                   'brand_pronunciation','service_area_notes','differentiators','holiday_hours','escalation_contact',
                   'emergency_policy','services_not_offered','tone_preference')
  LOOP
    v_title := CASE r.key
      WHEN 'pricing_signals' THEN 'Pricing information'
      WHEN 'diagnostic_fee' THEN 'Trip and diagnostic fee'
      WHEN 'financing' THEN 'Financing'
      WHEN 'licenses_insurance' THEN 'Licensing and insurance'
      WHEN 'warranties' THEN 'Warranty'
      WHEN 'never_book' THEN 'Jobs we never book'
      WHEN 'brand_pronunciation' THEN 'How to say our business name'
      WHEN 'service_area_notes' THEN 'Edge of our service area'
      WHEN 'differentiators' THEN 'What sets us apart'
      WHEN 'holiday_hours' THEN 'Holiday hours'
      WHEN 'escalation_contact' THEN 'Escalation contact (internal)'
      WHEN 'emergency_policy' THEN 'After-hours emergencies'
      WHEN 'services_not_offered' THEN 'Services we do not offer'
      ELSE 'Phone style' END;
    -- internal facts must never be read to a caller
    v_audience := CASE WHEN r.key = 'escalation_contact' THEN 'team'
                       WHEN r.key IN ('never_book','tone_preference','brand_pronunciation') THEN 'ai'
                       ELSE 'all' END;
    v_val := r.value;

    DELETE FROM public.knowledge_articles
     WHERE user_id = v_owner AND keywords @> ARRAY['sarah-learn:' || r.key];

    INSERT INTO public.knowledge_articles (user_id, title, summary, body, category, keywords, audience, status, source)
    VALUES (
      v_owner,
      v_title,
      left(CASE WHEN jsonb_typeof(v_val) = 'string' THEN v_val #>> '{}'
                WHEN jsonb_typeof(v_val) = 'object' THEN COALESCE(v_val ->> 'note', '')
                ELSE (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(v_val) x) END, 300),
      left(CASE WHEN jsonb_typeof(v_val) = 'string' THEN v_val #>> '{}'
                WHEN jsonb_typeof(v_val) = 'object' THEN COALESCE(v_val ->> 'note', '')
                ELSE (SELECT string_agg(x, E'\n') FROM jsonb_array_elements_text(v_val) x) END, 2000),
      'Learned by Sarah',
      ARRAY['sarah-learn', 'sarah-learn:' || r.key],
      v_audience,
      'published',
      'faq_import'
    );
  END LOOP;

  v_ms := GREATEST(0, (extract(epoch FROM (now() - v_run.started_at)) * 1000)::bigint);
  UPDATE public.sarah_learn_runs
     SET status = 'live', live_at = now(), approved_at = COALESCE(approved_at, now()), updated_at = now()
   WHERE id = p_run;
  INSERT INTO public.sarah_learn_events (user_id, run_id, event, ms) VALUES (v_owner, p_run, 'go_live', v_ms);

  RETURN jsonb_build_object('live', true, 'time_to_live_ms', v_ms);
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_go_live(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_go_live(uuid) TO authenticated;

-- =============================================================
-- 6. Continuous learning: suggestions from real unanswered questions
-- =============================================================

-- Idempotent; safe to call whenever the panel opens or from a weekly schedule.
CREATE OR REPLACE FUNCTION public.sarah_learn_refresh_suggestions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_count integer;
BEGIN
  INSERT INTO public.sarah_learn_suggestions (user_id, kind, dedupe_key, payload)
  SELECT v_owner, 'unanswered_question', g.question_key,
         jsonb_build_object('question', left(g.question, 300), 'asked_count', g.asked_count, 'gap_id', g.id)
    FROM public.knowledge_gaps g
   WHERE g.user_id = v_owner AND g.status = 'open' AND g.last_asked_at > now() - interval '30 days'
   ORDER BY g.asked_count DESC
   LIMIT 10
  ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_refresh_suggestions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_refresh_suggestions() TO authenticated;

-- One click: approve an unanswered-question suggestion by supplying the answer.
CREATE OR REPLACE FUNCTION public.sarah_learn_decide_suggestion(p_id uuid, p_decision text, p_answer text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  s public.sarah_learn_suggestions%ROWTYPE;
  v_answer text := btrim(COALESCE(p_answer, ''));
BEGIN
  IF p_decision NOT IN ('approve','dismiss') THEN RAISE EXCEPTION 'bad_decision' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM public.sarah_learn_suggestions WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found' USING ERRCODE = 'P0002'; END IF;
  IF s.status <> 'pending' THEN RETURN; END IF;

  IF p_decision = 'approve' THEN
    IF s.kind = 'unanswered_question' THEN
      IF char_length(v_answer) < 3 OR char_length(v_answer) > 600 THEN
        RAISE EXCEPTION 'answer_required' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.business_profile (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
      UPDATE public.business_profile
         SET faqs = COALESCE(faqs, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('question', s.payload ->> 'question', 'answer', v_answer))
       WHERE user_id = v_owner;
      UPDATE public.knowledge_gaps SET status = 'answered'
       WHERE user_id = v_owner AND id = NULLIF(s.payload ->> 'gap_id', '')::uuid;
    END IF;
    UPDATE public.sarah_learn_suggestions SET status = 'approved', decided_at = now() WHERE id = p_id;
  ELSE
    UPDATE public.sarah_learn_suggestions SET status = 'dismissed', decided_at = now() WHERE id = p_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_decide_suggestion(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_decide_suggestion(uuid, text, text) TO authenticated;

-- =============================================================
-- 7. Deletion + retention
-- =============================================================

CREATE OR REPLACE FUNCTION public.sarah_learn_delete_run(p_run uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
BEGIN
  DELETE FROM public.sarah_learn_runs WHERE id = p_run AND user_id = v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_delete_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_delete_run(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_learn_delete_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.sarah_learn_assert_access();
  v_count integer;
BEGIN
  DELETE FROM public.sarah_learn_runs WHERE user_id = v_owner;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.sarah_learn_suggestions WHERE user_id = v_owner;
  DELETE FROM public.sarah_learn_events WHERE user_id = v_owner;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_delete_all() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_learn_delete_all() TO authenticated;

-- Service role / scheduled job only. Schedule daily, e.g. with pg_cron:
--   select cron.schedule('sarah-learn-purge', '17 3 * * *', $$select public.sarah_learn_purge_expired()$$);
CREATE OR REPLACE FUNCTION public.sarah_learn_purge_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.sarah_learn_runs WHERE created_at + make_interval(days => retention_days) < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.sarah_learn_events WHERE created_at < now() - interval '400 days';
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.sarah_learn_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_learn_purge_expired() TO service_role;
