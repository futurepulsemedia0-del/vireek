/*
  # North Star metric tree (platform staff ONLY, read-only, additive)

  North Star candidate: KEPT APPOINTMENTS FROM VOICE CALLS, per week.
    A "kept appointment" = a job that (a) is linked (jobs.call_id) to a call that Vireek's voice agent handled
    (calls.vapi_call_id IS NOT NULL), and (b) reached job_status = 'completed'.
    Attribution week = the week of the CALL (UTC, Monday start), not the completion week, so every input metric
    below describes the same cohort of calls and the tree multiplies out:
        kept = calls x booking_rate x (kept / booked)
    Recent cohorts are still maturing (visits not yet happened); `pending_n` says how many jobs are unresolved.

  Definitions live in docs/analytics/north-star.md. This file only computes counts; ratios, the "enough data?"
  decision and all labels live in src/lib/growth/northStar.ts (same split as growthMetrics.ts).

  Objects (all new; nothing existing is altered):
    north_star_calls_v            one row per qualifying call
    north_star_jobs_v             one row per job linked to a qualifying call (kept / resolved / paid flags)
    north_star_weekly_account_v   per account x call-week counts
    north_star_weekly_v           platform x call-week counts (what the admin card reads)
    staff_north_star_tree(int)    staff-only SECURITY DEFINER RPC -> jsonb

  Qualifying call: vapi_call_id IS NOT NULL, status is not 'spam', not a voicemail, owner is neither platform
  staff nor a synthetic probe tenant.
  Resolved job: completed, cancelled, or scheduled more than 7 days ago. Rework jobs (is_rework) are excluded:
  a rework visit is not a new booking.

  Tenant boundary: the views read across ALL tenants, so every privilege on them is revoked from anon and
  authenticated; they are reachable only through the RPC, which re-checks is_vireek_staff(auth.uid()).
  The RPC returns aggregates only (no account ids, names, phones or free text).

  Requires: calls(vapi_call_id,is_voicemail,answer_ms), jobs(call_id,is_rework,voice_idempotency_key,completed_at),
  invoices(job_id,status), invoice_payments(amount_cents), profiles(is_staff,is_synthetic_tenant),
  is_vireek_staff(uuid).

  Performance: NOT MEASURED. The views scan calls/jobs by week across tenants (no cross-tenant time index exists).
  If the RPC is slow on production data, add:
    CREATE INDEX CONCURRENTLY idx_calls_voice_week ON public.calls (call_datetime) WHERE vapi_call_id IS NOT NULL;

  ROLLBACK (derived views only, no data is stored):
    DROP FUNCTION IF EXISTS public.staff_north_star_tree(integer);
    DROP VIEW IF EXISTS public.north_star_weekly_v;
    DROP VIEW IF EXISTS public.north_star_weekly_account_v;
    DROP VIEW IF EXISTS public.north_star_jobs_v;
    DROP VIEW IF EXISTS public.north_star_calls_v;
*/
-- rollback: drop the RPC, then the four views in reverse order (see the ROLLBACK block above); no data is stored, so nothing is lost.

-- =============================================================
-- L0 base: qualifying calls
-- =============================================================
CREATE OR REPLACE VIEW public.north_star_calls_v AS
SELECT
  c.id        AS call_id,
  c.user_id   AS user_id,
  c.call_datetime,
  (date_trunc('week', c.call_datetime AT TIME ZONE 'UTC'))::date AS week_start
FROM public.calls c
JOIN public.profiles p ON p.id = c.user_id
WHERE c.vapi_call_id IS NOT NULL
  AND c.status IS DISTINCT FROM 'spam'
  AND NOT COALESCE(c.is_voicemail, false)
  AND NOT COALESCE(p.is_staff, false)
  AND NOT COALESCE(p.is_synthetic_tenant, false);

-- =============================================================
-- Jobs booked from those calls (same tenant on both sides)
-- =============================================================
CREATE OR REPLACE VIEW public.north_star_jobs_v AS
SELECT
  j.id        AS job_id,
  c.user_id   AS user_id,
  c.call_id   AS call_id,
  c.week_start,
  (j.job_status = 'completed') AS is_kept,
  (
    j.job_status IN ('completed', 'cancelled')
    OR (j.scheduled_datetime IS NOT NULL AND j.scheduled_datetime < now() - interval '7 days')
  ) AS is_resolved,
  (j.voice_idempotency_key IS NOT NULL) AS has_voice_key,
  COALESCE(pay.paid_cents, 0)::bigint AS paid_cents
FROM public.jobs j
JOIN public.north_star_calls_v c
  ON c.call_id = j.call_id
 AND c.user_id = j.user_id
LEFT JOIN LATERAL (
  SELECT sum(ip.amount_cents) AS paid_cents
  FROM public.invoices i
  JOIN public.invoice_payments ip ON ip.invoice_id = i.id
  WHERE i.job_id = j.id
    AND i.status <> 'void'
) pay ON true
WHERE NOT COALESCE(j.is_rework, false);

-- =============================================================
-- Per account x call-week counts
-- =============================================================
CREATE OR REPLACE VIEW public.north_star_weekly_account_v AS
WITH calls AS (
  SELECT user_id, week_start, count(*)::bigint AS calls_n
  FROM public.north_star_calls_v
  GROUP BY user_id, week_start
),
booked AS (
  SELECT
    user_id,
    week_start,
    count(DISTINCT call_id)::bigint                                AS booked_calls_n,
    count(*)::bigint                                               AS jobs_n,
    count(*) FILTER (WHERE is_kept)::bigint                        AS kept_n,
    count(*) FILTER (WHERE is_resolved)::bigint                    AS resolved_n,
    COALESCE(sum(paid_cents) FILTER (WHERE is_kept), 0)::bigint    AS paid_cents
  FROM public.north_star_jobs_v
  GROUP BY user_id, week_start
)
SELECT
  c.user_id,
  c.week_start,
  c.calls_n,
  COALESCE(b.booked_calls_n, 0) AS booked_calls_n,
  COALESCE(b.jobs_n, 0)         AS jobs_n,
  COALESCE(b.kept_n, 0)         AS kept_n,
  COALESCE(b.resolved_n, 0)     AS resolved_n,
  COALESCE(b.paid_cents, 0)     AS paid_cents
FROM calls c
LEFT JOIN booked b USING (user_id, week_start);

-- =============================================================
-- Platform x call-week counts (the North Star and its inputs)
-- =============================================================
CREATE OR REPLACE VIEW public.north_star_weekly_v AS
SELECT
  week_start,
  sum(calls_n)::bigint                          AS calls_n,
  sum(booked_calls_n)::bigint                   AS booked_calls_n,
  sum(jobs_n)::bigint                           AS jobs_n,
  sum(kept_n)::bigint                           AS kept_n,
  sum(resolved_n)::bigint                       AS resolved_n,
  (sum(jobs_n) - sum(resolved_n))::bigint       AS pending_n,
  count(*)::bigint                              AS accounts_with_calls_n,
  count(*) FILTER (WHERE kept_n > 0)::bigint    AS active_accounts_n,
  sum(paid_cents)::bigint                       AS paid_cents
FROM public.north_star_weekly_account_v
GROUP BY week_start;

REVOKE ALL ON public.north_star_calls_v           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.north_star_jobs_v            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.north_star_weekly_account_v  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.north_star_weekly_v          FROM PUBLIC, anon, authenticated;

-- =============================================================
-- Staff-only read API
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_north_star_tree(p_weeks integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_this_week date := (date_trunc('week', now() AT TIME ZONE 'UTC'))::date;
  v_from      date;
  v_since     timestamptz := now() - interval '90 days';
  v_weeks     jsonb;
  v_dq        jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 52 THEN
    RAISE EXCEPTION 'p_weeks must be between 1 and 52' USING ERRCODE = '22023';
  END IF;

  v_from := v_this_week - ((p_weeks - 1) * 7);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'week_start',            g.week_start,
           'calls_n',               COALESCE(w.calls_n, 0),
           'booked_calls_n',        COALESCE(w.booked_calls_n, 0),
           'jobs_n',                COALESCE(w.jobs_n, 0),
           'kept_n',                COALESCE(w.kept_n, 0),
           'resolved_n',            COALESCE(w.resolved_n, 0),
           'pending_n',             COALESCE(w.pending_n, 0),
           'accounts_with_calls_n', COALESCE(w.accounts_with_calls_n, 0),
           'active_accounts_n',     COALESCE(w.active_accounts_n, 0),
           'paid_cents',            COALESCE(w.paid_cents, 0)
         ) ORDER BY g.week_start DESC), '[]'::jsonb)
    INTO v_weeks
    FROM (
      SELECT gs::date AS week_start
      FROM generate_series(v_from::timestamp, v_this_week::timestamp, interval '7 days') AS gs
    ) g
    LEFT JOIN public.north_star_weekly_v w ON w.week_start = g.week_start;

  SELECT jsonb_build_object(
    'calls_all_sources_90d',         (SELECT count(*) FROM public.calls WHERE call_datetime >= v_since),
    'calls_qualifying_90d',          (SELECT count(*) FROM public.north_star_calls_v WHERE call_datetime >= v_since),
    'calls_with_answer_ms_90d',      (SELECT count(*) FROM public.calls c
                                       JOIN public.north_star_calls_v v ON v.call_id = c.id
                                      WHERE v.call_datetime >= v_since AND c.answer_ms IS NOT NULL),
    'jobs_linked_90d',               (SELECT count(*) FROM public.north_star_jobs_v WHERE week_start >= v_since::date - 7),
    'jobs_linked_with_voice_key_90d',(SELECT count(*) FROM public.north_star_jobs_v WHERE week_start >= v_since::date - 7 AND has_voice_key),
    'calls_booked_status_no_job_90d',(SELECT count(*) FROM public.north_star_calls_v v
                                       JOIN public.calls c ON c.id = v.call_id
                                      WHERE v.call_datetime >= v_since AND c.status = 'booked'
                                        AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.call_id = v.call_id))
  ) INTO v_dq;

  RETURN jsonb_build_object(
    'generated_at',     now(),
    'definition_version', 1,
    'resolved_after_days', 7,
    'weeks',            v_weeks,
    'data_quality',     v_dq
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_north_star_tree(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_north_star_tree(integer) TO authenticated;
