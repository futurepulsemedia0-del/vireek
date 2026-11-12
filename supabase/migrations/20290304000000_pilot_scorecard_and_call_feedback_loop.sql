/*
  # Weekly scorecard (tenant) + "this call was wrong" feedback loop

  Verified against migrations in the ZIP (the ZIP may be older than the live repo):
  calls(user_id, call_datetime, status, is_voicemail, booking_outcome, answer_ms, escalated_at, transcript),
  call_feedback(call_id, rating 1-5), get_account_owner_id(), can_view_feedback_analytics(), can_edit_call_scripts().

  ## Scorecard definitions (single source of truth)
  - Week = Monday 00:00 UTC .. next Monday 00:00 UTC. Compared with the previous week.
  - missed   = calls.status = 'missed' OR calls.is_voicemail
  - answered = total - missed
  - booked   = calls.booking_outcome = 'booked'; booking_rate = booked / (booked + not_booked), NULL if no denominator
  - answer speed = avg(calls.answer_ms) over rows where it is NOT NULL; `answer_ms_n` says how many. Nothing populates
    answer_ms yet (see 20280501000000_trust_badge.sql) -> this is NULL ("no data"), never 0.
  - satisfaction = avg(call_feedback.rating) + n (NOT a CSAT survey of every caller: only calls an owner rated)
  - escalation rate = escalated_at IS NOT NULL / total
  - errors: NOT MEASURED (no verified error column). Returned as errors_measured = false.
  - "previously missed" baseline per tenant does not exist in the database: only prior-week comparison is reported.

  ## Feedback loop
  - call_eval_candidates: one row per reported call. Written ONLY by report_wrong_call() (SECURITY DEFINER).
  - The owner's note is always PII-scrubbed. The transcript is stored (scrubbed, max 2000 chars) ONLY when
    p_share_for_eval = true, which records consent_at. Without consent nothing from the transcript is kept.
  - Candidates are UNLABELED drafts: a human must write the expected outcome before they enter eval/.
  - scrub_pii masks card-like numbers, SSNs, emails, phone numbers and street addresses. It does NOT mask personal names.

  ## Security
  - Tenant = get_account_owner_id() resolved server-side, never from arguments.
  - Scorecard requires can_view_feedback_analytics(); reporting requires can_edit_call_scripts().
  - call_eval_candidates: RLS on, SELECT only for the account owner scope, no INSERT/UPDATE/DELETE grant.

  ## Rollback
    DROP FUNCTION public.get_weekly_scorecard(date), public.report_wrong_call(uuid, text, text, boolean), public.scrub_pii(text);
    DROP TABLE public.call_eval_candidates;
*/

CREATE OR REPLACE FUNCTION public.scrub_pii(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(left(coalesce(p_text, ''), 2000),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
      '\m(?:\d[ -]?){13,19}\M', '[card]', 'g'),
      '\m\d{3}-\d{2}-\d{4}\M', '[ssn]', 'g'),
      '(?:\+?\d{1,2}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}', '[phone]', 'g'),
      '\m\d{1,6}\s+(?:[A-Za-z0-9.]+\s+){1,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl)\M\.?', '[address]', 'gi'),
    '');
$$;

CREATE TABLE IF NOT EXISTS public.call_eval_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  reported_by uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('wrong_price','wrong_booking','missed_emergency','false_emergency','wrong_escalation','promised_arrival','other')),
  note_scrubbed text,
  scrubbed_transcript text,
  consent_at timestamptz,
  status text NOT NULL DEFAULT 'unlabeled' CHECK (status IN ('unlabeled','labeled','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id),
  CHECK (scrubbed_transcript IS NULL OR consent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_call_eval_candidates_owner ON public.call_eval_candidates (account_owner_id, created_at DESC);

ALTER TABLE public.call_eval_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_eval_candidates_select ON public.call_eval_candidates;
CREATE POLICY call_eval_candidates_select ON public.call_eval_candidates
  FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
REVOKE ALL ON public.call_eval_candidates FROM anon, authenticated;
GRANT SELECT ON public.call_eval_candidates TO authenticated;

CREATE OR REPLACE FUNCTION public.report_wrong_call(p_call_id uuid, p_reason text, p_note text DEFAULT NULL, p_share_for_eval boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_transcript text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_edit_call_scripts() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT transcript INTO v_transcript FROM public.calls WHERE id = p_call_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.call_eval_candidates (account_owner_id, call_id, reported_by, reason, note_scrubbed, scrubbed_transcript, consent_at)
  VALUES (v_owner, p_call_id, auth.uid(), p_reason, public.scrub_pii(left(coalesce(p_note, ''), 1000)),
          CASE WHEN p_share_for_eval THEN public.scrub_pii(v_transcript) END,
          CASE WHEN p_share_for_eval THEN now() END)
  ON CONFLICT (call_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id; -- NULL when this call was already reported (idempotent)
END;
$$;
REVOKE ALL ON FUNCTION public.report_wrong_call(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_wrong_call(uuid, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_weekly_scorecard(p_week_start date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_start timestamptz := (date_trunc('week', coalesce(p_week_start::timestamp, (now() AT TIME ZONE 'UTC')))) AT TIME ZONE 'UTC';
  v_end timestamptz := v_start + interval '7 days';
  v_prev timestamptz := v_start - interval '7 days';
  cur jsonb;
  prv jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_view_feedback_analytics() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total', count(*),
    'missed', count(*) FILTER (WHERE c.status = 'missed' OR c.is_voicemail),
    'answered', count(*) FILTER (WHERE NOT (c.status = 'missed' OR c.is_voicemail)),
    'booked', count(*) FILTER (WHERE c.booking_outcome = 'booked'),
    'not_booked', count(*) FILTER (WHERE c.booking_outcome = 'not_booked'),
    'escalated', count(*) FILTER (WHERE c.escalated_at IS NOT NULL),
    'answer_ms_avg', round(avg(c.answer_ms))::int,
    'answer_ms_n', count(c.answer_ms),
    'rating_avg', round(avg(f.rating)::numeric, 2),
    'rating_n', count(f.rating),
    'wrong_reports', (SELECT count(*) FROM public.call_eval_candidates e
                        WHERE e.account_owner_id = v_owner AND e.created_at >= v_start AND e.created_at < v_end)
  ) INTO cur
  FROM public.calls c LEFT JOIN public.call_feedback f ON f.call_id = c.id
  WHERE c.user_id = v_owner AND c.call_datetime >= v_start AND c.call_datetime < v_end;

  SELECT jsonb_build_object(
    'total', count(*),
    'missed', count(*) FILTER (WHERE c.status = 'missed' OR c.is_voicemail),
    'answered', count(*) FILTER (WHERE NOT (c.status = 'missed' OR c.is_voicemail)),
    'booked', count(*) FILTER (WHERE c.booking_outcome = 'booked'),
    'not_booked', count(*) FILTER (WHERE c.booking_outcome = 'not_booked'),
    'escalated', count(*) FILTER (WHERE c.escalated_at IS NOT NULL),
    'answer_ms_avg', round(avg(c.answer_ms))::int,
    'answer_ms_n', count(c.answer_ms),
    'rating_avg', round(avg(f.rating)::numeric, 2),
    'rating_n', count(f.rating),
    'wrong_reports', 0
  ) INTO prv
  FROM public.calls c LEFT JOIN public.call_feedback f ON f.call_id = c.id
  WHERE c.user_id = v_owner AND c.call_datetime >= v_prev AND c.call_datetime < v_start;

  RETURN jsonb_build_object('week_start', v_start, 'week_end', v_end, 'current', cur, 'previous', prv, 'errors_measured', false);
END;
$$;
REVOKE ALL ON FUNCTION public.get_weekly_scorecard(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_weekly_scorecard(date) TO authenticated;
