-- =====================================================================================================
-- 20290304000000_tenant_margin_alerts_and_ai_roi.sql
--
-- 1) economics_alerts: allow kind 'tenant_negative_margin' (written by economics-sweep, service role).
-- 2) economics_tenant_margin_core(): per-tenant cost + usage for a window. SERVICE ROLE ONLY.
--    staff_tenant_margin(): staff-gated wrapper for the dashboard.
-- 3) ai_roi_inputs_core(): the raw, owner-scoped inputs for the customer ROI card / monthly report.
--    tenant_ai_roi_inputs(): OWNER-ONLY wrapper (billing figures are never shown to non-owner members).
--
-- Additive only. Nothing here changes an existing table's data.
--
-- ROLLBACK (run manually, in this order):
--   DROP FUNCTION IF EXISTS public.tenant_ai_roi_inputs(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.ai_roi_inputs_core(uuid, timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.staff_tenant_margin(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.economics_tenant_margin_core(timestamptz, timestamptz);
--   -- (alert kind: re-add the old CHECK only after DELETE FROM economics_alerts WHERE kind = 'tenant_negative_margin')
-- =====================================================================================================

-- 1) alert kind ---------------------------------------------------------------------------------------
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'public.economics_alerts'::regclass AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%kind%' AND pg_get_constraintdef(c.oid) ILIKE '%cost_per_call_spike%'
  LOOP
    EXECUTE format('ALTER TABLE public.economics_alerts DROP CONSTRAINT %I', v_name);
  END LOOP;
  ALTER TABLE public.economics_alerts
    ADD CONSTRAINT economics_alerts_kind_check CHECK (kind IN
      ('cost_per_call_spike','reconciliation_variance','missing_correlation','budget_breach','tenant_negative_margin'));
END $$;

-- 2) per-tenant margin inputs -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economics_tenant_margin_core(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  account_id uuid, plan text, minutes_included integer, minutes_used bigint, call_count bigint,
  cost_micro bigint, has_subscription boolean, subscription_status text, trial_state text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cost AS (
    SELECT l.account_id, sum(l.cost_micro)::bigint AS cost_micro
      FROM cost_ledger l
     WHERE l.account_id IS NOT NULL AND l.occurred_at >= p_start AND l.occurred_at < p_end
     GROUP BY l.account_id
  ), use AS (
    SELECT c.user_id AS account_id, sum(ceil(c.duration_seconds / 60.0))::bigint AS minutes, count(*)::bigint AS calls
      FROM calls c
     WHERE c.call_datetime >= p_start AND c.call_datetime < p_end AND coalesce(c.duration_seconds, 0) > 0
     GROUP BY c.user_id
  )
  SELECT p.id, p.plan, p.minutes_included, coalesce(u.minutes, 0), coalesce(u.calls, 0), coalesce(k.cost_micro, 0),
         (p.stripe_subscription_id IS NOT NULL), p.subscription_status, p.trial_state
    FROM profiles p
    LEFT JOIN cost k ON k.account_id = p.id
    LEFT JOIN use u ON u.account_id = p.id
   WHERE (k.cost_micro IS NOT NULL AND k.cost_micro <> 0) OR coalesce(u.minutes, 0) > 0
   ORDER BY p.id
   LIMIT 5000;
$$;
REVOKE ALL ON FUNCTION public.economics_tenant_margin_core(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economics_tenant_margin_core(timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.staff_tenant_margin(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(m)) FROM public.economics_tenant_margin_core(p_start, p_end) m), '[]'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION public.staff_tenant_margin(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_tenant_margin(timestamptz, timestamptz) TO authenticated;

-- 3) customer ROI inputs ------------------------------------------------------------------------------
-- Definitions (also shown to the customer):
--   answered      = call that is not missed, not voicemail, not spam
--   AI-created job = jobs.voice_idempotency_key IS NOT NULL (set only by the voice booking tool in vapi-webhook)
--   paid          = an invoices row for that job with status = 'paid'
-- Jobs booked before voice_idempotency_key existed are NOT counted: the figure can only be understated.
CREATE OR REPLACE FUNCTION public.ai_roi_inputs_core(p_owner uuid, p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_calls jsonb; v_jobs jsonb; v_hist jsonb; v_rec jsonb;
BEGIN
  WITH c AS (
    SELECT cl.duration_seconds,
           (cl.status = 'missed' OR coalesce(cl.is_voicemail, false)) AS is_missed,
           public.report_after_hours(cl.call_datetime, rs.time_zone, bp.business_hours) AS ah
      FROM calls cl
      LEFT JOIN business_regional_settings rs ON rs.user_id = cl.user_id
      LEFT JOIN business_profile bp ON bp.user_id = cl.user_id
     WHERE cl.user_id = p_owner AND cl.call_datetime >= p_start AND cl.call_datetime < p_end
       AND cl.status IS DISTINCT FROM 'spam'
  )
  SELECT jsonb_build_object(
    'total', count(*), 'answered', count(*) FILTER (WHERE NOT is_missed), 'missed', count(*) FILTER (WHERE is_missed),
    'after_hours_known', count(*) FILTER (WHERE ah IS NOT NULL AND NOT is_missed),
    'after_hours_answered', count(*) FILTER (WHERE ah AND NOT is_missed),
    'handled_seconds', coalesce(sum(duration_seconds) FILTER (WHERE NOT is_missed AND duration_seconds > 0), 0))
  INTO v_calls FROM c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'created_at', j.created_at, 'job_status', j.job_status, 'completed_at', j.completed_at,
           'amount_cents', CASE WHEN j.invoice_amount IS NULL THEN NULL ELSE round(j.invoice_amount * 100)::bigint END,
           'paid', EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.user_id = p_owner AND i.status = 'paid')
         ) ORDER BY j.created_at DESC), '[]'::jsonb)
  INTO v_jobs
  FROM (SELECT * FROM jobs jj WHERE jj.user_id = p_owner AND jj.voice_idempotency_key IS NOT NULL
           AND jj.created_at >= p_start AND jj.created_at < p_end ORDER BY jj.created_at DESC LIMIT 2000) j;

  -- the customer's OWN paid-job history (12 months before the window end) for the average job value
  SELECT jsonb_build_object('n', count(*), 'sum_cents', coalesce(sum(round(j.invoice_amount * 100)), 0)::bigint)
  INTO v_hist
  FROM jobs j
  WHERE j.user_id = p_owner AND j.job_status = 'completed' AND coalesce(j.invoice_amount, 0) > 0
    AND EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.user_id = p_owner AND i.status = 'paid')
    AND coalesce(j.completed_at, j.created_at) >= p_end - interval '365 days' AND coalesce(j.completed_at, j.created_at) < p_end;

  SELECT jsonb_build_object('events', count(*), 'recovered', count(*) FILTER (WHERE r.status = 'recovered'),
           'recovered_cents', coalesce(sum(r.recovered_amount_cents) FILTER (WHERE r.status = 'recovered'), 0)::bigint)
  INTO v_rec
  FROM revenue_recovery_events r
  WHERE r.user_id = p_owner AND r.source_type IN ('missed_call','voicemail') AND r.occurred_at >= p_start AND r.occurred_at < p_end;

  RETURN jsonb_build_object('calls', v_calls, 'ai_jobs', v_jobs, 'history', v_hist, 'recovery', v_rec,
                            'jobs_truncated', jsonb_array_length(v_jobs) >= 2000);
END; $$;
REVOKE ALL ON FUNCTION public.ai_roi_inputs_core(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_roi_inputs_core(uuid, timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_ai_roi_inputs(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  -- Owner only: these are billing figures, and team members without can_view_billing must not see them.
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN RAISE EXCEPTION 'owner only' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;
  RETURN public.ai_roi_inputs_core(v_owner, p_start, p_end);
END; $$;
REVOKE ALL ON FUNCTION public.tenant_ai_roi_inputs(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_ai_roi_inputs(timestamptz, timestamptz) TO authenticated;
