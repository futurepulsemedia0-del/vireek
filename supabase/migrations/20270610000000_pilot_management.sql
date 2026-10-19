/*
  # Pilot management (/staff/pilots) — staff only

  What this is
  - A staff view of every pilot customer: baseline (before Vireek) vs live
    metrics, a week-by-week trend, recovered revenue, call-quality flags and a
    consent-gated export for case studies.

  Tables
  - pilot_customers: one row per pilot. Holds the BASELINE (entered by staff,
    because pre-Vireek numbers do not exist in our database) and the CONSENT
    record (status, scope, evidence). Live numbers are never stored: they are
    computed from `calls`, `jobs` and `revenue_recovery_events` on demand, so
    they cannot drift or be edited.
  - pilot_audit: append-only history (create / update / delete / export).
    Filled by triggers and the export RPC only.

  Definitions (the single source of truth is in this file)
  - Weeks are 7-day buckets anchored on `started_on` (week 1 = days 1-7), so
    every week is the same length and comparable. Dates are UTC.
  - missed call        = calls.status = 'missed' OR calls.is_voicemail
  - booking rate       = booked / (booked + not_booked) by calls.booking_outcome
  - revenue            = jobs with invoice_status = 'paid' (not cancelled),
                         dated by scheduled_datetime, falling back to created_at
  - recovered revenue  = revenue_recovery_events with status = 'recovered',
                         dated by resolved_at, summed as recovered_amount_cents
  - live window        = the last 28 days of the pilot (or fewer if it is newer)
  - quality flags      = see pilot_call_flags()
  A metric with no denominator (e.g. booking rate with zero booking
  opportunities) is NULL, never 0, so the UI can say "no data".

  Access
  - Staff only (profiles.is_staff via is_vireek_staff()). Tenants have no
    policy, no grant and no RPC. Every staff RPC re-checks the flag.
  - Quality-flag rows contain NO caller name, phone, transcript or summary.
  - Export is refused unless consent_status = 'granted' AND the scope includes
    'metrics'. The customer's name is only included when the scope includes
    'company_name'. Every export is written to pilot_audit.

  Depends on
  - 20260913020000_live_chat_and_academy.sql        (is_vireek_staff)
  - 20270411000000_protect_profiles_is_staff.sql    (is_staff cannot be forged)
  - 20270411000100_feature_flags.sql                (staff_search_tenants, used by the UI)
  - 20260922000000_missed_revenue_recovery_ledger.sql (revenue_recovery_events)
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS pilot_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'active', 'completed', 'churned')),
  started_on date NOT NULL,
  ended_on date,

  -- Baseline: how the business performed BEFORE Vireek (staff-entered).
  baseline_weekly_calls integer CHECK (baseline_weekly_calls IS NULL OR baseline_weekly_calls BETWEEN 0 AND 100000),
  baseline_missed_call_pct numeric(5, 2) CHECK (baseline_missed_call_pct IS NULL OR baseline_missed_call_pct BETWEEN 0 AND 100),
  baseline_booking_rate_pct numeric(5, 2) CHECK (baseline_booking_rate_pct IS NULL OR baseline_booking_rate_pct BETWEEN 0 AND 100),
  baseline_avg_job_value_cents integer CHECK (baseline_avg_job_value_cents IS NULL OR baseline_avg_job_value_cents >= 0),
  baseline_weekly_revenue_cents bigint CHECK (baseline_weekly_revenue_cents IS NULL OR baseline_weekly_revenue_cents >= 0),
  baseline_source text NOT NULL DEFAULT 'self_reported'
    CHECK (baseline_source IN ('self_reported', 'pre_pilot_data', 'estimated')),
  baseline_notes text CHECK (baseline_notes IS NULL OR char_length(baseline_notes) <= 1000),

  -- Consent to use this pilot's results publicly (set by staff after the
  -- customer agreed in writing; evidence says where that agreement lives).
  consent_status text NOT NULL DEFAULT 'not_requested'
    CHECK (consent_status IN ('not_requested', 'requested', 'granted', 'declined', 'revoked')),
  consent_scope text[] NOT NULL DEFAULT '{}'
    CHECK (consent_scope <@ ARRAY['company_name', 'metrics', 'quote', 'logo']::text[]),
  consent_evidence text CHECK (consent_evidence IS NULL OR char_length(consent_evidence) <= 500),
  consent_granted_at timestamptz,
  consent_recorded_by uuid,
  consent_updated_at timestamptz,

  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),

  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pilot_dates_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT pilot_consent_needs_evidence CHECK (
    consent_status <> 'granted'
    OR (cardinality(consent_scope) > 0 AND char_length(btrim(COALESCE(consent_evidence, ''))) > 0)
  )
);

-- A tenant can only be in one open pilot at a time (history is kept).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pilot_customers_one_open
  ON pilot_customers(tenant_id) WHERE status IN ('onboarding', 'active');
CREATE INDEX IF NOT EXISTS idx_pilot_customers_tenant ON pilot_customers(tenant_id);

CREATE TABLE IF NOT EXISTS pilot_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pilot_id uuid NOT NULL, -- deliberately no FK: history outlives a deleted pilot
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'export')),
  changes jsonb,
  actor uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_audit_pilot ON pilot_audit(pilot_id, id DESC);

-- =============================================================
-- TRIGGERS: validation, consent bookkeeping, audit
-- =============================================================

CREATE OR REPLACE FUNCTION public.pilot_customers_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.tenant_id AND role = 'owner') THEN
      RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
    END IF;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'A pilot cannot be moved to another tenant' USING ERRCODE = '22023';
  END IF;

  -- Open pilots have no end date; closed pilots always have one.
  IF NEW.status IN ('onboarding', 'active') THEN
    NEW.ended_on := NULL;
  ELSIF NEW.ended_on IS NULL THEN
    NEW.ended_on := GREATEST(NEW.started_on, (now() AT TIME ZONE 'UTC')::date);
  END IF;

  -- Consent timestamps are server-controlled: a client cannot backdate or forge them.
  IF TG_OP = 'INSERT' THEN
    NEW.consent_granted_at := CASE WHEN NEW.consent_status = 'granted' THEN now() END;
    NEW.consent_recorded_by := CASE WHEN NEW.consent_status = 'granted' THEN auth.uid() END;
    NEW.consent_updated_at := now();
    NEW.created_at := now();
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    IF NEW.consent_status IS DISTINCT FROM OLD.consent_status THEN
      NEW.consent_updated_at := now();
      IF NEW.consent_status = 'granted' THEN
        NEW.consent_granted_at := now();
        NEW.consent_recorded_by := auth.uid();
      ELSE
        NEW.consent_granted_at := OLD.consent_granted_at;
        NEW.consent_recorded_by := OLD.consent_recorded_by;
      END IF;
    ELSE
      NEW.consent_granted_at := OLD.consent_granted_at;
      NEW.consent_recorded_by := OLD.consent_recorded_by;
      NEW.consent_updated_at := OLD.consent_updated_at;
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pilot_customers_before_write ON pilot_customers;
CREATE TRIGGER trg_pilot_customers_before_write
  BEFORE INSERT OR UPDATE ON pilot_customers
  FOR EACH ROW EXECUTE FUNCTION public.pilot_customers_before_write();

CREATE OR REPLACE FUNCTION public.pilot_customers_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changes jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO pilot_audit (pilot_id, action, changes)
    VALUES (NEW.id, 'create', jsonb_build_object('status', NEW.status, 'started_on', NEW.started_on, 'tenant_id', NEW.tenant_id));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO pilot_audit (pilot_id, action, changes)
    VALUES (OLD.id, 'delete', jsonb_build_object('status', OLD.status, 'consent_status', OLD.consent_status, 'tenant_id', OLD.tenant_id));
    RETURN OLD;
  END IF;

  -- UPDATE: record only the columns that changed (bookkeeping columns excluded).
  SELECT jsonb_object_agg(n.key, jsonb_build_object('from', to_jsonb(OLD) -> n.key, 'to', n.value))
    INTO v_changes
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value
     AND n.key NOT IN ('updated_at', 'updated_by', 'consent_updated_at');

  IF v_changes IS NOT NULL THEN
    INSERT INTO pilot_audit (pilot_id, action, changes) VALUES (NEW.id, 'update', v_changes);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pilot_customers_audit ON pilot_customers;
CREATE TRIGGER trg_pilot_customers_audit
  AFTER INSERT OR UPDATE OR DELETE ON pilot_customers
  FOR EACH ROW EXECUTE FUNCTION public.pilot_customers_audit();

-- =============================================================
-- RLS: staff only. The audit table is read-only for everyone.
-- =============================================================

ALTER TABLE pilot_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pilot_customers, pilot_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pilot_audit FROM authenticated;

DROP POLICY IF EXISTS "staff_manage_pilot_customers" ON pilot_customers;
CREATE POLICY "staff_manage_pilot_customers" ON pilot_customers FOR ALL TO authenticated
  USING (is_vireek_staff(auth.uid())) WITH CHECK (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_read_pilot_audit" ON pilot_audit;
CREATE POLICY "staff_read_pilot_audit" ON pilot_audit FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

-- =============================================================
-- INTERNAL HELPERS (not callable by clients; staff RPCs call them)
-- =============================================================

-- Call-quality flags. Pure and immutable so the list, the detail panel and the
-- export can never disagree about what counts as a flagged call.
CREATE OR REPLACE FUNCTION public.pilot_call_flags(
  p_call_score smallint, p_sentiment text, p_price_status text,
  p_is_emergency boolean, p_booking_outcome text, p_objections_resolved boolean
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p_call_score IS NOT NULL AND p_call_score < 50 THEN 'low_score' END,
    CASE WHEN p_sentiment = 'negative' THEN 'negative_sentiment' END,
    CASE WHEN p_price_status = 'mismatch' THEN 'price_mismatch' END,
    CASE WHEN COALESCE(p_is_emergency, false) AND p_booking_outcome = 'not_booked' THEN 'emergency_not_booked' END,
    CASE WHEN p_objections_resolved IS FALSE THEN 'objection_unresolved' END
  ]::text[], NULL);
$$;

-- Week-by-week series for one tenant between two UTC dates (inclusive).
-- Always returns one row per week, zero-filled, so charts have no gaps.
CREATE OR REPLACE FUNCTION public.pilot_weekly_series(p_tenant uuid, p_from date, p_to date)
RETURNS TABLE (
  week_index integer, week_start date, week_end date, is_complete boolean,
  total_calls integer, missed_calls integer, booking_opportunities integer, booked integer,
  avg_call_score numeric, flagged_calls integer,
  paid_jobs integer, revenue_cents bigint, recovered_count integer, recovered_cents bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT (p_from::timestamp AT TIME ZONE 'UTC') AS lo,
           ((p_to + 1)::timestamp AT TIME ZONE 'UTC') AS hi
  ),
  weeks AS (
    SELECT g.n, p_from + g.n * 7 AS ws
      FROM generate_series(0, (p_to - p_from) / 7) AS g(n)
     WHERE p_to >= p_from
  ),
  c AS (
    SELECT (((x.call_datetime AT TIME ZONE 'UTC')::date - p_from) / 7) AS n,
           count(*)::integer AS total_calls,
           count(*) FILTER (WHERE x.status = 'missed' OR x.is_voicemail)::integer AS missed_calls,
           count(*) FILTER (WHERE x.booking_outcome IN ('booked', 'not_booked'))::integer AS booking_opportunities,
           count(*) FILTER (WHERE x.booking_outcome = 'booked')::integer AS booked,
           round(avg(x.call_score)::numeric, 1) AS avg_call_score,
           count(*) FILTER (WHERE cardinality(public.pilot_call_flags(
             x.call_score, x.sentiment, x.price_accuracy_status, x.is_emergency, x.booking_outcome, x.objections_resolved)) > 0)::integer AS flagged_calls
      FROM calls x, bounds b
     WHERE x.user_id = p_tenant AND x.call_datetime >= b.lo AND x.call_datetime < b.hi
     GROUP BY 1
  ),
  j AS (
    SELECT (((COALESCE(x.scheduled_datetime, x.created_at) AT TIME ZONE 'UTC')::date - p_from) / 7) AS n,
           count(*)::integer AS paid_jobs,
           COALESCE(sum(round(x.invoice_amount * 100)), 0)::bigint AS revenue_cents
      FROM jobs x, bounds b
     WHERE x.user_id = p_tenant AND x.invoice_status = 'paid' AND x.invoice_amount IS NOT NULL
       AND x.job_status <> 'cancelled'
       AND COALESCE(x.scheduled_datetime, x.created_at) >= b.lo
       AND COALESCE(x.scheduled_datetime, x.created_at) < b.hi
     GROUP BY 1
  ),
  r AS (
    SELECT (((x.resolved_at AT TIME ZONE 'UTC')::date - p_from) / 7) AS n,
           count(*)::integer AS recovered_count,
           COALESCE(sum(x.recovered_amount_cents), 0)::bigint AS recovered_cents
      FROM revenue_recovery_events x, bounds b
     WHERE x.user_id = p_tenant AND x.status = 'recovered'
       AND x.resolved_at >= b.lo AND x.resolved_at < b.hi
     GROUP BY 1
  )
  SELECT (w.n + 1)::integer, w.ws, w.ws + 6,
         (w.ws + 6) < (now() AT TIME ZONE 'UTC')::date,
         COALESCE(c.total_calls, 0), COALESCE(c.missed_calls, 0),
         COALESCE(c.booking_opportunities, 0), COALESCE(c.booked, 0),
         c.avg_call_score, COALESCE(c.flagged_calls, 0),
         COALESCE(j.paid_jobs, 0), COALESCE(j.revenue_cents, 0),
         COALESCE(r.recovered_count, 0), COALESCE(r.recovered_cents, 0)
    FROM weeks w
    LEFT JOIN c ON c.n = w.n
    LEFT JOIN j ON j.n = w.n
    LEFT JOIN r ON r.n = w.n
   ORDER BY w.n;
$$;

-- Live metrics for one pilot: the last-28-day window plus since-start totals.
CREATE OR REPLACE FUNCTION public.pilot_live_metrics(p_pilot_id uuid)
RETURNS TABLE (
  live_days integer, weeks_elapsed integer,
  live_weekly_calls numeric, live_missed_call_pct numeric, live_booking_rate_pct numeric,
  live_avg_job_value_cents numeric, live_weekly_revenue_cents numeric, live_avg_call_score numeric,
  total_calls integer, flagged_calls integer, recovered_cents bigint, recovered_count integer
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_pc pilot_customers%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_we date;
  v_ws date;
  v_days integer;
  v_lo timestamptz;
  v_hi timestamptz;
  v_wlo timestamptz;
  a_total integer; a_flagged integer; w_calls integer; w_missed integer; w_opps integer; w_booked integer; w_score numeric;
  w_paid integer; w_rev bigint; rc_cents bigint; rc_count integer;
BEGIN
  SELECT * INTO v_pc FROM pilot_customers WHERE id = p_pilot_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_we := LEAST(COALESCE(v_pc.ended_on, v_today), v_today);
  v_ws := GREATEST(v_pc.started_on, v_we - 27);
  v_days := GREATEST(0, v_we - v_ws + 1);
  v_lo := v_pc.started_on::timestamp AT TIME ZONE 'UTC';
  v_hi := (v_we + 1)::timestamp AT TIME ZONE 'UTC';
  v_wlo := v_ws::timestamp AT TIME ZONE 'UTC';

  SELECT count(*)::integer,
         count(*) FILTER (WHERE cardinality(public.pilot_call_flags(
           x.call_score, x.sentiment, x.price_accuracy_status, x.is_emergency, x.booking_outcome, x.objections_resolved)) > 0)::integer,
         count(*) FILTER (WHERE x.call_datetime >= v_wlo)::integer,
         count(*) FILTER (WHERE x.call_datetime >= v_wlo AND (x.status = 'missed' OR x.is_voicemail))::integer,
         count(*) FILTER (WHERE x.call_datetime >= v_wlo AND x.booking_outcome IN ('booked', 'not_booked'))::integer,
         count(*) FILTER (WHERE x.call_datetime >= v_wlo AND x.booking_outcome = 'booked')::integer,
         avg(x.call_score) FILTER (WHERE x.call_datetime >= v_wlo)
    INTO a_total, a_flagged, w_calls, w_missed, w_opps, w_booked, w_score
    FROM calls x
   WHERE x.user_id = v_pc.tenant_id AND x.call_datetime >= v_lo AND x.call_datetime < v_hi;

  SELECT count(*)::integer, COALESCE(sum(round(x.invoice_amount * 100)), 0)::bigint
    INTO w_paid, w_rev
    FROM jobs x
   WHERE x.user_id = v_pc.tenant_id AND x.invoice_status = 'paid' AND x.invoice_amount IS NOT NULL
     AND x.job_status <> 'cancelled'
     AND COALESCE(x.scheduled_datetime, x.created_at) >= v_wlo
     AND COALESCE(x.scheduled_datetime, x.created_at) < v_hi;

  SELECT COALESCE(sum(x.recovered_amount_cents), 0)::bigint, count(*)::integer
    INTO rc_cents, rc_count
    FROM revenue_recovery_events x
   WHERE x.user_id = v_pc.tenant_id AND x.status = 'recovered'
     AND x.resolved_at >= v_lo AND x.resolved_at < v_hi;

  RETURN QUERY SELECT
    v_days,
    CASE WHEN v_we >= v_pc.started_on THEN (v_we - v_pc.started_on) / 7 + 1 ELSE 0 END,
    CASE WHEN v_days > 0 THEN round(w_calls::numeric / v_days * 7, 1) END,
    CASE WHEN w_calls > 0 THEN round(w_missed::numeric / w_calls * 100, 1) END,
    CASE WHEN w_opps > 0 THEN round(w_booked::numeric / w_opps * 100, 1) END,
    CASE WHEN w_paid > 0 THEN round(w_rev::numeric / w_paid, 0) END,
    CASE WHEN v_days > 0 THEN round(w_rev::numeric / v_days * 7, 0) END,
    round(w_score, 1),
    a_total, a_flagged, rc_cents, rc_count;
END;
$$;

REVOKE ALL ON FUNCTION public.pilot_call_flags(smallint, text, text, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pilot_weekly_series(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pilot_live_metrics(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- STAFF RPCs (each re-checks is_vireek_staff)
-- =============================================================

CREATE OR REPLACE FUNCTION public.staff_list_pilots()
RETURNS TABLE (
  id uuid, tenant_id uuid, status text, started_on date, ended_on date,
  tenant_email text, company_name text, plan text,
  baseline_weekly_calls integer, baseline_missed_call_pct numeric, baseline_booking_rate_pct numeric,
  baseline_avg_job_value_cents integer, baseline_weekly_revenue_cents bigint,
  baseline_source text, baseline_notes text,
  consent_status text, consent_scope text[], consent_evidence text, consent_granted_at timestamptz, notes text,
  live_days integer, weeks_elapsed integer,
  live_weekly_calls numeric, live_missed_call_pct numeric, live_booking_rate_pct numeric,
  live_avg_job_value_cents numeric, live_weekly_revenue_cents numeric, live_avg_call_score numeric,
  total_calls integer, flagged_calls integer, recovered_cents bigint, recovered_count integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT pc.id, pc.tenant_id, pc.status, pc.started_on, pc.ended_on,
         p.email, p.company_name, p.plan,
         pc.baseline_weekly_calls, pc.baseline_missed_call_pct, pc.baseline_booking_rate_pct,
         pc.baseline_avg_job_value_cents, pc.baseline_weekly_revenue_cents,
         pc.baseline_source, pc.baseline_notes,
         pc.consent_status, pc.consent_scope, pc.consent_evidence, pc.consent_granted_at, pc.notes,
         m.live_days, m.weeks_elapsed,
         m.live_weekly_calls, m.live_missed_call_pct, m.live_booking_rate_pct,
         m.live_avg_job_value_cents, m.live_weekly_revenue_cents, m.live_avg_call_score,
         m.total_calls, m.flagged_calls, m.recovered_cents, m.recovered_count,
         pc.updated_at
    FROM pilot_customers pc
    JOIN profiles p ON p.id = pc.tenant_id
   CROSS JOIN LATERAL public.pilot_live_metrics(pc.id) m
   ORDER BY CASE pc.status WHEN 'active' THEN 0 WHEN 'onboarding' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
            pc.started_on DESC, pc.created_at DESC
   LIMIT 500;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pilot_trend(p_pilot_id uuid)
RETURNS TABLE (
  week_index integer, week_start date, week_end date, is_complete boolean,
  total_calls integer, missed_calls integer, booking_opportunities integer, booked integer,
  avg_call_score numeric, flagged_calls integer,
  paid_jobs integer, revenue_cents bigint, recovered_count integer, recovered_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_pc pilot_customers%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pc FROM pilot_customers WHERE id = p_pilot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pilot not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT * FROM public.pilot_weekly_series(
    v_pc.tenant_id, v_pc.started_on, LEAST(COALESCE(v_pc.ended_on, (now() AT TIME ZONE 'UTC')::date), (now() AT TIME ZONE 'UTC')::date));
END;
$$;

-- Flagged calls since the pilot started. No caller name, phone, transcript or summary.
CREATE OR REPLACE FUNCTION public.staff_pilot_quality_flags(p_pilot_id uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (
  call_id uuid, call_datetime timestamptz, duration_seconds integer, call_score smallint,
  sentiment text, intent text, booking_outcome text, flags text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_pc pilot_customers%ROWTYPE;
  v_limit integer := LEAST(200, GREATEST(1, COALESCE(p_limit, 50)));
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pc FROM pilot_customers WHERE id = p_pilot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pilot not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT x.id, x.call_datetime, x.duration_seconds, x.call_score, x.sentiment, x.intent, x.booking_outcome, f.flags
    FROM calls x
   CROSS JOIN LATERAL (SELECT public.pilot_call_flags(
           x.call_score, x.sentiment, x.price_accuracy_status, x.is_emergency, x.booking_outcome, x.objections_resolved) AS flags) f
   WHERE x.user_id = v_pc.tenant_id
     AND x.call_datetime >= (v_pc.started_on::timestamp AT TIME ZONE 'UTC')
     AND x.call_datetime < (((LEAST(COALESCE(v_pc.ended_on, (now() AT TIME ZONE 'UTC')::date), (now() AT TIME ZONE 'UTC')::date)) + 1)::timestamp AT TIME ZONE 'UTC')
     AND cardinality(f.flags) > 0
   ORDER BY x.call_datetime DESC
   LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_pilot_audit(p_pilot_id uuid)
RETURNS TABLE (id bigint, action text, changes jsonb, created_at timestamptz, actor_email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.action, a.changes, a.created_at, ap.email
    FROM pilot_audit a
    LEFT JOIN profiles ap ON ap.id = a.actor
   WHERE a.pilot_id = p_pilot_id
   ORDER BY a.id DESC
   LIMIT 30;
END;
$$;

-- One-click case-study export. Refuses without recorded consent. Audited.
CREATE OR REPLACE FUNCTION public.staff_export_pilot_case_study(p_pilot_id uuid, p_format text DEFAULT 'markdown')
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_pc pilot_customers%ROWTYPE;
  v_company text;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_live record;
  v_weekly jsonb;
  v_name text;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_format NOT IN ('markdown', 'csv', 'json') THEN
    RAISE EXCEPTION 'Format must be markdown, csv or json' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pc FROM pilot_customers WHERE id = p_pilot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pilot not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_pc.consent_status <> 'granted' OR NOT ('metrics' = ANY (v_pc.consent_scope)) THEN
    RAISE EXCEPTION 'Export needs the customer''s recorded consent to share metrics' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_live FROM public.pilot_live_metrics(p_pilot_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.week_index), '[]'::jsonb) INTO v_weekly
    FROM public.pilot_weekly_series(
      v_pc.tenant_id, v_pc.started_on, LEAST(COALESCE(v_pc.ended_on, v_today), v_today)) s;

  SELECT NULLIF(btrim(company_name), '') INTO v_company FROM profiles WHERE id = v_pc.tenant_id;
  v_name := CASE WHEN 'company_name' = ANY (v_pc.consent_scope) AND v_company IS NOT NULL THEN v_company END;

  INSERT INTO pilot_audit (pilot_id, action, changes)
  VALUES (p_pilot_id, 'export', jsonb_build_object('format', p_format, 'named', v_name IS NOT NULL, 'scope', to_jsonb(v_pc.consent_scope)));

  RETURN jsonb_build_object(
    'generated_at', now(),
    'customer_name', v_name,
    'pilot', jsonb_build_object(
      'status', v_pc.status, 'started_on', v_pc.started_on, 'ended_on', v_pc.ended_on,
      'weeks_elapsed', v_live.weeks_elapsed, 'live_days', v_live.live_days),
    'baseline', jsonb_build_object(
      'weekly_calls', v_pc.baseline_weekly_calls,
      'missed_call_pct', v_pc.baseline_missed_call_pct,
      'booking_rate_pct', v_pc.baseline_booking_rate_pct,
      'avg_job_value_cents', v_pc.baseline_avg_job_value_cents,
      'weekly_revenue_cents', v_pc.baseline_weekly_revenue_cents,
      'source', v_pc.baseline_source),
    'live', jsonb_build_object(
      'weekly_calls', v_live.live_weekly_calls,
      'missed_call_pct', v_live.live_missed_call_pct,
      'booking_rate_pct', v_live.live_booking_rate_pct,
      'avg_job_value_cents', v_live.live_avg_job_value_cents,
      'weekly_revenue_cents', v_live.live_weekly_revenue_cents,
      'avg_call_score', v_live.live_avg_call_score,
      'total_calls', v_live.total_calls,
      'recovered_cents', v_live.recovered_cents,
      'recovered_count', v_live.recovered_count),
    'weekly', v_weekly,
    'consent', jsonb_build_object(
      'scope', to_jsonb(v_pc.consent_scope),
      'granted_at', v_pc.consent_granted_at,
      'evidence', v_pc.consent_evidence)
  );
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.staff_list_pilots() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pilot_trend(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pilot_quality_flags(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_pilot_audit(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_export_pilot_case_study(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_list_pilots() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pilot_trend(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pilot_quality_flags(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_pilot_audit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_export_pilot_case_study(uuid, text) TO authenticated;
