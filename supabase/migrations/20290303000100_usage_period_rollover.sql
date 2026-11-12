/*
  # Monthly usage rollover (idempotent, recompute-based)

  ## Why
  profiles.minutes_used_this_month has NO automated reset in this repo (see 20260927000000_call_usage_metering.sql).
  Without one, an alert ledger keyed by calendar month would re-alert every account each month.

  ## What
  - usage_period_rollovers: one row per UTC month that has been rolled over (primary key = period_key).
  - rollover_usage_period(): once per month, RECOMPUTES every owner's counter from the calls table for the current
    UTC month (sum of ceil(usage_billed_seconds / 60)) instead of blindly zeroing it. Running it twice, or on top of
    another reset job, can therefore never lose usage.
  - This migration seeds the CURRENT month as already rolled over, so deploying it changes no data. The first real
    rollover happens at the start of next month.

  ## Scheduling (run once in the SQL editor; see docs/USAGE_ALERTS.md). If you already run a monthly reset job, you
  may keep it: both are safe together.
    select cron.schedule('usage-period-rollover', '5 0 1 * *', $$ select public.rollover_usage_period(); $$);

  ## Rollback
    DROP FUNCTION IF EXISTS public.rollover_usage_period(timestamptz);
    DROP TABLE IF EXISTS public.usage_period_rollovers;
*/

CREATE TABLE IF NOT EXISTS public.usage_period_rollovers (
  period_key       text PRIMARY KEY CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ran_at           timestamptz NOT NULL DEFAULT now(),
  accounts_updated integer NOT NULL DEFAULT 0
);

ALTER TABLE public.usage_period_rollovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.usage_period_rollovers FROM anon, authenticated;
-- No policies: service role / SECURITY DEFINER only.

CREATE OR REPLACE FUNCTION public.rollover_usage_period(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   text := to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM');
  v_start timestamptz := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_end   timestamptz := (date_trunc('month', p_now AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
  v_count integer;
BEGIN
  -- Only the first caller for a given month proceeds.
  INSERT INTO public.usage_period_rollovers (period_key) VALUES (v_key)
  ON CONFLICT (period_key) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  UPDATE public.profiles p
     SET minutes_used_this_month = COALESCE(c.minutes, 0)
    FROM (
      SELECT pr.id AS user_id,
             (SELECT COALESCE(SUM(CEIL(cl.usage_billed_seconds / 60.0)), 0)::int
                FROM public.calls cl
               WHERE cl.user_id = pr.id
                 AND cl.call_datetime >= v_start
                 AND cl.call_datetime <  v_end) AS minutes
        FROM public.profiles pr
    ) c
   WHERE c.user_id = p.id
     AND p.minutes_used_this_month IS DISTINCT FROM COALESCE(c.minutes, 0);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.usage_period_rollovers SET accounts_updated = v_count WHERE period_key = v_key;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rollover_usage_period(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollover_usage_period(timestamptz) TO service_role;

-- Baseline: treat the month this migration is applied in as already rolled over (no data change).
INSERT INTO public.usage_period_rollovers (period_key, accounts_updated)
VALUES (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 0)
ON CONFLICT (period_key) DO NOTHING;
