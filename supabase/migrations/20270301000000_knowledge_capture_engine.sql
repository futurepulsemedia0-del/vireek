/*
  # Vireek Knowledge Capture Engine (KCE)

  ## Why
  A senior technician's diagnostic instinct lives in their head. When they retire,
  it leaves the company. KCE turns the signals Vireek already sees (calls, job notes,
  diagnosis runs, live copilot sessions, expert sessions, repair outcomes, corrections,
  voice/video) into governed "tribal rules":

      On <make/model>: when <symptom A + symptom B> -> usually <cause> -> do <action>

  and walks each rule through a controlled lifecycle:

      candidate -> in_review -> approved -> deployed        (or rejected / retired)

  with immutable versions, a computed confidence score, and an outcome feedback loop
  (technicians mark "worked / didn't work" on real jobs, which moves confidence).

  ## Not the Knowledge Base
  knowledge_articles stays the human-written KB. KCE owns the *rules* and their
  evidence. Deploying a rule MIRRORS it into knowledge_articles (audience='team',
  source='manual', category 'Tribal Knowledge') so the existing search/embedding
  pipeline serves it with zero changes. knowledge_articles is never altered.

  ## Safety model
  - AI only ever creates CANDIDATES. Nothing reaches technicians without a human approving it.
  - Approver cannot be the rule's originating contributor (owner excepted - sole-operator case).
  - Deploy requires approved status AND confidence >= 40.
  - Every content edit creates an immutable version row.
  - All writes go through SECURITY DEFINER RPCs; clients only SELECT.
  - Account scoping via get_account_owner_id() on every table.

  ## Depends on (all already in the repo)
  get_account_owner_id(), get_my_team_member_id() (20261212000000), profiles, team_members,
  jobs, calls, diagnosis_sessions, live_copilot_sessions, expert_assist_requests,
  knowledge_articles.

  ## Deploy order
    1. Run this migration (rename the timestamp so it sorts AFTER your newest migration).
    2. supabase functions deploy kce-extract --no-verify-jwt
    3. Secrets: reuses GEMINI_API_KEY / GEMINI_MODEL / CRON_SECRET (already set).
    4. Apply the src/ edits.
*/

-- =============================================================
-- 0. Pure helpers (immutable)
-- =============================================================

-- Lowercased, de-noised, lightly stemmed tokens (clicking/clicks/click -> click) so that the same
-- knowledge phrased differently by two technicians still matches. Used on BOTH sides of every
-- comparison, so consistency matters more than linguistic perfection.
CREATE OR REPLACE FUNCTION public.kce_tokens(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT s), ARRAY[]::text[])
  FROM (
    SELECT regexp_replace(
             CASE
               WHEN t ~ '^[a-z]+$' AND length(t) >= 6 AND t ~ 'ing$' THEN regexp_replace(t, 'ing$', '')
               WHEN t ~ '^[a-z]+$' AND length(t) >= 5 AND t ~ '(ed|es)$' THEN regexp_replace(t, '(ed|es)$', '')
               WHEN t ~ '^[a-z]+$' AND length(t) >= 4 AND t ~ '[^s]s$' THEN regexp_replace(t, 's$', '')
               ELSE t
             END,
             '([^aeiou0-9])\1$', '\1'
           ) AS s
    FROM unnest(regexp_split_to_array(lower(regexp_replace(COALESCE(p_text, ''), '[^[:alnum:]]+', ' ', 'g')), '\s+')) AS t
    WHERE length(t) >= 3
      AND t <> ALL (ARRAY[
        'the','and','for','with','that','this','from','when','then','has','have','had','was','were',
        'are','not','but','its','into','out','unit','system','after','before','than','usually','check',
        'issue','problem','you','your','will','can','may','also','just','very','all','any','one','two'
      ])
  ) x
  WHERE length(s) >= 3;
$$;

-- |a ∩ b| / |a ∪ b|  (inputs are DISTINCT token arrays)
CREATE OR REPLACE FUNCTION public.kce_jaccard(a text[], b text[])
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN COALESCE(cardinality(a), 0) = 0 OR COALESCE(cardinality(b), 0) = 0 THEN 0::numeric
    ELSE (SELECT count(*) FROM unnest(a) x WHERE x = ANY(b))::numeric
         / (cardinality(a) + cardinality(b) - (SELECT count(*) FROM unnest(a) x WHERE x = ANY(b)))::numeric
  END;
$$;

-- |a ∩ b| / |a|   (how much of the query a rule covers)
CREATE OR REPLACE FUNCTION public.kce_overlap(a text[], b text[])
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN COALESCE(cardinality(a), 0) = 0 THEN 0::numeric
    ELSE (SELECT count(*) FROM unnest(a) x WHERE x = ANY(b))::numeric / cardinality(a)::numeric
  END;
$$;

-- Outcome-bearing text of a job, resilient to columns that may not exist in every environment.
CREATE OR REPLACE FUNCTION public.kce_job_text(p_job jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(concat_ws(' ',
    NULLIF(p_job->>'technician_diagnosis', ''),
    NULLIF(p_job->>'work_performed_notes', ''),
    NULLIF(p_job->>'completion_notes', ''),
    NULLIF(p_job->>'notes', '')
  ), '');
$$;

-- Who may review / approve / deploy: the account owner or a team member with can_manage_team.
CREATE OR REPLACE FUNCTION public.kce_can_review()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.invite_status = 'accepted'
        AND COALESCE(tm.permissions->>'can_manage_team', 'false') = 'true'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.kce_can_review() TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner');
$$;

-- =============================================================
-- 1. Tables
-- =============================================================

-- One row per ingested source item. Idempotent: (user_id, source_type, source_ref) is unique.
CREATE TABLE IF NOT EXISTS kce_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
    'call', 'job_note', 'diagnosis', 'live_copilot', 'expert_session',
    'repair_outcome', 'video', 'voice_note', 'correction', 'manual'
  )),
  source_ref text NOT NULL,
  contributor_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  raw_text text,
  media_path text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'extracted', 'no_knowledge', 'failed')),
  rules_found integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  UNIQUE (user_id, source_type, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_kce_captures_user_status ON kce_captures(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kce_captures_contributor ON kce_captures(contributor_id) WHERE contributor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kce_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'in_review', 'approved', 'deployed', 'rejected', 'retired')),

  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  trade text,
  equipment_make text,
  equipment_model text,
  symptoms text[] NOT NULL CHECK (cardinality(symptoms) >= 1),
  condition_summary text NOT NULL,
  likely_cause text NOT NULL,
  recommended_action text NOT NULL,
  caveats text,

  symptom_tokens text[] NOT NULL DEFAULT '{}',
  cause_tokens text[] NOT NULL DEFAULT '{}',

  current_version integer NOT NULL DEFAULT 1,
  deployed_version integer,

  confidence_score integer NOT NULL DEFAULT 0 CHECK (confidence_score BETWEEN 0 AND 100),
  confidence_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_count integer NOT NULL DEFAULT 0,
  contributor_count integer NOT NULL DEFAULT 0,
  applied_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  needs_revalidation boolean NOT NULL DEFAULT false,

  origin_contributor_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note text,
  retired_reason text,
  deployed_article_id uuid REFERENCES knowledge_articles(id) ON DELETE SET NULL,

  approved_at timestamptz,
  deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kce_rules_user_status ON kce_rules(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kce_rules_origin ON kce_rules(origin_contributor_id) WHERE origin_contributor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kce_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES kce_rules(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES kce_captures(id) ON DELETE CASCADE,
  contributor_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  excerpt text NOT NULL,
  specificity integer NOT NULL DEFAULT 50 CHECK (specificity BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, capture_id)
);

CREATE INDEX IF NOT EXISTS idx_kce_evidence_rule ON kce_evidence(rule_id, created_at DESC);

-- Immutable content history.
CREATE TABLE IF NOT EXISTS kce_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES kce_rules(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version)
);

-- Field feedback: did a deployed rule actually fix the job?
CREATE TABLE IF NOT EXISTS kce_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES kce_rules(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rule_version integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('resolved', 'not_resolved')),
  recorded_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_kce_applications_user ON kce_applications(user_id, created_at DESC);

-- Retirement-risk planning: who is leaving, and when.
CREATE TABLE IF NOT EXISTS kce_expert_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  expected_departure date,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, team_member_id)
);

CREATE TABLE IF NOT EXISTS kce_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  auto_capture boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Atomic per-user hourly quota for AI extraction (same pattern as the other AI engines).
CREATE TABLE IF NOT EXISTS kce_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.consume_kce_quota(p_user_id uuid, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO kce_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1 END
  RETURNING u.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_kce_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_kce_quota(uuid, integer, integer) TO service_role;

-- =============================================================
-- 2. RLS - clients can only SELECT; every write is an RPC.
-- =============================================================

ALTER TABLE kce_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_expert_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kce_usage ENABLE ROW LEVEL SECURITY; -- intentionally no policies

DROP POLICY IF EXISTS "kce_captures_select" ON kce_captures;
CREATE POLICY "kce_captures_select" ON kce_captures FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.kce_can_review());

-- Non-reviewers (technicians) only ever see what is live.
DROP POLICY IF EXISTS "kce_rules_select" ON kce_rules;
CREATE POLICY "kce_rules_select" ON kce_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND (status = 'deployed' OR public.kce_can_review()));

DROP POLICY IF EXISTS "kce_evidence_select" ON kce_evidence;
CREATE POLICY "kce_evidence_select" ON kce_evidence FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.kce_can_review());

DROP POLICY IF EXISTS "kce_rule_versions_select" ON kce_rule_versions;
CREATE POLICY "kce_rule_versions_select" ON kce_rule_versions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.kce_can_review());

DROP POLICY IF EXISTS "kce_applications_select" ON kce_applications;
CREATE POLICY "kce_applications_select" ON kce_applications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "kce_expert_profiles_select" ON kce_expert_profiles;
CREATE POLICY "kce_expert_profiles_select" ON kce_expert_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.kce_can_review());

DROP POLICY IF EXISTS "kce_settings_select" ON kce_settings;
CREATE POLICY "kce_settings_select" ON kce_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.kce_can_review());

-- =============================================================
-- 3. Private media bucket (voice + video)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kce-media', 'kce-media', false, 14680064, -- 14 MB (Gemini inline limit after base64)
  ARRAY[
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp4', 'audio/aac',
    'audio/ogg', 'audio/webm', 'audio/flac',
    'video/mp4', 'video/quicktime', 'video/webm'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_kce_media" ON storage.objects;
CREATE POLICY "users_manage_own_kce_media" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'kce-media' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'kce-media' AND (storage.foldername(name))[1] = auth.uid()::text);

-- =============================================================
-- 4. Confidence engine (single source of truth)
--
--   score = 30% specificity   (how concrete the supporting evidence is)
--         + 25% corroboration (independent captures + independent people)
--         + 25% outcome       (Laplace-smoothed field success rate)
--         + 15% verification  (a human approved it)
--         +  5% recency       (freshness of the latest supporting evidence)
--
--  An unapproved rule can never exceed 85. Components are stored so the UI can explain them.
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_recompute_confidence(p_rule_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r kce_rules;
  v_spec numeric;
  v_caps integer;
  v_contribs integer;
  v_last timestamptz;
  v_corr numeric;
  v_out numeric;
  v_ver numeric;
  v_rec numeric;
  v_age_days numeric;
  v_score integer;
BEGIN
  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(avg(specificity), 0),
         count(*),
         count(DISTINCT COALESCE(contributor_id::text, 'unattributed')),
         max(created_at)
    INTO v_spec, v_caps, v_contribs, v_last
  FROM kce_evidence WHERE rule_id = p_rule_id;

  v_caps := GREATEST(v_caps, 1);
  v_contribs := GREATEST(v_contribs, 1);

  v_corr := LEAST(1, 0.2 + 0.2 * (v_caps - 1) + 0.2 * (v_contribs - 1));
  v_out := (r.success_count + 1)::numeric / (r.applied_count + 2);
  v_ver := CASE WHEN r.status IN ('approved', 'deployed') THEN 1 ELSE 0 END;
  v_age_days := EXTRACT(EPOCH FROM (now() - COALESCE(v_last, r.created_at))) / 86400;
  v_rec := CASE
    WHEN v_age_days <= 180 THEN 1
    WHEN v_age_days >= 730 THEN 0.4
    ELSE 1 - 0.6 * ((v_age_days - 180) / 550)
  END;

  v_score := round(100 * (0.30 * (v_spec / 100) + 0.25 * v_corr + 0.25 * v_out + 0.15 * v_ver + 0.05 * v_rec));
  v_score := GREATEST(0, LEAST(100, v_score));

  UPDATE kce_rules SET
    confidence_score = v_score,
    confidence_breakdown = jsonb_build_object(
      'specificity',   jsonb_build_object('score', round(v_spec), 'weight', 30),
      'corroboration', jsonb_build_object('score', round(v_corr * 100), 'weight', 25),
      'outcome',       jsonb_build_object('score', round(v_out * 100), 'weight', 25),
      'verification',  jsonb_build_object('score', round(v_ver * 100), 'weight', 15),
      'recency',       jsonb_build_object('score', round(v_rec * 100), 'weight', 5)
    ),
    needs_revalidation = (r.applied_count >= 5 AND r.success_count::numeric / r.applied_count < 0.5),
    updated_at = now()
  WHERE id = p_rule_id;

  RETURN v_score;
END;
$$;

REVOKE ALL ON FUNCTION public.kce_recompute_confidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kce_recompute_confidence(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.kce_rule_snapshot(r kce_rules)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'title', r.title, 'trade', r.trade,
    'equipment_make', r.equipment_make, 'equipment_model', r.equipment_model,
    'symptoms', to_jsonb(r.symptoms),
    'condition_summary', r.condition_summary, 'likely_cause', r.likely_cause,
    'recommended_action', r.recommended_action, 'caveats', r.caveats
  );
$$;

-- =============================================================
-- 5. Source harvesting (service role only; called by the edge function)
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_enqueue_sources(p_owner uuid, p_days integer DEFAULT 90, p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 90), 1));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_total integer := 0;
  v_n integer;
BEGIN
  -- Completed jobs with substantive technician notes
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'job_note', j.id::text, j.assigned_technician_id
  FROM jobs j
  WHERE j.user_id = p_owner AND j.job_status = 'completed'
    AND COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) >= v_since
    AND length(kce_job_text(to_jsonb(j))) >= 60
    AND NOT EXISTS (SELECT 1 FROM kce_captures c WHERE c.user_id = p_owner AND c.source_type = 'job_note' AND c.source_ref = j.id::text)
  ORDER BY COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Repair outcomes: callbacks / reworks (what went wrong the first time is gold)
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'repair_outcome', j.id::text, j.assigned_technician_id
  FROM jobs j
  WHERE j.user_id = p_owner AND j.job_status = 'completed'
    AND COALESCE((to_jsonb(j)->>'is_rework')::boolean, false)
    AND NULLIF(to_jsonb(j)->>'rework_of_job_id', '') IS NOT NULL
    AND COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) >= v_since
    AND length(kce_job_text(to_jsonb(j))) >= 40
    AND NOT EXISTS (SELECT 1 FROM kce_captures c WHERE c.user_id = p_owner AND c.source_type = 'repair_outcome' AND c.source_ref = j.id::text)
  ORDER BY COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- AI diagnosis runs whose job closed with technician notes (ground truth exists)
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'diagnosis', d.id::text, j.assigned_technician_id
  FROM diagnosis_sessions d
  JOIN jobs j ON j.id = d.job_id AND j.job_status = 'completed'
  WHERE d.user_id = p_owner AND d.created_at >= v_since
    AND length(kce_job_text(to_jsonb(j))) >= 40
    AND NOT EXISTS (SELECT 1 FROM kce_captures c WHERE c.user_id = p_owner AND c.source_type = 'diagnosis' AND c.source_ref = d.id::text)
  ORDER BY d.created_at DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Live copilot sessions that ended with an outcome note
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'live_copilot', s.id::text,
         (SELECT j.assigned_technician_id FROM jobs j WHERE j.id = s.job_id)
  FROM live_copilot_sessions s
  WHERE s.user_id = p_owner AND s.status IN ('completed', 'escalated')
    AND s.created_at >= v_since
    AND length(COALESCE(s.outcome_note, '')) >= 30
    AND NOT EXISTS (SELECT 1 FROM kce_captures c WHERE c.user_id = p_owner AND c.source_type = 'live_copilot' AND c.source_ref = s.id::text)
  ORDER BY s.created_at DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Resolved remote-expert sessions (the expert is the knowledge source)
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'expert_session', e.id::text, e.assigned_expert_id
  FROM expert_assist_requests e
  WHERE e.user_id = p_owner AND e.status = 'resolved'
    AND COALESCE(e.resolved_at, e.created_at) >= v_since
    AND length(COALESCE(e.resolution_summary, '')) >= 30
    AND NOT EXISTS (SELECT 1 FROM kce_captures c WHERE c.user_id = p_owner AND c.source_type = 'expert_session' AND c.source_ref = e.id::text)
  ORDER BY COALESCE(e.resolved_at, e.created_at) DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Calls with a transcript that led to a completed job with technician notes
  INSERT INTO kce_captures (user_id, source_type, source_ref, contributor_id)
  SELECT p_owner, 'call', c.id::text,
         (SELECT j.assigned_technician_id FROM jobs j
           WHERE j.call_id = c.id AND j.job_status = 'completed' ORDER BY j.created_at DESC LIMIT 1)
  FROM calls c
  WHERE c.user_id = p_owner AND c.call_datetime >= v_since
    AND length(COALESCE(c.transcript, '')) >= 200
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.call_id = c.id AND j.job_status = 'completed' AND length(kce_job_text(to_jsonb(j))) >= 60)
    AND NOT EXISTS (SELECT 1 FROM kce_captures k WHERE k.user_id = p_owner AND k.source_type = 'call' AND k.source_ref = c.id::text)
  ORDER BY c.call_datetime DESC
  LIMIT v_limit
  ON CONFLICT (user_id, source_type, source_ref) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.kce_enqueue_sources(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kce_enqueue_sources(uuid, integer, integer) TO service_role;

-- =============================================================
-- 6. Extraction write path (service role only)
--    Merges corroborating evidence into an existing rule instead of creating duplicates.
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_upsert_extracted_rule(p_owner uuid, p_capture_id uuid, p_rule jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capture kce_captures;
  v_make text;
  v_model text;
  v_symptoms text[];
  v_sym_tokens text[];
  v_cause_tokens text[];
  v_title text;
  v_condition text;
  v_cause text;
  v_action text;
  v_excerpt text;
  v_spec integer;
  v_rule_id uuid;
  v_status text;
  v_inserted integer;
BEGIN
  SELECT * INTO v_capture FROM kce_captures WHERE id = p_capture_id AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capture not found.'; END IF;

  v_make := NULLIF(btrim(COALESCE(p_rule->>'equipment_make', '')), '');
  v_model := NULLIF(btrim(COALESCE(p_rule->>'equipment_model', '')), '');
  v_title := left(btrim(COALESCE(p_rule->>'title', '')), 200);
  v_condition := btrim(COALESCE(p_rule->>'condition_summary', ''));
  v_cause := btrim(COALESCE(p_rule->>'likely_cause', ''));
  v_action := btrim(COALESCE(p_rule->>'recommended_action', ''));
  v_excerpt := left(btrim(COALESCE(NULLIF(p_rule->>'excerpt', ''), v_condition)), 400);
  v_spec := GREATEST(0, LEAST(100, COALESCE((p_rule->>'specificity')::integer, 50)));

  SELECT COALESCE(array_agg(btrim(x)) FILTER (WHERE btrim(x) <> ''), ARRAY[]::text[])
    INTO v_symptoms
  FROM jsonb_array_elements_text(COALESCE(p_rule->'symptoms', '[]'::jsonb)) AS x;

  IF v_title = '' OR v_condition = '' OR v_cause = '' OR v_action = '' OR cardinality(v_symptoms) = 0 THEN
    RAISE EXCEPTION 'Incomplete rule.';
  END IF;

  v_sym_tokens := kce_tokens(array_to_string(v_symptoms, ' '));
  v_cause_tokens := kce_tokens(v_cause);

  -- Same equipment scope + overlapping symptoms + overlapping cause => same knowledge.
  SELECT r.id, r.status INTO v_rule_id, v_status
  FROM kce_rules r
  WHERE r.user_id = p_owner
    AND lower(COALESCE(r.equipment_make, '')) = lower(COALESCE(v_make, ''))
    AND lower(COALESCE(r.equipment_model, '')) = lower(COALESCE(v_model, ''))
    AND kce_jaccard(r.symptom_tokens, v_sym_tokens) >= 0.5
    AND kce_jaccard(r.cause_tokens, v_cause_tokens) >= 0.34
  ORDER BY kce_jaccard(r.symptom_tokens, v_sym_tokens) + kce_jaccard(r.cause_tokens, v_cause_tokens) DESC
  LIMIT 1
  FOR UPDATE OF r;

  IF v_rule_id IS NOT NULL AND v_status IN ('rejected', 'retired') THEN
    RETURN jsonb_build_object('rule_id', v_rule_id, 'created', false, 'skipped', true);
  END IF;

  IF v_rule_id IS NULL THEN
    INSERT INTO kce_rules (
      user_id, title, trade, equipment_make, equipment_model, symptoms,
      condition_summary, likely_cause, recommended_action, caveats,
      symptom_tokens, cause_tokens, origin_contributor_id
    ) VALUES (
      p_owner, v_title, NULLIF(left(btrim(COALESCE(p_rule->>'trade', '')), 60), ''), v_make, v_model, v_symptoms,
      v_condition, v_cause, v_action, NULLIF(btrim(COALESCE(p_rule->>'caveats', '')), ''),
      v_sym_tokens, v_cause_tokens, v_capture.contributor_id
    ) RETURNING id INTO v_rule_id;

    INSERT INTO kce_rule_versions (user_id, rule_id, version, snapshot, change_note)
    SELECT p_owner, r.id, 1, kce_rule_snapshot(r), 'Extracted from ' || v_capture.source_type
    FROM kce_rules r WHERE r.id = v_rule_id;

    INSERT INTO kce_evidence (user_id, rule_id, capture_id, contributor_id, excerpt, specificity)
    VALUES (p_owner, v_rule_id, p_capture_id, v_capture.contributor_id, v_excerpt, v_spec);

    UPDATE kce_rules SET
      evidence_count = 1, contributor_count = 1
    WHERE id = v_rule_id;

    PERFORM kce_recompute_confidence(v_rule_id);
    RETURN jsonb_build_object('rule_id', v_rule_id, 'created', true, 'skipped', false);
  END IF;

  INSERT INTO kce_evidence (user_id, rule_id, capture_id, contributor_id, excerpt, specificity)
  VALUES (p_owner, v_rule_id, p_capture_id, v_capture.contributor_id, v_excerpt, v_spec)
  ON CONFLICT (rule_id, capture_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('rule_id', v_rule_id, 'created', false, 'skipped', true);
  END IF;

  UPDATE kce_rules SET
    evidence_count = (SELECT count(*) FROM kce_evidence WHERE rule_id = v_rule_id),
    contributor_count = (SELECT count(DISTINCT COALESCE(contributor_id::text, 'unattributed')) FROM kce_evidence WHERE rule_id = v_rule_id)
  WHERE id = v_rule_id;

  PERFORM kce_recompute_confidence(v_rule_id);
  RETURN jsonb_build_object('rule_id', v_rule_id, 'created', false, 'skipped', false);
END;
$$;

REVOKE ALL ON FUNCTION public.kce_upsert_extracted_rule(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kce_upsert_extracted_rule(uuid, uuid, jsonb) TO service_role;

-- =============================================================
-- 7. Governance RPCs (authenticated; permission-checked inside)
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_review_rule(
  p_rule_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_edits jsonb DEFAULT NULL
)
RETURNS kce_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  r kce_rules;
  v_title text;
  v_make text;
  v_model text;
  v_symptoms text[];
  v_condition text;
  v_cause text;
  v_action text;
  v_caveats text;
  v_has_edits boolean := p_edits IS NOT NULL AND p_edits <> '{}'::jsonb;
  v_changed boolean := false;
  v_new_status text;
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to review captured knowledge.';
  END IF;
  IF p_action NOT IN ('start_review', 'approve', 'reject', 'revise') THEN
    RAISE EXCEPTION 'Unknown action.';
  END IF;

  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found.'; END IF;

  -- State machine
  v_new_status := CASE
    WHEN p_action = 'start_review' AND r.status = 'candidate' THEN 'in_review'
    WHEN p_action = 'approve' AND r.status IN ('candidate', 'in_review') THEN 'approved'
    WHEN p_action = 'reject' AND r.status IN ('candidate', 'in_review') THEN 'rejected'
    WHEN p_action = 'revise' AND r.status IN ('approved', 'deployed') THEN 'in_review'
    ELSE NULL
  END;
  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'This action is not available for a rule that is %.', r.status;
  END IF;

  IF p_action = 'reject' AND COALESCE(btrim(p_note), '') = '' THEN
    RAISE EXCEPTION 'Add a short reason for rejecting this rule.';
  END IF;
  IF p_action = 'revise' AND NOT v_has_edits THEN
    RAISE EXCEPTION 'Nothing to revise.';
  END IF;

  -- Two-person rule: contributors cannot approve their own captured knowledge (owner excepted).
  IF p_action = 'approve' AND v_me IS NOT NULL AND v_me = r.origin_contributor_id AND NOT public.kce_is_owner() THEN
    RAISE EXCEPTION 'Ask a different reviewer to approve this - contributors cannot approve their own knowledge.';
  END IF;

  -- Optional content edits -> new immutable version
  IF v_has_edits AND p_action <> 'reject' THEN
    v_title := left(COALESCE(NULLIF(btrim(p_edits->>'title'), ''), r.title), 200);
    v_make := CASE WHEN p_edits ? 'equipment_make' THEN NULLIF(btrim(p_edits->>'equipment_make'), '') ELSE r.equipment_make END;
    v_model := CASE WHEN p_edits ? 'equipment_model' THEN NULLIF(btrim(p_edits->>'equipment_model'), '') ELSE r.equipment_model END;
    v_condition := COALESCE(NULLIF(btrim(p_edits->>'condition_summary'), ''), r.condition_summary);
    v_cause := COALESCE(NULLIF(btrim(p_edits->>'likely_cause'), ''), r.likely_cause);
    v_action := COALESCE(NULLIF(btrim(p_edits->>'recommended_action'), ''), r.recommended_action);
    v_caveats := CASE WHEN p_edits ? 'caveats' THEN NULLIF(btrim(p_edits->>'caveats'), '') ELSE r.caveats END;

    IF p_edits ? 'symptoms' THEN
      SELECT COALESCE(array_agg(btrim(x)) FILTER (WHERE btrim(x) <> ''), ARRAY[]::text[])
        INTO v_symptoms FROM jsonb_array_elements_text(p_edits->'symptoms') AS x;
      IF cardinality(v_symptoms) = 0 THEN v_symptoms := r.symptoms; END IF;
    ELSE
      v_symptoms := r.symptoms;
    END IF;

    v_changed := v_title IS DISTINCT FROM r.title
      OR v_make IS DISTINCT FROM r.equipment_make
      OR v_model IS DISTINCT FROM r.equipment_model
      OR v_condition IS DISTINCT FROM r.condition_summary
      OR v_cause IS DISTINCT FROM r.likely_cause
      OR v_action IS DISTINCT FROM r.recommended_action
      OR v_caveats IS DISTINCT FROM r.caveats
      OR v_symptoms IS DISTINCT FROM r.symptoms;

    IF p_action = 'revise' AND NOT v_changed THEN
      RAISE EXCEPTION 'Nothing to revise.';
    END IF;

    IF v_changed THEN
      UPDATE kce_rules SET
        title = v_title, equipment_make = v_make, equipment_model = v_model,
        symptoms = v_symptoms, condition_summary = v_condition, likely_cause = v_cause,
        recommended_action = v_action, caveats = v_caveats,
        symptom_tokens = kce_tokens(array_to_string(v_symptoms, ' ')),
        cause_tokens = kce_tokens(v_cause),
        current_version = r.current_version + 1
      WHERE id = r.id
      RETURNING * INTO r;

      INSERT INTO kce_rule_versions (user_id, rule_id, version, snapshot, change_note, changed_by)
      VALUES (v_owner, r.id, r.current_version, kce_rule_snapshot(r),
              COALESCE(NULLIF(btrim(p_note), ''), 'Edited during ' || p_action), auth.uid());
    END IF;
  END IF;

  UPDATE kce_rules SET
    status = v_new_status,
    reviewed_by = auth.uid(),
    review_note = COALESCE(NULLIF(btrim(p_note), ''), review_note),
    approved_at = CASE WHEN v_new_status = 'approved' THEN now() ELSE approved_at END
  WHERE id = r.id;

  PERFORM kce_recompute_confidence(r.id);
  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.kce_review_rule(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_review_rule(uuid, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_deploy_rule(p_rule_id uuid, p_note text DEFAULT NULL)
RETURNS kce_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r kce_rules;
  v_summary text;
  v_body text;
  v_keywords text[];
  v_category text;
  v_article_id uuid;
  v_updated integer := 0;
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to deploy captured knowledge.';
  END IF;

  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found.'; END IF;
  IF r.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved rule can be deployed (this one is %).', r.status;
  END IF;
  IF r.confidence_score < 40 THEN
    RAISE EXCEPTION 'Confidence is %, below the deployment floor of 40. Add corroborating evidence first.', r.confidence_score;
  END IF;

  v_summary := left(r.condition_summary || ' -> ' || r.likely_cause, 400);
  v_body := 'WHEN: ' || r.condition_summary || E'\n\n'
    || 'LIKELY CAUSE: ' || r.likely_cause || E'\n\n'
    || 'DO THIS: ' || r.recommended_action
    || CASE WHEN r.caveats IS NOT NULL THEN E'\n\nCAVEATS: ' || r.caveats ELSE '' END
    || E'\n\n[Captured tribal knowledge - v' || r.current_version
    || ', confidence ' || r.confidence_score || '%, '
    || r.evidence_count || ' supporting case' || CASE WHEN r.evidence_count = 1 THEN '' ELSE 's' END || ']';
  v_category := CASE WHEN r.trade IS NULL THEN 'Tribal Knowledge' ELSE 'Tribal Knowledge - ' || r.trade END;
  v_keywords := (
    SELECT COALESCE(array_agg(k), ARRAY[]::text[])
    FROM (
      SELECT DISTINCT k FROM unnest(ARRAY[r.equipment_make, r.equipment_model] || r.symptoms) AS k
      WHERE k IS NOT NULL AND btrim(k) <> '' LIMIT 8
    ) s
  );

  IF r.deployed_article_id IS NOT NULL THEN
    UPDATE knowledge_articles SET
      title = r.title, summary = v_summary, body = v_body, category = v_category,
      keywords = v_keywords, status = 'published', updated_by = auth.uid()
    WHERE id = r.deployed_article_id AND user_id = v_owner;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_article_id := r.deployed_article_id;
  END IF;

  IF v_updated = 0 THEN
    INSERT INTO knowledge_articles (
      user_id, title, summary, body, category, keywords, audience, status, source, contributed_by, created_by
    ) VALUES (
      v_owner, r.title, v_summary, v_body, v_category, v_keywords, 'team', 'published', 'manual',
      r.origin_contributor_id, auth.uid()
    ) RETURNING id INTO v_article_id;
  END IF;

  UPDATE kce_rules SET
    status = 'deployed', deployed_version = r.current_version, deployed_at = now(),
    deployed_article_id = v_article_id, reviewed_by = auth.uid(),
    review_note = COALESCE(NULLIF(btrim(p_note), ''), review_note)
  WHERE id = r.id;

  PERFORM kce_recompute_confidence(r.id);
  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.kce_deploy_rule(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_deploy_rule(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_retire_rule(p_rule_id uuid, p_reason text)
RETURNS kce_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r kce_rules;
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to retire captured knowledge.';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Add a short reason for retiring this rule.';
  END IF;

  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found.'; END IF;
  IF r.status IN ('rejected', 'retired') THEN
    RAISE EXCEPTION 'This rule is already %.', r.status;
  END IF;

  IF r.deployed_article_id IS NOT NULL THEN
    UPDATE knowledge_articles SET status = 'archived', updated_by = auth.uid()
    WHERE id = r.deployed_article_id AND user_id = v_owner;
  END IF;

  UPDATE kce_rules SET
    status = 'retired', retired_reason = btrim(p_reason), reviewed_by = auth.uid()
  WHERE id = r.id;

  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.kce_retire_rule(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_retire_rule(uuid, text) TO authenticated;

-- Field feedback loop: any team member on the job (or a reviewer) can mark worked / didn't work.
CREATE OR REPLACE FUNCTION public.kce_record_application(p_rule_id uuid, p_job_id uuid, p_outcome text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  r kce_rules;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Could not resolve your account.'; END IF;
  IF p_outcome NOT IN ('resolved', 'not_resolved') THEN RAISE EXCEPTION 'Unknown outcome.'; END IF;

  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id AND user_id = v_owner AND status = 'deployed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This rule is not live.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = p_job_id AND j.user_id = v_owner
      AND (j.assigned_technician_id = v_me OR public.kce_can_review())
  ) THEN
    RAISE EXCEPTION 'You can only record outcomes on your own jobs.';
  END IF;

  INSERT INTO kce_applications (user_id, rule_id, job_id, rule_version, outcome, recorded_by)
  VALUES (v_owner, p_rule_id, p_job_id, COALESCE(r.deployed_version, r.current_version), p_outcome, v_me)
  ON CONFLICT (rule_id, job_id) DO UPDATE
    SET outcome = EXCLUDED.outcome, rule_version = EXCLUDED.rule_version,
        recorded_by = EXCLUDED.recorded_by, created_at = now();

  UPDATE kce_rules SET
    applied_count = (SELECT count(*) FROM kce_applications WHERE rule_id = p_rule_id),
    success_count = (SELECT count(*) FROM kce_applications WHERE rule_id = p_rule_id AND outcome = 'resolved')
  WHERE id = p_rule_id;

  PERFORM kce_recompute_confidence(p_rule_id);
  SELECT * INTO r FROM kce_rules WHERE id = p_rule_id;

  RETURN jsonb_build_object(
    'confidence_score', r.confidence_score, 'applied_count', r.applied_count,
    'success_count', r.success_count, 'needs_revalidation', r.needs_revalidation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kce_record_application(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_record_application(uuid, uuid, text) TO authenticated;

-- =============================================================
-- 8. Deployment surface: ranked retrieval of LIVE rules
--    Usable from the UI, from edge functions (with the caller's JWT), and by AI copilots.
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_search_deployed_rules(
  p_query text DEFAULT NULL,
  p_make text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_limit integer DEFAULT 8
)
RETURNS TABLE (
  id uuid, title text, equipment_make text, equipment_model text, symptoms text[],
  condition_summary text, likely_cause text, recommended_action text, caveats text,
  confidence_score integer, applied_count integer, success_count integer,
  deployed_version integer, needs_revalidation boolean, relevance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH q AS (SELECT kce_tokens(COALESCE(p_query, '')) AS qt),
  scored AS (
    SELECT r.*,
      (
        kce_overlap(q.qt, r.symptom_tokens || r.cause_tokens || kce_tokens(COALESCE(r.equipment_make, '') || ' ' || COALESCE(r.equipment_model, '')))
        + CASE WHEN NULLIF(btrim(p_make), '') IS NOT NULL AND lower(r.equipment_make) = lower(btrim(p_make)) THEN 0.3 ELSE 0 END
        + CASE WHEN NULLIF(btrim(p_model), '') IS NOT NULL AND lower(r.equipment_model) = lower(btrim(p_model)) THEN 0.3 ELSE 0 END
      ) AS rel
    FROM kce_rules r, q
    WHERE r.user_id = public.get_account_owner_id() AND r.status = 'deployed'
  )
  SELECT s.id, s.title, s.equipment_make, s.equipment_model, s.symptoms,
         s.condition_summary, s.likely_cause, s.recommended_action, s.caveats,
         s.confidence_score, s.applied_count, s.success_count,
         s.deployed_version, s.needs_revalidation, round(s.rel, 3)
  FROM scored s
  WHERE s.rel > 0
     OR (NULLIF(btrim(p_query), '') IS NULL AND NULLIF(btrim(p_make), '') IS NULL AND NULLIF(btrim(p_model), '') IS NULL)
  ORDER BY s.rel DESC, s.confidence_score DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 8), 1), 25);
$$;

REVOKE ALL ON FUNCTION public.kce_search_deployed_rules(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_search_deployed_rules(text, text, text, integer) TO authenticated;

-- =============================================================
-- 9. Dashboards
-- =============================================================

CREATE OR REPLACE FUNCTION public.kce_get_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF NOT public.kce_can_review() THEN
    RETURN jsonb_build_object(
      'is_reviewer', false,
      'status_counts', jsonb_build_object('deployed', (SELECT count(*) FROM kce_rules WHERE user_id = v_owner AND status = 'deployed'))
    );
  END IF;

  RETURN jsonb_build_object(
    'is_reviewer', true,
    'status_counts', (SELECT COALESCE(jsonb_object_agg(status, c), '{}'::jsonb)
                      FROM (SELECT status, count(*) AS c FROM kce_rules WHERE user_id = v_owner GROUP BY status) s),
    'avg_confidence_deployed', (SELECT round(avg(confidence_score)) FROM kce_rules WHERE user_id = v_owner AND status = 'deployed'),
    'needs_revalidation', (SELECT count(*) FROM kce_rules WHERE user_id = v_owner AND status = 'deployed' AND needs_revalidation),
    'pending_captures', (SELECT count(*) FROM kce_captures WHERE user_id = v_owner AND status = 'pending'),
    'failed_captures', (SELECT count(*) FROM kce_captures WHERE user_id = v_owner AND status = 'failed'),
    'captures_30d', (SELECT count(*) FROM kce_captures WHERE user_id = v_owner AND created_at >= now() - interval '30 days'),
    'applications_90d', (SELECT count(*) FROM kce_applications WHERE user_id = v_owner AND created_at >= now() - interval '90 days'),
    'resolved_90d', (SELECT count(*) FROM kce_applications WHERE user_id = v_owner AND outcome = 'resolved' AND created_at >= now() - interval '90 days'),
    'auto_capture', COALESCE((SELECT auto_capture FROM kce_settings WHERE user_id = v_owner), false),
    'sources', (SELECT COALESCE(jsonb_object_agg(source_type, c), '{}'::jsonb)
                FROM (SELECT source_type, count(*) AS c FROM kce_captures WHERE user_id = v_owner GROUP BY source_type) s)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kce_get_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_get_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_get_expert_risk()
RETURNS TABLE (
  team_member_id uuid, member_name text, expected_departure date, notes text,
  jobs_completed_180d integer, rules_originated integer, rules_deployed integer,
  sole_source_rules integer, captures_90d integer, last_capture_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to view knowledge-risk data.';
  END IF;

  RETURN QUERY
  SELECT
    tm.id,
    COALESCE(NULLIF(tm.member_name, ''), tm.member_email),
    ep.expected_departure,
    ep.notes,
    (SELECT count(*)::integer FROM jobs j
      WHERE j.user_id = v_owner AND j.assigned_technician_id = tm.id AND j.job_status = 'completed'
        AND COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) >= now() - interval '180 days'),
    (SELECT count(*)::integer FROM kce_rules r
      WHERE r.user_id = v_owner AND r.origin_contributor_id = tm.id AND r.status NOT IN ('rejected', 'retired')),
    (SELECT count(*)::integer FROM kce_rules r
      WHERE r.user_id = v_owner AND r.origin_contributor_id = tm.id AND r.status = 'deployed'),
    (SELECT count(*)::integer FROM kce_rules r
      WHERE r.user_id = v_owner AND r.origin_contributor_id = tm.id AND r.contributor_count <= 1
        AND r.status NOT IN ('rejected', 'retired')),
    (SELECT count(*)::integer FROM kce_captures c
      WHERE c.user_id = v_owner AND c.contributor_id = tm.id AND c.status = 'extracted'
        AND c.created_at >= now() - interval '90 days'),
    (SELECT max(c.created_at) FROM kce_captures c WHERE c.user_id = v_owner AND c.contributor_id = tm.id)
  FROM team_members tm
  LEFT JOIN kce_expert_profiles ep ON ep.team_member_id = tm.id AND ep.user_id = v_owner
  WHERE tm.account_owner_id = v_owner AND tm.invite_status = 'accepted'
  ORDER BY ep.expected_departure ASC NULLS LAST, COALESCE(NULLIF(tm.member_name, ''), tm.member_email);
END;
$$;

REVOKE ALL ON FUNCTION public.kce_get_expert_risk() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_get_expert_risk() TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_set_expert_profile(p_team_member_id uuid, p_expected_departure date, p_notes text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to edit expert profiles.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = p_team_member_id AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Team member not found.';
  END IF;

  INSERT INTO kce_expert_profiles (user_id, team_member_id, expected_departure, notes)
  VALUES (v_owner, p_team_member_id, p_expected_departure, NULLIF(btrim(COALESCE(p_notes, '')), ''))
  ON CONFLICT (user_id, team_member_id) DO UPDATE
    SET expected_departure = EXCLUDED.expected_departure, notes = EXCLUDED.notes, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.kce_set_expert_profile(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_set_expert_profile(uuid, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.kce_set_auto_capture(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.kce_can_review() THEN
    RAISE EXCEPTION 'You do not have permission to change capture settings.';
  END IF;
  INSERT INTO kce_settings (user_id, auto_capture) VALUES (v_owner, COALESCE(p_enabled, false))
  ON CONFLICT (user_id) DO UPDATE SET auto_capture = EXCLUDED.auto_capture, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.kce_set_auto_capture(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kce_set_auto_capture(boolean) TO authenticated;
