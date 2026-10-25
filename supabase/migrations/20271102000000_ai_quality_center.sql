/*
  # AI Quality Center

  ## Why
  Owners could see THAT calls happened (calls, call_score, call_feedback) but not
  whether the AI receptionist was RIGHT: did it invent a fact, miss a booking,
  skip a required sentence — and what to change so it stops. This adds a
  per-call scorecard, flagged findings, and one-click fixes that update the
  Knowledge Base or a Call Script.

  ## What this adds
  1. `ai_quality_rules`     owner-editable compliance phrases (required / forbidden).
  2. `ai_quality_reviews`   one scorecard per call (overall + 5 dimensions).
  3. `ai_quality_findings`  flagged issues with a verified evidence quote.
  4. `ai_quality_fixes`     proposed one-click fixes (KB article / script patch).
  5. RPCs: ensure_ai_quality_default_rules, get_ai_quality_feed,
     get_ai_quality_overview (coverage + live-copilot stats),
     set_ai_quality_finding_status, reject_ai_quality_fix, apply_ai_quality_fix.

  ## Security
  - Same gate as Call Scripts: tenant = get_account_owner_id() AND
    can_edit_call_scripts() (owner, or member with can_edit_business_profile).
  - reviews / findings / fixes are SELECT-only for `authenticated`. They are
    written by the call-quality-review Edge Function (service role) and by the
    SECURITY DEFINER RPCs below, so scores and evidence can never be forged
    from the browser.
  - apply_ai_quality_fix writes knowledge_articles / call_script_versions under
    the caller's permission check; articles are versioned by the existing
    trigger and script versions are immutable, so every fix is reversible.

  Depends on: calls, call_feedback, knowledge_articles, call_scripts,
  call_script_versions, live_copilot_sessions, live_copilot_turns,
  team_members, can_edit_call_scripts(), get_account_owner_id().
*/

-- =============================================================
-- 1. Compliance rules
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_quality_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 80),
  rule_type text NOT NULL CHECK (rule_type IN ('required', 'forbidden')),
  patterns text[] NOT NULL CHECK (cardinality(patterns) BETWEEN 1 AND 12),
  applies_when text NOT NULL DEFAULT 'always' CHECK (applies_when IN ('always', 'emergency', 'booking', 'pricing')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  script_instruction text CHECK (script_instruction IS NULL OR char_length(script_instruction) <= 400),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_quality_rules_label
  ON public.ai_quality_rules (user_id, lower(btrim(label)));

-- =============================================================
-- 2. Reviews (one scorecard per call)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_quality_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES public.calls(id) ON DELETE CASCADE,
  call_at timestamptz NOT NULL,
  scenario text,
  overall_score smallint CHECK (overall_score BETWEEN 0 AND 100),
  accuracy_score smallint CHECK (accuracy_score BETWEEN 0 AND 100),
  compliance_score smallint CHECK (compliance_score BETWEEN 0 AND 100),
  booking_score smallint CHECK (booking_score BETWEEN 0 AND 100),
  upsell_score smallint CHECK (upsell_score BETWEEN 0 AND 100),
  experience_score smallint CHECK (experience_score BETWEEN 0 AND 100),
  ai_status text NOT NULL DEFAULT 'ok' CHECK (ai_status IN ('ok', 'skipped', 'failed')),
  summary text,
  compliance jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  quality_version integer NOT NULL DEFAULT 1,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_quality_reviews_user_call_at
  ON public.ai_quality_reviews (user_id, call_at DESC);

-- =============================================================
-- 3. Findings
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_quality_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.ai_quality_reviews(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN
    ('hallucination', 'price_error', 'missed_booking', 'missed_upsell', 'compliance_miss', 'knowledge_gap')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 600),
  evidence_quote text CHECK (evidence_quote IS NULL OR char_length(evidence_quote) <= 400),
  turn_index integer,
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 200),
  rule_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_ai_quality_findings_user_status
  ON public.ai_quality_findings (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_quality_findings_review
  ON public.ai_quality_findings (review_id);

-- =============================================================
-- 4. Fixes
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_quality_fixes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES public.ai_quality_findings(id) ON DELETE SET NULL,
  fix_key text NOT NULL CHECK (char_length(fix_key) BETWEEN 1 AND 240),
  fix_type text NOT NULL CHECK (fix_type IN ('kb_article', 'script_patch')),
  scenario text,
  proposal jsonb NOT NULL,
  rationale text CHECK (rationale IS NULL OR char_length(rationale) <= 400),
  evidence_count integer NOT NULL DEFAULT 1 CHECK (evidence_count >= 1),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected')),
  applied_by uuid,
  applied_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One open proposal per fix_key: the same problem on 12 calls is ONE fix with evidence_count = 12.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_quality_fixes_open_key
  ON public.ai_quality_fixes (user_id, fix_key) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_ai_quality_fixes_user_status
  ON public.ai_quality_fixes (user_id, status, created_at DESC);

-- =============================================================
-- 5. Row Level Security
-- =============================================================

ALTER TABLE public.ai_quality_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quality_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quality_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_quality_fixes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_quality_rules_select" ON public.ai_quality_rules;
DROP POLICY IF EXISTS "ai_quality_rules_insert" ON public.ai_quality_rules;
DROP POLICY IF EXISTS "ai_quality_rules_update" ON public.ai_quality_rules;
DROP POLICY IF EXISTS "ai_quality_rules_delete" ON public.ai_quality_rules;

CREATE POLICY "ai_quality_rules_select" ON public.ai_quality_rules
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "ai_quality_rules_insert" ON public.ai_quality_rules
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "ai_quality_rules_update" ON public.ai_quality_rules
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "ai_quality_rules_delete" ON public.ai_quality_rules
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

DROP POLICY IF EXISTS "ai_quality_reviews_select" ON public.ai_quality_reviews;
CREATE POLICY "ai_quality_reviews_select" ON public.ai_quality_reviews
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

DROP POLICY IF EXISTS "ai_quality_findings_select" ON public.ai_quality_findings;
CREATE POLICY "ai_quality_findings_select" ON public.ai_quality_findings
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

DROP POLICY IF EXISTS "ai_quality_fixes_select" ON public.ai_quality_fixes;
CREATE POLICY "ai_quality_fixes_select" ON public.ai_quality_fixes
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

-- =============================================================
-- 6. Internal helper: every auth user that belongs to an account
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_quality_account_user_ids(p_owner uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_owner
  UNION
  SELECT u.id
    FROM public.team_members tm
    JOIN auth.users u ON u.email = tm.member_email
   WHERE tm.account_owner_id = p_owner;
$$;

REVOKE ALL ON FUNCTION public.ai_quality_account_user_ids(uuid) FROM PUBLIC;

-- =============================================================
-- 7. Default compliance rules (seeded once, then owner-editable)
-- =============================================================

CREATE OR REPLACE FUNCTION public.ensure_ai_quality_default_rules()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count integer := 0;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to manage AI quality rules' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ai_quality_rules:' || v_owner::text, 0));

  -- Seed only for accounts that have never been reviewed, so an owner who
  -- deliberately deletes every rule does not get them back.
  IF EXISTS (SELECT 1 FROM public.ai_quality_rules WHERE user_id = v_owner)
     OR EXISTS (SELECT 1 FROM public.ai_quality_reviews WHERE user_id = v_owner) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.ai_quality_rules (user_id, label, rule_type, patterns, applies_when, severity, script_instruction)
  VALUES
    (v_owner, 'Call recording notice', 'required',
      ARRAY['may be recorded', 'being recorded', 'is recorded', 'recorded for quality'], 'always', 'medium',
      'Early in every call, say that the call may be recorded for quality purposes.'),
    (v_owner, 'AI disclosure', 'required',
      ARRAY['ai assistant', 'virtual assistant', 'automated assistant', 'ai receptionist', 'digital assistant'], 'always', 'medium',
      'Introduce yourself as the business''s AI assistant at the start of the call.'),
    (v_owner, 'Emergency safety advice', 'required',
      ARRAY['911', 'emergency services', 'fire department', 'leave the house', 'leave the home', 'evacuate'], 'emergency', 'critical',
      'For a gas smell, smoke, fire, sparking or carbon monoxide: tell the caller to leave the building and call 911 or emergency services BEFORE anything else.'),
    (v_owner, 'No claiming to be human', 'forbidden',
      ARRAY['i am a real person', 'im a real person', 'i am human', 'im a human', 'i am not a robot', 'im not a robot'], 'always', 'high',
      'Never claim to be a human. If asked, say you are the business''s AI assistant.'),
    (v_owner, 'No guarantees', 'forbidden',
      ARRAY['100 guaranteed', 'guaranteed to fix', 'i guarantee', 'we guarantee', 'no risk'], 'always', 'medium',
      'Never promise guaranteed outcomes. Say the technician will assess and confirm on site.')
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_ai_quality_default_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_ai_quality_default_rules() TO authenticated;

-- =============================================================
-- 8. Scorecard feed (reviews + call + CURRENT customer rating)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ai_quality_feed(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer DEFAULT 1500
)
RETURNS TABLE (
  review_id uuid,
  call_id uuid,
  call_at timestamptz,
  caller_name text,
  caller_phone text,
  duration_seconds integer,
  is_emergency boolean,
  scenario text,
  overall_score smallint,
  accuracy_score smallint,
  compliance_score smallint,
  booking_score smallint,
  upsell_score smallint,
  experience_score smallint,
  ai_status text,
  summary text,
  compliance jsonb,
  feedback_rating smallint,
  feedback_comment text,
  open_findings integer,
  reviewed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to view AI quality' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT r.id, r.call_id, r.call_at, c.caller_name, c.caller_phone, c.duration_seconds, c.is_emergency,
         r.scenario, r.overall_score, r.accuracy_score, r.compliance_score, r.booking_score,
         r.upsell_score, r.experience_score, r.ai_status, r.summary, r.compliance,
         cf.rating, nullif(btrim(cf.comment), ''),
         (SELECT count(*)::integer FROM public.ai_quality_findings f WHERE f.review_id = r.id AND f.status = 'open'),
         r.reviewed_at
    FROM public.ai_quality_reviews r
    JOIN public.calls c ON c.id = r.call_id AND c.user_id = v_owner
    LEFT JOIN public.call_feedback cf ON cf.call_id = r.call_id
   WHERE r.user_id = v_owner
     AND r.call_at >= p_from
     AND r.call_at < p_to
   ORDER BY r.call_at DESC
   LIMIT least(greatest(p_limit, 1), 5000);
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_quality_feed(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ai_quality_feed(timestamptz, timestamptz, integer) TO authenticated;

-- =============================================================
-- 9. Overview: review coverage + live-copilot quality
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ai_quality_overview(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_calls integer;
  v_eligible integer;
  v_reviewed integer;
  v_sessions integer;
  v_escalated integer;
  v_emergency integer;
  v_turns integer;
  v_avg_conf numeric;
  v_low_conf integer;
  v_missing jsonb;
  v_flagged jsonb;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to view AI quality' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE length(coalesce(c.transcript, '')) >= 200)::integer
    INTO v_calls, v_eligible
    FROM public.calls c
   WHERE c.user_id = v_owner AND c.call_datetime >= p_from AND c.call_datetime < p_to;

  SELECT count(*)::integer INTO v_reviewed
    FROM public.ai_quality_reviews r
   WHERE r.user_id = v_owner AND r.call_at >= p_from AND r.call_at < p_to;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE s.status = 'escalated')::integer,
         count(*) FILTER (WHERE s.max_severity = 'emergency')::integer
    INTO v_sessions, v_escalated, v_emergency
    FROM public.live_copilot_sessions s
   WHERE s.user_id IN (SELECT public.ai_quality_account_user_ids(v_owner))
     AND s.created_at >= p_from AND s.created_at < p_to;

  SELECT count(*)::integer,
         round(avg(t.confidence)::numeric, 3),
         count(*) FILTER (WHERE t.confidence IS NOT NULL AND t.confidence < 0.5)::integer
    INTO v_turns, v_avg_conf, v_low_conf
    FROM public.live_copilot_turns t
   WHERE t.user_id IN (SELECT public.ai_quality_account_user_ids(v_owner))
     AND t.created_at >= p_from AND t.created_at < p_to;

  SELECT coalesce(jsonb_agg(jsonb_build_object('text', x.txt, 'count', x.n) ORDER BY x.n DESC, x.txt), '[]'::jsonb)
    INTO v_missing
    FROM (
      SELECT lower(btrim(m.txt)) AS txt, count(*)::integer AS n
        FROM public.live_copilot_turns t
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(t.result -> 'missing_info') = 'array' THEN t.result -> 'missing_info' ELSE '[]'::jsonb END
        ) AS m(txt)
       WHERE t.user_id IN (SELECT public.ai_quality_account_user_ids(v_owner))
         AND t.created_at >= p_from AND t.created_at < p_to
         AND length(btrim(m.txt)) > 0
       GROUP BY 1
       ORDER BY n DESC, txt
       LIMIT 8
    ) x;

  SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY y.created_at DESC), '[]'::jsonb)
    INTO v_flagged
    FROM (
      SELECT s.id, s.created_at, s.status, s.max_severity, s.turn_count, s.job_id,
             (SELECT min(t.confidence) FROM public.live_copilot_turns t WHERE t.session_id = s.id) AS min_confidence
        FROM public.live_copilot_sessions s
       WHERE s.user_id IN (SELECT public.ai_quality_account_user_ids(v_owner))
         AND s.created_at >= p_from AND s.created_at < p_to
         AND (
           s.status = 'escalated'
           OR s.max_severity IN ('high', 'emergency')
           OR EXISTS (SELECT 1 FROM public.live_copilot_turns t WHERE t.session_id = s.id AND t.confidence < 0.4)
         )
       ORDER BY s.created_at DESC
       LIMIT 10
    ) y;

  RETURN jsonb_build_object(
    'coverage', jsonb_build_object('calls', coalesce(v_calls, 0), 'eligible', coalesce(v_eligible, 0), 'reviewed', coalesce(v_reviewed, 0)),
    'copilot', jsonb_build_object(
      'sessions', coalesce(v_sessions, 0),
      'escalated', coalesce(v_escalated, 0),
      'emergency', coalesce(v_emergency, 0),
      'turns', coalesce(v_turns, 0),
      'avg_confidence', v_avg_conf,
      'low_confidence_turns', coalesce(v_low_conf, 0),
      'top_missing_info', v_missing,
      'flagged_sessions', v_flagged
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_quality_overview(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ai_quality_overview(timestamptz, timestamptz) TO authenticated;

-- =============================================================
-- 10. Finding / fix state changes
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_ai_quality_finding_status(p_finding_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to manage AI quality' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('open', 'dismissed') THEN
    RAISE EXCEPTION 'Status must be open or dismissed';
  END IF;

  UPDATE public.ai_quality_findings f
     SET status = p_status,
         resolved_by = CASE WHEN p_status = 'dismissed' THEN auth.uid() ELSE NULL END,
         resolved_at = CASE WHEN p_status = 'dismissed' THEN now() ELSE NULL END
   WHERE f.id = p_finding_id AND f.user_id = v_owner AND f.status <> 'fixed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finding not found or already fixed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_ai_quality_finding_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ai_quality_finding_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_ai_quality_fix(p_fix_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_finding uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to manage AI quality' USING ERRCODE = '42501';
  END IF;

  UPDATE public.ai_quality_fixes x
     SET status = 'rejected'
   WHERE x.id = p_fix_id AND x.user_id = v_owner AND x.status = 'proposed'
  RETURNING x.finding_id INTO v_finding;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fix not found or already handled';
  END IF;

  UPDATE public.ai_quality_findings f
     SET status = 'dismissed', resolved_by = auth.uid(), resolved_at = now()
   WHERE f.id = v_finding AND f.user_id = v_owner AND f.status = 'open';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_ai_quality_fix(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_ai_quality_fix(uuid) TO authenticated;

-- =============================================================
-- 11. One-click fix
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_ai_quality_fix(p_fix_id uuid, p_overrides jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fix public.ai_quality_fixes%ROWTYPE;
  v_ov jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_result jsonb;
  v_resolved integer := 0;
  v_fp text;

  -- knowledge base
  v_title text;
  v_body text;
  v_summary text;
  v_keywords text[];
  v_target uuid;
  v_article uuid;
  v_updated boolean := false;

  -- script
  v_scn text;
  v_add text;
  v_script public.call_scripts%ROWTYPE;
  v_open text := '';
  v_cur text := '';
  v_new text;
  v_ver uuid;
  v_live boolean := false;
  v_changed boolean := true;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'Not allowed to apply AI quality fixes' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_fix FROM public.ai_quality_fixes WHERE id = p_fix_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fix not found';
  END IF;
  IF v_fix.status <> 'proposed' THEN
    RAISE EXCEPTION 'This fix was already handled';
  END IF;

  IF v_fix.fix_type = 'kb_article' THEN
    v_title := left(btrim(coalesce(v_ov ->> 'title', v_fix.proposal ->> 'title', '')), 120);
    v_body := btrim(regexp_replace(coalesce(v_ov ->> 'answer', v_ov ->> 'body', ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'));
    v_body := left(replace(replace(v_body, '{{', '{ {'), '}}', '} }'), 1200);
    IF char_length(v_body) < 10 THEN
      RAISE EXCEPTION 'Write the correct answer first (at least 10 characters).';
    END IF;
    IF char_length(v_title) < 2 THEN
      RAISE EXCEPTION 'The article needs a title.';
    END IF;
    v_summary := CASE WHEN char_length(v_body) <= 300 THEN v_body ELSE left(v_body, 297) || '…' END;

    v_keywords := ARRAY[]::text[];
    IF jsonb_typeof(v_fix.proposal -> 'keywords') = 'array' THEN
      SELECT coalesce(array_agg(k.kw), ARRAY[]::text[]) INTO v_keywords
        FROM (
          SELECT left(btrim(e.value), 40) AS kw
            FROM jsonb_array_elements_text(v_fix.proposal -> 'keywords') AS e(value)
           WHERE btrim(e.value) <> ''
           LIMIT 8
        ) k;
    END IF;

    BEGIN
      v_target := nullif(v_fix.proposal ->> 'target_article_id', '')::uuid;
    EXCEPTION WHEN others THEN
      v_target := NULL;
    END;

    IF v_target IS NOT NULL THEN
      UPDATE public.knowledge_articles a
         SET summary = v_summary,
             body = v_body,
             status = 'published',
             keywords = CASE WHEN cardinality(v_keywords) > 0 THEN v_keywords ELSE a.keywords END
       WHERE a.id = v_target AND a.user_id = v_owner
      RETURNING a.id INTO v_article;
      v_updated := v_article IS NOT NULL;
    END IF;

    IF v_article IS NULL THEN
      INSERT INTO public.knowledge_articles
        (user_id, title, summary, body, keywords, audience, status, source, created_by, updated_by)
      VALUES
        (v_owner, v_title, v_summary, v_body, v_keywords, 'all', 'published', 'gap', auth.uid(), auth.uid())
      RETURNING id INTO v_article;
    END IF;

    v_result := jsonb_build_object('type', 'kb_article', 'article_id', v_article, 'updated_existing', v_updated);

  ELSIF v_fix.fix_type = 'script_patch' THEN
    v_scn := coalesce(nullif(btrim(v_ov ->> 'scenario'), ''), v_fix.scenario, v_fix.proposal ->> 'scenario');
    IF v_scn IS NULL OR v_scn NOT IN
       ('emergency', 'after_hours', 'new_inquiry', 'price_quote', 'reschedule_cancel', 'existing_customer', 'complaint') THEN
      RAISE EXCEPTION 'Choose which call script this change belongs to.';
    END IF;

    v_add := btrim(regexp_replace(coalesce(v_ov ->> 'addition', v_fix.proposal ->> 'addition', ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'));
    v_add := left(replace(replace(v_add, '{{', '{ {'), '}}', '} }'), 400);
    IF char_length(v_add) < 10 THEN
      RAISE EXCEPTION 'The instruction is too short.';
    END IF;

    INSERT INTO public.call_scripts (user_id, scenario) VALUES (v_owner, v_scn)
    ON CONFLICT (user_id, scenario) DO NOTHING;

    SELECT * INTO v_script FROM public.call_scripts WHERE user_id = v_owner AND scenario = v_scn FOR UPDATE;

    IF v_script.active_version_id IS NOT NULL THEN
      SELECT coalesce(v.opening_line, ''), coalesce(v.body, '') INTO v_open, v_cur
        FROM public.call_script_versions v WHERE v.id = v_script.active_version_id;
    END IF;

    IF position(lower(regexp_replace(v_add, '\s+', ' ', 'g')) IN lower(regexp_replace(v_cur, '\s+', ' ', 'g'))) > 0 THEN
      v_changed := false;
      v_result := jsonb_build_object('type', 'script_patch', 'scenario', v_scn, 'changed', false, 'live', true);
    ELSE
      v_new := CASE WHEN btrim(v_cur) = '' THEN v_add ELSE rtrim(v_cur) || E'\n\n' || v_add END;
      IF char_length(v_new) > 2500 THEN
        RAISE EXCEPTION 'This script is full (2500 characters). Shorten it in Call Scripts, then apply the fix.';
      END IF;
      IF char_length(v_new) < 20 THEN
        RAISE EXCEPTION 'The instruction is too short to publish as a script.';
      END IF;

      INSERT INTO public.call_script_versions (script_id, user_id, opening_line, body, change_note, created_by)
      VALUES (v_script.id, v_owner, v_open, v_new, 'AI Quality Center fix', auth.uid())
      RETURNING id INTO v_ver;

      -- Never silently restart a running A/B test: with a challenger the new
      -- version is saved but stays off until the owner decides in Call Scripts.
      IF v_script.challenger_version_id IS NULL THEN
        UPDATE public.call_scripts SET active_version_id = v_ver WHERE id = v_script.id;
        v_live := true;
      END IF;

      v_result := jsonb_build_object('type', 'script_patch', 'scenario', v_scn, 'changed', true, 'live', v_live, 'version_id', v_ver);
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown fix type';
  END IF;

  UPDATE public.ai_quality_fixes
     SET status = 'applied', applied_by = auth.uid(), applied_at = now(), result = v_result
   WHERE id = v_fix.id;

  -- The same root cause on other calls (same fingerprint) is resolved by the same fix.
  IF v_fix.finding_id IS NOT NULL THEN
    SELECT f.fingerprint INTO v_fp FROM public.ai_quality_findings f WHERE f.id = v_fix.finding_id;
    UPDATE public.ai_quality_findings f
       SET status = 'fixed', resolved_by = auth.uid(), resolved_at = now()
     WHERE f.user_id = v_owner AND f.status = 'open'
       AND (f.id = v_fix.finding_id OR (v_fp IS NOT NULL AND f.fingerprint = v_fp AND f.kind <> 'hallucination'));
    GET DIAGNOSTICS v_resolved = ROW_COUNT;
  END IF;

  RETURN v_result || jsonb_build_object('findings_resolved', v_resolved);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_ai_quality_fix(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_ai_quality_fix(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.apply_ai_quality_fix(uuid, jsonb) IS
  'One-click fix: creates/updates a published knowledge article (owner-supplied answer) or appends guidance to a call script as a new immutable version. Owner or can_edit_business_profile only.';
