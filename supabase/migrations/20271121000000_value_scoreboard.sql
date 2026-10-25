/*
  # Value Scoreboard  (per-account "Results" page: what Vireek delivered this month)

  ## Why
  Owners see many dashboards but never one defensible answer to "what did this earn me?".
  This adds an append-only value ledger. Every number on the Results page is a row here, every row
  points at the record that justifies it, and measured and estimated value are never mixed.

  ## Tables
  - value_events         append-only ledger (recovered_revenue | saved_hours | avoided_cost)
  - value_event_reviews  append-only owner decisions ("not due to Vireek" / "restored")
  - value_settings       one row per owner: editable assumptions, monthly email opt-in, case-study consent
  - value_statements     one immutable snapshot per account per month + send log

  ## Integrity
  - value_events can never be UPDATEd, DELETEd or TRUNCATEd (RLS has no write policy, privileges are
    revoked, and a trigger blocks it even for the table owner). The only allowed delete is the
    cascade from deleting the account itself (GDPR erasure).
  - Dedupe: UNIQUE (user_id, type, evidence_ref). Re-emitting the same evidence is a silent no-op.
  - Money is integer cents, time is integer minutes. Currency is mandatory on money rows.
  - A measured event may name `supersedes_ref`: the estimate it replaces (no double counting).
  - Emission failures never block the write that caused them (calls / jobs / ledger keep working).

  ## What emits events (all automatic, via triggers)
  - revenue_recovery_events -> recovered                 : measured when the recovering job is paid (invoice amount),
                                                           estimated when owner-entered or not yet paid
  - jobs -> invoice_status = 'paid'                       : measured, when the job came from a call that Vireek
                                                           answered after hours (job created within 14 days)
  - calls (answered, >= 20 s)                             : estimated saved minutes (owner-editable assumption)
  - calls (answered after hours, booking_outcome=booked)  : estimated revenue = avg ticket x close rate
                                                           (replaced by the measured event once the job is paid)
  - public.value_emit_event(...) (service role only)      : integration point for any other feature

  ## Requires
  profiles, calls, jobs, business_profile, revenue_recovery_events (20260922000000),
  get_account_owner_id(), reports_can_access() (20270415000000), is_vireek_staff() (20260913020000).

  ## Cron (monthly email) — run ONCE in the Supabase SQL editor (pg_cron + pg_net enabled)
  Replace <project-ref> and <CRON_SECRET> (same value as the VALUE_SCOREBOARD_CRON_SECRET function secret).
  Hourly on purpose: each owner's send hour is evaluated in their own time zone.

    select cron.schedule('value-scoreboard-hourly', '25 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/value-scoreboard-run',
        headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
        body := jsonb_build_object('action','sweep')
      ); $$);
*/

-- =============================================================
-- 1. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS value_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  avg_ticket_cents integer CHECK (avg_ticket_cents IS NULL OR (avg_ticket_cents > 0 AND avg_ticket_cents <= 100000000)),
  close_rate_bp integer NOT NULL DEFAULT 2500 CHECK (close_rate_bp BETWEEN 0 AND 10000),
  minutes_per_handled_call integer NOT NULL DEFAULT 3 CHECK (minutes_per_handled_call BETWEEN 0 AND 60),
  subscription_cents_override integer CHECK (subscription_cents_override IS NULL OR (subscription_cents_override >= 0 AND subscription_cents_override <= 100000000)),
  timezone text,
  monthly_email_enabled boolean NOT NULL DEFAULT false,
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  extra_recipients text[] NOT NULL DEFAULT '{}' CHECK (cardinality(extra_recipients) <= 10),
  case_study_consent boolean NOT NULL DEFAULT false,
  case_study_consent_at timestamptz,
  case_study_consent_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_value_settings_email ON value_settings(monthly_email_enabled) WHERE monthly_email_enabled;

CREATE OR REPLACE FUNCTION public.value_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  -- Consent metadata is server-controlled so it cannot be spoofed from the client.
  IF TG_OP = 'INSERT' THEN
    IF NEW.case_study_consent THEN
      NEW.case_study_consent_at := now();
      NEW.case_study_consent_by := auth.uid();
    ELSE
      NEW.case_study_consent_at := NULL;
      NEW.case_study_consent_by := NULL;
    END IF;
  ELSIF NEW.case_study_consent IS DISTINCT FROM OLD.case_study_consent THEN
    IF NEW.case_study_consent THEN
      NEW.case_study_consent_at := now();
      NEW.case_study_consent_by := auth.uid();
    ELSE
      NEW.case_study_consent_at := NULL;
      NEW.case_study_consent_by := NULL;
    END IF;
  ELSE
    NEW.case_study_consent_at := OLD.case_study_consent_at;
    NEW.case_study_consent_by := OLD.case_study_consent_by;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_value_settings_guard ON value_settings;
CREATE TRIGGER trg_value_settings_guard
  BEFORE INSERT OR UPDATE ON value_settings
  FOR EACH ROW EXECUTE FUNCTION public.value_settings_guard();

CREATE TABLE IF NOT EXISTS value_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_feature text NOT NULL CHECK (source_feature ~ '^[a-z][a-z0-9_]{1,48}$'),
  type text NOT NULL CHECK (type IN ('recovered_revenue', 'saved_hours', 'avoided_cost')),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 100000000000),
  unit text NOT NULL CHECK (unit IN ('cents', 'minutes')),
  currency text,
  confidence text NOT NULL CHECK (confidence IN ('measured', 'estimated')),
  method_note text NOT NULL CHECK (char_length(method_note) BETWEEN 1 AND 600),
  evidence_ref text NOT NULL CHECK (char_length(evidence_ref) BETWEEN 3 AND 200),
  supersedes_ref text CHECK (supersedes_ref IS NULL OR char_length(supersedes_ref) BETWEEN 3 AND 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_value_events_dedupe UNIQUE (user_id, type, evidence_ref),
  CONSTRAINT value_events_unit_matches_type CHECK (
    (type = 'saved_hours' AND unit = 'minutes' AND currency IS NULL)
    OR (type IN ('recovered_revenue', 'avoided_cost') AND unit = 'cents' AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_value_events_user_time ON value_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_value_events_supersedes ON value_events(user_id, type, supersedes_ref) WHERE supersedes_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_value_events_time ON value_events(occurred_at);

CREATE TABLE IF NOT EXISTS value_event_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  value_event_id uuid NOT NULL REFERENCES value_events(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('not_due_to_vireek', 'restored')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  decided_by uuid NOT NULL DEFAULT auth.uid(),
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_value_event_reviews_event ON value_event_reviews(value_event_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_value_event_reviews_user ON value_event_reviews(user_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS value_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  month_start date NOT NULL,
  period_label text NOT NULL,
  method_version text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  measured_cents bigint NOT NULL DEFAULT 0 CHECK (measured_cents >= 0),
  estimated_cents bigint NOT NULL DEFAULT 0 CHECK (estimated_cents >= 0),
  saved_minutes bigint NOT NULL DEFAULT 0 CHECK (saved_minutes >= 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 524288),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'partial', 'failed')),
  deliveries jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(deliveries) = 'array'),
  send_attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_value_statements_user ON value_statements(user_id, month_start DESC);

-- =============================================================
-- 2. Append-only guard (events + reviews)
-- =============================================================
CREATE OR REPLACE FUNCTION public.value_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deleting an account cascades through the foreign key; that nested delete runs at trigger depth > 1.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS trg_value_events_append_only ON value_events;
CREATE TRIGGER trg_value_events_append_only
  BEFORE UPDATE OR DELETE ON value_events
  FOR EACH ROW EXECUTE FUNCTION public.value_append_only_guard();
DROP TRIGGER IF EXISTS trg_value_events_no_truncate ON value_events;
CREATE TRIGGER trg_value_events_no_truncate
  BEFORE TRUNCATE ON value_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.value_append_only_guard();

DROP TRIGGER IF EXISTS trg_value_event_reviews_append_only ON value_event_reviews;
CREATE TRIGGER trg_value_event_reviews_append_only
  BEFORE UPDATE OR DELETE ON value_event_reviews
  FOR EACH ROW EXECUTE FUNCTION public.value_append_only_guard();
DROP TRIGGER IF EXISTS trg_value_event_reviews_no_truncate ON value_event_reviews;
CREATE TRIGGER trg_value_event_reviews_no_truncate
  BEFORE TRUNCATE ON value_event_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.value_append_only_guard();

-- =============================================================
-- 3. RLS + privileges
-- =============================================================
ALTER TABLE value_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_event_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_statements ENABLE ROW LEVEL SECURITY;

-- Read: the account owner, or a team member with can_view_billing. Never another tenant.
DROP POLICY IF EXISTS "value_events_select" ON value_events;
CREATE POLICY "value_events_select" ON value_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "value_reviews_select" ON value_event_reviews;
CREATE POLICY "value_reviews_select" ON value_event_reviews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "value_settings_select" ON value_settings;
CREATE POLICY "value_settings_select" ON value_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "value_statements_select" ON value_statements;
CREATE POLICY "value_statements_select" ON value_statements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

-- Write: owner only. Events and statements have NO client write policy at all.
DROP POLICY IF EXISTS "value_reviews_insert" ON value_event_reviews;
CREATE POLICY "value_reviews_insert" ON value_event_reviews FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND decided_by = auth.uid()
    AND EXISTS (SELECT 1 FROM value_events e WHERE e.id = value_event_id AND e.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "value_settings_insert" ON value_settings;
CREATE POLICY "value_settings_insert" ON value_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "value_settings_update" ON value_settings;
CREATE POLICY "value_settings_update" ON value_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON value_events, value_event_reviews, value_settings, value_statements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON value_events, value_statements TO authenticated;
GRANT SELECT, INSERT ON value_event_reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE ON value_settings TO authenticated;

-- =============================================================
-- 4. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.value_hhmm(p text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(p, '^(\d{1,2}):(\d{2})');
  IF m IS NULL THEN RETURN NULL; END IF;
  IF m[1]::integer > 24 OR m[2]::integer > 59 THEN RETURN NULL; END IF;
  RETURN m[1]::integer * 60 + m[2]::integer;
END $$;

/* Same rule as RevenueRecoveredCard and the Leak Report (isAfterHours): an unlisted or malformed day
   counts as closed; no hours configured at all means Mon-Fri 08:00-18:00. */
CREATE OR REPLACE FUNCTION public.value_is_after_hours(p_user_id uuid, p_at timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_hours jsonb;
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_mins integer;
  v_day jsonb;
  v_open integer;
  v_close integer;
BEGIN
  SELECT bp.business_hours, bp.timezone INTO v_hours, v_tz
  FROM business_profile bp WHERE bp.user_id = p_user_id LIMIT 1;

  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'America/New_York';
  END IF;

  v_local := p_at AT TIME ZONE v_tz;
  v_dow := EXTRACT(DOW FROM v_local)::integer; -- 0 = Sunday
  v_mins := EXTRACT(HOUR FROM v_local)::integer * 60 + EXTRACT(MINUTE FROM v_local)::integer;

  IF v_hours IS NOT NULL AND jsonb_typeof(v_hours) = 'object' AND v_hours <> '{}'::jsonb THEN
    v_day := v_hours -> (ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[v_dow + 1];
    v_open := public.value_hhmm(v_day ->> 'open');
    v_close := public.value_hhmm(v_day ->> 'close');
    IF v_open IS NULL OR v_close IS NULL THEN RETURN true; END IF;
    RETURN v_mins < v_open OR v_mins >= v_close;
  END IF;

  RETURN v_dow IN (0, 6) OR v_mins < 480 OR v_mins >= 1080;
END $$;

CREATE OR REPLACE FUNCTION public.value_call_was_handled(p_call calls)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_call.status IS DISTINCT FROM 'missed' AND NOT COALESCE(p_call.is_voicemail, false);
$$;

CREATE OR REPLACE FUNCTION public.value_currency_for(p_user_id uuid, p_job_currency text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v text;
BEGIN
  v := upper(NULLIF(trim(COALESCE(p_job_currency, '')), ''));
  IF v IS NULL THEN
    SELECT upper(NULLIF(trim(COALESCE(p.invoice_currency, '')), '')) INTO v FROM profiles p WHERE p.id = p_user_id;
  END IF;
  IF v IS NULL OR v !~ '^[A-Z]{3}$' THEN v := 'USD'; END IF;
  RETURN v;
END $$;

-- =============================================================
-- 5. The one write path into the ledger
-- =============================================================
CREATE OR REPLACE FUNCTION public.value_emit_event(
  p_user_id uuid,
  p_feature text,
  p_type text,
  p_amount bigint,
  p_unit text,
  p_currency text,
  p_confidence text,
  p_note text,
  p_evidence_ref text,
  p_occurred_at timestamptz,
  p_supersedes_ref text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;
  INSERT INTO value_events (
    user_id, source_feature, type, amount, unit, currency, confidence,
    method_note, evidence_ref, supersedes_ref, occurred_at
  )
  VALUES (
    p_user_id, p_feature, p_type, p_amount, p_unit, p_currency, p_confidence,
    left(p_note, 600), p_evidence_ref, p_supersedes_ref, COALESCE(p_occurred_at, now())
  )
  ON CONFLICT ON CONSTRAINT uq_value_events_dedupe DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

REVOKE ALL ON FUNCTION public.value_emit_event(uuid, text, text, bigint, text, text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.value_emit_event(uuid, text, text, bigint, text, text, text, text, text, timestamptz, text) TO service_role;

-- =============================================================
-- 6. Row-level emitters (shared by the triggers and the backfill)
-- =============================================================

-- 6a. Missed-revenue ledger: recovered -> value
CREATE OR REPLACE FUNCTION public.value_emit_for_recovery(p_event revenue_recovery_events, p_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job jobs;
  v_paid boolean := false;
  v_cents bigint;
  v_currency text;
  v_when timestamptz;
BEGIN
  IF p_event.status IS DISTINCT FROM 'recovered' OR COALESCE(p_event.recovered_amount_cents, 0) <= 0 THEN
    RETURN;
  END IF;

  IF p_event.recovered_job_id IS NOT NULL AND COALESCE(p_event.recovery_method, '') <> 'manual' THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_event.recovered_job_id AND user_id = p_event.user_id;
    IF FOUND AND v_job.invoice_status = 'paid' AND COALESCE(v_job.invoice_amount, 0) > 0 THEN
      v_paid := true;
    END IF;
  END IF;

  v_when := COALESCE(p_at, p_event.resolved_at, now());

  IF v_paid THEN
    v_cents := round(v_job.invoice_amount * 100)::bigint;
    v_currency := public.value_currency_for(p_event.user_id, v_job.invoice_currency);
    PERFORM public.value_emit_event(
      p_event.user_id, 'revenue_recovery', 'recovered_revenue', v_cents, 'cents', v_currency, 'measured',
      'Lost opportunity (' || replace(p_event.source_type, '_', ' ') || ') followed up, then its job was paid. Counted at the paid invoice amount.',
      'jobs:' || v_job.id::text, v_when, 'revenue_recovery_events:' || p_event.id::text
    );
  ELSE
    v_cents := p_event.recovered_amount_cents;
    v_currency := public.value_currency_for(p_event.user_id, NULL);
    PERFORM public.value_emit_event(
      p_event.user_id, 'revenue_recovery', 'recovered_revenue', v_cents, 'cents', v_currency, 'estimated',
      CASE WHEN COALESCE(p_event.recovery_method, '') = 'manual'
        THEN 'Marked recovered by you with an amount you entered. Not yet backed by a paid invoice.'
        ELSE 'Recovered (quote accepted or job booked) but the invoice is not paid yet. Replaced by a measured amount once paid.'
      END,
      'revenue_recovery_events:' || p_event.id::text, v_when, NULL
    );
  END IF;
END $$;

-- 6b. Paid job -> value (measured)
CREATE OR REPLACE FUNCTION public.value_emit_for_job(p_job jobs, p_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rec revenue_recovery_events;
  v_attributed boolean := false;
  v_call calls;
  v_cents bigint;
BEGIN
  IF p_job.invoice_status IS DISTINCT FROM 'paid' OR COALESCE(p_job.invoice_amount, 0) <= 0 THEN
    RETURN;
  END IF;

  -- (a) The job closed a lost opportunity from the Recovery Ledger.
  FOR v_rec IN
    SELECT * FROM revenue_recovery_events e
    WHERE e.user_id = p_job.user_id AND e.status = 'recovered' AND e.recovered_job_id = p_job.id
  LOOP
    PERFORM public.value_emit_for_recovery(v_rec, p_at);
    v_attributed := true;
  END LOOP;
  IF v_attributed THEN RETURN; END IF;

  -- (b) The job came from a call that Vireek answered outside business hours.
  IF p_job.call_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_call FROM calls WHERE id = p_job.call_id AND user_id = p_job.user_id;
  IF NOT FOUND OR NOT public.value_call_was_handled(v_call) THEN RETURN; END IF;
  IF p_job.created_at < v_call.call_datetime OR p_job.created_at > v_call.call_datetime + interval '14 days' THEN RETURN; END IF;
  IF NOT public.value_is_after_hours(p_job.user_id, v_call.call_datetime) THEN RETURN; END IF;

  v_cents := round(p_job.invoice_amount * 100)::bigint;
  PERFORM public.value_emit_event(
    p_job.user_id, 'after_hours_answering', 'recovered_revenue', v_cents, 'cents',
    public.value_currency_for(p_job.user_id, p_job.invoice_currency), 'measured',
    'After-hours call answered by Vireek, then a job was booked within 14 days and its invoice was paid. Counted at the paid invoice amount.',
    'jobs:' || p_job.id::text, COALESCE(p_at, now()), 'calls:' || v_call.id::text
  );
END $$;

-- 6c. Answered call -> saved time + after-hours booking estimate (both estimated)
CREATE OR REPLACE FUNCTION public.value_emit_for_call(p_call calls)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_set value_settings;
  v_minutes integer;
  v_close_bp integer;
  v_avg bigint;
  v_est bigint;
BEGIN
  IF NOT public.value_call_was_handled(p_call) THEN RETURN; END IF;

  SELECT * INTO v_set FROM value_settings WHERE user_id = p_call.user_id;
  v_minutes := COALESCE(v_set.minutes_per_handled_call, 3);
  v_close_bp := COALESCE(v_set.close_rate_bp, 2500);

  IF COALESCE(p_call.duration_seconds, 0) >= 20 AND v_minutes > 0 THEN
    PERFORM public.value_emit_event(
      p_call.user_id, 'call_handling', 'saved_hours', v_minutes, 'minutes', NULL, 'estimated',
      'Call handled by Vireek (' || p_call.duration_seconds || ' s). Estimated at ' || v_minutes || ' staff minutes per handled call (editable in Results settings).',
      'calls:' || p_call.id::text, p_call.call_datetime, NULL
    );
  END IF;

  IF p_call.booking_outcome = 'booked' AND public.value_is_after_hours(p_call.user_id, p_call.call_datetime) THEN
    v_avg := v_set.avg_ticket_cents;
    IF v_avg IS NULL THEN
      SELECT round(bp.avg_job_value * 100)::bigint INTO v_avg
      FROM business_profile bp WHERE bp.user_id = p_call.user_id AND bp.avg_job_value > 0 LIMIT 1;
    END IF;
    IF v_avg IS NOT NULL AND v_avg > 0 THEN
      v_est := round((v_avg * v_close_bp)::numeric / 10000)::bigint;
      PERFORM public.value_emit_event(
        p_call.user_id, 'after_hours_answering', 'recovered_revenue', v_est, 'cents',
        public.value_currency_for(p_call.user_id, NULL), 'estimated',
        'After-hours call answered and booked. Estimated at your average ticket x close rate (' || (v_close_bp / 100.0)::numeric(5, 1) || '%). Replaced by a measured amount when the job is paid.',
        'calls:' || p_call.id::text, p_call.call_datetime, NULL
      );
    END IF;
  END IF;
END $$;

-- The row-level emitters take a whole row as input, so they must never be callable by clients
-- (a forged row could otherwise write value into another account). Triggers and the backfill run as owner.
REVOKE ALL ON FUNCTION public.value_emit_for_recovery(revenue_recovery_events, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.value_emit_for_job(jobs, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.value_emit_for_call(calls) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 7. Triggers (a failure here can NEVER block the call, job or ledger write)
-- =============================================================
CREATE OR REPLACE FUNCTION public.value_trg_recovery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.value_emit_for_recovery(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'value_scoreboard: recovery emit failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_value_on_recovery ON revenue_recovery_events;
CREATE TRIGGER trg_value_on_recovery
  AFTER INSERT OR UPDATE OF status, recovered_amount_cents, recovered_job_id ON revenue_recovery_events
  FOR EACH ROW WHEN (NEW.status = 'recovered')
  EXECUTE FUNCTION public.value_trg_recovery();

CREATE OR REPLACE FUNCTION public.value_trg_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.value_emit_for_job(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'value_scoreboard: job emit failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_value_on_job_paid ON jobs;
CREATE TRIGGER trg_value_on_job_paid
  AFTER INSERT OR UPDATE OF invoice_status, invoice_amount ON jobs
  FOR EACH ROW WHEN (NEW.invoice_status = 'paid')
  EXECUTE FUNCTION public.value_trg_job();

CREATE OR REPLACE FUNCTION public.value_trg_call()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.value_emit_for_call(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'value_scoreboard: call emit failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_value_on_call ON calls;
CREATE TRIGGER trg_value_on_call
  AFTER INSERT OR UPDATE OF status, duration_seconds, booking_outcome, is_voicemail ON calls
  FOR EACH ROW EXECUTE FUNCTION public.value_trg_call();

-- =============================================================
-- 8. Backfill (idempotent; the Results page runs it once for an empty account)
-- =============================================================
CREATE OR REPLACE FUNCTION public.value_backfill_internal(p_user_id uuid, p_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => p_days);
  v_before bigint;
  v_after bigint;
  v_rec revenue_recovery_events;
  v_job jobs;
  v_call calls;
BEGIN
  SELECT count(*) INTO v_before FROM value_events WHERE user_id = p_user_id;

  FOR v_rec IN
    SELECT * FROM revenue_recovery_events e
    WHERE e.user_id = p_user_id AND e.status = 'recovered' AND COALESCE(e.resolved_at, e.updated_at) >= v_since
  LOOP
    BEGIN
      PERFORM public.value_emit_for_recovery(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'value_scoreboard: backfill recovery failed: %', SQLERRM;
    END;
  END LOOP;

  FOR v_job IN
    SELECT * FROM jobs j
    WHERE j.user_id = p_user_id AND j.invoice_status = 'paid' AND j.created_at >= v_since
  LOOP
    BEGIN
      PERFORM public.value_emit_for_job(v_job, v_job.created_at);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'value_scoreboard: backfill job failed: %', SQLERRM;
    END;
  END LOOP;

  FOR v_call IN
    SELECT * FROM calls c WHERE c.user_id = p_user_id AND c.call_datetime >= v_since
  LOOP
    BEGIN
      PERFORM public.value_emit_for_call(v_call);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'value_scoreboard: backfill call failed: %', SQLERRM;
    END;
  END LOOP;

  SELECT count(*) INTO v_after FROM value_events WHERE user_id = p_user_id;
  RETURN (v_after - v_before)::integer;
END $$;

REVOKE ALL ON FUNCTION public.value_backfill_internal(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.value_backfill_internal(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.value_backfill_my_account(p_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the account owner can import history' USING ERRCODE = '42501';
  END IF;
  RETURN public.value_backfill_internal(auth.uid(), LEAST(GREATEST(COALESCE(p_days, 90), 1), 365));
END $$;

REVOKE ALL ON FUNCTION public.value_backfill_my_account(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.value_backfill_my_account(integer) TO authenticated;

-- =============================================================
-- 9. Staff view: anonymized aggregates + consented case studies only
-- =============================================================
/* Mirrors the engine's integrity rules (dedupe is the unique constraint; measured supersedes its
   estimate; the owner's newest "not due to Vireek" decision removes an event). Internal only. */
CREATE OR REPLACE FUNCTION public.value_effective_events(p_from timestamptz, p_to timestamptz)
RETURNS SETOF value_events LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.*
  FROM value_events e
  WHERE e.occurred_at >= p_from AND e.occurred_at < p_to
    AND NOT (
      e.confidence = 'estimated'
      AND EXISTS (
        SELECT 1 FROM value_events m
        WHERE m.user_id = e.user_id AND m.type = e.type AND m.confidence = 'measured' AND m.supersedes_ref = e.evidence_ref
      )
    )
    AND COALESCE((
      SELECT r.decision FROM value_event_reviews r
      WHERE r.value_event_id = e.id ORDER BY r.decided_at DESC, r.id DESC LIMIT 1
    ), 'restored') <> 'not_due_to_vireek';
$$;

REVOKE ALL ON FUNCTION public.value_effective_events(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

/* One row per feature/type/confidence/currency. Groups with fewer than 5 accounts are hidden (k-anonymity),
   so a single customer can never be identified from the staff view. Months are UTC calendar months. */
CREATE OR REPLACE FUNCTION public.value_staff_aggregates(p_month text)
RETURNS TABLE (
  feature text,
  value_type text,
  conf text,
  ccy text,
  events bigint,
  accounts bigint,
  total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from timestamptz;
  v_to timestamptz;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'p_month must be YYYY-MM' USING ERRCODE = '22023';
  END IF;
  v_from := make_timestamptz(substr(p_month, 1, 4)::integer, substr(p_month, 6, 2)::integer, 1, 0, 0, 0, 'UTC');
  v_to := v_from + interval '1 month';

  RETURN QUERY
  SELECT e.source_feature, e.type, e.confidence, e.currency,
         count(*)::bigint, count(DISTINCT e.user_id)::bigint, sum(e.amount)::bigint
  FROM public.value_effective_events(v_from, v_to) e
  GROUP BY e.source_feature, e.type, e.confidence, e.currency
  HAVING count(DISTINCT e.user_id) >= 5
  ORDER BY e.type, e.source_feature, e.confidence, e.currency;
END $$;

REVOKE ALL ON FUNCTION public.value_staff_aggregates(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.value_staff_aggregates(text) TO authenticated;

/* Only accounts whose owner switched on "Allow Vireek to use my results in case studies". */
CREATE OR REPLACE FUNCTION public.value_staff_case_studies(p_month text)
RETURNS TABLE (
  account_id uuid,
  company text,
  ccy text,
  measured_cents bigint,
  estimated_cents bigint,
  saved_minutes bigint,
  consented_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from timestamptz;
  v_to timestamptz;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'p_month must be YYYY-MM' USING ERRCODE = '22023';
  END IF;
  v_from := make_timestamptz(substr(p_month, 1, 4)::integer, substr(p_month, 6, 2)::integer, 1, 0, 0, 0, 'UTC');
  v_to := v_from + interval '1 month';

  RETURN QUERY
  WITH cons AS (
    SELECT s.user_id, s.case_study_consent_at FROM value_settings s WHERE s.case_study_consent
  ),
  ev AS (
    SELECT x.* FROM public.value_effective_events(v_from, v_to) x WHERE x.user_id IN (SELECT user_id FROM cons)
  ),
  money AS (
    SELECT ev.user_id,
           ev.currency AS ccy,
           sum(ev.amount) FILTER (WHERE ev.confidence = 'measured') AS measured,
           sum(ev.amount) FILTER (WHERE ev.confidence = 'estimated') AS estimated
    FROM ev WHERE ev.unit = 'cents' GROUP BY ev.user_id, ev.currency
  ),
  mins AS (
    SELECT ev.user_id, sum(ev.amount) AS minutes FROM ev WHERE ev.unit = 'minutes' GROUP BY ev.user_id
  )
  SELECT c.user_id,
         COALESCE(NULLIF(trim(p.company_name), ''), 'Account'),
         m.ccy,
         COALESCE(m.measured, 0)::bigint,
         COALESCE(m.estimated, 0)::bigint,
         COALESCE(n.minutes, 0)::bigint,
         c.case_study_consent_at
  FROM cons c
  JOIN profiles p ON p.id = c.user_id
  LEFT JOIN money m ON m.user_id = c.user_id
  LEFT JOIN mins n ON n.user_id = c.user_id
  WHERE m.user_id IS NOT NULL OR n.user_id IS NOT NULL
  ORDER BY COALESCE(m.measured, 0) DESC, c.user_id;
END $$;

REVOKE ALL ON FUNCTION public.value_staff_case_studies(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.value_staff_case_studies(text) TO authenticated;
