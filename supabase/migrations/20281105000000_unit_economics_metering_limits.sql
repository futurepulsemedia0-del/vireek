/*
  # Unit economics: token-based metering, estimated flag, plan cost limit lookup, storage snapshot

  - cost_usage_events: allow raw token units (input_tokens / output_tokens) and add quantity_estimated
    (true = counted by us, false = reported by the provider).
  - tenant_month_cost_total(p_user, p_month_start): service-role only. Provider-reported voice cost + logged AI cost for one
    tenant and month. Used by ai-core to pause OPTIONAL AI tasks when plan_cost_limits.hard_cost_usd is reached.
  - staff_usage_events_summary: now also returns estimated_events.
  - staff_storage_summary(): staff-only snapshot of recording/audio bucket sizes (a stock, not a monthly flow).

  Requires 20281101000000 .. 20281104000000.
  Rollback: restore the previous unit check, DROP COLUMN quantity_estimated, DROP FUNCTION tenant_month_cost_total / staff_storage_summary.
*/

ALTER TABLE public.cost_usage_events DROP CONSTRAINT IF EXISTS cost_usage_events_unit_check;
ALTER TABLE public.cost_usage_events ADD CONSTRAINT cost_usage_events_unit_check CHECK (unit IN (
  'per_segment','per_gb_month','per_minute','per_1m_input_tokens','per_image','per_event','input_tokens','output_tokens'));
ALTER TABLE public.cost_usage_events ADD COLUMN IF NOT EXISTS quantity_estimated boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.tenant_month_cost_total(p_user uuid, p_month_start timestamptz)
RETURNS float8
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce((
      SELECT sum(cc.amount_usd)
      FROM calls c
      JOIN call_cost_components cc ON cc.vapi_call_id = c.vapi_call_id AND cc.basis = 'provider_reported'
      WHERE c.user_id = p_user AND c.call_datetime >= p_month_start AND c.call_datetime < p_month_start + interval '1 month'
    ), 0)::float8
    + coalesce((
      SELECT sum(cost_usd)
      FROM ai_usage_logs
      WHERE account_id = p_user AND created_at >= p_month_start AND created_at < p_month_start + interval '1 month'
    ), 0)::float8;
$$;
REVOKE ALL ON FUNCTION public.tenant_month_cost_total(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_month_cost_total(uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.staff_usage_events_summary(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x ORDER BY x.component, x.unit) FROM (
      SELECT component, unit, sum(quantity)::float8 AS quantity, count(*)::bigint AS events,
             (count(*) FILTER (WHERE quantity_estimated))::bigint AS estimated_events
      FROM cost_usage_events
      WHERE occurred_at >= p_start AND occurred_at < p_end
      GROUP BY component, unit
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_usage_events_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_usage_events_summary(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_storage_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x ORDER BY x.bytes DESC) FROM (
      SELECT bucket_id,
             sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END)::float8 AS bytes,
             count(*)::bigint AS objects
      FROM storage.objects
      WHERE bucket_id ~* '(record|audio|voicemail)'
      GROUP BY bucket_id
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_storage_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_storage_summary() TO authenticated;
