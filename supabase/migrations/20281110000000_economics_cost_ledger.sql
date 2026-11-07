/*
  # Economics: append-only cost ledger (integer micro-USD), correlation ids, reconciliation RPCs (staff-only)

  Design (extends the 20281101..20281105 unit-economics layer, does not replace it):
  - provider_cost_rates stays THE versioned price table (effective_from/effective_to). The ledger stores rate_id +
    a unit_price_usd snapshot, so changing a price never rewrites history.
  - cost_ledger: append-only. Corrections are NEW rows (kind='correction', may be negative), never UPDATE/DELETE.
  - Tenant column is `account_id` (NOT `user_id`) on purpose: erase_user_rows() deletes from every table that has a
    uuid user_id column; an append-only financial ledger must not be hit by that sweep (it would be reported as
    `blocked`). account_id carries no FK for the same reason. Counsel decides retention (see risks in the report).
  - Cost is measured (basis provider_reported/invoiced) or estimated (basis estimated). Assumed shared/fixed costs are
    NEVER written here; they live outside the ledger so nothing assumed is ever labeled "measured".

  Requires 20281101000000 .. 20281105000000 (provider_cost_rates, provider_invoices, call_cost_components).
  NOT EXECUTED in authoring (no Postgres available): run on a staging copy first.
  Rollback: DROP FUNCTION staff_cost_per_call, staff_ledger_coverage, staff_cost_reconciliation, post_cost_correction;
            DROP TABLE cost_ledger; DROP FUNCTION cost_ledger_block_mutation();
*/

CREATE TABLE IF NOT EXISTS public.cost_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid,
  provider             text NOT NULL CHECK (length(btrim(provider)) > 0),
  resource_type        text NOT NULL CHECK (resource_type IN (
    'llm_tokens','voice_minutes','stt','tts','sms_segments','telephony','maps','storage','other_api')),
  component            text,
  quantity             numeric(18,4) CHECK (quantity IS NULL OR quantity >= 0),
  unit                 text,
  unit_price_usd       numeric(18,8) CHECK (unit_price_usd IS NULL OR unit_price_usd >= 0),
  rate_id              uuid REFERENCES public.provider_cost_rates(id) ON DELETE RESTRICT,
  price_effective_from date,
  cost_micro           bigint NOT NULL,
  basis                text NOT NULL CHECK (basis IN ('estimated','provider_reported','invoiced')),
  kind                 text NOT NULL DEFAULT 'usage' CHECK (kind IN ('usage','correction','backfill')),
  corrects_id          uuid REFERENCES public.cost_ledger(id),
  reason               text,
  posted_by            uuid,
  call_id              text,
  job_id               uuid,
  workflow_run_id      uuid,
  agent_action_log_id  uuid,
  task_type            text,
  source               text NOT NULL CHECK (length(btrim(source)) > 0),
  ref                  text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'correction' OR cost_micro >= 0),
  CHECK (kind <> 'correction' OR (reason IS NOT NULL AND length(btrim(reason)) >= 10))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_ledger_source_ref ON public.cost_ledger (source, ref); -- non-partial: PostgREST onConflict=source,ref needs a plain unique index (NULL refs stay distinct)
CREATE INDEX IF NOT EXISTS idx_cost_ledger_account_time ON public.cost_ledger (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_call ON public.cost_ledger (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_provider_time ON public.cost_ledger (lower(provider), occurred_at);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_task_time ON public.cost_ledger (task_type, occurred_at) WHERE task_type IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cost_ledger_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cost_ledger is append-only: post an offsetting correction instead' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_cost_ledger_immutable_row ON public.cost_ledger;
CREATE TRIGGER trg_cost_ledger_immutable_row BEFORE UPDATE OR DELETE ON public.cost_ledger
  FOR EACH ROW EXECUTE FUNCTION public.cost_ledger_block_mutation();
DROP TRIGGER IF EXISTS trg_cost_ledger_immutable_truncate ON public.cost_ledger;
CREATE TRIGGER trg_cost_ledger_immutable_truncate BEFORE TRUNCATE ON public.cost_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.cost_ledger_block_mutation();

ALTER TABLE public.cost_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_ledger_staff_select ON public.cost_ledger;
CREATE POLICY cost_ledger_staff_select ON public.cost_ledger
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
-- No client write policy: only the service role (edge functions) inserts; corrections go through post_cost_correction().
REVOKE ALL ON public.cost_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cost_ledger FROM authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- One-time backfill of history. Rows are marked kind='backfill' (never presented as live-metered).
-- Only rows BEFORE this migration runs are copied, so a gap before the writers are deployed shows up as missing
-- (visible in coverage), never as double counting. Idempotent via (source, ref).
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO public.cost_ledger (account_id, provider, resource_type, component, cost_micro, basis, kind, call_id, source, ref, occurred_at)
SELECT cc.user_id, 'vapi',
       CASE WHEN cc.component = 'asr' THEN 'stt'
            WHEN cc.component = 'tts' THEN 'tts'
            WHEN cc.component = 'llm' THEN 'llm_tokens'
            WHEN cc.component = 'voice_platform' THEN 'voice_minutes'
            WHEN cc.component LIKE 'carrier_%' THEN 'telephony'
            ELSE 'other_api' END,
       cc.component, round(cc.amount_usd * 1000000)::bigint, cc.basis, 'backfill', cc.vapi_call_id,
       'backfill:call_cost_components', cc.id::text, cc.created_at
FROM public.call_cost_components cc
WHERE cc.created_at < now()
ON CONFLICT (source, ref) DO NOTHING;

INSERT INTO public.cost_ledger (account_id, provider, resource_type, component, quantity, unit, cost_micro, basis, kind, task_type, source, ref, occurred_at)
SELECT a.account_id, a.provider, 'llm_tokens', 'llm', (a.input_tokens + a.output_tokens), 'tokens',
       round(a.cost_usd * 1000000)::bigint, 'estimated', 'backfill', a.task,
       'backfill:ai_usage_logs', a.id::text, a.created_at
FROM public.ai_usage_logs a
WHERE a.ok AND a.cost_usd > 0 AND a.created_at < now()
ON CONFLICT (source, ref) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- Staff-only RPCs (same guard pattern as staff_unit_economics)
-- ---------------------------------------------------------------------------------------------------------------

-- Offsetting correction. Never edits history. Idempotent on p_ref.
CREATE OR REPLACE FUNCTION public.post_cost_correction(
  p_provider text, p_month date, p_delta_micro bigint, p_reason text, p_ref text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR length(btrim(p_provider)) = 0 OR p_ref IS NULL OR length(btrim(p_ref)) = 0
     OR p_month IS NULL OR p_month <> date_trunc('month', p_month)::date
     OR p_delta_micro IS NULL OR p_delta_micro = 0
     OR p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'invalid correction' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.cost_ledger (provider, resource_type, component, cost_micro, basis, kind, reason, posted_by, source, ref, occurred_at)
  VALUES (lower(btrim(p_provider)), 'other_api', 'reconciliation', p_delta_micro, 'invoiced', 'correction',
          btrim(p_reason), auth.uid(), 'reconciliation', p_ref, p_month::timestamptz)
  ON CONFLICT (source, ref) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.cost_ledger WHERE source = 'reconciliation' AND ref = p_ref;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.post_cost_correction(text, date, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_cost_correction(text, date, bigint, text, text) TO authenticated;

-- Ledger vs entered provider invoices, per provider for one month. Variance is reported, never auto-corrected.
CREATE OR REPLACE FUNCTION public.staff_cost_reconciliation(p_month date)
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
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'p_month must be the first day of a month' USING ERRCODE = '22023';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x ORDER BY x.provider) FROM (
      WITH l AS (
        SELECT lower(provider) AS provider, sum(cost_micro)::bigint AS ledger_micro, count(*)::bigint AS events
        FROM cost_ledger
        WHERE occurred_at >= p_month::timestamptz AND occurred_at < (p_month + interval '1 month')::timestamptz
        GROUP BY lower(provider)
      ), i AS (
        SELECT lower(provider) AS provider, round(sum(invoiced_usd) * 1000000)::bigint AS invoiced_micro
        FROM provider_invoices WHERE period_month = p_month GROUP BY lower(provider)
      )
      SELECT coalesce(l.provider, i.provider) AS provider,
             l.ledger_micro, l.events, i.invoiced_micro,
             CASE WHEN l.ledger_micro IS NOT NULL AND i.invoiced_micro IS NOT NULL THEN l.ledger_micro - i.invoiced_micro END AS variance_micro,
             CASE WHEN l.ledger_micro IS NOT NULL AND i.invoiced_micro > 0
                  THEN round(((l.ledger_micro - i.invoiced_micro)::numeric / i.invoiced_micro) * 100, 2) END AS variance_pct,
             CASE WHEN i.invoiced_micro IS NULL THEN 'no_invoice'
                  WHEN l.ledger_micro IS NULL THEN 'no_ledger'
                  WHEN l.ledger_micro = i.invoiced_micro THEN 'match'
                  WHEN i.invoiced_micro > 0 AND abs((l.ledger_micro - i.invoiced_micro)::numeric / i.invoiced_micro) <= 0.05 THEN 'within_tolerance'
                  ELSE 'over_threshold' END AS status
      FROM l FULL JOIN i ON i.provider = l.provider
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cost_reconciliation(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cost_reconciliation(date) TO authenticated;

-- % of usage events that carry at least one correlation id (call / job / workflow run / agent action log).
CREATE OR REPLACE FUNCTION public.staff_ledger_coverage(p_start timestamptz, p_end timestamptz)
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
    SELECT jsonb_agg(x ORDER BY x.resource_type) FROM (
      SELECT resource_type,
             count(*)::bigint AS events,
             (count(*) FILTER (WHERE call_id IS NOT NULL OR job_id IS NOT NULL OR workflow_run_id IS NOT NULL OR agent_action_log_id IS NOT NULL))::bigint AS with_correlation,
             (count(*) FILTER (WHERE account_id IS NOT NULL))::bigint AS with_tenant,
             sum(cost_micro)::bigint AS cost_micro
      FROM cost_ledger
      WHERE occurred_at >= p_start AND occurred_at < p_end AND kind <> 'correction'
      GROUP BY resource_type
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_ledger_coverage(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_ledger_coverage(timestamptz, timestamptz) TO authenticated;

-- Cost per handled call from the ledger, with sample sizes, basis mix and a volume-bucket view (does cost/call fall with scale?).
-- "handled call" = a row in calls inside the window. Calls with no ledger cost are counted and reported, not silently dropped.
CREATE OR REPLACE FUNCTION public.staff_cost_per_call(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;

  WITH w AS (
    SELECT c.user_id AS account_id, c.vapi_call_id
    FROM calls c
    WHERE c.call_datetime >= p_start AND c.call_datetime < p_end AND c.vapi_call_id IS NOT NULL
  ),
  cost AS (
    SELECT l.call_id, sum(l.cost_micro)::bigint AS micro,
           sum(l.cost_micro) FILTER (WHERE l.basis = 'estimated')::bigint AS micro_estimated
    FROM cost_ledger l
    WHERE l.call_id IN (SELECT vapi_call_id FROM w)
    GROUP BY l.call_id
  ),
  per_call AS (
    SELECT w.account_id, w.vapi_call_id, coalesce(c.micro, 0) AS micro, c.call_id IS NOT NULL AS has_cost
    FROM w LEFT JOIN cost c ON c.call_id = w.vapi_call_id
  ),
  tenant AS (
    SELECT account_id, count(*) AS calls, sum(micro) AS micro FROM per_call WHERE has_cost GROUP BY account_id
  ),
  bucketed AS (
    SELECT CASE WHEN calls < 50 THEN '1-49' WHEN calls < 200 THEN '50-199' WHEN calls < 1000 THEN '200-999' ELSE '1000+' END AS bucket,
           calls, micro
    FROM tenant
  )
  SELECT jsonb_build_object(
    'calls_total', (SELECT count(*) FROM w),
    'calls_with_cost', (SELECT count(*) FROM per_call WHERE has_cost),
    'calls_without_cost', (SELECT count(*) FROM per_call WHERE NOT has_cost),
    'total_micro', coalesce((SELECT sum(micro) FROM per_call), 0),
    'estimated_micro', coalesce((SELECT sum(micro_estimated) FROM cost), 0),
    'micro_per_call_with_cost', (SELECT CASE WHEN count(*) FILTER (WHERE has_cost) > 0 THEN round(sum(micro)::numeric / count(*) FILTER (WHERE has_cost)) END FROM per_call),
    'volume_buckets', coalesce((
      SELECT jsonb_agg(jsonb_build_object('bucket', b.bucket, 'tenants', b.tenants, 'calls', b.calls,
                                          'micro_per_call', CASE WHEN b.calls > 0 THEN round(b.micro::numeric / b.calls) END)
                       ORDER BY b.bucket)
      FROM (SELECT bucket, count(*) AS tenants, sum(calls) AS calls, sum(micro) AS micro FROM bucketed GROUP BY bucket) b
    ), '[]'::jsonb),
    'notes', jsonb_build_array(
      'Per-booking / per-workflow / per-paid-invoice cost requires a verified call->job link; not computed here.',
      'Excludes unpriced usage (no rate row) and costs without a call_id.')
  ) INTO v;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cost_per_call(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cost_per_call(timestamptz, timestamptz) TO authenticated;
