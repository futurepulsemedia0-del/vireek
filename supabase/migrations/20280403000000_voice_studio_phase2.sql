/*
  # Voice Studio Phase 2: consent, A/B, votes, sync log
  Rollback: DROP TABLE public.voice_sync_log, public.voice_ab_votes,
            public.voice_experiment_assignments, public.voice_experiments, public.voice_clone_consents;
  Note: rolling back voice_clone_consents makes clone-voice (once patched) refuse every request.
*/

CREATE TABLE IF NOT EXISTS public.voice_clone_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signed_by uuid NOT NULL,
  voice_owner_name text NOT NULL CHECK (char_length(btrim(voice_owner_name)) BETWEEN 2 AND 120),
  relationship text NOT NULL CHECK (relationship IN ('self', 'employee_written_consent')),
  consent_version text NOT NULL,
  consent_sha256 text NOT NULL CHECK (consent_sha256 ~ '^[0-9a-f]{64}$'),
  attested boolean NOT NULL CHECK (attested = true),
  liveness_phrase text NOT NULL CHECK (char_length(liveness_phrase) BETWEEN 5 AND 120),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  sample_path text,
  provider_voice_id text,
  failure_reason text,
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_clone_consents_user ON public.voice_clone_consents (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS voice_clone_consents_one_approved
  ON public.voice_clone_consents (user_id) WHERE status = 'approved';

ALTER TABLE public.voice_clone_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_clone_consents_select ON public.voice_clone_consents;
CREATE POLICY voice_clone_consents_select ON public.voice_clone_consents
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
GRANT SELECT ON public.voice_clone_consents TO authenticated;

CREATE TABLE IF NOT EXISTS public.voice_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  location_id uuid REFERENCES public.business_locations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'stopped', 'completed')),
  arms jsonb NOT NULL CHECK (
    CASE WHEN jsonb_typeof(arms) = 'array' THEN jsonb_array_length(arms) BETWEEN 2 AND 3 ELSE false END
  ),
  min_per_arm integer NOT NULL DEFAULT 200 CHECK (min_per_arm BETWEEN 50 AND 100000),
  started_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_experiments_user ON public.voice_experiments (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS voice_experiments_one_running
  ON public.voice_experiments (user_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'running';

ALTER TABLE public.voice_experiments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_experiments_select ON public.voice_experiments;
CREATE POLICY voice_experiments_select ON public.voice_experiments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS voice_experiments_insert ON public.voice_experiments;
CREATE POLICY voice_experiments_insert ON public.voice_experiments
  FOR INSERT TO authenticated WITH CHECK (
    user_id = public.get_account_owner_id() AND status = 'draft'
    AND (voice_experiments.location_id IS NULL OR EXISTS (
      SELECT 1 FROM public.business_locations l
      WHERE l.id = voice_experiments.location_id AND l.user_id = public.get_account_owner_id()))
  );
DROP POLICY IF EXISTS voice_experiments_update ON public.voice_experiments;
CREATE POLICY voice_experiments_update ON public.voice_experiments
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
GRANT SELECT, INSERT, UPDATE ON public.voice_experiments TO authenticated;

CREATE TABLE IF NOT EXISTS public.voice_experiment_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES public.voice_experiments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  call_id text NOT NULL CHECK (char_length(call_id) BETWEEN 1 AND 128),
  arm_key text NOT NULL CHECK (char_length(arm_key) BETWEEN 1 AND 64),
  outcome text CHECK (outcome IS NULL OR outcome IN ('booked', 'hangup', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, call_id)
);

CREATE INDEX IF NOT EXISTS voice_experiment_assignments_exp ON public.voice_experiment_assignments (experiment_id, arm_key);

ALTER TABLE public.voice_experiment_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_experiment_assignments_select ON public.voice_experiment_assignments;
CREATE POLICY voice_experiment_assignments_select ON public.voice_experiment_assignments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
GRANT SELECT ON public.voice_experiment_assignments TO authenticated;

CREATE TABLE IF NOT EXISTS public.voice_ab_votes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  voter_id uuid NOT NULL DEFAULT auth.uid(),
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 64),
  voice_key text NOT NULL CHECK (voice_key IN (
    'sarah-warm-f-us', 'aria-friendly-f-us', 'maya-calm-f-uk',
    'miles-confident-m-us', 'jay-easygoing-m-us', 'oliver-polished-m-uk'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, voter_id)
);

ALTER TABLE public.voice_ab_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_ab_votes_select ON public.voice_ab_votes;
CREATE POLICY voice_ab_votes_select ON public.voice_ab_votes
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS voice_ab_votes_insert ON public.voice_ab_votes;
CREATE POLICY voice_ab_votes_insert ON public.voice_ab_votes
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND voter_id = auth.uid());
GRANT SELECT, INSERT ON public.voice_ab_votes TO authenticated;

CREATE TABLE IF NOT EXISTS public.voice_sync_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  assistant_id text NOT NULL,
  ok boolean NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_sync_log_user ON public.voice_sync_log (user_id, created_at DESC);

ALTER TABLE public.voice_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_sync_log_select ON public.voice_sync_log;
CREATE POLICY voice_sync_log_select ON public.voice_sync_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
GRANT SELECT ON public.voice_sync_log TO authenticated;
