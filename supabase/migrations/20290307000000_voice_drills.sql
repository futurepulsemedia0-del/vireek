/*
  # Voice resilience: drill schedule + evidence log (per account)

  - voice_drill_schedules: one row per account; how often the owner wants to re-prove the carrier safety net.
    The "next due" date is DERIVED in the app from the newest passed `forward_on` check, so nothing here can drift.
  - voice_drill_evidence: append-only manual log (voicemail drill, emergency-key drill, ...). System-verified test calls
    stay in voice_forward_checks; the evidence page merges both.
  Writes go through the voice-resilience-admin edge function (service role). Clients can only SELECT their own account.
  Rollback: DROP TABLE public.voice_drill_evidence, public.voice_drill_schedules; DROP FUNCTION public.voice_drill_evidence_no_update();
*/

CREATE TABLE IF NOT EXISTS public.voice_drill_schedules (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  interval_days integer NOT NULL DEFAULT 30 CHECK (interval_days BETWEEN 7 AND 90),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.voice_drill_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('voicemail','emergency_key','owner_forward','other')),
  outcome     text NOT NULL CHECK (outcome IN ('passed','failed')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vde_user_created ON public.voice_drill_evidence (user_id, created_at DESC);

-- Evidence must not be rewritten after the fact. DELETE is left alone on purpose: account deletion cascades.
CREATE OR REPLACE FUNCTION public.voice_drill_evidence_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'voice_drill_evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS voice_drill_evidence_no_update ON public.voice_drill_evidence;
CREATE TRIGGER voice_drill_evidence_no_update BEFORE UPDATE ON public.voice_drill_evidence
  FOR EACH ROW EXECUTE FUNCTION public.voice_drill_evidence_no_update();

ALTER TABLE public.voice_drill_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_drill_evidence  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_drill_schedules_select ON public.voice_drill_schedules;
CREATE POLICY voice_drill_schedules_select ON public.voice_drill_schedules
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS voice_drill_evidence_select ON public.voice_drill_evidence;
CREATE POLICY voice_drill_evidence_select ON public.voice_drill_evidence
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.voice_drill_schedules FROM anon, authenticated;
REVOKE ALL ON public.voice_drill_evidence  FROM anon, authenticated;
GRANT SELECT ON public.voice_drill_schedules TO authenticated;
GRANT SELECT ON public.voice_drill_evidence  TO authenticated;
