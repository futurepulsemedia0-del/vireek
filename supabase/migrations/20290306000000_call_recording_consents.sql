/*
  # Call recording consent ledger (per call, with caller state)

  Complements, does not replace:
  - call_ai_disclosures (20271112000000): proves the AI disclosure was spoken.
  - consent_records: a per-contact grant/revoke ledger; it has no call id, no jurisdiction and no
    record of what the system decided to do. (Note: two migrations define public.consent_records with
    different columns - see docs/ai-governance/iso42001-gap.md section 5. This table deliberately does
    not depend on it.)

  This ledger answers, for ONE call: which jurisdiction rule applied, whether audio recording was
  allowed or blocked, the exact notice wording spoken (hash), whether it was in the first assistant turn,
  what the caller answered, and whether the recording / transcript were stored or suppressed.

  DRAFT - NOT LEGAL ADVICE. Jurisdiction rules come from _shared/compliance/recordingProfiles.ts
  (legal_review = 'draft' until counsel approves). caller_state is derived from the caller's area code
  and is a heuristic, not the caller's location.

  ## Access model (same as call_ai_disclosures)
  - Reads: account owner + members with can_edit_business_profile (ai_disclosure_can_view()).
  - Writes: service role only (the webhook). No client writes.
  - Once consent_outcome leaves 'pending' the proof columns are immutable (trigger).
  - No caller phone number or name is stored; excerpt is capped at 120 characters.
*/

CREATE TABLE IF NOT EXISTS public.call_recording_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL,
  call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,

  business_country text,
  business_subdivision text,
  caller_state text CHECK (caller_state IS NULL OR caller_state ~ '^[A-Z]{2}$'),
  caller_state_source text NOT NULL DEFAULT 'none' CHECK (caller_state_source IN ('area_code_heuristic', 'none')),

  profile_jurisdiction text NOT NULL,
  profile_mode text NOT NULL CHECK (profile_mode IN ('off', 'notice', 'opt_in', 'opt_in_strict')),
  effective_mode text NOT NULL CHECK (effective_mode IN ('off', 'notice', 'opt_in', 'opt_in_strict')),
  legal_review text NOT NULL DEFAULT 'draft' CHECK (legal_review IN ('draft', 'approved')),

  language text NOT NULL CHECK (language IN ('en', 'de', 'fr', 'es')),
  language_supported boolean NOT NULL,
  gate_mode text NOT NULL CHECK (gate_mode IN ('shadow', 'enforce')),
  would_block boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN (
    'record_after_notice', 'no_recording_consent_gate', 'no_recording_language_unsupported', 'no_recording_disabled')),
  recording_enabled_requested boolean NOT NULL,

  spoken_kind text NOT NULL CHECK (spoken_kind IN ('recording_notice', 'transcript_consent_ask', 'none')),
  notice_text text CHECK (notice_text IS NULL OR char_length(notice_text) <= 1000),
  notice_sha256 text,
  notice_in_first_turn boolean,

  consent_outcome text NOT NULL DEFAULT 'pending'
    CHECK (consent_outcome IN ('pending', 'granted', 'declined', 'unclear', 'not_asked')),
  consent_method text CHECK (consent_method IS NULL OR consent_method IN ('transcript_inferred')),
  consent_turn_index integer CHECK (consent_turn_index IS NULL OR consent_turn_index >= 0),
  consent_excerpt text CHECK (consent_excerpt IS NULL OR char_length(consent_excerpt) <= 120),

  recording_stored boolean,
  transcript_stored boolean,
  storage_reason text,
  provider_deletion_required boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_recording_consents_one_per_call UNIQUE (user_id, vapi_call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_recording_consents_user_created
  ON public.call_recording_consents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recording_consents_user_state
  ON public.call_recording_consents (user_id, caller_state, consent_outcome);
CREATE INDEX IF NOT EXISTS idx_call_recording_consents_call
  ON public.call_recording_consents (call_id) WHERE call_id IS NOT NULL;
-- Work queue: provider copies a caller refused that still need deleting.
CREATE INDEX IF NOT EXISTS idx_call_recording_consents_deletion
  ON public.call_recording_consents (user_id, created_at) WHERE provider_deletion_required;

-- Immutable once final. Only the call link, the deletion flag and updated_at may still change.
CREATE OR REPLACE FUNCTION public.call_recording_consents_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF OLD.consent_outcome <> 'pending'
     AND (to_jsonb(NEW) - 'call_id' - 'provider_deletion_required' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'call_id' - 'provider_deletion_required' - 'updated_at') THEN
    RAISE EXCEPTION 'call_recording_consent_is_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_call_recording_consents_guard ON public.call_recording_consents;
CREATE TRIGGER trigger_call_recording_consents_guard
  BEFORE UPDATE ON public.call_recording_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.call_recording_consents_guard();

ALTER TABLE public.call_recording_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_recording_consents_select" ON public.call_recording_consents;
CREATE POLICY "call_recording_consents_select" ON public.call_recording_consents
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

REVOKE ALL ON public.call_recording_consents FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.call_recording_consents FROM authenticated;
GRANT SELECT ON public.call_recording_consents TO authenticated;

-- Roll-up by caller state. security_invoker = true: the view runs with the caller's rights, so the
-- table's RLS applies (same pattern as win_loss_summary).
CREATE OR REPLACE VIEW public.call_recording_consents_by_state
WITH (security_invoker = true) AS
SELECT
  user_id,
  COALESCE(caller_state, 'unknown') AS caller_state,
  effective_mode,
  gate_mode,
  count(*)                                                    AS calls,
  count(*) FILTER (WHERE consent_outcome = 'granted')         AS granted,
  count(*) FILTER (WHERE consent_outcome = 'declined')        AS declined,
  count(*) FILTER (WHERE consent_outcome = 'unclear')         AS unclear,
  count(*) FILTER (WHERE consent_outcome = 'not_asked')       AS not_asked,
  count(*) FILTER (WHERE consent_outcome = 'pending')         AS pending,
  count(*) FILTER (WHERE would_block)                         AS would_block,
  count(*) FILTER (WHERE recording_stored IS TRUE)            AS recordings_stored,
  count(*) FILTER (WHERE notice_in_first_turn IS FALSE)       AS notice_not_in_first_turn,
  count(*) FILTER (WHERE provider_deletion_required)          AS provider_deletions_open
FROM public.call_recording_consents
GROUP BY user_id, COALESCE(caller_state, 'unknown'), effective_mode, gate_mode;

REVOKE ALL ON public.call_recording_consents_by_state FROM anon;
GRANT SELECT ON public.call_recording_consents_by_state TO authenticated;

COMMENT ON TABLE public.call_recording_consents IS
  'Per-call recording/transcript consent evidence: jurisdiction rule applied, notice spoken (hash), caller answer, what was stored. Immutable once final. DRAFT jurisdiction rules - not legal advice.';
COMMENT ON COLUMN public.call_recording_consents.caller_state IS
  'US state guessed from the caller area code (heuristic, not a location).';

/* Rollback (manual, destructive - evidence is lost):
     DROP VIEW IF EXISTS public.call_recording_consents_by_state;
     DROP TABLE IF EXISTS public.call_recording_consents;
     DROP FUNCTION IF EXISTS public.call_recording_consents_guard();
*/
