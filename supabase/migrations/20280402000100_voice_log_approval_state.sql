-- Adds the 'approving' state so approvals are crash-safe and offline-retry-safe:
--   ready -> approving (claim) -> [client writes the job note] -> approved
--   approving -> ready only when the note definitely was NOT written.
ALTER TABLE public.voice_log_drafts DROP CONSTRAINT IF EXISTS voice_log_drafts_status_check;
ALTER TABLE public.voice_log_drafts
  ADD CONSTRAINT voice_log_drafts_status_check CHECK (status IN ('ready', 'approving', 'approved', 'discarded'));

CREATE OR REPLACE FUNCTION public.transition_voice_log_draft(
  p_id uuid, p_from text, p_to text, p_extraction jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF NOT ((p_from = 'ready'     AND p_to = 'approving')
       OR (p_from = 'approving' AND p_to = 'approved')
       OR (p_from = 'approving' AND p_to = 'ready')
       OR (p_from = 'ready'     AND p_to = 'approved')   -- legacy single-step path
       OR (p_from = 'approved'  AND p_to = 'ready')      -- legacy rollback
       OR (p_from = 'ready'     AND p_to = 'discarded')) THEN
    RETURN false;
  END IF;
  IF p_extraction IS NOT NULL AND (jsonb_typeof(p_extraction) <> 'object' OR pg_column_size(p_extraction) >= 65536) THEN
    RETURN false;
  END IF;

  UPDATE voice_log_drafts
     SET status = p_to,
         extraction = CASE WHEN p_to IN ('approving', 'approved') AND p_extraction IS NOT NULL THEN p_extraction ELSE extraction END,
         approved_at = CASE WHEN p_to = 'approved' THEN now() WHEN p_to = 'ready' THEN NULL ELSE approved_at END,
         transcript = CASE WHEN p_to = 'discarded' THEN '' ELSE transcript END
   WHERE id = p_id AND created_by = auth.uid() AND status = p_from;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.transition_voice_log_draft(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_voice_log_draft(uuid, text, text, jsonb) TO authenticated;
-- Rollback: re-run the function body from 20280402000000_voice_job_log.sql and restore the 3-state CHECK.
