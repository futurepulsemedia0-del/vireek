/*
  # Transparency report + public AI incident log

  ## What this adds (purely additive; nothing existing is altered)
  - transparency_reports            one row per half-year. Staff compile exact counts from the REAL source tables, add
                                   the narrative, a counsel approval date and publish. Publishing freezes a public
                                   snapshot; nothing is ever recomputed for the public.
  - transparency_compile_metrics() internal: exact counts for a date range from ai_incidents, dmca_notices,
                                   legal_requests, data_subject_requests and status_incidents. Not callable by any client.
  - transparency_apply_rules()     pure: small-number suppression applied to the public snapshot (rule chosen by counsel).
  - transparency_report_create()   staff RPC: creates a draft for 'YYYY-H1' / 'YYYY-H2' (dates derived from the label).
  - transparency_report_refresh()  staff RPC: recompiles a draft or approved report (an approved one drops back to draft).
  - get_public_transparency_reports()  anon RPC: published reports only, explicit columns, public snapshot only.
  - ai_incident_public_entries     curated PUBLIC log entries about AI-behaviour incidents. Separate from ai_incidents on
                                   purpose: the internal register is never exposed, only what staff wrote for publication.
  - get_public_ai_incident_log()   anon RPC: published entries only, explicit columns. No internal ids or references.

  ## Source of the numbers (period = half-year, UTC)
  ai_incidents.detected_at | dmca_notices.created_at | legal_requests.received_on |
  data_subject_requests.created_at (VERIFIED requests only: unverified ones are scrubbed after 24h) | status_incidents.started_at.
  Counts are exact in the draft. Suppression of small numbers is applied only to the public snapshot, only when
  suppress_below is set, and uniformly to every count (totals included). Whether that is enough to prevent
  differencing is a counsel decision. [COUNSEL]

  ## Security model
  - Tables are staff-only through RLS (is_vireek_staff). anon has NO table privilege; the two public RPCs are the only
    public surface and return a fixed set of columns of published rows.
  - Clients cannot write metrics: authenticated has UPDATE only on the editable text/status columns; compile/refresh run in
    SECURITY DEFINER functions that check is_vireek_staff themselves.
  - NO DELETE privilege and NO DELETE policy. A mistaken publication is withdrawn with status 'unpublished' (kept as a record).
  - Publishing needs a counsel approval date (reports) / a redaction check date AND a counsel approval date (incident entries).
  - Incident entry text is linted by a guard trigger (e-mail, URL, UUID, IPv4, phone-like or long digit runs). It is defence
    in depth, NOT a PII scanner: names and addresses are caught only by the human redaction check.

  ## Requires
  is_vireek_staff(uuid), staff_audit_log, auth.users, ai_incidents, dmca_notices, legal_requests, data_subject_requests,
  status_incidents.

  ## Rollback (manual, destroys drafts and published history; run only on purpose)
  DROP FUNCTION public.get_public_ai_incident_log(); DROP FUNCTION public.get_public_transparency_reports();
  DROP TABLE public.ai_incident_public_entries; DROP TABLE public.transparency_reports;
  DROP FUNCTION public.transparency_report_refresh(uuid); DROP FUNCTION public.transparency_report_create(text, integer);
  DROP FUNCTION public.transparency_compile_metrics(date, date); DROP FUNCTION public.transparency_apply_rules(jsonb, integer);
  DROP FUNCTION public.transparency_reports_guard(); DROP FUNCTION public.transparency_reports_audit();
  DROP FUNCTION public.ai_incident_public_guard(); DROP FUNCTION public.ai_incident_public_lint(text);
  DROP SEQUENCE public.ai_incident_public_seq;
*/

-- rollback: see the commented block above. Published reports are public records: do NOT run without counsel sign-off. [COUNSEL]

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regclass('public.staff_audit_log') IS NULL
     OR to_regclass('public.ai_incidents') IS NULL
     OR to_regclass('public.dmca_notices') IS NULL
     OR to_regclass('public.legal_requests') IS NULL
     OR to_regclass('public.data_subject_requests') IS NULL
     OR to_regclass('public.status_incidents') IS NULL THEN
    RAISE EXCEPTION 'transparency_report: prerequisites missing (is_vireek_staff, staff_audit_log, ai_incidents, dmca_notices, legal_requests, data_subject_requests, status_incidents)';
  END IF;
END $$;

-- =============================================================================================
-- 1. Pure helper: small-number suppression for the public snapshot
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.transparency_apply_rules(p_metrics jsonb, p_suppress_below integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN p_suppress_below IS NOT NULL
         AND (m.e ->> 'count') IS NOT NULL
         AND (m.e ->> 'count')::bigint > 0
         AND (m.e ->> 'count')::bigint < p_suppress_below
        THEN (m.e - 'count') || '{"count": null, "suppressed": true}'::jsonb
        ELSE m.e
      END
      ORDER BY m.ord
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) WITH ORDINALITY AS m(e, ord);
$$;

-- =============================================================================================
-- 2. Compile exact metrics (internal; never callable by a client role)
-- =============================================================================================
-- Output: jsonb array of {"section","metric","dimension","key","count"}. dimension = '' and key = '' mean "total".
-- Every dimension that is exhaustive is zero-filled so that a zero is reported as a zero, and the dimension rows of a
-- metric always add up to its total (asserted in supabase/tests/database/transparency_report.test.sql).
CREATE OR REPLACE FUNCTION public.transparency_compile_metrics(p_start date, p_end date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  b AS (
    SELECT (p_start::timestamp AT TIME ZONE 'UTC') AS s,
           ((p_end + 1)::timestamp AT TIME ZONE 'UTC') AS e
  ),
  ai AS (
    SELECT i.* FROM public.ai_incidents i, b WHERE i.detected_at >= b.s AND i.detected_at < b.e
  ),
  dm AS (
    SELECT n.* FROM public.dmca_notices n, b WHERE n.created_at >= b.s AND n.created_at < b.e
  ),
  lr AS (
    SELECT l.* FROM public.legal_requests l WHERE l.received_on BETWEEN p_start AND p_end
  ),
  lr_disc AS (
    SELECT * FROM lr WHERE outcome IN ('complied_in_full', 'complied_in_part')
  ),
  dr AS (
    SELECT d.*,
           CASE
             WHEN d.status = 'completed' THEN 'completed'
             WHEN d.status = 'rejected' THEN 'rejected'
             WHEN d.status = 'cancelled' THEN 'cancelled'
             WHEN d.status = 'expired' THEN 'expired'
             ELSE 'open'
           END AS outcome_bucket
    FROM public.data_subject_requests d, b
    WHERE d.verified_at IS NOT NULL AND d.created_at >= b.s AND d.created_at < b.e
  ),
  si AS (
    SELECT x.* FROM public.status_incidents x, b WHERE x.started_at >= b.s AND x.started_at < b.e
  ),
  rows AS (
    -- ---- AI incidents
    SELECT 'ai_incidents' AS section, 'received' AS metric, '' AS dimension, '' AS key, (SELECT count(*) FROM ai) AS n
    UNION ALL SELECT 'ai_incidents', 'received', 'incident_type', t, (SELECT count(*) FROM ai WHERE ai.incident_type = t)
      FROM unnest(ARRAY['wrong_diagnosis','wrong_price_commitment','pii_leak_on_call','discriminatory_behavior','prompt_injection','other']) AS t
    UNION ALL SELECT 'ai_incidents', 'received', 'severity', t, (SELECT count(*) FROM ai WHERE ai.severity = t)
      FROM unnest(ARRAY['low','medium','high','critical']) AS t
    UNION ALL SELECT 'ai_incidents', 'customer_notified', '', '', (SELECT count(*) FROM ai WHERE customer_notification = 'sent')
    UNION ALL SELECT 'ai_incidents', 'regulator_notified', '', '', (SELECT count(*) FROM ai WHERE regulator_notification = 'sent')
    -- ---- Copyright takedowns (dmca_notices); legal requests are NOT in this table
    UNION ALL SELECT 'takedowns', 'received', '', '', (SELECT count(*) FROM dm)
    UNION ALL SELECT 'takedowns', 'received', 'notice_type', t, (SELECT count(*) FROM dm WHERE dm.notice_type = t)
      FROM unnest(ARRAY['takedown','counter']) AS t
    UNION ALL SELECT 'takedowns', 'status_at_compile', 'status', t, (SELECT count(*) FROM dm WHERE dm.status = t)
      FROM unnest(ARRAY['new','under_review','content_removed','counter_pending','restored','rejected','closed']) AS t
    -- ---- Legal requests
    UNION ALL SELECT 'legal_requests', 'received', '', '', (SELECT count(*) FROM lr)
    UNION ALL SELECT 'legal_requests', 'received', 'request_type', t, (SELECT count(*) FROM lr WHERE lr.request_type = t)
      FROM unnest(ARRAY['subpoena','court_order','search_warrant','preservation_request','emergency_disclosure','regulator_inquiry','civil_discovery','other']) AS t
    UNION ALL SELECT 'legal_requests', 'received', 'outcome', t, (SELECT count(*) FROM lr WHERE lr.outcome = t)
      FROM unnest(ARRAY['pending','complied_in_full','complied_in_part','objected','challenged','rejected_invalid','no_data_found','withdrawn_by_requester']) AS t
    UNION ALL SELECT 'legal_requests', 'received', 'country', c.country, c.n
      FROM (SELECT jurisdiction_country AS country, count(*) AS n FROM lr GROUP BY 1) AS c
    UNION ALL SELECT 'legal_requests', 'disclosed', '', '', (SELECT count(*) FROM lr_disc)
    UNION ALL SELECT 'legal_requests', 'disclosed', 'data_category', t,
        (SELECT count(*) FROM lr_disc WHERE t = ANY (lr_disc.data_categories))
      FROM unnest(ARRAY['subscriber_info','call_metadata','call_recordings','transcripts','messages','account_records','billing_records','location_data','other']) AS t
    UNION ALL SELECT 'legal_requests', 'accounts_affected', '', '', (SELECT COALESCE(sum(accounts_affected), 0) FROM lr_disc)
    UNION ALL SELECT 'legal_requests', 'nondisclosure_orders', '', '', (SELECT count(*) FROM lr WHERE nondisclosure_order)
    -- ---- Data requests from people (verified only)
    UNION ALL SELECT 'data_requests', 'received', '', '', (SELECT count(*) FROM dr)
    UNION ALL SELECT 'data_requests', 'received', 'request_kind', t, (SELECT count(*) FROM dr WHERE dr.request_kind = t)
      FROM unnest(ARRAY['access','delete','correct']) AS t
    UNION ALL SELECT 'data_requests', 'received', 'outcome', t, (SELECT count(*) FROM dr WHERE dr.outcome_bucket = t)
      FROM unnest(ARRAY['completed','rejected','cancelled','expired','open']) AS t
    UNION ALL SELECT 'data_requests', 'completed_on_time', '', '',
        (SELECT count(*) FROM dr WHERE dr.status = 'completed' AND (dr.due_at IS NULL OR dr.completed_at <= dr.due_at))
    UNION ALL SELECT 'data_requests', 'completed_late', '', '',
        (SELECT count(*) FROM dr WHERE dr.status = 'completed' AND dr.due_at IS NOT NULL AND dr.completed_at > dr.due_at)
    -- ---- Outages (status_incidents)
    UNION ALL SELECT 'outages', 'incidents', '', '', (SELECT count(*) FROM si)
    UNION ALL SELECT 'outages', 'incidents', 'impact', t, (SELECT count(*) FROM si WHERE si.impact = t)
      FROM unnest(ARRAY['minor','major']) AS t
    UNION ALL SELECT 'outages', 'incidents', 'source', t, (SELECT count(*) FROM si WHERE si.source = t)
      FROM unnest(ARRAY['manual','synthetic']) AS t
    UNION ALL SELECT 'outages', 'incidents', 'component', c.component_id, c.n
      FROM (SELECT component_id, count(*) AS n FROM si GROUP BY 1) AS c
    UNION ALL SELECT 'outages', 'open_at_period_end', '', '',
        (SELECT count(*) FROM si, b WHERE si.resolved_at IS NULL OR si.resolved_at >= b.e)
    UNION ALL SELECT 'outages', 'resolved_minutes', 'impact', t,
        (SELECT COALESCE(round(sum(extract(epoch FROM (si.resolved_at - si.started_at)) / 60.0)), 0)::bigint
           FROM si, b WHERE si.impact = t AND si.resolved_at IS NOT NULL AND si.resolved_at < b.e)
      FROM unnest(ARRAY['minor','major']) AS t
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('section', r.section, 'metric', r.metric, 'dimension', r.dimension, 'key', r.key, 'count', r.n)
      ORDER BY r.section, r.metric, r.dimension, r.key
    ),
    '[]'::jsonb
  )
  FROM rows r;
$$;

REVOKE ALL ON FUNCTION public.transparency_compile_metrics(date, date) FROM PUBLIC, anon, authenticated;

-- =============================================================================================
-- 3. Transparency reports
-- =============================================================================================
CREATE TABLE IF NOT EXISTS public.transparency_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_label text NOT NULL CHECK (period_label ~ '^[0-9]{4}-H[12]$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'unpublished')),
  -- Counsel's small-number rule. NULL = none. [COUNSEL]
  suppress_below integer CHECK (suppress_below IS NULL OR suppress_below BETWEEN 2 AND 100),
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,   -- exact counts, staff only
  public_metrics jsonb,                         -- derived once, at publication
  compiled_at timestamptz,
  intro_text text CHECK (intro_text IS NULL OR char_length(intro_text) <= 4000),
  reporting_rules_text text CHECK (reporting_rules_text IS NULL OR char_length(reporting_rules_text) <= 4000),
  corrections_text text CHECK (corrections_text IS NULL OR char_length(corrections_text) <= 2000),
  counsel_approved_on date,
  published_at timestamptz,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transparency_reports_period_valid CHECK (
    period_end >= period_start AND period_end - period_start BETWEEN 180 AND 186
  ),
  CONSTRAINT transparency_reports_approval_needed CHECK (
    status NOT IN ('approved', 'published') OR counsel_approved_on IS NOT NULL
  ),
  CONSTRAINT transparency_reports_published_has_snapshot CHECK (
    status <> 'published' OR (public_metrics IS NOT NULL AND published_at IS NOT NULL)
  )
);

-- At most one PUBLISHED report per half-year; drafts and withdrawn rows are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transparency_reports_published_period
  ON public.transparency_reports (period_label) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_transparency_reports_period
  ON public.transparency_reports (period_start DESC, created_at DESC);

COMMENT ON TABLE public.transparency_reports IS 'Half-yearly transparency reports. Staff only (RLS); public sees get_public_transparency_reports() only. No delete.';

CREATE OR REPLACE FUNCTION public.transparency_reports_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_content_changed boolean;
BEGIN
  NEW.intro_text := nullif(btrim(coalesce(NEW.intro_text, '')), '');
  NEW.reporting_rules_text := nullif(btrim(coalesce(NEW.reporting_rules_text, '')), '');
  NEW.corrections_text := nullif(btrim(coalesce(NEW.corrections_text, '')), '');

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.public_metrics := NULL;
    NEW.published_at := NULL;
    NEW.counsel_approved_on := NULL;
    NEW.created_by := auth.uid();
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.period_label IS DISTINCT FROM OLD.period_label
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'id, period and creation fields are immutable.' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('published', 'unpublished') THEN
    -- Published content is frozen. Only a correction note may be added, or the report withdrawn.
    IF NEW.metrics IS DISTINCT FROM OLD.metrics
       OR NEW.public_metrics IS DISTINCT FROM OLD.public_metrics
       OR NEW.suppress_below IS DISTINCT FROM OLD.suppress_below
       OR NEW.intro_text IS DISTINCT FROM OLD.intro_text
       OR NEW.reporting_rules_text IS DISTINCT FROM OLD.reporting_rules_text
       OR NEW.counsel_approved_on IS DISTINCT FROM OLD.counsel_approved_on
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.compiled_at IS DISTINCT FROM OLD.compiled_at THEN
      RAISE EXCEPTION 'A published report cannot be edited. Add a correction note or withdraw it.' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'unpublished' AND NEW.status <> 'unpublished' THEN
      RAISE EXCEPTION 'A withdrawn report cannot be republished. Create a new draft.' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'unpublished') THEN
      RAISE EXCEPTION 'A published report can only stay published or be withdrawn.' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_content_changed :=
         NEW.metrics IS DISTINCT FROM OLD.metrics
      OR NEW.suppress_below IS DISTINCT FROM OLD.suppress_below
      OR NEW.intro_text IS DISTINCT FROM OLD.intro_text
      OR NEW.reporting_rules_text IS DISTINCT FROM OLD.reporting_rules_text;
    -- Approval is bound to the content it was given for: any change sends the report back to draft.
    IF OLD.status = 'approved' AND NEW.status = 'approved' AND v_content_changed THEN
      NEW.status := 'draft';
      NEW.counsel_approved_on := NULL;
    END IF;
    IF NEW.status = 'draft' THEN
      NEW.counsel_approved_on := NULL;
    END IF;
    NEW.public_metrics := NULL;
    NEW.published_at := NULL;

    IF NEW.status = 'approved' THEN
      IF NEW.intro_text IS NULL OR NEW.reporting_rules_text IS NULL THEN
        RAISE EXCEPTION 'The introduction and the reporting rules must be written before approval.' USING ERRCODE = '23514';
      END IF;
      IF jsonb_array_length(NEW.metrics) = 0 THEN
        RAISE EXCEPTION 'Compile the figures before approval.' USING ERRCODE = '23514';
      END IF;
      IF NEW.counsel_approved_on IS NOT NULL AND NEW.counsel_approved_on > current_date THEN
        RAISE EXCEPTION 'The counsel approval date cannot be in the future.' USING ERRCODE = '22023';
      END IF;
    END IF;

    IF NEW.status = 'published' THEN
      IF OLD.status <> 'approved' THEN
        RAISE EXCEPTION 'Only an approved report can be published.' USING ERRCODE = '23514';
      END IF;
      IF NEW.period_end >= current_date THEN
        RAISE EXCEPTION 'The reporting period has not ended yet.' USING ERRCODE = '23514';
      END IF;
      NEW.public_metrics := public.transparency_apply_rules(NEW.metrics, NEW.suppress_below);
      NEW.published_at := now();
    END IF;
  END IF;

  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transparency_reports_guard ON public.transparency_reports;
CREATE TRIGGER trg_transparency_reports_guard
  BEFORE INSERT OR UPDATE ON public.transparency_reports
  FOR EACH ROW EXECUTE FUNCTION public.transparency_reports_guard();

-- Audit trail: ids and status only (never figures or text).
CREATE OR REPLACE FUNCTION public.transparency_reports_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.corrections_text IS NOT DISTINCT FROM OLD.corrections_text THEN
    RETURN NULL;
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO public.staff_audit_log (staff_id, staff_email, action, metadata)
  VALUES (auth.uid(), v_email, 'explorer_list',
          jsonb_build_object('view', 'transparency_report_change', 'op', TG_OP, 'report_id', NEW.id,
                             'period', NEW.period_label, 'status', NEW.status));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_transparency_reports_audit ON public.transparency_reports;
CREATE TRIGGER trg_transparency_reports_audit
  AFTER INSERT OR UPDATE ON public.transparency_reports
  FOR EACH ROW EXECUTE FUNCTION public.transparency_reports_audit();

REVOKE ALL ON FUNCTION public.transparency_reports_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transparency_reports_audit() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.transparency_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.transparency_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.transparency_reports TO authenticated;
-- Column-level UPDATE: clients can never write metrics, snapshots or timestamps directly.
GRANT UPDATE (status, suppress_below, intro_text, reporting_rules_text, corrections_text, counsel_approved_on)
  ON TABLE public.transparency_reports TO authenticated;

DROP POLICY IF EXISTS transparency_reports_staff_select ON public.transparency_reports;
CREATE POLICY transparency_reports_staff_select ON public.transparency_reports
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS transparency_reports_staff_update ON public.transparency_reports;
CREATE POLICY transparency_reports_staff_update ON public.transparency_reports
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())))
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

-- Deliberately NO insert/delete policy and NO insert/delete privilege: creation goes through the RPC below.

CREATE OR REPLACE FUNCTION public.transparency_report_create(p_period_label text, p_suppress_below integer DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_year integer;
  v_half text;
  v_start date;
  v_end date;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_period_label IS NULL OR p_period_label !~ '^[0-9]{4}-H[12]$' THEN
    RAISE EXCEPTION 'Period must look like 2026-H1 or 2026-H2.' USING ERRCODE = '22023';
  END IF;
  v_year := substr(p_period_label, 1, 4)::integer;
  IF v_year < 2020 THEN
    RAISE EXCEPTION 'Period is too early.' USING ERRCODE = '22023';
  END IF;
  v_half := substr(p_period_label, 6, 2);
  v_start := CASE v_half WHEN 'H1' THEN make_date(v_year, 1, 1) ELSE make_date(v_year, 7, 1) END;
  v_end := CASE v_half WHEN 'H1' THEN make_date(v_year, 6, 30) ELSE make_date(v_year, 12, 31) END;
  IF p_suppress_below IS NOT NULL AND p_suppress_below NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'suppress_below must be between 2 and 100, or empty.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.transparency_reports (period_label, period_start, period_end, suppress_below, metrics, compiled_at)
  VALUES (p_period_label, v_start, v_end, p_suppress_below, public.transparency_compile_metrics(v_start, v_end), now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transparency_report_refresh(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r public.transparency_reports%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.transparency_reports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found.' USING ERRCODE = 'P0002';
  END IF;
  IF r.status IN ('published', 'unpublished') THEN
    RAISE EXCEPTION 'A published or withdrawn report cannot be recompiled.' USING ERRCODE = '42501';
  END IF;
  -- The guard sends an approved report back to draft because its figures changed.
  UPDATE public.transparency_reports
     SET metrics = public.transparency_compile_metrics(r.period_start, r.period_end), compiled_at = now()
   WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transparency_report_create(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transparency_report_refresh(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transparency_report_create(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transparency_report_refresh(uuid) TO authenticated;

-- The refresh UPDATE writes metrics/compiled_at as the function owner; the guard trigger still runs and still resets approval.

CREATE OR REPLACE FUNCTION public.get_public_transparency_reports()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'period_label', t.period_label,
        'period_start', t.period_start,
        'period_end', t.period_end,
        'published_at', t.published_at,
        'counsel_approved_on', t.counsel_approved_on,
        'suppress_below', t.suppress_below,
        'intro_text', t.intro_text,
        'reporting_rules_text', t.reporting_rules_text,
        'corrections_text', t.corrections_text,
        'metrics', t.public_metrics
      )
      ORDER BY t.period_start DESC
    ),
    '[]'::jsonb
  )
  FROM public.transparency_reports t
  WHERE t.status = 'published';
$$;

REVOKE ALL ON FUNCTION public.get_public_transparency_reports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_transparency_reports() TO anon, authenticated;

-- =============================================================================================
-- 4. Public AI incident log (curated, separate from the internal register)
-- =============================================================================================
CREATE SEQUENCE IF NOT EXISTS public.ai_incident_public_seq;

-- Automated redaction lint. Mirrors src/lib/incidentRedaction.ts (keep the two in step). Returns the name of the first
-- rule that matched, or NULL. ISO dates are removed before the digit rules so "2026-03-14" is not read as a phone number.
CREATE OR REPLACE FUNCTION public.ai_incident_public_lint(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean text;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  IF p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' THEN RETURN 'email'; END IF;
  IF p_text ~* '(https?://|www\.)[^\s]+' THEN RETURN 'url'; END IF;
  IF p_text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' THEN RETURN 'uuid'; END IF;
  IF p_text ~ '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}($|[^0-9.])' THEN RETURN 'ip_address'; END IF;
  v_clean := regexp_replace(p_text, '[0-9]{4}-[0-9]{2}-[0-9]{2}', ' ', 'g');
  IF v_clean ~ '([0-9][ ().-]?){7,}' THEN RETURN 'phone_or_long_number'; END IF;
  RETURN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS public.ai_incident_public_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE
    DEFAULT ('PIL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.ai_incident_public_seq')::text, 4, '0')),
  -- Internal pointer to the register row; never returned by the public RPC.
  incident_id uuid REFERENCES public.ai_incidents(id) ON DELETE SET NULL,
  incident_type text NOT NULL CHECK (incident_type IN (
    'wrong_diagnosis', 'wrong_price_commitment', 'pii_leak_on_call', 'discriminatory_behavior', 'prompt_injection', 'other'
  )),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  occurred_on date NOT NULL CHECK (occurred_on >= DATE '2020-01-01'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  what_happened text NOT NULL CHECK (char_length(btrim(what_happened)) BETWEEN 20 AND 2000),
  impact text NOT NULL CHECK (char_length(btrim(impact)) BETWEEN 10 AND 1000),
  what_we_did text NOT NULL CHECK (char_length(btrim(what_we_did)) BETWEEN 10 AND 2000),
  correction_note text CHECK (correction_note IS NULL OR char_length(btrim(correction_note)) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'unpublished')),
  redaction_checked_on date,
  redaction_checked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  counsel_approved_on date,
  published_at timestamptz,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_incident_public_gates CHECK (
    status NOT IN ('approved', 'published')
    OR (redaction_checked_on IS NOT NULL AND counsel_approved_on IS NOT NULL)
  ),
  CONSTRAINT ai_incident_public_published_at CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_incident_public_status ON public.ai_incident_public_entries (status, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_ai_incident_public_incident
  ON public.ai_incident_public_entries (incident_id) WHERE incident_id IS NOT NULL;

COMMENT ON TABLE public.ai_incident_public_entries IS 'Curated public AI-behaviour incident log. Staff only (RLS); public sees get_public_ai_incident_log() only. No delete.';

CREATE OR REPLACE FUNCTION public.ai_incident_public_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rule text;
  v_field text;
  v_content_changed boolean;
BEGIN
  NEW.title := btrim(NEW.title);
  NEW.what_happened := btrim(NEW.what_happened);
  NEW.impact := btrim(NEW.impact);
  NEW.what_we_did := btrim(NEW.what_we_did);
  NEW.correction_note := nullif(btrim(coalesce(NEW.correction_note, '')), '');

  FOREACH v_field IN ARRAY ARRAY['title', 'what_happened', 'impact', 'what_we_did', 'correction_note'] LOOP
    v_rule := public.ai_incident_public_lint(to_jsonb(NEW) ->> v_field);
    IF v_rule IS NOT NULL THEN
      RAISE EXCEPTION 'redaction:%: remove personal data, links and identifiers from "%" before saving.', v_rule, v_field
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF NEW.occurred_on > current_date + 1 THEN
    RAISE EXCEPTION 'occurred_on cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.published_at := NULL;
    NEW.redaction_checked_on := NULL;
    NEW.redaction_checked_by := NULL;
    NEW.counsel_approved_on := NULL;
    NEW.correction_note := NULL;
    NEW.created_by := auth.uid();
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_ref IS DISTINCT FROM OLD.public_ref
     OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'id, public_ref, incident_id and creation fields are immutable.' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('published', 'unpublished') THEN
    IF NEW.incident_type IS DISTINCT FROM OLD.incident_type
       OR NEW.severity IS DISTINCT FROM OLD.severity
       OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.what_happened IS DISTINCT FROM OLD.what_happened
       OR NEW.impact IS DISTINCT FROM OLD.impact
       OR NEW.what_we_did IS DISTINCT FROM OLD.what_we_did
       OR NEW.redaction_checked_on IS DISTINCT FROM OLD.redaction_checked_on
       OR NEW.counsel_approved_on IS DISTINCT FROM OLD.counsel_approved_on
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'A published entry cannot be edited. Add a correction note or withdraw it.' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'unpublished' AND NEW.status <> 'unpublished' THEN
      RAISE EXCEPTION 'A withdrawn entry cannot be republished. Create a new entry.' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'unpublished') THEN
      RAISE EXCEPTION 'A published entry can only stay published or be withdrawn.' USING ERRCODE = '42501';
    END IF;
  ELSE
    NEW.correction_note := NULL;
    v_content_changed :=
         NEW.incident_type IS DISTINCT FROM OLD.incident_type
      OR NEW.severity IS DISTINCT FROM OLD.severity
      OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.what_happened IS DISTINCT FROM OLD.what_happened
      OR NEW.impact IS DISTINCT FROM OLD.impact
      OR NEW.what_we_did IS DISTINCT FROM OLD.what_we_did;
    -- Both approvals are bound to the exact text: any edit sends the entry back to draft and clears them.
    IF v_content_changed AND OLD.status = 'approved' AND NEW.status = 'approved' THEN
      NEW.status := 'draft';
    END IF;
    IF v_content_changed OR NEW.status = 'draft' THEN
      NEW.redaction_checked_on := NULL;
      NEW.redaction_checked_by := NULL;
      NEW.counsel_approved_on := NULL;
    END IF;
    IF NEW.redaction_checked_on IS NOT NULL AND (OLD.redaction_checked_on IS DISTINCT FROM NEW.redaction_checked_on) THEN
      NEW.redaction_checked_by := auth.uid();
    END IF;
    IF NEW.redaction_checked_on > current_date OR NEW.counsel_approved_on > current_date THEN
      RAISE EXCEPTION 'Approval dates cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    NEW.published_at := NULL;
    IF NEW.status = 'published' THEN
      IF OLD.status <> 'approved' THEN
        RAISE EXCEPTION 'Only an approved entry can be published.' USING ERRCODE = '23514';
      END IF;
      NEW.published_at := now();
    END IF;
  END IF;

  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_incident_public_guard ON public.ai_incident_public_entries;
CREATE TRIGGER trg_ai_incident_public_guard
  BEFORE INSERT OR UPDATE ON public.ai_incident_public_entries
  FOR EACH ROW EXECUTE FUNCTION public.ai_incident_public_guard();

REVOKE ALL ON FUNCTION public.ai_incident_public_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.ai_incident_public_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_incident_public_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ai_incident_public_entries TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ai_incident_public_seq TO authenticated;

DROP POLICY IF EXISTS ai_incident_public_staff_select ON public.ai_incident_public_entries;
CREATE POLICY ai_incident_public_staff_select ON public.ai_incident_public_entries
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS ai_incident_public_staff_insert ON public.ai_incident_public_entries;
CREATE POLICY ai_incident_public_staff_insert ON public.ai_incident_public_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS ai_incident_public_staff_update ON public.ai_incident_public_entries;
CREATE POLICY ai_incident_public_staff_update ON public.ai_incident_public_entries
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())))
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

-- Deliberately NO delete policy and NO delete privilege.

CREATE OR REPLACE FUNCTION public.get_public_ai_incident_log()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'public_ref', e.public_ref,
        'incident_type', e.incident_type,
        'severity', e.severity,
        'occurred_on', e.occurred_on,
        'title', e.title,
        'what_happened', e.what_happened,
        'impact', e.impact,
        'what_we_did', e.what_we_did,
        'correction_note', e.correction_note,
        'published_at', e.published_at
      )
      ORDER BY e.occurred_on DESC, e.public_ref DESC
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT * FROM public.ai_incident_public_entries
    WHERE status = 'published'
    ORDER BY occurred_on DESC, public_ref DESC
    LIMIT 500
  ) AS e;
$$;

REVOKE ALL ON FUNCTION public.get_public_ai_incident_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_ai_incident_log() TO anon, authenticated;
