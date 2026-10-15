/*
  # Staff usage & margin report (/staff/usage)

  ## What this adds (read-only; no table, column, policy or trigger is changed)
  - public.staff_usage_report(p_start, p_end): ONE SECURITY DEFINER function that returns, as jsonb, the
    cross-tenant cost picture a Vireek employee needs:
      tenants   : per account owner — plan, AI cost/tokens/calls/failures/fallbacks (ai_usage_logs) and
                  voice seconds/calls (calls.duration_seconds). Tenants with zero usage are included
                  (they still pay, which is part of the margin picture).
      daily     : per UTC day — AI cost, AI calls, voice seconds.
      providers : per provider/model — cost, calls, tokens, failures, fallbacks.
      tasks     : per AI task — cost, calls.
      unattributed_cost_usd : ai_usage_logs rows with no account (platform-internal / deleted accounts).
      truncated : true when more than 5000 tenants matched (the 5000 costliest are returned).

  ## Security
  - Callable only by authenticated users whose profiles.is_staff is true (is_vireek_staff). Everyone else
    gets an exception — tenants can never read other tenants' cost data through this.
  - anon has no EXECUTE.
  - The window is capped at 400 days so a single call cannot scan the whole table.

  ## Cost model note
  AI cost = ai_usage_logs.cost_usd, an ESTIMATE from list prices (see _shared/ai-core/costTracking.ts).
  Voice cost is NOT stored, so the report returns raw seconds and the page applies an editable
  $/minute assumption. Revenue is estimated from the plan's list price on the client.

  ## Requires (already in your project)
  profiles (is_staff, email, company_name, plan, role), public.is_vireek_staff(uuid),
  ai_usage_logs (account_id, cost_usd, ...), calls (user_id, duration_seconds, call_datetime).
*/

CREATE INDEX IF NOT EXISTS idx_calls_user_datetime ON calls (user_id, call_datetime DESC);
CREATE INDEX IF NOT EXISTS ai_usage_logs_created_idx ON public.ai_usage_logs (created_at DESC);

CREATE OR REPLACE FUNCTION public.staff_usage_report(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'window too large (max 400 days)' USING ERRCODE = '22023';
  END IF;

  WITH ai AS (
    SELECT account_id,
           sum(cost_usd)::float8                              AS ai_cost_usd,
           count(*)                                           AS ai_calls,
           count(*) FILTER (WHERE NOT ok)                     AS ai_failed,
           count(*) FILTER (WHERE was_fallback)               AS ai_fallbacks,
           coalesce(sum(input_tokens), 0)::bigint             AS input_tokens,
           coalesce(sum(output_tokens), 0)::bigint            AS output_tokens
    FROM ai_usage_logs
    WHERE created_at >= p_start AND created_at < p_end AND account_id IS NOT NULL
    GROUP BY account_id
  ),
  voice AS (
    SELECT user_id,
           coalesce(sum(duration_seconds), 0)::bigint AS voice_seconds,
           count(*)                                    AS voice_calls
    FROM calls
    WHERE call_datetime >= p_start AND call_datetime < p_end
    GROUP BY user_id
  ),
  tenants AS (
    SELECT p.id AS account_id, p.email, p.company_name, p.plan,
           coalesce(ai.ai_cost_usd, 0) AS ai_cost_usd,
           coalesce(ai.ai_calls, 0) AS ai_calls,
           coalesce(ai.ai_failed, 0) AS ai_failed,
           coalesce(ai.ai_fallbacks, 0) AS ai_fallbacks,
           coalesce(ai.input_tokens, 0) AS input_tokens,
           coalesce(ai.output_tokens, 0) AS output_tokens,
           coalesce(v.voice_seconds, 0) AS voice_seconds,
           coalesce(v.voice_calls, 0) AS voice_calls
    FROM profiles p
    LEFT JOIN ai ON ai.account_id = p.id
    LEFT JOIN voice v ON v.user_id = p.id
    WHERE p.role = 'owner' AND NOT coalesce(p.is_staff, false)
  ),
  ranked AS (
    SELECT * FROM tenants ORDER BY ai_cost_usd DESC, voice_seconds DESC, account_id LIMIT 5000
  )
  SELECT
    jsonb_build_object(
      'tenants', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM ranked r), '[]'::jsonb),
      'daily', coalesce((
        SELECT jsonb_agg(d ORDER BY d.day) FROM (
          SELECT to_char(day, 'YYYY-MM-DD') AS day,
                 sum(ai_cost_usd)::float8 AS ai_cost_usd,
                 sum(ai_calls)::bigint AS ai_calls,
                 sum(voice_seconds)::bigint AS voice_seconds
          FROM (
            SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
                   sum(cost_usd) AS ai_cost_usd, count(*) AS ai_calls, 0::bigint AS voice_seconds
            FROM ai_usage_logs WHERE created_at >= p_start AND created_at < p_end
            GROUP BY 1
            UNION ALL
            SELECT date_trunc('day', call_datetime AT TIME ZONE 'UTC'),
                   0, 0, coalesce(sum(duration_seconds), 0)::bigint
            FROM calls WHERE call_datetime >= p_start AND call_datetime < p_end
            GROUP BY 1
          ) u GROUP BY day
        ) d
      ), '[]'::jsonb),
      'providers', coalesce((
        SELECT jsonb_agg(x ORDER BY x.cost_usd DESC) FROM (
          SELECT provider, model, sum(cost_usd)::float8 AS cost_usd, count(*) AS calls,
                 coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
                 coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
                 count(*) FILTER (WHERE NOT ok) AS failed,
                 count(*) FILTER (WHERE was_fallback) AS fallbacks
          FROM ai_usage_logs WHERE created_at >= p_start AND created_at < p_end
          GROUP BY provider, model ORDER BY sum(cost_usd) DESC LIMIT 50
        ) x
      ), '[]'::jsonb),
      'tasks', coalesce((
        SELECT jsonb_agg(x ORDER BY x.cost_usd DESC) FROM (
          SELECT task, sum(cost_usd)::float8 AS cost_usd, count(*) AS calls
          FROM ai_usage_logs WHERE created_at >= p_start AND created_at < p_end
          GROUP BY task ORDER BY sum(cost_usd) DESC LIMIT 50
        ) x
      ), '[]'::jsonb),
      'unattributed_cost_usd', coalesce((
        SELECT sum(cost_usd)::float8 FROM ai_usage_logs
        WHERE created_at >= p_start AND created_at < p_end AND account_id IS NULL
      ), 0),
      'truncated', (SELECT count(*) FROM tenants) > 5000
    )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_usage_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_usage_report(timestamptz, timestamptz) TO authenticated;
