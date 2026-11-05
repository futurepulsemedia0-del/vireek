/*
  # Causal Dispatch Loop — Phase 0: indifference-set feasibility (READ-ONLY)

  Adds ONE read-only function. No table, column, policy or trigger is created or changed,
  so dispatch behaviour is untouched.

  public.dispatch_indifference_feasibility(p_delta, p_days, p_modes)
    For the caller's account, over the last p_days days of dispatch_decisions, counts how many
    decisions had >= 2 eligible technicians (every `require` rule passed) scoring within p_delta
    points of the top eligible technician, and returns the set-size distribution.

  Limits (also returned in the payload so nobody over-reads the number):
    - Score criterion only. FTF probability / duration upper bound are not stored per decision, so
      this is an UPPER BOUND on the full definition: adding those checks can only shrink the sets.
      If the share is already < 10% here, the idea is not viable.
    - Reads dispatch_decisions.explanation->'candidates' (top 5 candidates, written by
      snapshotForAudit()). Set sizes are therefore capped at 5.
    - Reads columns through to_jsonb(row) so the function still runs (and reports
      decisions_with_candidate_list = 0) if the live table is the older dispatch_intelligence
      shape that has no `mode` / `explanation` columns.

  Security: SECURITY INVOKER (RLS on dispatch_decisions applies) plus an explicit
  user_id = get_account_owner_id() filter. Executable by authenticated only.

  Rollback: DROP FUNCTION public.dispatch_indifference_feasibility(numeric, integer, text[]);
*/

CREATE OR REPLACE FUNCTION public.dispatch_indifference_feasibility(
  p_delta numeric DEFAULT 3,
  p_days integer DEFAULT 90,
  p_modes text[] DEFAULT ARRAY['auto']
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_with_list integer;
  v_dist jsonb;
  v_with_eligible integer;
  v_qualifying integer;
BEGIN
  IF p_delta IS NULL OR p_delta < 0 OR p_delta > 100 THEN
    RAISE EXCEPTION 'p_delta must be between 0 and 100';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 365';
  END IF;

  WITH base AS (
    SELECT d.id, to_jsonb(d) AS j
    FROM public.dispatch_decisions d
    WHERE d.user_id = public.get_account_owner_id()
      AND d.created_at >= now() - make_interval(days => p_days)
  ),
  scoped AS (
    SELECT id,
           CASE WHEN jsonb_typeof(j #> '{explanation,candidates}') = 'array'
                THEN j #> '{explanation,candidates}' ELSE '[]'::jsonb END AS cands
    FROM base
    WHERE (j ->> 'mode') = ANY (p_modes)
  ),
  listed AS (
    SELECT id, cands FROM scoped WHERE jsonb_array_length(cands) > 0
  ),
  elig AS (
    SELECT l.id, (c ->> 'score')::numeric AS score
    FROM listed l
    CROSS JOIN LATERAL jsonb_array_elements(l.cands) AS c
    WHERE c -> 'eligible' = 'true'::jsonb
      AND (c ->> 'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
  ),
  tops AS (
    SELECT id, max(score) AS top_score FROM elig GROUP BY id
  ),
  sizes AS (
    -- the top itself satisfies score >= top - delta, so size >= 1 whenever anyone is eligible
    SELECT e.id, count(*)::integer AS set_size
    FROM elig e JOIN tops t USING (id)
    WHERE e.score >= t.top_score - p_delta
    GROUP BY e.id
  ),
  per_decision AS (
    SELECT l.id, COALESCE(s.set_size, 0) AS set_size
    FROM listed l LEFT JOIN sizes s USING (id)
  ),
  dist AS (
    SELECT set_size, count(*)::integer AS n FROM per_decision GROUP BY set_size
  )
  SELECT
    (SELECT count(*)::integer FROM base),
    (SELECT count(*)::integer FROM listed),
    COALESCE((SELECT jsonb_object_agg(set_size::text, n ORDER BY set_size) FROM dist), '{}'::jsonb),
    (SELECT count(*)::integer FROM per_decision WHERE set_size >= 1),
    (SELECT count(*)::integer FROM per_decision WHERE set_size >= 2)
  INTO v_total, v_with_list, v_dist, v_with_eligible, v_qualifying;

  RETURN jsonb_build_object(
    'delta', p_delta,
    'days', p_days,
    'modes', to_jsonb(p_modes),
    'decisions_total', v_total,
    'decisions_with_candidate_list', v_with_list,
    'decisions_with_eligible', v_with_eligible,
    'size_distribution', v_dist,
    'qualifying', v_qualifying,
    'qualifying_pct', CASE WHEN v_with_eligible > 0 THEN round(100.0 * v_qualifying / v_with_eligible, 1) ELSE NULL END,
    'viable', CASE WHEN v_with_eligible > 0 THEN (v_qualifying::numeric / v_with_eligible) >= 0.10 ELSE NULL END,
    'criterion', 'score_only_upper_bound',
    'set_size_capped_at', 5
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_indifference_feasibility(numeric, integer, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_indifference_feasibility(numeric, integer, text[]) TO authenticated;
