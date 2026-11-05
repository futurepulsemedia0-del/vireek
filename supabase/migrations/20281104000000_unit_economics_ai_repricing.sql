/*
  # Unit economics: AI usage breakdown for re-pricing (staff-only)

  staff_ai_usage_breakdown(p_start,p_end) returns ai_usage_logs aggregated per (account, provider, model) with token
  counts, so the margin dashboard can re-price AI usage from staff-entered provider_cost_rates instead of the prices
  hard-coded in costTracking.ts (which prices Cloudflare Workers AI at $0). Read-only; no data is changed.

  Requires 20281101000000 and 20281102000000. Rollback: DROP FUNCTION public.staff_ai_usage_breakdown(timestamptz, timestamptz);
*/

CREATE OR REPLACE FUNCTION public.staff_ai_usage_breakdown(p_start timestamptz, p_end timestamptz)
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

  RETURN (
    WITH g AS (
      SELECT account_id, provider, model,
             sum(input_tokens)::bigint  AS input_tokens,
             sum(output_tokens)::bigint AS output_tokens,
             count(*)::bigint           AS calls,
             (count(*) FILTER (WHERE tokens_estimated))::bigint AS estimated_calls,
             sum(cost_usd)::float8      AS logged_cost_usd
      FROM ai_usage_logs
      WHERE created_at >= p_start AND created_at < p_end
      GROUP BY account_id, provider, model
    ),
    lim AS (
      SELECT * FROM g ORDER BY logged_cost_usd DESC, calls DESC, provider, model LIMIT 20000
    )
    SELECT jsonb_build_object(
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(lim)) FROM lim), '[]'::jsonb),
      'truncated', (SELECT count(*) FROM g) > 20000
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_ai_usage_breakdown(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_ai_usage_breakdown(timestamptz, timestamptz) TO authenticated;
