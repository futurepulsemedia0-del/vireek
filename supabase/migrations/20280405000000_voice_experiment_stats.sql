/*
  # Voice experiments: server-owned lifecycle + outcome stats
  - Experiments are created/started/stopped only by the voice-experiment edge function (service role),
    so arms and status cannot be edited from the client mid-run.
  - voice_experiment_stats joins assignments to finished calls (calls.vapi_call_id = assignment.call_id).
    booking = calls.booking_outcome = 'booked'; hang-up = not booked and shorter than p_hangup_seconds.
  Rollback: DROP FUNCTION public.voice_experiment_stats(uuid, integer);
            then re-create the insert/update policies and grants from 20280403000000_voice_studio_phase2.sql.
*/

DROP POLICY IF EXISTS voice_experiments_insert ON public.voice_experiments;
DROP POLICY IF EXISTS voice_experiments_update ON public.voice_experiments;
REVOKE INSERT, UPDATE ON public.voice_experiments FROM authenticated;

CREATE OR REPLACE FUNCTION public.voice_experiment_stats(p_experiment uuid, p_hangup_seconds integer DEFAULT 15)
RETURNS TABLE (arm text, n_calls bigint, n_bookings bigint, n_hangups bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_hangup_seconds IS NULL OR p_hangup_seconds < 1 OR p_hangup_seconds > 600 THEN
    RAISE EXCEPTION 'invalid hang-up threshold' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.voice_experiments e
    WHERE e.id = p_experiment AND e.user_id = public.get_account_owner_id()
  ) THEN
    RAISE EXCEPTION 'experiment not found' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.arm_key,
         count(*)::bigint,
         count(*) FILTER (WHERE c.booking_outcome = 'booked')::bigint,
         count(*) FILTER (
           WHERE c.booking_outcome IS DISTINCT FROM 'booked'
             AND c.duration_seconds IS NOT NULL
             AND c.duration_seconds < p_hangup_seconds
         )::bigint
  FROM public.voice_experiment_assignments a
  JOIN public.calls c ON c.vapi_call_id = a.call_id AND c.user_id = a.user_id
  WHERE a.experiment_id = p_experiment
  GROUP BY a.arm_key;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_experiment_stats(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.voice_experiment_stats(uuid, integer) TO authenticated;
