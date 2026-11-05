/*
  # Unit economics: usage events, audit trail, margin extras (staff-only)

  - cost_usage_events        : metered usage quantities (SMS segments, storage, embeddings, vision...). Written by edge
                               functions (service role) only. Cost = quantity x provider_cost_rates (an ESTIMATE).
  - unit_economics_audit     : who changed which rate / limit / invoice, with before/after JSON (trigger-written).
  - staff_usage_events_summary(p_start,p_end) : staff-only totals per component/unit.
  - staff_margin_extras(p_start,p_end)        : staff-only signup cohorts + AI cost per task (feature).

  Requires 20281101000000 and 20281102000000. Rollback: drop the triggers, function, tables and the two RPCs created here.
*/

CREATE TABLE IF NOT EXISTS public.cost_usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  component   text NOT NULL CHECK (component IN ('sms_segment','recording_storage','transcription','embeddings','vision')),
  quantity    numeric(18,4) NOT NULL CHECK (quantity >= 0),
  unit        text NOT NULL CHECK (unit IN ('per_segment','per_gb_month','per_minute','per_1m_input_tokens','per_image','per_event')),
  source      text NOT NULL CHECK (length(btrim(source)) > 0),
  ref         text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, ref)
);
CREATE INDEX IF NOT EXISTS idx_cost_usage_events_user_time ON public.cost_usage_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_usage_events_component_time ON public.cost_usage_events (component, occurred_at DESC);
ALTER TABLE public.cost_usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_usage_events_staff_select ON public.cost_usage_events;
CREATE POLICY cost_usage_events_staff_select ON public.cost_usage_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON public.cost_usage_events FROM anon;

CREATE TABLE IF NOT EXISTS public.unit_economics_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_key    text,
  action     text NOT NULL,
  old_row    jsonb,
  new_row    jsonb,
  actor      uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.unit_economics_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unit_economics_audit_staff_select ON public.unit_economics_audit;
CREATE POLICY unit_economics_audit_staff_select ON public.unit_economics_audit
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON public.unit_economics_audit FROM anon;

CREATE OR REPLACE FUNCTION public.log_unit_economics_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb;
BEGIN
  r := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  INSERT INTO public.unit_economics_audit (table_name, row_key, action, old_row, new_row, actor)
  VALUES (
    TG_TABLE_NAME,
    coalesce(r->>'id', r->>'plan'),
    TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    auth.uid()
  );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.log_unit_economics_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_provider_cost_rates ON public.provider_cost_rates;
CREATE TRIGGER trg_audit_provider_cost_rates AFTER INSERT OR UPDATE OR DELETE ON public.provider_cost_rates
  FOR EACH ROW EXECUTE FUNCTION public.log_unit_economics_change();
DROP TRIGGER IF EXISTS trg_audit_plan_cost_limits ON public.plan_cost_limits;
CREATE TRIGGER trg_audit_plan_cost_limits AFTER INSERT OR UPDATE OR DELETE ON public.plan_cost_limits
  FOR EACH ROW EXECUTE FUNCTION public.log_unit_economics_change();
DROP TRIGGER IF EXISTS trg_audit_provider_invoices ON public.provider_invoices;
CREATE TRIGGER trg_audit_provider_invoices AFTER INSERT OR UPDATE OR DELETE ON public.provider_invoices
  FOR EACH ROW EXECUTE FUNCTION public.log_unit_economics_change();

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
      SELECT component, unit, sum(quantity)::float8 AS quantity, count(*)::bigint AS events
      FROM cost_usage_events
      WHERE occurred_at >= p_start AND occurred_at < p_end
      GROUP BY component, unit
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_usage_events_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_usage_events_summary(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_margin_extras(p_start timestamptz, p_end timestamptz)
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
  RETURN jsonb_build_object(
    'cohorts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'account_id', p.id,
               'signup_month', to_char(date_trunc('month', p.created_at AT TIME ZONE 'UTC'), 'YYYY-MM')))
      FROM (SELECT id, created_at FROM profiles WHERE role = 'owner' AND NOT coalesce(is_staff, false) LIMIT 5000) p
    ), '[]'::jsonb),
    'features', coalesce((
      SELECT jsonb_agg(x ORDER BY x.cost_usd DESC) FROM (
        SELECT task, sum(cost_usd)::float8 AS cost_usd, count(*)::bigint AS calls
        FROM ai_usage_logs WHERE created_at >= p_start AND created_at < p_end
        GROUP BY task ORDER BY sum(cost_usd) DESC LIMIT 50
      ) x
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_margin_extras(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_margin_extras(timestamptz, timestamptz) TO authenticated;
