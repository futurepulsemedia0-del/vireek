/*
  # Agent runtime — observability metrics (feeds the EXISTING alert engine)

  obs_agent_metrics(p_window_minutes) returns the same row shape as obs_voice_metrics
  ([{metric, scope_key, value, samples}]) so observability-alerts can merge it and the existing
  anti-fatigue state machine (volume gate, confirmations, hysteresis, dedupe, page budget) applies.

  Metrics:
    agent_stuck_runs      running runs with no heartbeat for 15 min          (samples = open runs)
    agent_dead_letter_rate (dead_letter + escalated) / finished runs in window (samples = finished runs)
    agent_breaker_open    1 when a provider breaker is open/half-open (scope = provider)
    agent_stale_approvals approvals waiting > 24h (they can no longer execute)  (samples = waiting approvals)

  Rollback: DROP FUNCTION public.obs_agent_metrics(integer);
*/
CREATE OR REPLACE FUNCTION public.obs_agent_metrics(p_window_minutes integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(mins => greatest(1, least(coalesce(p_window_minutes, 60), 1440)));
  v_rows jsonb := '[]'::jsonb;
  v_open integer;
  v_stuck integer;
  v_finished integer;
  v_bad integer;
  v_waiting integer;
  v_stale integer;
BEGIN
  SELECT count(*) FILTER (WHERE true),
         count(*) FILTER (WHERE heartbeat_at < now() - interval '15 minutes')
    INTO v_open, v_stuck
    FROM agent_runs WHERE status = 'running' AND created_at > now() - interval '7 days';
  v_rows := v_rows || jsonb_build_array(jsonb_build_object(
    'metric', 'agent_stuck_runs', 'scope_key', 'global', 'value', v_stuck, 'samples', v_open));

  SELECT count(*), count(*) FILTER (WHERE status IN ('dead_letter', 'escalated'))
    INTO v_finished, v_bad
    FROM agent_runs WHERE finished_at >= v_since;
  v_rows := v_rows || jsonb_build_array(jsonb_build_object(
    'metric', 'agent_dead_letter_rate', 'scope_key', 'global',
    'value', CASE WHEN v_finished = 0 THEN NULL ELSE v_bad::numeric / v_finished END, 'samples', v_finished));

  SELECT count(*), count(*) FILTER (WHERE updated_at < now() - interval '24 hours')
    INTO v_waiting, v_stale
    FROM agent_runs WHERE status = 'awaiting_approval';
  v_rows := v_rows || jsonb_build_array(jsonb_build_object(
    'metric', 'agent_stale_approvals', 'scope_key', 'global', 'value', v_stale, 'samples', v_waiting));

  v_rows := v_rows || COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'metric', 'agent_breaker_open', 'scope_key', provider,
      'value', CASE WHEN state = 'closed' THEN 0 ELSE 1 END, 'samples', 1))
    FROM agent_circuit_breakers), '[]'::jsonb);

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.obs_agent_metrics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.obs_agent_metrics(integer) TO service_role;
