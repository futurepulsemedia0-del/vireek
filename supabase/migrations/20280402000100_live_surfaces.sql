-- Live surfaces: Live Activity tokens (iOS), widget snapshot RPC, and the live_calls -> dispatch trigger.
-- Depends on: device_push_tokens, live_calls, jobs, calls, revenue_recovery_events, on_call_* , team_members, get_account_owner_id().

CREATE TABLE IF NOT EXISTS public.live_activity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- account owner (same scoping as device_push_tokens)
  subscriber_user_id uuid NOT NULL,            -- the person whose phone this is
  kind text NOT NULL CHECK (kind IN ('start', 'update')),
  target text NOT NULL DEFAULT '' ,            -- live_calls.vapi_call_id for 'update'; '' for push-to-start
  token text NOT NULL CHECK (char_length(token) BETWEEN 20 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS idx_live_activity_tokens_user ON public.live_activity_tokens(user_id, kind, target);
ALTER TABLE public.live_activity_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_live_activity_tokens" ON public.live_activity_tokens;
CREATE POLICY "select_own_live_activity_tokens" ON public.live_activity_tokens
  FOR SELECT TO authenticated USING (subscriber_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.register_live_activity_token(p_kind text, p_target text, p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('start', 'update') THEN RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.live_activity_tokens (user_id, subscriber_user_id, kind, target, token)
  VALUES (v_owner, auth.uid(), p_kind, COALESCE(p_target, ''), p_token)
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id, subscriber_user_id = EXCLUDED.subscriber_user_id,
        kind = EXCLUDED.kind, target = EXCLUDED.target, last_seen_at = now();
END; $$;

CREATE OR REPLACE FUNCTION public.unregister_live_activity_token(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  DELETE FROM public.live_activity_tokens WHERE token = p_token AND subscriber_user_id = auth.uid();
END; $$;

REVOKE ALL ON FUNCTION public.register_live_activity_token(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unregister_live_activity_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_live_activity_token(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_live_activity_token(text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Widget / Siri snapshot. Runs as the caller (SECURITY INVOKER) so existing RLS still applies.
-- Deliberately contains NO customer names, phones or addresses: it is stored on the phone for
-- lock-screen widgets and read by Siri.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mobile_surface_snapshot(p_tz text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tz text := CASE WHEN p_tz IN (SELECT name FROM pg_timezone_names) THEN p_tz ELSE 'UTC' END;
  v_day_start timestamptz := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  v_me uuid;
  v_answered int; v_missed int; v_recovered bigint;
  v_job record; v_oncall_id uuid; v_oncall_name text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;

  SELECT tm.id INTO v_me FROM team_members tm
   WHERE tm.account_owner_id = v_owner AND tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1;

  SELECT count(*) FILTER (WHERE status <> 'missed'), count(*) FILTER (WHERE status = 'missed')
    INTO v_answered, v_missed FROM calls WHERE user_id = v_owner AND call_datetime >= v_day_start;

  SELECT COALESCE(sum(recovered_amount_cents), 0) INTO v_recovered FROM revenue_recovery_events
   WHERE user_id = v_owner AND status = 'recovered' AND resolved_at >= v_day_start;

  SELECT j.id, j.service_type, j.scheduled_datetime INTO v_job FROM jobs j
   WHERE j.user_id = v_owner AND j.scheduled_datetime >= now() - interval '1 hour'
     AND j.job_status NOT IN ('completed', 'cancelled')
     AND (v_me IS NULL OR j.assigned_technician_id = v_me)
   ORDER BY j.scheduled_datetime ASC LIMIT 1;

  SELECT s.id INTO v_oncall_id FROM on_call_schedules s WHERE s.user_id = v_owner AND s.is_active ORDER BY s.created_at LIMIT 1;
  IF v_oncall_id IS NOT NULL THEN
    v_oncall_id := public.get_current_on_call(v_oncall_id);
    SELECT COALESCE(member_name, 'Team member') INTO v_oncall_name FROM team_members WHERE id = v_oncall_id;
  END IF;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'calls_answered', COALESCE(v_answered, 0),
    'calls_missed', COALESCE(v_missed, 0),
    'revenue_recovered_cents', v_recovered,
    'next_job', CASE WHEN v_job.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_job.id, 'service', COALESCE(v_job.service_type, 'Job'), 'scheduled_at', v_job.scheduled_datetime) END,
    'on_call', CASE WHEN v_oncall_id IS NULL THEN NULL ELSE jsonb_build_object(
        'name', v_oncall_name, 'is_me', (v_me IS NOT NULL AND v_me = v_oncall_id)) END
  );
END; $$;
REVOKE ALL ON FUNCTION public.mobile_surface_snapshot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mobile_surface_snapshot(text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- live_calls -> live-surface-dispatch (same pg_net + shared-secret pattern as dispatch_push_notification)
-- Fires on INSERT, and on UPDATE only when status / emergency / handoff state changed.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_live_surface()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_base_url text; v_secret text; v_event text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status AND NEW.is_emergency = OLD.is_emergency
     AND NEW.handoff_status = OLD.handoff_status THEN
    RETURN NEW;
  END IF;
  v_event := CASE WHEN NEW.status = 'ended' THEN 'ended' WHEN TG_OP = 'INSERT' THEN 'started' ELSE 'updated' END;

  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url := v_base_url || '/live-surface-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
    body := jsonb_build_object('live_call_id', NEW.id, 'event', v_event)
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trigger_dispatch_live_surface ON public.live_calls;
CREATE TRIGGER trigger_dispatch_live_surface
  AFTER INSERT OR UPDATE ON public.live_calls
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_live_surface();

-- Rollback: DROP TRIGGER trigger_dispatch_live_surface ON public.live_calls; DROP FUNCTION public.dispatch_live_surface();
--           DROP FUNCTION public.mobile_surface_snapshot(text); DROP TABLE public.live_activity_tokens; (+ the two RPCs)
