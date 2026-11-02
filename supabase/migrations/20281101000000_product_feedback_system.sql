/*
  # Product feedback system (in-app feedback, CSAT/CES, help loop, staff triage, privacy)

  Additive only. Nothing existing is dropped, renamed or loosened. Reuses: get_account_owner_id(),
  is_vireek_staff(uuid), staff_audit_log, _success_is_impersonated(uuid), nps_responses, notifications,
  roadmap_items, help_article_feedback.

  ## Tables (RLS on, no client write policies - every write goes through a SECURITY DEFINER RPC)
  product_feedback / product_feedback_events   in-app feedback + a status timeline the submitter can follow
  feedback_themes                              AI-suggested, human-reviewed clusters
  feedback_followups                           closed-loop tasks (low CSAT/CES/NPS, staff follow-ups)
  feedback_survey_responses / _events / _prefs in-app CSAT (1-5) and CES (1-7) + fatigue state
  help_search_gaps                             anonymous daily counters of help searches with no result
  you_asked_we_built                           published "You asked, we built" entries

  ## Privacy model
  - Messages and context are redacted SERVER-side (feedback_redact / feedback_clean_context).
  - "Anonymous" = staff never see who sent it; the row keeps user_id only so the sender can follow
    status and erase it. plan/role are stored as non-identifying segments.
  - Follow-up emails only go to people who ticked "OK to email me" (contact_ok).
  - export_my_feedback_data() / delete_my_feedback_data() for GDPR; feedback_retention_apply() for limits.

  ## Deploy order
  1. Run this migration.  2. supabase functions deploy feedback-cluster feedback-followup-dispatch feedback-retention
  3. Schedule feedback-followup-dispatch (every 10 min) and feedback-retention (daily) with header X-Cron-Secret.
*/

-- ---------------------------------------------------------------------------
-- Redaction helpers (mirrored by src/lib/feedback/redact.ts - same fixtures test both)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feedback_redact(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  t text := p_text;
BEGIN
  IF t IS NULL THEN
    RETURN NULL;
  END IF;
  t := regexp_replace(t, 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', '[token]', 'g');
  t := regexp_replace(t, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g');
  t := regexp_replace(t, '\m(?:sk|pk|rk|whsec|ghp|gho|xox[abprs])[-_][A-Za-z0-9_-]{16,}', '[secret]', 'g');
  t := regexp_replace(t, '(https?://[^\s?#]+)[?#]\S*', '\1', 'g');
  t := regexp_replace(t, '\m(?:\d[ -]?){12,18}\d\M', '[number]', 'g');
  t := regexp_replace(t, '\m\d{3}-\d{2}-\d{4}\M', '[id]', 'g');
  t := regexp_replace(t, '(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}', '[phone]', 'g');
  t := regexp_replace(t, '\+\d[\d\s.-]{7,}\d', '[phone]', 'g');
  t := regexp_replace(t, '\m\d{1,3}(?:\.\d{1,3}){3}\M', '[ip]', 'g');
  RETURN t;
END;
$$;

CREATE OR REPLACE FUNCTION public.feedback_clean_route(p_route text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(p_route, ''), '[?#].*$', ''),
        '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '/:id', 'g'),
      '/\d{3,}', '/:id', 'g'),
    200);
$$;

-- Whitelist + trim + redact whatever the browser sent as "context".
CREATE OR REPLACE FUNCTION public.feedback_clean_context(p_ctx jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  k text;
  v text;
  out jsonb := '{}'::jsonb;
BEGIN
  IF p_ctx IS NULL OR jsonb_typeof(p_ctx) <> 'object' THEN
    RETURN out;
  END IF;
  FOREACH k IN ARRAY ARRAY['route', 'app_version', 'browser', 'os', 'viewport', 'locale', 'theme', 'online', 'error_id'] LOOP
    v := p_ctx ->> k;
    CONTINUE WHEN v IS NULL OR btrim(v) = '';
    IF k = 'route' THEN
      v := public.feedback_clean_route(v);
    ELSIF k = 'error_id' THEN
      CONTINUE WHEN v !~ '^INC-[A-Z0-9]{4}-[A-Z0-9]{4}$';
    ELSE
      v := left(public.feedback_redact(v), 120);
    END IF;
    out := out || jsonb_build_object(k, v);
  END LOOP;
  RETURN out;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback_themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 600),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  source text NOT NULL DEFAULT 'human' CHECK (source IN ('ai', 'human')),
  roadmap_item_id uuid REFERENCES public.roadmap_items(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_code text NOT NULL UNIQUE CHECK (tracking_code ~ '^FB-[A-Z0-9]{8}$'),
  account_owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous boolean NOT NULL DEFAULT false,
  contact_ok boolean NOT NULL DEFAULT false,
  category text NOT NULL CHECK (category IN ('bug', 'idea', 'question', 'praise', 'other')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan text CHECK (plan IS NULL OR char_length(plan) <= 40),
  role text CHECK (role IS NULL OR char_length(role) <= 40),
  screenshot_path text CHECK (screenshot_path IS NULL OR char_length(screenshot_path) <= 200),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'triaged', 'planned', 'in_progress', 'shipped', 'closed', 'declined')),
  public_note text CHECK (public_note IS NULL OR char_length(public_note) <= 500),
  roadmap_item_id uuid REFERENCES public.roadmap_items(id) ON DELETE SET NULL,
  theme_id uuid REFERENCES public.feedback_themes(id) ON DELETE SET NULL,
  theme_source text CHECK (theme_source IS NULL OR theme_source IN ('ai', 'human')),
  content_hash text,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_feedback_user ON public.product_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_feedback_status ON public.product_feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_feedback_theme ON public.product_feedback (theme_id) WHERE theme_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_feedback_roadmap ON public.product_feedback (roadmap_item_id) WHERE roadmap_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.product_feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES public.product_feedback(id) ON DELETE CASCADE,
  status text NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_feedback_events_fb ON public.product_feedback_events (feedback_id, created_at);

CREATE TABLE IF NOT EXISTS public.feedback_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('feedback', 'survey', 'nps')),
  source_id uuid NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  account_owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) <= 200),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  assignee uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  contact_ok boolean NOT NULL DEFAULT false,
  email_status text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'queued', 'sent', 'failed')),
  email_body text CHECK (email_body IS NULL OR char_length(email_body) <= 1500),
  email_error text,
  due_at timestamptz NOT NULL DEFAULT now() + interval '2 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_followups_open ON public.feedback_followups (status, due_at);
CREATE INDEX IF NOT EXISTS idx_feedback_followups_email ON public.feedback_followups (email_status) WHERE email_status = 'queued';

CREATE TABLE IF NOT EXISTS public.feedback_survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  survey_type text NOT NULL CHECK (survey_type IN ('csat', 'ces')),
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z0-9_]{1,40}$'),
  subject_ref text CHECK (subject_ref IS NULL OR char_length(subject_ref) <= 64),
  score smallint NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  contact_ok boolean NOT NULL DEFAULT false,
  plan text,
  role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_survey_score_range CHECK (
    (survey_type = 'csat' AND score BETWEEN 1 AND 5) OR (survey_type = 'ces' AND score BETWEEN 1 AND 7)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_survey_subject
  ON public.feedback_survey_responses (user_id, survey_type, trigger_key, coalesce(subject_ref, ''));
CREATE INDEX IF NOT EXISTS idx_feedback_survey_created ON public.feedback_survey_responses (created_at DESC);

CREATE TABLE IF NOT EXISTS public.feedback_survey_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  survey_type text NOT NULL CHECK (survey_type IN ('csat', 'ces')),
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z0-9_]{1,40}$'),
  subject_ref text CHECK (subject_ref IS NULL OR char_length(subject_ref) <= 64),
  action text NOT NULL CHECK (action IN ('shown', 'answered', 'dismissed', 'snoozed', 'never')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_survey_events_user ON public.feedback_survey_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.feedback_survey_prefs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  never_ask boolean NOT NULL DEFAULT false,
  snoozed_until timestamptz,
  anonymous_default boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.help_search_gaps (
  query_norm text NOT NULL CHECK (char_length(query_norm) BETWEEN 2 AND 80),
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  miss_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (query_norm, day)
);

CREATE TABLE IF NOT EXISTS public.you_asked_we_built (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 3 AND 600),
  href text CHECK (href IS NULL OR href ~ '^/[A-Za-z0-9/_?=&#.-]{0,198}$'),
  roadmap_item_id uuid REFERENCES public.roadmap_items(id) ON DELETE SET NULL,
  notified_count integer NOT NULL DEFAULT 0,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_you_asked_published ON public.you_asked_we_built (published_at DESC);

-- help_article_feedback gets an optional reason (additive column)
ALTER TABLE public.help_article_feedback ADD COLUMN IF NOT EXISTS reason text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'help_feedback_reason_check') THEN
    ALTER TABLE public.help_article_feedback
      ADD CONSTRAINT help_feedback_reason_check
      CHECK (reason IS NULL OR reason IN ('inaccurate', 'unclear', 'incomplete', 'outdated', 'not_found', 'other'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: on everywhere. Tenants read only their own rows; every write is an RPC.
-- ---------------------------------------------------------------------------
ALTER TABLE public.feedback_themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_survey_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_survey_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_search_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.you_asked_we_built ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.feedback_themes, public.product_feedback, public.product_feedback_events,
  public.feedback_followups, public.feedback_survey_responses, public.feedback_survey_events,
  public.feedback_survey_prefs, public.help_search_gaps, public.you_asked_we_built FROM anon, authenticated;

DROP POLICY IF EXISTS "product_feedback_select_own" ON public.product_feedback;
CREATE POLICY "product_feedback_select_own" ON public.product_feedback FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.product_feedback TO authenticated;

DROP POLICY IF EXISTS "product_feedback_events_select_own" ON public.product_feedback_events;
CREATE POLICY "product_feedback_events_select_own" ON public.product_feedback_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.product_feedback f WHERE f.id = feedback_id AND f.user_id = auth.uid()));
GRANT SELECT ON public.product_feedback_events TO authenticated;

DROP POLICY IF EXISTS "survey_prefs_select_own" ON public.feedback_survey_prefs;
CREATE POLICY "survey_prefs_select_own" ON public.feedback_survey_prefs FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.feedback_survey_prefs TO authenticated;

DROP POLICY IF EXISTS "you_asked_select_all" ON public.you_asked_we_built;
CREATE POLICY "you_asked_select_all" ON public.you_asked_we_built FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.you_asked_we_built TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for annotated screenshots, one folder per user id
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('feedback-screenshots', 'feedback-screenshots', false, 2097152, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "feedback_shots_insert_own" ON storage.objects;
CREATE POLICY "feedback_shots_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'feedback-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "feedback_shots_select_own" ON storage.objects;
CREATE POLICY "feedback_shots_select_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'feedback-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "feedback_shots_delete_own" ON storage.objects;
CREATE POLICY "feedback_shots_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'feedback-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "feedback_shots_select_staff" ON storage.objects;
CREATE POLICY "feedback_shots_select_staff" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'feedback-screenshots' AND public.is_vireek_staff(auth.uid()));

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._feedback_segment(p_uid uuid, p_owner uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'plan', (SELECT left(p.plan, 40) FROM profiles p WHERE p.id = p_owner),
    'role', coalesce(
      (SELECT left(t.role, 40) FROM team_members t WHERE t.user_id = p_uid AND t.account_owner_id = p_owner LIMIT 1),
      'owner')
  );
$$;

CREATE OR REPLACE FUNCTION public._feedback_tracking_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea;
  code text := '';
  i int;
BEGIN
  bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  FOR i IN 0..7 LOOP
    code := code || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
  END LOOP;
  RETURN 'FB-' || code;
END;
$$;

CREATE OR REPLACE FUNCTION public._feedback_assert_staff(p_view text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  -- One audit row per view per minute, so refreshing a dashboard does not flood the log.
  IF NOT EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid() AND l.action = 'explorer_list'
      AND l.metadata ->> 'view' = p_view AND l.created_at > now() - interval '1 minute'
  ) THEN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
    INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
    VALUES (auth.uid(), v_email, 'explorer_list', jsonb_build_object('view', p_view));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._feedback_notify(p_user uuid, p_title text, p_message text, p_url text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO notifications (user_id, type, title, message, action_url)
  SELECT p_user, 'feedback_update', left(p_title, 120), left(p_message, 300), p_url
  WHERE p_user IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------
-- 1. In-app feedback (tenant RPCs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_product_feedback(
  p_category text,
  p_message text,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_anonymous boolean DEFAULT false,
  p_contact_ok boolean DEFAULT false,
  p_screenshot_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_msg text;
  v_hash text;
  v_seg jsonb;
  v_row product_feedback%ROWTYPE;
  v_code text;
  v_tries int := 0;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('bug', 'idea', 'question', 'praise', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_category');
  END IF;
  v_msg := btrim(coalesce(p_message, ''));
  IF char_length(v_msg) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'message_too_short');
  END IF;
  IF char_length(v_msg) > 4000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'message_too_long');
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  IF p_screenshot_path IS NOT NULL AND (
       p_screenshot_path NOT LIKE v_uid::text || '/%'
       OR p_screenshot_path LIKE '%..%'
       OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'feedback-screenshots' AND o.name = p_screenshot_path)
     ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_screenshot');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('feedback:' || v_uid::text));

  v_msg := public.feedback_redact(v_msg);
  v_hash := md5(v_uid::text || '|' || p_category || '|' || v_msg);

  -- Idempotent double-submit: same text from the same person within 10 minutes returns the first ticket.
  SELECT * INTO v_row FROM product_feedback f
  WHERE f.user_id = v_uid AND f.content_hash = v_hash AND f.created_at > now() - interval '10 minutes'
  ORDER BY f.created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'tracking_code', v_row.tracking_code, 'status', v_row.status, 'duplicate', true);
  END IF;

  IF (SELECT count(*) FROM product_feedback f WHERE f.user_id = v_uid AND f.created_at > now() - interval '1 hour') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  v_seg := public._feedback_segment(v_uid, v_owner);

  LOOP
    v_code := public._feedback_tracking_code();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM product_feedback f WHERE f.tracking_code = v_code);
    v_tries := v_tries + 1;
    IF v_tries > 8 THEN
      RAISE EXCEPTION 'tracking_code_exhausted';
    END IF;
  END LOOP;

  INSERT INTO product_feedback (
    tracking_code, account_owner_id, user_id, anonymous, contact_ok, category, message, context,
    plan, role, screenshot_path, content_hash
  ) VALUES (
    v_code, v_owner, v_uid, coalesce(p_anonymous, false), coalesce(p_contact_ok, false), p_category, v_msg,
    public.feedback_clean_context(p_context), v_seg ->> 'plan', v_seg ->> 'role', p_screenshot_path, v_hash
  ) RETURNING * INTO v_row;

  INSERT INTO product_feedback_events (feedback_id, status, note) VALUES (v_row.id, 'received', NULL);

  RETURN jsonb_build_object('ok', true, 'tracking_code', v_row.tracking_code, 'status', v_row.status, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.my_feedback_list(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'created_at') DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', f.id, 'tracking_code', f.tracking_code, 'category', f.category, 'message', f.message,
      'status', f.status, 'public_note', f.public_note, 'anonymous', f.anonymous, 'has_screenshot', f.screenshot_path IS NOT NULL,
      'created_at', f.created_at, 'updated_at', f.updated_at,
      'events', coalesce((
        SELECT jsonb_agg(jsonb_build_object('status', e.status, 'note', e.note, 'at', e.created_at) ORDER BY e.created_at)
        FROM product_feedback_events e WHERE e.feedback_id = f.id), '[]'::jsonb)
    ) AS x
    FROM product_feedback f
    WHERE f.user_id = auth.uid()
    ORDER BY f.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- 2. Surveys: fatigue rules are enforced here (survey_claim is the single gate)
--    Rules: <= 1 survey per 7 days, <= 2 per 30 days (in-app CSAT/CES + NPS counted together),
--    per-trigger cooldown (CSAT 14d, CES 30d), one answer per subject, snooze, never-ask,
--    new accounts (< 7 days) and staff impersonation are never surveyed.
--    Client-only rules (critical flows, errors, consent) live in src/lib/feedback/surveyRules.ts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.survey_claim(p_type text, p_trigger text, p_subject text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_prefs feedback_survey_prefs%ROWTYPE;
  v_subject text := nullif(left(btrim(coalesce(p_subject, '')), 64), '');
  v_cool interval;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_type NOT IN ('csat', 'ces') OR p_trigger IS NULL OR p_trigger !~ '^[a-z0-9_]{1,40}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'impersonated');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('survey:' || v_uid::text));

  SELECT * INTO v_prefs FROM feedback_survey_prefs WHERE user_id = v_uid;
  IF FOUND THEN
    IF v_prefs.never_ask THEN RETURN jsonb_build_object('ok', false, 'reason', 'never_ask'); END IF;
    IF v_prefs.snoozed_until IS NOT NULL AND v_prefs.snoozed_until > now() THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'snoozed');
    END IF;
  END IF;

  IF (SELECT p.created_at FROM profiles p WHERE p.id = v_owner) > now() - interval '7 days' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'new_account');
  END IF;

  IF EXISTS (
    SELECT 1 FROM feedback_survey_responses r
    WHERE r.user_id = v_uid AND r.survey_type = p_type AND r.trigger_key = p_trigger
      AND coalesce(r.subject_ref, '') = coalesce(v_subject, '')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  IF EXISTS (SELECT 1 FROM feedback_survey_events e WHERE e.user_id = v_uid AND e.action = 'shown' AND e.created_at > now() - interval '7 days')
     OR EXISTS (SELECT 1 FROM nps_responses n WHERE n.user_id = v_uid AND n.created_at > now() - interval '7 days') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'global_gap');
  END IF;

  IF (SELECT count(*) FROM feedback_survey_events e WHERE e.user_id = v_uid AND e.action = 'shown' AND e.created_at > now() - interval '30 days') >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'monthly_cap');
  END IF;

  v_cool := CASE WHEN p_type = 'csat' THEN interval '14 days' ELSE interval '30 days' END;
  IF EXISTS (
    SELECT 1 FROM feedback_survey_events e
    WHERE e.user_id = v_uid AND e.action = 'shown' AND e.survey_type = p_type AND e.trigger_key = p_trigger
      AND e.created_at > now() - v_cool
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cooldown');
  END IF;

  INSERT INTO feedback_survey_events (user_id, survey_type, trigger_key, subject_ref, action)
  VALUES (v_uid, p_type, p_trigger, v_subject, 'shown');
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.survey_respond(
  p_type text, p_trigger text, p_subject text, p_score integer, p_comment text DEFAULT NULL, p_contact_ok boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_subject text := nullif(left(btrim(coalesce(p_subject, '')), 64), '');
  v_comment text := nullif(left(btrim(public.feedback_redact(coalesce(p_comment, ''))), 1000), '');
  v_seg jsonb;
  v_id uuid;
  v_low boolean;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_type NOT IN ('csat', 'ces') OR p_trigger IS NULL OR p_trigger !~ '^[a-z0-9_]{1,40}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF p_score IS NULL OR (p_type = 'csat' AND p_score NOT BETWEEN 1 AND 5) OR (p_type = 'ces' AND p_score NOT BETWEEN 1 AND 7) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_score');
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'impersonated');
  END IF;
  -- A response is only accepted for a survey that survey_claim actually offered in the last hour.
  IF NOT EXISTS (
    SELECT 1 FROM feedback_survey_events e
    WHERE e.user_id = v_uid AND e.action = 'shown' AND e.survey_type = p_type AND e.trigger_key = p_trigger
      AND coalesce(e.subject_ref, '') = coalesce(v_subject, '') AND e.created_at > now() - interval '1 hour'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_offered');
  END IF;

  v_seg := public._feedback_segment(v_uid, v_owner);
  INSERT INTO feedback_survey_responses (account_owner_id, user_id, survey_type, trigger_key, subject_ref, score, comment, contact_ok, plan, role)
  VALUES (v_owner, v_uid, p_type, p_trigger, v_subject, p_score, v_comment, coalesce(p_contact_ok, false), v_seg ->> 'plan', v_seg ->> 'role')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  INSERT INTO feedback_survey_events (user_id, survey_type, trigger_key, subject_ref, action)
  VALUES (v_uid, p_type, p_trigger, v_subject, 'answered');

  v_low := (p_type = 'csat' AND p_score <= 2) OR (p_type = 'ces' AND p_score <= 3);
  IF v_low THEN
    INSERT INTO feedback_followups (source_type, source_id, user_id, account_owner_id, reason, severity, contact_ok)
    VALUES ('survey', v_id, v_uid, v_owner,
            format('Low %s (%s) after %s', upper(p_type), p_score, replace(p_trigger, '_', ' ')),
            CASE WHEN (p_type = 'csat' AND p_score = 1) OR (p_type = 'ces' AND p_score = 1) THEN 'high' ELSE 'normal' END,
            coalesce(p_contact_ok, false))
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'low', v_low);
END;
$$;

CREATE OR REPLACE FUNCTION public.survey_dismiss(p_type text, p_trigger text, p_subject text, p_action text, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_subject text := nullif(left(btrim(coalesce(p_subject, '')), 64), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_type NOT IN ('csat', 'ces') OR p_trigger IS NULL OR p_trigger !~ '^[a-z0-9_]{1,40}$'
     OR p_action NOT IN ('dismissed', 'snoozed', 'never') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  INSERT INTO feedback_survey_events (user_id, survey_type, trigger_key, subject_ref, action)
  VALUES (v_uid, p_type, p_trigger, v_subject, p_action);
  IF p_action = 'snoozed' THEN
    INSERT INTO feedback_survey_prefs (user_id, snoozed_until)
    VALUES (v_uid, now() + make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90)))
    ON CONFLICT (user_id) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, updated_at = now();
  ELSIF p_action = 'never' THEN
    INSERT INTO feedback_survey_prefs (user_id, never_ask) VALUES (v_uid, true)
    ON CONFLICT (user_id) DO UPDATE SET never_ask = true, updated_at = now();
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Detractor NPS (0-6) becomes a team task too. Additive trigger; nps_responses is otherwise untouched.
CREATE OR REPLACE FUNCTION public._nps_followup_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.score <= 6 THEN
    INSERT INTO feedback_followups (source_type, source_id, user_id, account_owner_id, reason, severity, contact_ok)
    VALUES ('nps', NEW.id, NEW.user_id, NEW.account_owner_id, format('NPS detractor (%s)', NEW.score),
            CASE WHEN NEW.score <= 3 THEN 'high' ELSE 'normal' END, false)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_nps_followup ON public.nps_responses;
CREATE TRIGGER trg_nps_followup AFTER INSERT ON public.nps_responses
  FOR EACH ROW EXECUTE FUNCTION public._nps_followup_trigger();

-- Negative in-app feedback (bug reports) also opens a task when the sender allows contact.
CREATE OR REPLACE FUNCTION public._feedback_followup_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category = 'bug' AND NEW.user_id IS NOT NULL THEN
    INSERT INTO feedback_followups (source_type, source_id, user_id, account_owner_id, reason, severity, contact_ok)
    VALUES ('feedback', NEW.id, NEW.user_id, NEW.account_owner_id, 'Bug report ' || NEW.tracking_code, 'normal', NEW.contact_ok)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_feedback_followup ON public.product_feedback;
CREATE TRIGGER trg_feedback_followup AFTER INSERT ON public.product_feedback
  FOR EACH ROW EXECUTE FUNCTION public._feedback_followup_trigger();

-- ---------------------------------------------------------------------------
-- 4. Help-centre loop (anon-callable, aggregate only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_help_feedback_reason(p_slug text, p_visitor_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(p_slug) > 120
     OR p_visitor_id IS NULL OR char_length(p_visitor_id) NOT BETWEEN 8 AND 64
     OR p_reason IS NULL OR p_reason NOT IN ('inaccurate', 'unclear', 'incomplete', 'outdated', 'not_found', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid');
  END IF;
  UPDATE help_article_feedback SET reason = p_reason, updated_at = now()
  WHERE article_slug = p_slug AND visitor_id = p_visitor_id AND helpful = false;
  RETURN jsonb_build_object('success', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION public.log_help_search_miss(p_query text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
  v_clean text;
  v_today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  v_norm := left(regexp_replace(lower(btrim(coalesce(p_query, ''))), '\s+', ' ', 'g'), 80);
  IF char_length(v_norm) < 2 THEN
    RETURN false;
  END IF;
  v_clean := public.feedback_redact(v_norm);
  -- A query that contained an email, phone, token... is dropped, never stored in redacted form.
  IF v_clean <> v_norm THEN
    RETURN false;
  END IF;
  -- Hard daily cap on distinct queries bounds the table against abuse (anon-callable).
  IF NOT EXISTS (SELECT 1 FROM help_search_gaps g WHERE g.query_norm = v_norm AND g.day = v_today)
     AND (SELECT count(*) FROM help_search_gaps g WHERE g.day = v_today) >= 2000 THEN
    RETURN false;
  END IF;
  INSERT INTO help_search_gaps (query_norm, day) VALUES (v_norm, v_today)
  ON CONFLICT (query_norm, day) DO UPDATE SET miss_count = help_search_gaps.miss_count + 1;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Staff dashboard (all audited, staff-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_feedback_inbox(
  p_status text DEFAULT NULL, p_category text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_items jsonb;
BEGIN
  PERFORM public._feedback_assert_staff('feedback_inbox');
  SELECT count(*) INTO v_total FROM product_feedback f
  WHERE (p_status IS NULL OR f.status = p_status) AND (p_category IS NULL OR f.category = p_category);
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_items FROM (
    SELECT jsonb_build_object(
      'id', f.id, 'tracking_code', f.tracking_code, 'category', f.category, 'message', f.message,
      'status', f.status, 'public_note', f.public_note, 'plan', f.plan, 'role', f.role,
      'anonymous', f.anonymous, 'contact_ok', f.contact_ok,
      'account_owner_id', CASE WHEN f.anonymous THEN NULL ELSE f.account_owner_id END,
      'context', f.context, 'screenshot_path', f.screenshot_path,
      'theme_id', f.theme_id, 'theme_source', f.theme_source, 'roadmap_item_id', f.roadmap_item_id,
      'created_at', f.created_at) AS x
    FROM product_feedback f
    WHERE (p_status IS NULL OR f.status = p_status) AND (p_category IS NULL OR f.category = p_category)
    ORDER BY f.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 200) OFFSET greatest(coalesce(p_offset, 0), 0)
  ) s;
  RETURN jsonb_build_object('total', v_total, 'items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_feedback_update(
  p_id uuid, p_status text DEFAULT NULL, p_public_note text DEFAULT NULL,
  p_roadmap_item_id uuid DEFAULT NULL, p_theme_id uuid DEFAULT NULL, p_clear_roadmap boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row product_feedback%ROWTYPE;
  v_note text := nullif(left(btrim(coalesce(p_public_note, '')), 500), '');
BEGIN
  PERFORM public._feedback_assert_staff('feedback_update');
  IF p_status IS NOT NULL AND p_status NOT IN ('received', 'triaged', 'planned', 'in_progress', 'shipped', 'closed', 'declined') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status');
  END IF;
  SELECT * INTO v_row FROM product_feedback WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  UPDATE product_feedback SET
    status = coalesce(p_status, status),
    public_note = CASE WHEN p_public_note IS NULL THEN public_note ELSE v_note END,
    roadmap_item_id = CASE WHEN p_clear_roadmap THEN NULL ELSE coalesce(p_roadmap_item_id, roadmap_item_id) END,
    theme_id = coalesce(p_theme_id, theme_id),
    theme_source = CASE WHEN p_theme_id IS NOT NULL THEN 'human' ELSE theme_source END,
    updated_at = now()
  WHERE id = p_id;

  IF p_status IS NOT NULL AND p_status <> v_row.status THEN
    INSERT INTO product_feedback_events (feedback_id, status, note) VALUES (p_id, p_status, v_note);
    IF p_status IN ('planned', 'in_progress', 'shipped', 'closed', 'declined') THEN
      PERFORM public._feedback_notify(v_row.user_id, 'Update on your feedback ' || v_row.tracking_code,
        'Status is now: ' || replace(p_status, '_', ' ') || coalesce('. ' || v_note, ''), '/dashboard/feedback/mine');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_themes_list()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._feedback_assert_staff('feedback_themes');
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'count')::int DESC), '[]'::jsonb) INTO v FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'title', t.title, 'summary', t.summary, 'status', t.status, 'source', t.source,
      'roadmap_item_id', t.roadmap_item_id, 'created_at', t.created_at,
      'count', (SELECT count(*) FROM product_feedback f WHERE f.theme_id = t.id),
      'samples', coalesce((SELECT jsonb_agg(left(f.message, 160)) FROM (
          SELECT message FROM product_feedback WHERE theme_id = t.id ORDER BY created_at DESC LIMIT 3) f), '[]'::jsonb)
    ) AS x
    FROM feedback_themes t WHERE t.status <> 'rejected'
  ) s;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_theme_review(
  p_theme_id uuid, p_decision text, p_title text DEFAULT NULL, p_roadmap_item_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._feedback_assert_staff('feedback_theme_review');
  IF p_decision NOT IN ('confirm', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_decision');
  END IF;
  UPDATE feedback_themes SET
    status = CASE WHEN p_decision = 'confirm' THEN 'confirmed' ELSE 'rejected' END,
    title = coalesce(nullif(left(btrim(coalesce(p_title, '')), 120), ''), title),
    roadmap_item_id = coalesce(p_roadmap_item_id, roadmap_item_id),
    reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_theme_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE product_feedback SET theme_id = NULL, theme_source = NULL, updated_at = now() WHERE theme_id = p_theme_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Service role only: the feedback-cluster edge function proposes themes; humans confirm them above.
CREATE OR REPLACE FUNCTION public.feedback_theme_apply_ai(p_themes jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t jsonb;
  v_id uuid;
  v_ids uuid[];
  v_made integer := 0;
BEGIN
  IF jsonb_typeof(p_themes) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_themes) LOOP
    CONTINUE WHEN char_length(btrim(coalesce(t ->> 'title', ''))) < 3;
    SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_ids
    FROM jsonb_array_elements_text(coalesce(t -> 'feedback_ids', '[]'::jsonb)) AS x
    WHERE x ~ '^[0-9a-fA-F-]{36}$';
    CONTINUE WHEN cardinality(v_ids) < 2;
    INSERT INTO feedback_themes (title, summary, status, source)
    VALUES (left(btrim(t ->> 'title'), 120), left(btrim(coalesce(t ->> 'summary', '')), 600), 'suggested', 'ai')
    RETURNING id INTO v_id;
    UPDATE product_feedback SET theme_id = v_id, theme_source = 'ai', updated_at = now()
    WHERE id = ANY (v_ids) AND theme_id IS NULL;
    v_made := v_made + 1;
  END LOOP;
  RETURN v_made;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_feedback_trends(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 90), 7), 365);
  v_since timestamptz;
BEGIN
  PERFORM public._feedback_assert_staff('feedback_trends');
  v_since := now() - make_interval(days => v_days);
  RETURN jsonb_build_object(
    'by_category', coalesce((SELECT jsonb_object_agg(category, n) FROM (
        SELECT category, count(*) AS n FROM product_feedback WHERE created_at >= v_since GROUP BY 1) a), '{}'::jsonb),
    'weekly', coalesce((SELECT jsonb_agg(w ORDER BY (w ->> 'week')) FROM (
        SELECT jsonb_build_object('week', to_char(date_trunc('week', created_at), 'YYYY-MM-DD'), 'count', count(*)) AS w
        FROM product_feedback WHERE created_at >= v_since GROUP BY date_trunc('week', created_at)) b), '[]'::jsonb),
    'by_plan', coalesce((SELECT jsonb_agg(p) FROM (
        SELECT jsonb_build_object('plan', coalesce(plan, 'unknown'), 'count', count(*)) AS p
        FROM product_feedback WHERE created_at >= v_since GROUP BY 1 ORDER BY count(*) DESC) c), '[]'::jsonb),
    'by_role', coalesce((SELECT jsonb_agg(r) FROM (
        SELECT jsonb_build_object('role', coalesce(role, 'unknown'), 'count', count(*)) AS r
        FROM product_feedback WHERE created_at >= v_since GROUP BY 1 ORDER BY count(*) DESC) d), '[]'::jsonb),
    'survey_by_plan', coalesce((SELECT jsonb_agg(s) FROM (
        SELECT jsonb_build_object('survey_type', survey_type, 'plan', coalesce(plan, 'unknown'),
                                  'responses', count(*), 'avg', round(avg(score)::numeric, 2)) AS s
        FROM feedback_survey_responses WHERE created_at >= v_since GROUP BY survey_type, plan) e), '[]'::jsonb),
    'survey_by_role', coalesce((SELECT jsonb_agg(s) FROM (
        SELECT jsonb_build_object('survey_type', survey_type, 'role', coalesce(role, 'unknown'),
                                  'responses', count(*), 'avg', round(avg(score)::numeric, 2)) AS s
        FROM feedback_survey_responses WHERE created_at >= v_since GROUP BY survey_type, role) f), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_feedback_top_requests(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._feedback_assert_staff('feedback_top_requests');
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'title', r.title, 'status', r.status, 'votes', r.votes_count,
      'linked_feedback', (SELECT count(*) FROM product_feedback f WHERE f.roadmap_item_id = r.id),
      'score', r.votes_count + (SELECT count(*) FROM product_feedback f WHERE f.roadmap_item_id = r.id)) AS x
    FROM roadmap_items r
    WHERE r.status <> 'declined'
    ORDER BY (r.votes_count + (SELECT count(*) FROM product_feedback f WHERE f.roadmap_item_id = r.id)) DESC, r.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  ) s;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_help_gap_report(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since date := (now() AT TIME ZONE 'utc')::date - least(greatest(coalesce(p_days, 30), 1), 180);
BEGIN
  PERFORM public._feedback_assert_staff('help_gap_report');
  RETURN jsonb_build_object(
    'no_result_queries', coalesce((SELECT jsonb_agg(q) FROM (
        SELECT jsonb_build_object('query', query_norm, 'count', sum(miss_count)) AS q
        FROM help_search_gaps WHERE day >= v_since GROUP BY query_norm ORDER BY sum(miss_count) DESC LIMIT 50) a), '[]'::jsonb),
    'weak_articles', coalesce((SELECT jsonb_agg(w) FROM (
        SELECT jsonb_build_object(
          'slug', article_slug, 'helpful', count(*) FILTER (WHERE helpful), 'not_helpful', count(*) FILTER (WHERE NOT helpful),
          'reasons', coalesce(jsonb_object_agg(reason, 1) FILTER (WHERE reason IS NOT NULL), '{}'::jsonb)) AS w
        FROM help_article_feedback WHERE updated_at >= v_since
        GROUP BY article_slug HAVING count(*) FILTER (WHERE NOT helpful) >= 2
        ORDER BY count(*) FILTER (WHERE NOT helpful) DESC LIMIT 30) b), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_followups_list(p_status text DEFAULT 'open')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._feedback_assert_staff('feedback_followups');
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'due_at')), '[]'::jsonb) INTO v FROM (
    SELECT jsonb_build_object(
      'id', f.id, 'source_type', f.source_type, 'source_id', f.source_id, 'reason', f.reason, 'severity', f.severity,
      'status', f.status, 'note', f.note, 'contact_ok', f.contact_ok, 'email_status', f.email_status,
      'due_at', f.due_at, 'account_owner_id', f.account_owner_id, 'created_at', f.created_at) AS x
    FROM feedback_followups f
    WHERE p_status IS NULL OR f.status = p_status
    ORDER BY f.due_at LIMIT 200
  ) s;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_followup_update(
  p_id uuid, p_status text DEFAULT NULL, p_note text DEFAULT NULL, p_email_body text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row feedback_followups%ROWTYPE;
  v_body text := nullif(left(btrim(coalesce(p_email_body, '')), 1500), '');
BEGIN
  PERFORM public._feedback_assert_staff('feedback_followup_update');
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'in_progress', 'done', 'dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status');
  END IF;
  SELECT * INTO v_row FROM feedback_followups WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_body IS NOT NULL AND NOT v_row.contact_ok THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_contact_consent');
  END IF;
  UPDATE feedback_followups SET
    status = coalesce(p_status, status),
    note = CASE WHEN p_note IS NULL THEN note ELSE nullif(left(btrim(p_note), 1000), '') END,
    assignee = coalesce(assignee, auth.uid()),
    email_body = coalesce(v_body, email_body),
    email_status = CASE WHEN v_body IS NOT NULL THEN 'queued' ELSE email_status END,
    updated_at = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_publish_you_asked(
  p_title text, p_body text, p_href text DEFAULT NULL, p_roadmap_item_id uuid DEFAULT NULL, p_feedback_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  r record;
  v_n integer := 0;
BEGIN
  PERFORM public._feedback_assert_staff('you_asked_publish');
  IF char_length(btrim(coalesce(p_title, ''))) < 3 OR char_length(btrim(coalesce(p_body, ''))) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF p_href IS NOT NULL AND p_href !~ '^/[A-Za-z0-9/_?=&#.-]{0,198}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_href');
  END IF;
  INSERT INTO you_asked_we_built (title, body, href, roadmap_item_id, published_by)
  VALUES (left(btrim(p_title), 120), left(btrim(p_body), 600), p_href, p_roadmap_item_id, auth.uid())
  RETURNING id INTO v_id;

  FOR r IN
    SELECT DISTINCT f.id, f.user_id, f.tracking_code FROM product_feedback f
    WHERE (f.id = ANY (coalesce(p_feedback_ids, ARRAY[]::uuid[]))
           OR (p_roadmap_item_id IS NOT NULL AND f.roadmap_item_id = p_roadmap_item_id))
      AND f.user_id IS NOT NULL
  LOOP
    UPDATE product_feedback SET status = 'shipped', updated_at = now() WHERE id = r.id AND status <> 'shipped';
    IF FOUND THEN
      INSERT INTO product_feedback_events (feedback_id, status, note) VALUES (r.id, 'shipped', left(btrim(p_title), 200));
    END IF;
    PERFORM public._feedback_notify(r.user_id, 'You asked, we built: ' || left(btrim(p_title), 80),
      left(btrim(p_body), 200), coalesce(p_href, '/dashboard/feedback/mine'));
    v_n := v_n + 1;
  END LOOP;

  UPDATE you_asked_we_built SET notified_count = v_n WHERE id = v_id;
  IF p_roadmap_item_id IS NOT NULL THEN
    UPDATE roadmap_items SET status = 'shipped', updated_at = now() WHERE id = p_roadmap_item_id AND status <> 'shipped';
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'notified', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_you_asked_we_built(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', id, 'title', title, 'body', body, 'href', href, 'published_at', published_at) AS x
    FROM you_asked_we_built ORDER BY published_at DESC LIMIT least(greatest(coalesce(p_limit, 5), 1), 20)
  ) s
  WHERE auth.uid() IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privacy: preferences, GDPR export / erase, retention
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_feedback_privacy()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'never_ask', coalesce((SELECT never_ask FROM feedback_survey_prefs WHERE user_id = auth.uid()), false),
    'anonymous_default', coalesce((SELECT anonymous_default FROM feedback_survey_prefs WHERE user_id = auth.uid()), false),
    'snoozed_until', (SELECT snoozed_until FROM feedback_survey_prefs WHERE user_id = auth.uid())
  )
  WHERE auth.uid() IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.set_feedback_privacy(p_never_ask boolean DEFAULT NULL, p_anonymous_default boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  INSERT INTO feedback_survey_prefs (user_id, never_ask, anonymous_default)
  VALUES (auth.uid(), coalesce(p_never_ask, false), coalesce(p_anonymous_default, false))
  ON CONFLICT (user_id) DO UPDATE SET
    never_ask = coalesce(p_never_ask, feedback_survey_prefs.never_ask),
    anonymous_default = coalesce(p_anonymous_default, feedback_survey_prefs.anonymous_default),
    -- turning surveys back on also clears any snooze
    snoozed_until = CASE WHEN p_never_ask = false THEN NULL ELSE feedback_survey_prefs.snoozed_until END,
    updated_at = now();
  RETURN public.get_feedback_privacy();
END;
$$;

CREATE OR REPLACE FUNCTION public.export_my_feedback_data()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN jsonb_build_object(
    'exported_at', now(),
    'feedback', coalesce((SELECT jsonb_agg(to_jsonb(f) - 'content_hash' - 'user_id' - 'account_owner_id' ORDER BY f.created_at)
                          FROM product_feedback f WHERE f.user_id = v_uid), '[]'::jsonb),
    'feedback_events', coalesce((SELECT jsonb_agg(jsonb_build_object('tracking_code', f.tracking_code, 'status', e.status, 'note', e.note, 'at', e.created_at) ORDER BY e.created_at)
                          FROM product_feedback_events e JOIN product_feedback f ON f.id = e.feedback_id WHERE f.user_id = v_uid), '[]'::jsonb),
    'survey_responses', coalesce((SELECT jsonb_agg(to_jsonb(r) - 'user_id' - 'account_owner_id' ORDER BY r.created_at)
                          FROM feedback_survey_responses r WHERE r.user_id = v_uid), '[]'::jsonb),
    'survey_events', coalesce((SELECT jsonb_agg(to_jsonb(e) - 'user_id' ORDER BY e.created_at)
                          FROM feedback_survey_events e WHERE e.user_id = v_uid), '[]'::jsonb),
    'preferences', (SELECT to_jsonb(p) - 'user_id' FROM feedback_survey_prefs p WHERE p.user_id = v_uid)
  );
END;
$$;

-- Erases the caller's feedback data. Returns the screenshot paths so the client can remove the files
-- from the bucket (the delete policy above allows exactly that, own folder only).
CREATE OR REPLACE FUNCTION public.delete_my_feedback_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_paths text[];
  n_fb integer;
  n_sr integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT coalesce(array_agg(screenshot_path), ARRAY[]::text[]) INTO v_paths
  FROM product_feedback WHERE user_id = v_uid AND screenshot_path IS NOT NULL;

  DELETE FROM feedback_followups WHERE user_id = v_uid;
  DELETE FROM product_feedback WHERE user_id = v_uid;
  GET DIAGNOSTICS n_fb = ROW_COUNT;
  DELETE FROM feedback_survey_responses WHERE user_id = v_uid;
  GET DIAGNOSTICS n_sr = ROW_COUNT;
  DELETE FROM feedback_survey_events WHERE user_id = v_uid;
  DELETE FROM feedback_survey_prefs WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'feedback', n_fb, 'survey_responses', n_sr, 'screenshot_paths', to_jsonb(v_paths));
END;
$$;

-- Retention (service role, run daily by the feedback-retention edge function).
-- Screenshots 90d, survey events 400d, search gaps 90d, done follow-ups 365d,
-- identity link + survey comments removed after 730d (the redacted text is kept as anonymous data).
CREATE OR REPLACE FUNCTION public.feedback_retention_screenshots(p_days integer DEFAULT 90)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(screenshot_path), ARRAY[]::text[])
  FROM product_feedback
  WHERE screenshot_path IS NOT NULL AND created_at < now() - make_interval(days => greatest(coalesce(p_days, 90), 7));
$$;

CREATE OR REPLACE FUNCTION public.feedback_retention_apply(p_screenshot_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_shots integer; n_events integer; n_gaps integer; n_follow integer; n_anon integer; n_comments integer;
BEGIN
  UPDATE product_feedback SET screenshot_path = NULL, updated_at = now()
  WHERE screenshot_path IS NOT NULL AND created_at < now() - make_interval(days => greatest(coalesce(p_screenshot_days, 90), 7));
  GET DIAGNOSTICS n_shots = ROW_COUNT;

  DELETE FROM feedback_survey_events WHERE created_at < now() - interval '400 days';
  GET DIAGNOSTICS n_events = ROW_COUNT;

  DELETE FROM help_search_gaps WHERE day < (now() AT TIME ZONE 'utc')::date - 90;
  GET DIAGNOSTICS n_gaps = ROW_COUNT;

  DELETE FROM feedback_followups WHERE status IN ('done', 'dismissed') AND updated_at < now() - interval '365 days';
  GET DIAGNOSTICS n_follow = ROW_COUNT;

  UPDATE product_feedback SET user_id = NULL, account_owner_id = NULL, contact_ok = false, anonymized_at = now(), updated_at = now()
  WHERE user_id IS NOT NULL AND created_at < now() - interval '730 days';
  GET DIAGNOSTICS n_anon = ROW_COUNT;

  UPDATE feedback_survey_responses SET comment = NULL
  WHERE comment IS NOT NULL AND created_at < now() - interval '730 days';
  GET DIAGNOSTICS n_comments = ROW_COUNT;

  RETURN jsonb_build_object('screenshots_cleared', n_shots, 'survey_events', n_events, 'search_gaps', n_gaps,
                            'followups', n_follow, 'feedback_anonymized', n_anon, 'survey_comments_cleared', n_comments);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: nothing is callable unless listed here
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public._feedback_segment(uuid, uuid), public._feedback_tracking_code(), public._feedback_assert_staff(text),
  public._feedback_notify(uuid, text, text, text), public._nps_followup_trigger(), public._feedback_followup_trigger(),
  public.feedback_theme_apply_ai(jsonb), public.feedback_retention_screenshots(integer), public.feedback_retention_apply(integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.submit_product_feedback(text, text, jsonb, boolean, boolean, text), public.my_feedback_list(integer),
  public.survey_claim(text, text, text), public.survey_respond(text, text, text, integer, text, boolean),
  public.survey_dismiss(text, text, text, text, integer), public.list_you_asked_we_built(integer),
  public.get_feedback_privacy(), public.set_feedback_privacy(boolean, boolean),
  public.export_my_feedback_data(), public.delete_my_feedback_data(),
  public.staff_feedback_inbox(text, text, integer, integer),
  public.staff_feedback_update(uuid, text, text, uuid, uuid, boolean), public.staff_themes_list(),
  public.staff_theme_review(uuid, text, text, uuid), public.staff_feedback_trends(integer),
  public.staff_feedback_top_requests(integer), public.staff_help_gap_report(integer),
  public.staff_followups_list(text), public.staff_followup_update(uuid, text, text, text),
  public.staff_publish_you_asked(text, text, text, uuid, uuid[])
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.submit_product_feedback(text, text, jsonb, boolean, boolean, text), public.my_feedback_list(integer),
  public.survey_claim(text, text, text), public.survey_respond(text, text, text, integer, text, boolean),
  public.survey_dismiss(text, text, text, text, integer), public.list_you_asked_we_built(integer),
  public.get_feedback_privacy(), public.set_feedback_privacy(boolean, boolean),
  public.export_my_feedback_data(), public.delete_my_feedback_data(),
  public.staff_feedback_inbox(text, text, integer, integer),
  public.staff_feedback_update(uuid, text, text, uuid, uuid, boolean), public.staff_themes_list(),
  public.staff_theme_review(uuid, text, text, uuid), public.staff_feedback_trends(integer),
  public.staff_feedback_top_requests(integer), public.staff_help_gap_report(integer),
  public.staff_followups_list(text), public.staff_followup_update(uuid, text, text, text),
  public.staff_publish_you_asked(text, text, text, uuid, uuid[])
TO authenticated;

REVOKE ALL ON FUNCTION public.set_help_feedback_reason(text, text, text), public.log_help_search_miss(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_help_feedback_reason(text, text, text), public.log_help_search_miss(text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.feedback_redact(text), public.feedback_clean_context(jsonb), public.feedback_clean_route(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feedback_theme_apply_ai(jsonb), public.feedback_retention_screenshots(integer), public.feedback_retention_apply(integer) TO service_role;

COMMENT ON TABLE public.product_feedback IS 'In-app feedback. Written only by submit_product_feedback (server-side redaction).';
COMMENT ON TABLE public.feedback_survey_responses IS 'In-app CSAT/CES answers. Written only by survey_respond after survey_claim offered the survey.';
