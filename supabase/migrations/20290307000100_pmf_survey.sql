/*
  # PMF measurement: "How disappointed would you be?" survey + retention by segment

  Method and limits: docs/analytics/pmf.md.

  Reuses (nothing existing is changed): get_account_owner_id(), is_vireek_staff(uuid), _success_is_impersonated(uuid),
  _feedback_segment(uuid, uuid), _feedback_assert_staff(text), feedback_redact(text), feedback_survey_prefs
  (the user's snooze / "don't ask me again" choices), feedback_survey_events and nps_responses (shared survey fatigue).
  Browser-side rules (analytics consent, critical routes, open dialogs, typing) live in src/lib/feedback/surveyRules.ts and
  are applied by src/components/feedback/PmfPrompt.tsx; this file owns everything the server can know.

  ## Tables (RLS on, NO client policies; every write goes through a SECURITY DEFINER RPC)
  pmf_survey_events      shown / answered / dismissed / snoozed / never   -> PMF cadence + shared fatigue
  pmf_survey_responses   one answer per person per round, with the segment captured AT ANSWER TIME

  ## Eligibility (pmf_claim) - all must hold
  - not a staff impersonation session; user has not chosen "don't ask me again" or an active snooze
  - the account is at least 30 days old and had at least 10 calls + jobs in the last 30 days (usage threshold)
  - no PMF answer in the last 180 days; PMF shown at most once per 90 days
  - shared survey fatigue: nothing else shown or NPS answered in the last 7 days, and fewer than 2 surveys shown in 30 days

  ## Privacy
  Free text is redacted server-side (feedback_redact) and capped. Segments are coarse buckets, never ids or names.
  Staff aggregates hide groups with fewer than 5 responses / accounts.

  ROLLBACK: see the comment block at the end of this file.
*/

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pmf_survey_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     text NOT NULL CHECK (action IN ('shown', 'answered', 'dismissed', 'snoozed', 'never')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pmf_events_user ON public.pmf_survey_events (user_id, action, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pmf_survey_responses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  round_key        text NOT NULL CHECK (round_key ~ '^[0-9]{4}Q[1-4]$'),
  answer           text NOT NULL CHECK (answer IN ('very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'no_longer_use')),
  main_benefit     text CHECK (main_benefit IS NULL OR char_length(main_benefit) <= 500),
  improvement      text CHECK (improvement IS NULL OR char_length(improvement) <= 500),
  plan             text,
  role             text,
  trade            text,
  team_size        text,
  tenure_bucket    text NOT NULL CHECK (tenure_bucket IN ('30_89d', '90_179d', '180d_plus')),
  usage_bucket     text NOT NULL CHECK (usage_bucket IN ('light', 'regular', 'heavy')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pmf_user_round UNIQUE (user_id, round_key)
);
CREATE INDEX IF NOT EXISTS idx_pmf_responses_created ON public.pmf_survey_responses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmf_responses_account ON public.pmf_survey_responses (account_owner_id);

ALTER TABLE public.pmf_survey_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmf_survey_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pmf_survey_events, public.pmf_survey_responses FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
-- Calls + jobs of the account in the last 30 days. Same "real value" signal the NPS prompt uses.
CREATE OR REPLACE FUNCTION public._pmf_usage_30d(p_owner uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (SELECT count(*) FROM calls c WHERE c.user_id = p_owner AND c.created_at >= now() - interval '30 days')::integer
       + (SELECT count(*) FROM jobs j WHERE j.user_id = p_owner AND j.created_at >= now() - interval '30 days')::integer;
$$;

CREATE OR REPLACE FUNCTION public._pmf_usage_bucket(p_count integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN coalesce(p_count, 0) >= 50 THEN 'heavy' WHEN coalesce(p_count, 0) >= 10 THEN 'regular' ELSE 'light' END;
$$;

CREATE OR REPLACE FUNCTION public._pmf_tenure_bucket(p_created timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN p_created <= now() - interval '180 days' THEN '180d_plus'
              WHEN p_created <= now() - interval '90 days' THEN '90_179d'
              ELSE '30_89d' END;
$$;

CREATE OR REPLACE FUNCTION public._pmf_due(p_uid uuid, p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefs feedback_survey_prefs%ROWTYPE;
  v_created timestamptz;
BEGIN
  IF p_uid IS NULL OR p_owner IS NULL THEN RETURN false; END IF;
  IF public._success_is_impersonated(p_owner) THEN RETURN false; END IF;

  SELECT * INTO v_prefs FROM feedback_survey_prefs WHERE user_id = p_uid;
  IF FOUND AND (v_prefs.never_ask OR (v_prefs.snoozed_until IS NOT NULL AND v_prefs.snoozed_until > now())) THEN
    RETURN false;
  END IF;

  SELECT p.created_at INTO v_created FROM profiles p WHERE p.id = p_owner;
  IF v_created IS NULL OR v_created > now() - interval '30 days' THEN RETURN false; END IF;

  IF EXISTS (SELECT 1 FROM pmf_survey_responses r WHERE r.user_id = p_uid AND r.created_at > now() - interval '180 days') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM pmf_survey_events e WHERE e.user_id = p_uid AND e.action = 'shown' AND e.created_at > now() - interval '90 days') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM pmf_survey_events e WHERE e.user_id = p_uid AND e.action = 'never') THEN RETURN false; END IF;

  -- Shared fatigue with CSAT/CES/NPS.
  IF EXISTS (SELECT 1 FROM feedback_survey_events e WHERE e.user_id = p_uid AND e.action = 'shown' AND e.created_at > now() - interval '7 days')
     OR EXISTS (SELECT 1 FROM nps_responses n WHERE n.user_id = p_uid AND n.created_at > now() - interval '7 days')
     OR EXISTS (SELECT 1 FROM pmf_survey_events e WHERE e.user_id = p_uid AND e.action = 'shown' AND e.created_at > now() - interval '7 days') THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM feedback_survey_events e WHERE e.user_id = p_uid AND e.action = 'shown' AND e.created_at > now() - interval '30 days')
   + (SELECT count(*) FROM pmf_survey_events e WHERE e.user_id = p_uid AND e.action = 'shown' AND e.created_at > now() - interval '30 days') >= 2 THEN
    RETURN false;
  END IF;

  RETURN public._pmf_usage_30d(p_owner) >= 10;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tenant RPCs
-- ---------------------------------------------------------------------------
-- Single gate: records "shown" when (and only when) the person is eligible.
CREATE OR REPLACE FUNCTION public.pmf_claim()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('survey:' || v_uid::text));
  IF NOT public._pmf_due(v_uid, v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_due');
  END IF;
  INSERT INTO pmf_survey_events (user_id, action) VALUES (v_uid, 'shown');
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.pmf_respond(p_answer text, p_main_benefit text DEFAULT NULL, p_improvement text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_seg jsonb;
  v_qual record;
  v_created timestamptz;
  v_benefit text := nullif(left(btrim(public.feedback_redact(coalesce(p_main_benefit, ''))), 500), '');
  v_improve text := nullif(left(btrim(public.feedback_redact(coalesce(p_improvement, ''))), 500), '');
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_answer IS NULL OR p_answer NOT IN ('very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'no_longer_use') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_answer');
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'impersonated');
  END IF;
  -- Only a survey that pmf_claim offered in the last hour, and not yet answered since.
  IF NOT EXISTS (SELECT 1 FROM pmf_survey_events e WHERE e.user_id = v_uid AND e.action = 'shown' AND e.created_at > now() - interval '1 hour')
     OR EXISTS (SELECT 1 FROM pmf_survey_events e WHERE e.user_id = v_uid AND e.action IN ('answered', 'dismissed', 'snoozed', 'never')
                  AND e.created_at > (SELECT max(s.created_at) FROM pmf_survey_events s WHERE s.user_id = v_uid AND s.action = 'shown')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_offered');
  END IF;

  v_seg := public._feedback_segment(v_uid, v_owner);
  SELECT q.trade, q.team_size INTO v_qual FROM signup_qualification q WHERE q.user_id = v_owner AND q.status = 'completed';
  SELECT p.created_at INTO v_created FROM profiles p WHERE p.id = v_owner;

  INSERT INTO pmf_survey_responses (account_owner_id, user_id, round_key, answer, main_benefit, improvement,
                                    plan, role, trade, team_size, tenure_bucket, usage_bucket)
  VALUES (v_owner, v_uid, to_char(now() AT TIME ZONE 'UTC', 'YYYY"Q"Q'), p_answer, v_benefit, v_improve,
          v_seg ->> 'plan', v_seg ->> 'role', v_qual.trade, v_qual.team_size,
          public._pmf_tenure_bucket(v_created), public._pmf_usage_bucket(public._pmf_usage_30d(v_owner)))
  ON CONFLICT ON CONSTRAINT uq_pmf_user_round DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_answered');
  END IF;

  INSERT INTO pmf_survey_events (user_id, action) VALUES (v_uid, 'answered');
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.pmf_dismiss(p_action text, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismissed', 'snoozed', 'never') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  INSERT INTO pmf_survey_events (user_id, action) VALUES (v_uid, p_action);
  -- Same choices the other surveys honour, so "don't ask me again" means all surveys.
  IF p_action = 'snoozed' THEN
    INSERT INTO feedback_survey_prefs (user_id, snoozed_until)
    VALUES (v_uid, now() + make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90)))
    ON CONFLICT (user_id) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, updated_at = now();
  ELSIF p_action = 'never' THEN
    INSERT INTO feedback_survey_prefs (user_id, never_ask) VALUES (v_uid, true)
    ON CONFLICT (user_id) DO UPDATE SET never_ask = true, updated_at = now();
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.export_my_pmf_data()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'responses', coalesce((SELECT jsonb_agg(to_jsonb(r) - 'user_id' - 'account_owner_id' ORDER BY r.created_at)
                           FROM pmf_survey_responses r WHERE r.user_id = auth.uid()), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(to_jsonb(e) - 'user_id' ORDER BY e.created_at)
                        FROM pmf_survey_events e WHERE e.user_id = auth.uid()), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.delete_my_pmf_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  n_resp integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  DELETE FROM pmf_survey_responses WHERE user_id = v_uid;
  GET DIAGNOSTICS n_resp = ROW_COUNT;
  DELETE FROM pmf_survey_events WHERE user_id = v_uid;
  RETURN jsonb_build_object('ok', true, 'responses', n_resp);
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff views (aggregates only; small groups are merged, never shown)
-- ---------------------------------------------------------------------------
-- p_dimension: all | plan | role | trade | team_size | tenure_bucket | usage_bucket
CREATE OR REPLACE FUNCTION public.staff_pmf_summary(p_days integer DEFAULT 180, p_dimension text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 180), 7), 730));
BEGIN
  PERFORM public._feedback_assert_staff('pmf');
  IF p_dimension IS NULL OR p_dimension NOT IN ('all', 'plan', 'role', 'trade', 'team_size', 'tenure_bucket', 'usage_bucket') THEN
    RAISE EXCEPTION 'invalid_dimension' USING ERRCODE = '22023';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'segment', g.segment, 'n', g.n, 'very', g.very, 'somewhat', g.somewhat, 'not_disappointed', g.notd,
             'no_longer_use', g.nlu, 'pct_very', round(100.0 * g.very / g.n, 1)) ORDER BY (g.segment = 'small_groups'), g.n DESC, g.segment)
    FROM (
      SELECT CASE WHEN s.n < 5 THEN 'small_groups' ELSE s.segment END AS segment,
             sum(s.n)::integer AS n, sum(s.very)::integer AS very, sum(s.somewhat)::integer AS somewhat,
             sum(s.notd)::integer AS notd, sum(s.nlu)::integer AS nlu
      FROM (
        SELECT coalesce(CASE p_dimension
                          WHEN 'all' THEN 'all'
                          WHEN 'plan' THEN r.plan
                          WHEN 'role' THEN r.role
                          WHEN 'trade' THEN r.trade
                          WHEN 'team_size' THEN r.team_size
                          WHEN 'tenure_bucket' THEN r.tenure_bucket
                          WHEN 'usage_bucket' THEN r.usage_bucket
                        END, 'unknown') AS segment,
               count(*) AS n,
               count(*) FILTER (WHERE r.answer = 'very_disappointed') AS very,
               count(*) FILTER (WHERE r.answer = 'somewhat_disappointed') AS somewhat,
               count(*) FILTER (WHERE r.answer = 'not_disappointed') AS notd,
               count(*) FILTER (WHERE r.answer = 'no_longer_use') AS nlu
        FROM pmf_survey_responses r
        WHERE r.created_at >= v_since
        GROUP BY 1
      ) s
      GROUP BY 1
    ) g
  ), '[]'::jsonb);
END;
$$;

-- Weekly signup cohorts: share of accounts with at least one call or job in week N after the signup week.
-- Segment = the account's CURRENT plan / signup-qualification answers (plan at signup is not stored: see docs).
-- p_dimension: all | plan | trade | team_size
CREATE OR REPLACE FUNCTION public.staff_retention_by_segment(p_weeks integer DEFAULT 12, p_dimension text DEFAULT 'all')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 4), 26);
  v_this_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date;
  v_first_cohort date;
BEGIN
  PERFORM public._feedback_assert_staff('retention');
  IF p_dimension IS NULL OR p_dimension NOT IN ('all', 'plan', 'trade', 'team_size') THEN
    RAISE EXCEPTION 'invalid_dimension' USING ERRCODE = '22023';
  END IF;
  v_first_cohort := v_this_week - (v_weeks * 7);

  RETURN coalesce((
    WITH accts AS (
      SELECT p.id,
             date_trunc('week', p.created_at AT TIME ZONE 'UTC')::date AS cohort_week,
             coalesce(CASE p_dimension
                        WHEN 'all' THEN 'all'
                        WHEN 'plan' THEN p.plan
                        WHEN 'trade' THEN q.trade
                        WHEN 'team_size' THEN q.team_size
                      END, 'unknown') AS segment
      FROM profiles p
      LEFT JOIN signup_qualification q ON q.user_id = p.id AND q.status = 'completed'
      WHERE p.role = 'owner' AND NOT coalesce(p.is_staff, false) AND p.created_at >= v_first_cohort::timestamp AT TIME ZONE 'UTC'
    ),
    activity AS (
      SELECT DISTINCT x.user_id, date_trunc('week', x.at AT TIME ZONE 'UTC')::date AS wk
      FROM (
        SELECT c.user_id, c.created_at AS at FROM calls c WHERE c.created_at >= v_first_cohort::timestamp AT TIME ZONE 'UTC'
        UNION ALL
        SELECT j.user_id, j.created_at FROM jobs j WHERE j.created_at >= v_first_cohort::timestamp AT TIME ZONE 'UTC'
      ) x
    ),
    seg_size AS (SELECT segment, count(*) AS accounts FROM accts GROUP BY segment),
    cells AS (
      SELECT CASE WHEN z.accounts < 5 THEN 'small_groups' ELSE a.segment END AS segment,
             (ac.wk - a.cohort_week) / 7 AS week_offset,
             a.id AS account_id,
             a.cohort_week
      FROM accts a
      JOIN seg_size z ON z.segment = a.segment
      LEFT JOIN activity ac ON ac.user_id = a.id AND ac.wk >= a.cohort_week
    ),
    cohort_sizes AS (
      SELECT CASE WHEN z.accounts < 5 THEN 'small_groups' ELSE a.segment END AS segment, a.cohort_week, count(*) AS size
      FROM accts a JOIN seg_size z ON z.segment = a.segment GROUP BY 1, 2
    ),
    offsets AS (SELECT generate_series(0, v_weeks) AS week_offset),
    -- Only cohort/offset pairs that have fully happened (week N has started) count toward the denominator.
    denom AS (
      SELECT cs.segment, o.week_offset, sum(cs.size)::integer AS cohort_accounts
      FROM cohort_sizes cs JOIN offsets o ON cs.cohort_week + (o.week_offset * 7) <= v_this_week
      GROUP BY 1, 2
    ),
    numer AS (
      SELECT c.segment, c.week_offset, count(DISTINCT c.account_id)::integer AS active_accounts
      FROM cells c
      WHERE c.week_offset IS NOT NULL AND c.week_offset BETWEEN 0 AND v_weeks AND c.cohort_week + (c.week_offset * 7) <= v_this_week
      GROUP BY 1, 2
    )
    SELECT jsonb_agg(jsonb_build_object(
             'segment', d.segment, 'week_offset', d.week_offset, 'cohort_accounts', d.cohort_accounts,
             'active_accounts', coalesce(n.active_accounts, 0),
             'retention_pct', round(100.0 * coalesce(n.active_accounts, 0) / d.cohort_accounts, 1))
           ORDER BY (d.segment = 'small_groups'), d.segment, d.week_offset)
    FROM denom d LEFT JOIN numer n ON n.segment = d.segment AND n.week_offset = d.week_offset
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._pmf_usage_30d(uuid), public._pmf_usage_bucket(integer), public._pmf_tenure_bucket(timestamptz),
  public._pmf_due(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pmf_claim(), public.pmf_respond(text, text, text), public.pmf_dismiss(text, integer),
  public.export_my_pmf_data(), public.delete_my_pmf_data(),
  public.staff_pmf_summary(integer, text), public.staff_retention_by_segment(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pmf_claim(), public.pmf_respond(text, text, text), public.pmf_dismiss(text, integer),
  public.export_my_pmf_data(), public.delete_my_pmf_data(),
  public.staff_pmf_summary(integer, text), public.staff_retention_by_segment(integer, text) TO authenticated;

/*
  ## ROLLBACK (loses all PMF responses)
    DROP FUNCTION IF EXISTS public.staff_retention_by_segment(integer, text);
    DROP FUNCTION IF EXISTS public.staff_pmf_summary(integer, text);
    DROP FUNCTION IF EXISTS public.delete_my_pmf_data();
    DROP FUNCTION IF EXISTS public.export_my_pmf_data();
    DROP FUNCTION IF EXISTS public.pmf_dismiss(text, integer);
    DROP FUNCTION IF EXISTS public.pmf_respond(text, text, text);
    DROP FUNCTION IF EXISTS public.pmf_claim();
    DROP FUNCTION IF EXISTS public._pmf_due(uuid, uuid);
    DROP FUNCTION IF EXISTS public._pmf_tenure_bucket(timestamptz);
    DROP FUNCTION IF EXISTS public._pmf_usage_bucket(integer);
    DROP FUNCTION IF EXISTS public._pmf_usage_30d(uuid);
    DROP TABLE IF EXISTS public.pmf_survey_responses;
    DROP TABLE IF EXISTS public.pmf_survey_events;
*/
