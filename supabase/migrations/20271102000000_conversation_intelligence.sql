/*
  # Conversation Intelligence (in-home conversations)

  With explicit customer AND technician consent, a technician can record the
  on-site conversation. The audio is transcribed and analysed once to extract
  promises, objections, upsell opportunities and safety concerns, which then
  feed the existing Commitment Graph (`commitments`), Tasks (`tasks`) and an
  in-app safety notification, plus a coaching note per technician.

  ## Consent is enforced HERE, not only in the UI
  - Audio can only be attached to a recording row whose customer consent is
    'granted' (with a timestamp), technician consent is stamped and the
    disclosure was shown (trigger conversation_recordings_guard).
  - Consent fields are write-once evidence: once granted/declined they cannot
    be rewritten (except granted -> withdrawn, which discards the audio).
  - A declined row never has audio. Withdrawal = hard delete of audio + transcript.
  - The disclosure text + version shown is stored with the row (audit trail).

  ## Privacy defaults
  - Feature is OFF per account until a manager enables it.
  - Audio is kept 30 days by default, transcript 90 (configurable); purge via
    public.purge_expired_conversation_recordings() — see cron comment at bottom.
  - Private storage bucket; paths are "<account owner id>/<recording id>.<ext>".
  - Technicians see only their own recordings and coaching; managers see all.

  Requires: get_account_owner_id(), tasks_can_view_all() (20270501000000_tasks),
  team_members(user_id), jobs, commitments, tasks, notifications.
*/

-- ---------------------------------------------------------------------------
-- Settings (one row per account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_intel_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  audio_retention_days integer NOT NULL DEFAULT 30 CHECK (audio_retention_days BETWEEN 1 AND 365),
  transcript_retention_days integer NOT NULL DEFAULT 90 CHECK (transcript_retention_days BETWEEN 7 AND 730),
  auto_create_tasks boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_intel_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ci_settings_select" ON public.conversation_intel_settings;
CREATE POLICY "ci_settings_select" ON public.conversation_intel_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "ci_settings_insert" ON public.conversation_intel_settings;
CREATE POLICY "ci_settings_insert" ON public.conversation_intel_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.tasks_can_view_all());

DROP POLICY IF EXISTS "ci_settings_update" ON public.conversation_intel_settings;
CREATE POLICY "ci_settings_update" ON public.conversation_intel_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tasks_can_view_all())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.tasks_can_view_all());

-- ---------------------------------------------------------------------------
-- Recordings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  technician_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  technician_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),

  jurisdiction_state text CHECK (jurisdiction_state IS NULL OR jurisdiction_state ~ '^[A-Z]{2}$'),
  consent_mode text NOT NULL DEFAULT 'unknown_all_party'
    CHECK (consent_mode IN ('all_party', 'one_party_plus', 'unknown_all_party')),
  disclosure_version text NOT NULL,
  disclosure_text text NOT NULL CHECK (char_length(disclosure_text) BETWEEN 20 AND 4000),
  disclosure_shown_at timestamptz,

  customer_consent_status text NOT NULL DEFAULT 'not_asked'
    CHECK (customer_consent_status IN ('not_asked', 'granted', 'declined', 'withdrawn')),
  customer_consent_at timestamptz,
  customer_consent_method text CHECK (customer_consent_method IS NULL OR customer_consent_method IN ('tap_on_device', 'verbal_on_recording', 'both')),
  technician_consent_at timestamptz,

  status text NOT NULL DEFAULT 'pending_consent'
    CHECK (status IN ('pending_consent', 'recording', 'uploaded', 'analyzing', 'analyzed', 'failed', 'declined', 'discarded')),
  audio_path text,
  audio_mime text,
  audio_bytes integer CHECK (audio_bytes IS NULL OR audio_bytes BETWEEN 1 AND 20971520),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 14400),
  started_at timestamptz,
  ended_at timestamptz,

  transcript text,
  summary text,
  analysis_error text CHECK (analysis_error IS NULL OR char_length(analysis_error) <= 500),
  analyzed_at timestamptz,
  audio_expires_at timestamptz,
  transcript_expires_at timestamptz,

  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ci_rec_audio_needs_consent CHECK (
    audio_path IS NULL OR (customer_consent_status = 'granted' AND customer_consent_at IS NOT NULL AND technician_consent_at IS NOT NULL)
  ),
  CONSTRAINT ci_rec_declined_no_data CHECK (
    customer_consent_status NOT IN ('declined', 'withdrawn') OR (audio_path IS NULL AND transcript IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ci_rec_user_created ON public.conversation_recordings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_rec_tech ON public.conversation_recordings (technician_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_rec_job ON public.conversation_recordings (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_rec_audio_expiry ON public.conversation_recordings (audio_expires_at) WHERE audio_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_rec_transcript_expiry ON public.conversation_recordings (transcript_expires_at) WHERE transcript IS NOT NULL;

-- Integrity + consent guard.
CREATE OR REPLACE FUNCTION public.conversation_recordings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    -- A fresh row can never arrive pre-consented or with audio: consent is recorded via RPC below.
    NEW.customer_consent_status := 'not_asked';
    NEW.customer_consent_at := NULL;
    NEW.customer_consent_method := NULL;
    NEW.technician_consent_at := NULL;
    NEW.status := 'pending_consent';
    NEW.audio_path := NULL;
    NEW.transcript := NULL;
    RETURN NEW;
  END IF;

  -- Immutable evidence / ownership columns.
  NEW.user_id := OLD.user_id;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.disclosure_text := OLD.disclosure_text;
  NEW.disclosure_version := OLD.disclosure_version;
  NEW.consent_mode := OLD.consent_mode;
  NEW.jurisdiction_state := OLD.jurisdiction_state;
  NEW.technician_user_id := OLD.technician_user_id;

  -- Consent state machine: granted/declined are final; only granted -> withdrawn is allowed.
  IF OLD.customer_consent_status IN ('declined', 'withdrawn') AND NEW.customer_consent_status <> OLD.customer_consent_status THEN
    RAISE EXCEPTION 'Consent decision is final' USING ERRCODE = '22023';
  END IF;
  IF OLD.customer_consent_status = 'granted' AND NEW.customer_consent_status NOT IN ('granted', 'withdrawn') THEN
    RAISE EXCEPTION 'Consent can only be withdrawn, not reset' USING ERRCODE = '22023';
  END IF;
  IF OLD.customer_consent_status = 'granted' THEN
    NEW.customer_consent_at := OLD.customer_consent_at;
    NEW.customer_consent_method := OLD.customer_consent_method;
    NEW.technician_consent_at := OLD.technician_consent_at;
    NEW.disclosure_shown_at := OLD.disclosure_shown_at;
  END IF;

  IF NEW.customer_consent_status = 'withdrawn' THEN
    NEW.audio_path := NULL;
    NEW.transcript := NULL;
    NEW.summary := NULL;
    NEW.status := 'discarded';
  END IF;

  -- Audio / processing is impossible without full consent.
  IF NEW.audio_path IS NOT NULL AND (
       NEW.customer_consent_status <> 'granted' OR NEW.customer_consent_at IS NULL
       OR NEW.technician_consent_at IS NULL OR NEW.disclosure_shown_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Recording requires customer and technician consent' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IN ('recording', 'uploaded', 'analyzing', 'analyzed') AND NEW.customer_consent_status <> 'granted' THEN
    RAISE EXCEPTION 'Recording requires customer consent' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_conversation_recordings_guard ON public.conversation_recordings;
CREATE TRIGGER trigger_conversation_recordings_guard
  BEFORE INSERT OR UPDATE ON public.conversation_recordings
  FOR EACH ROW EXECUTE FUNCTION public.conversation_recordings_guard();

ALTER TABLE public.conversation_recordings ENABLE ROW LEVEL SECURITY;

-- Managers see everything in the account; technicians only their own.
DROP POLICY IF EXISTS "ci_rec_select" ON public.conversation_recordings;
CREATE POLICY "ci_rec_select" ON public.conversation_recordings
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.tasks_can_view_all() OR technician_user_id = auth.uid() OR created_by = auth.uid())
  );
-- No client INSERT/UPDATE/DELETE policies: every write goes through the SECURITY DEFINER RPCs below
-- (so the consent rules cannot be bypassed with a hand-crafted request) or the service-role edge function.

-- ---------------------------------------------------------------------------
-- Insights (promises / objections / upsells / safety)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recording_id uuid NOT NULL REFERENCES public.conversation_recordings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('commitment', 'objection', 'upsell', 'safety')),
  insight_key text NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 4 AND 300),
  speaker text NOT NULL DEFAULT 'unknown' CHECK (speaker IN ('technician', 'customer', 'unknown')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  evidence text CHECK (evidence IS NULL OR char_length(evidence) <= 200),
  due_description text,
  due_at timestamptz,
  resolved boolean,
  note text,
  commitment_id uuid REFERENCES public.commitments(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_ci_ins_recording ON public.conversation_insights (recording_id);
CREATE INDEX IF NOT EXISTS idx_ci_ins_user_kind ON public.conversation_insights (user_id, kind, created_at DESC);

ALTER TABLE public.conversation_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ci_ins_select" ON public.conversation_insights;
CREATE POLICY "ci_ins_select" ON public.conversation_insights
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.conversation_recordings r WHERE r.id = recording_id)
  );

-- ---------------------------------------------------------------------------
-- Coaching notes (one per recording)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_coaching_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recording_id uuid NOT NULL UNIQUE REFERENCES public.conversation_recordings(id) ON DELETE CASCADE,
  technician_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  summary text,
  strengths text[] NOT NULL DEFAULT '{}',
  improvements text[] NOT NULL DEFAULT '{}',
  focus_next text,
  score_communication integer CHECK (score_communication BETWEEN 0 AND 100),
  score_commitment_clarity integer CHECK (score_commitment_clarity BETWEEN 0 AND 100),
  score_objection_handling integer CHECK (score_objection_handling BETWEEN 0 AND 100),
  score_safety_awareness integer CHECK (score_safety_awareness BETWEEN 0 AND 100),
  score_upsell_discovery integer CHECK (score_upsell_discovery BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ci_coach_tech ON public.conversation_coaching_notes (technician_member_id, created_at DESC);

ALTER TABLE public.conversation_coaching_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ci_coach_select" ON public.conversation_coaching_notes;
CREATE POLICY "ci_coach_select" ON public.conversation_coaching_notes
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.conversation_recordings r WHERE r.id = recording_id)
  );

-- ---------------------------------------------------------------------------
-- Link commitments / tasks back to their source (idempotent re-analysis)
-- ---------------------------------------------------------------------------
ALTER TABLE public.commitments DROP CONSTRAINT IF EXISTS commitments_source_type_check;
ALTER TABLE public.commitments ADD CONSTRAINT commitments_source_type_check
  CHECK (source_type IN ('call', 'sms', 'quote', 'job_note', 'manual', 'chat', 'conversation'));

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS source_insight_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_per_insight
  ON public.tasks (source_insight_id);

-- ---------------------------------------------------------------------------
-- Audio objects waiting to be removed from storage. Filled in the SAME transaction that
-- detaches audio from a recording (discard / retention), drained by the conversation-intel-purge
-- edge function — so a failed storage call can never leave an orphaned recording behind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_audio_tombstones (
  path text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversation_audio_tombstones ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service role only.

-- ---------------------------------------------------------------------------
-- Private storage bucket for audio
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'conversation-recordings', 'conversation-recordings', false, 10485760,
  ARRAY['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac']
)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Upload only into "<owner>/<recording id>.<ext>" for a recording that is fully consented and owned by the caller.
DROP POLICY IF EXISTS "ci_audio_insert" ON storage.objects;
CREATE POLICY "ci_audio_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'conversation-recordings'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (
      SELECT 1 FROM public.conversation_recordings r
      WHERE r.id::text = split_part((storage.filename(name)), '.', 1)
        AND r.user_id = public.get_account_owner_id()
        AND (r.created_by = auth.uid() OR r.technician_user_id = auth.uid())
        AND r.customer_consent_status = 'granted'
        AND r.technician_consent_at IS NOT NULL
        AND r.audio_path IS NULL
    )
  );

-- Read: managers and the recording's technician. (The edge function uses the service role.)
DROP POLICY IF EXISTS "ci_audio_select" ON storage.objects;
CREATE POLICY "ci_audio_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'conversation-recordings'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (
      SELECT 1 FROM public.conversation_recordings r
      WHERE r.id::text = split_part((storage.filename(name)), '.', 1)
        AND (public.tasks_can_view_all() OR r.technician_user_id = auth.uid() OR r.created_by = auth.uid())
    )
  );
-- No client DELETE/UPDATE policy: deletion goes through discard_conversation_recording() / retention purge.

-- ---------------------------------------------------------------------------
-- RPC: start a consent session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_conversation_session(
  p_job_id uuid,
  p_customer_name text,
  p_state text,
  p_consent_mode text,
  p_disclosure_version text,
  p_disclosure_text text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_enabled boolean;
  v_member public.team_members%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT enabled INTO v_enabled FROM public.conversation_intel_settings WHERE user_id = v_owner;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'Conversation Intelligence is not enabled for this account' USING ERRCODE = '42501';
  END IF;

  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_member FROM public.team_members WHERE user_id = auth.uid() AND account_owner_id = v_owner LIMIT 1;

  INSERT INTO public.conversation_recordings (
    user_id, job_id, technician_member_id, technician_user_id, customer_name,
    jurisdiction_state, consent_mode, disclosure_version, disclosure_text, disclosure_shown_at
  )
  VALUES (
    v_owner, p_job_id, v_member.id, auth.uid(), NULLIF(btrim(p_customer_name), ''),
    NULLIF(upper(btrim(p_state)), ''), p_consent_mode, p_disclosure_version, p_disclosure_text, now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: record the customer's decision (+ technician confirmation when granted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_conversation_consent(
  p_id uuid,
  p_granted boolean,
  p_method text DEFAULT 'tap_on_device'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.conversation_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_rec FROM public.conversation_recordings
  WHERE id = p_id AND user_id = public.get_account_owner_id()
    AND (created_by = auth.uid() OR technician_user_id = auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recording not found' USING ERRCODE = '42501'; END IF;
  IF v_rec.customer_consent_status <> 'not_asked' THEN RAISE EXCEPTION 'Consent decision is final' USING ERRCODE = '22023'; END IF;
  IF p_method NOT IN ('tap_on_device', 'verbal_on_recording', 'both') THEN RAISE EXCEPTION 'Invalid method' USING ERRCODE = '22023'; END IF;

  IF p_granted THEN
    UPDATE public.conversation_recordings SET
      customer_consent_status = 'granted',
      customer_consent_at = now(),
      customer_consent_method = p_method,
      technician_consent_at = now(),
      status = 'recording',
      started_at = now()
    WHERE id = p_id;
  ELSE
    UPDATE public.conversation_recordings SET
      customer_consent_status = 'declined',
      customer_consent_at = now(),
      status = 'declined'
    WHERE id = p_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: attach the uploaded audio (after upload succeeded)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_conversation_audio(
  p_id uuid,
  p_path text,
  p_mime text,
  p_bytes integer,
  p_duration_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_audio_days integer;
  v_text_days integer;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_path IS NULL OR p_path !~ ('^' || v_owner::text || '/' || p_id::text || '\.[a-z0-9]{2,5}$') THEN
    RAISE EXCEPTION 'Invalid audio path' USING ERRCODE = '22023';
  END IF;

  SELECT audio_retention_days, transcript_retention_days INTO v_audio_days, v_text_days
  FROM public.conversation_intel_settings WHERE user_id = v_owner;

  UPDATE public.conversation_recordings SET
    audio_path = p_path,
    audio_mime = left(p_mime, 60),
    audio_bytes = p_bytes,
    duration_seconds = LEAST(GREATEST(p_duration_seconds, 0), 14400),
    ended_at = now(),
    status = 'uploaded',
    audio_expires_at = now() + make_interval(days => COALESCE(v_audio_days, 30)),
    transcript_expires_at = now() + make_interval(days => COALESCE(v_text_days, 90))
  WHERE id = p_id AND user_id = v_owner
    AND (created_by = auth.uid() OR technician_user_id = auth.uid())
    AND customer_consent_status = 'granted'
    AND audio_path IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recording not found or already uploaded' USING ERRCODE = '42501'; END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: delete a recording (customer withdrawal / manager / technician). Wipes the audio
-- reference, transcript, insights, coaching and every commitment/task derived from it; the
-- audio object itself is queued in conversation_audio_tombstones for removal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discard_conversation_recording(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_path text;
BEGIN
  SELECT audio_path INTO v_path FROM public.conversation_recordings
  WHERE id = p_id AND user_id = v_owner
    AND (public.tasks_can_view_all() OR technician_user_id = auth.uid() OR created_by = auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recording not found' USING ERRCODE = '42501'; END IF;

  DELETE FROM public.tasks
  WHERE user_id = v_owner
    AND source_insight_id IN (SELECT id FROM public.conversation_insights WHERE recording_id = p_id);
  DELETE FROM public.commitments
  WHERE user_id = v_owner AND source_type = 'conversation' AND source_id = p_id;
  DELETE FROM public.conversation_insights WHERE recording_id = p_id;
  DELETE FROM public.conversation_coaching_notes WHERE recording_id = p_id;

  IF v_path IS NOT NULL THEN
    INSERT INTO public.conversation_audio_tombstones (path) VALUES (v_path) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE public.conversation_recordings SET
    customer_consent_status = CASE WHEN customer_consent_status = 'granted' THEN 'withdrawn' ELSE customer_consent_status END,
    audio_path = NULL, transcript = NULL, summary = NULL, status = 'discarded'
  WHERE id = p_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: per-technician coaching rollup (managers: anyone; technicians: themselves)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_conversation_coaching_rollup(p_days integer DEFAULT 30)
RETURNS TABLE (
  technician_member_id uuid,
  technician_name text,
  conversations integer,
  avg_communication integer,
  avg_commitment_clarity integer,
  avg_objection_handling integer,
  avg_safety_awareness integer,
  avg_upsell_discovery integer,
  promises_made integer,
  promises_kept integer,
  promises_broken integer,
  objections_unresolved integer,
  upsells_found integer,
  safety_flags integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.get_account_owner_id() AS owner_id, public.tasks_can_view_all() AS is_mgr
  ),
  recs AS (
    SELECT r.id AS rec_id, r.technician_member_id AS tid
    FROM public.conversation_recordings r, me
    WHERE r.user_id = me.owner_id
      AND r.status = 'analyzed'
      AND r.created_at >= now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365))
      AND (me.is_mgr OR r.technician_user_id = auth.uid())
  ),
  conv AS (
    SELECT tid, COUNT(*)::int AS n FROM recs GROUP BY tid
  ),
  sc AS (
    SELECT recs.tid,
           ROUND(AVG(n.score_communication))::int AS communication,
           ROUND(AVG(n.score_commitment_clarity))::int AS commitment_clarity,
           ROUND(AVG(n.score_objection_handling))::int AS objection_handling,
           ROUND(AVG(n.score_safety_awareness))::int AS safety_awareness,
           ROUND(AVG(n.score_upsell_discovery))::int AS upsell_discovery
    FROM recs JOIN public.conversation_coaching_notes n ON n.recording_id = recs.rec_id
    GROUP BY recs.tid
  ),
  ct AS (
    SELECT recs.tid,
           COUNT(*) FILTER (WHERE i.kind = 'commitment')::int AS made,
           COUNT(*) FILTER (WHERE i.kind = 'commitment' AND c.status = 'kept')::int AS kept,
           COUNT(*) FILTER (WHERE i.kind = 'commitment' AND c.status = 'broken')::int AS broken,
           COUNT(*) FILTER (WHERE i.kind = 'objection' AND COALESCE(i.resolved, false) = false)::int AS unresolved,
           COUNT(*) FILTER (WHERE i.kind = 'upsell')::int AS upsells,
           COUNT(*) FILTER (WHERE i.kind = 'safety')::int AS safety
    FROM recs
    JOIN public.conversation_insights i ON i.recording_id = recs.rec_id
    LEFT JOIN public.commitments c ON c.id = i.commitment_id
    GROUP BY recs.tid
  )
  SELECT
    conv.tid,
    COALESCE(tm.member_name, tm.member_email, 'Owner / unassigned'),
    conv.n,
    sc.communication, sc.commitment_clarity, sc.objection_handling, sc.safety_awareness, sc.upsell_discovery,
    COALESCE(ct.made, 0), COALESCE(ct.kept, 0), COALESCE(ct.broken, 0),
    COALESCE(ct.unresolved, 0), COALESCE(ct.upsells, 0), COALESCE(ct.safety, 0)
  FROM conv
  LEFT JOIN sc ON sc.tid IS NOT DISTINCT FROM conv.tid
  LEFT JOIN ct ON ct.tid IS NOT DISTINCT FROM conv.tid
  LEFT JOIN public.team_members tm ON tm.id = conv.tid
  ORDER BY conv.n DESC, 2;
$$;

-- ---------------------------------------------------------------------------
-- Retention purge (service role / cron): detaches expired audio (queued for storage removal),
-- clears expired transcripts. Returns how many rows were touched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_conversation_recordings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audio integer := 0;
  v_text integer := 0;
BEGIN
  INSERT INTO public.conversation_audio_tombstones (path)
  SELECT r.audio_path FROM public.conversation_recordings r
  WHERE r.audio_path IS NOT NULL AND r.audio_expires_at IS NOT NULL AND r.audio_expires_at < now()
  ON CONFLICT DO NOTHING;

  UPDATE public.conversation_recordings
  SET audio_path = NULL
  WHERE audio_path IS NOT NULL AND audio_expires_at IS NOT NULL AND audio_expires_at < now();
  GET DIAGNOSTICS v_audio = ROW_COUNT;

  UPDATE public.conversation_recordings
  SET transcript = NULL, summary = NULL
  WHERE transcript IS NOT NULL AND transcript_expires_at IS NOT NULL AND transcript_expires_at < now();
  GET DIAGNOSTICS v_text = ROW_COUNT;

  RETURN v_audio + v_text;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.start_conversation_session(uuid, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_conversation_session(uuid, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.record_conversation_consent(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_conversation_consent(uuid, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.attach_conversation_audio(uuid, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_conversation_audio(uuid, text, text, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.discard_conversation_recording(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discard_conversation_recording(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_coaching_rollup(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_coaching_rollup(integer) TO authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_conversation_recordings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_conversation_recordings() TO service_role;

/*
  Retention: schedule hourly (pg_cron + pg_net, same pattern as commitment-monitor-tick):
    select cron.schedule('conversation-intel-purge', '17 * * * *',
      $$ select net.http_post(url := '<SUPABASE_URL>/functions/v1/conversation-intel-purge',
           headers := jsonb_build_object('X-Cron-Secret', '<CRON_SECRET>')) $$);
  The conversation-intel-purge function runs purge_expired_conversation_recordings() and then deletes
  every object listed in conversation_audio_tombstones from the bucket.
*/
