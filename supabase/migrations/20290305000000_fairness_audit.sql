/*
  # Fairness audit — staff-only aggregated outcome data

  ## Why
  The AI reviewer scores every call (ai_quality_reviews). Nobody could check whether outcomes differ
  systematically by detected language, by the region of the caller's number or by customer type.
  This adds ONE read-only function that returns aggregated cells for those three stratifiers.
  The statistics, thresholds and suppression live in supabase/functions/_shared/fairness/audit.ts,
  so the CLI (scripts/fairness/audit.mjs) and the staff page (/staff/fairness-audit) share one engine.

  ## What it does NOT do
  - No new table, no stored copy of call data, nothing is written.
  - Never selects or returns phone numbers, names, transcripts or call ids. Region is only the first
    three digits after "+" (enough for a country calling code), and only for E.164 numbers.
  - Never infers or accepts a protected attribute. The three stratifiers are fixed in this function.

  ## Security
  - SECURITY DEFINER + synthetic_is_operator() (service_role or profiles.is_staff), the same gate as
    staff_reliability_overview(). Everyone else gets SQLSTATE 42501. EXECUTE is revoked from PUBLIC/anon.
  - Cross-tenant by design (staff-only aggregates). Small-cell suppression is applied by the caller.
    [COUNSEL] confirm that aggregated, de-identified use of call QA data for internal fairness
    monitoring is covered by the customer terms / privacy notice before this runs on production data.

  Depends on: calls (detected_language, caller_phone, customer_id), customers (customer_type),
  ai_quality_reviews, ai_quality_findings, synthetic_is_operator().
*/

CREATE OR REPLACE FUNCTION public.staff_fairness_overview(
  p_days integer DEFAULT 90,
  p_low_score integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days  integer := least(greatest(coalesce(p_days, 90), 1), 365);
  v_low   integer := least(greatest(coalesce(p_low_score, 60), 1), 100);
  v_since timestamptz;
  v_cells jsonb;
BEGIN
  IF NOT public.synthetic_is_operator() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_since := now() - make_interval(days => v_days);

  WITH base AS (
    SELECT
      c.user_id,
      coalesce(
        nullif(left(lower(split_part(replace(btrim(coalesce(c.detected_language, '')), '_', '-'), '-', 1)), 8), ''),
        'undetected'
      ) AS lang_code,
      CASE
        WHEN regexp_replace(coalesce(c.caller_phone, ''), '[[:space:]().-]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$'
          THEN substr(regexp_replace(c.caller_phone, '[[:space:]().-]', '', 'g'), 2, 3)
        ELSE 'unknown'
      END AS region_prefix,
      coalesce(cu.customer_type, 'unlinked') AS customer_type,
      (r.ai_status = 'ok' AND r.overall_score IS NOT NULL) AS reviewed,
      r.overall_score,
      coalesce(f.missed_booking, false) AS missed_booking,
      coalesce(f.critical, false) AS critical
    FROM public.calls c
    LEFT JOIN public.customers cu
           ON cu.id = c.customer_id AND cu.user_id = c.user_id
    LEFT JOIN public.ai_quality_reviews r
           ON r.call_id = c.id
    LEFT JOIN LATERAL (
      SELECT bool_or(fi.kind = 'missed_booking') AS missed_booking,
             bool_or(fi.severity = 'critical')   AS critical
        FROM public.ai_quality_findings fi
       WHERE fi.call_id = c.id AND fi.status <> 'dismissed'
    ) f ON true
    WHERE c.call_datetime >= v_since
  )
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    INTO v_cells
    FROM (
      SELECT 'language'::text AS dimension, lang_code AS "group",
             count(*) AS calls,
             count(*) FILTER (WHERE reviewed) AS reviewed,
             count(DISTINCT user_id) AS accounts,
             coalesce(sum(overall_score) FILTER (WHERE reviewed), 0) AS score_sum,
             coalesce(sum(overall_score::bigint * overall_score) FILTER (WHERE reviewed), 0) AS score_sumsq,
             count(*) FILTER (WHERE reviewed AND overall_score < v_low) AS low_score,
             count(*) FILTER (WHERE reviewed AND missed_booking) AS missed_booking,
             count(*) FILTER (WHERE reviewed AND critical) AS critical
        FROM base GROUP BY lang_code
      UNION ALL
      SELECT 'region', region_prefix,
             count(*), count(*) FILTER (WHERE reviewed), count(DISTINCT user_id),
             coalesce(sum(overall_score) FILTER (WHERE reviewed), 0),
             coalesce(sum(overall_score::bigint * overall_score) FILTER (WHERE reviewed), 0),
             count(*) FILTER (WHERE reviewed AND overall_score < v_low),
             count(*) FILTER (WHERE reviewed AND missed_booking),
             count(*) FILTER (WHERE reviewed AND critical)
        FROM base GROUP BY region_prefix
      UNION ALL
      SELECT 'customer_type', customer_type,
             count(*), count(*) FILTER (WHERE reviewed), count(DISTINCT user_id),
             coalesce(sum(overall_score) FILTER (WHERE reviewed), 0),
             coalesce(sum(overall_score::bigint * overall_score) FILTER (WHERE reviewed), 0),
             count(*) FILTER (WHERE reviewed AND overall_score < v_low),
             count(*) FILTER (WHERE reviewed AND missed_booking),
             count(*) FILTER (WHERE reviewed AND critical)
        FROM base GROUP BY customer_type
    ) x;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'low_score_below', v_low,
    'cells', v_cells
  );
END;
$$;

COMMENT ON FUNCTION public.staff_fairness_overview(integer, integer) IS
  'Staff-only aggregated QA outcomes by language, region (calling code) and customer type. No PII, no protected attributes.';

REVOKE ALL ON FUNCTION public.staff_fairness_overview(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_fairness_overview(integer, integer) TO authenticated, service_role;
