/*
  # Exit-Ready: Lineage, Reconciliation, Staged Data Room, Q&A, Multiple Tables (owner-only)

  Extends the existing Exit Readiness system (20271121000000_exit_readiness.sql). Nothing is dropped
  or renamed; every change is additive. ALL OUTPUTS ARE SCREENING ESTIMATES - not a valuation,
  appraisal, QoE, tax or legal advice.

  ## New tables
  exit_multiple_tables          owner-entered multiples per trade x size band, each with source, date, illustrative flag
  exit_lineage_runs             one row per lineage run (as-of time, logic version, run hash, reconciliation checks)
  exit_lineage_facts            one row per metric per run: value, as-of, logic, source row count, SHA-256 content hash
  exit_dataroom_nda_acceptances append-only NDA acceptance records (owner-supplied NDA text, hashed)
  exit_dataroom_documents       documents shared in a room (minimum stage per document)
  exit_dataroom_doc_access_logs append-only per-document access log
  exit_dataroom_questions       buyer Q&A log (owner answers via RPC)
  exit_audit_events             append-only owner/buyer action audit trail

  ## Changed objects
  exit_readiness_settings   + owner_revenue_share_pct (self-reported owner dependence input)
  exit_dataroom_packages    + stage_content, lineage_run_id, content_hash
  exit_dataroom_links       + room_mode, stage_ceiling, pii_level, nda_*, detailed_*, view_only, watermark_text
  exit_dataroom_open()      CREATE OR REPLACE: legacy links behave exactly as before; staged links get stage-gated content

  ## Security
  - All tables are RLS-scoped to the real account owner (exit_is_owner()). Clients have no write policy on
    lineage, access logs, NDA acceptances, Q&A or audit tables: they change only through SECURITY DEFINER RPCs.
  - Buyer-facing RPCs are service_role only (called by the exit-dataroom-public edge function).
  - Customer PII never enters teaser / NDA-stage content. The detailed stage is built only when the owner
    explicitly approves it per link, after the NDA is accepted, with a chosen PII level.
  - Nothing here sends anything to anyone.

  ## Rollback
  See the commented ROLLBACK block at the end of this file.
*/

-- =============================================================
-- 0. Settings: self-reported owner dependence
-- =============================================================
ALTER TABLE public.exit_readiness_settings
  ADD COLUMN IF NOT EXISTS owner_revenue_share_pct numeric(5,2)
  CHECK (owner_revenue_share_pct IS NULL OR (owner_revenue_share_pct >= 0 AND owner_revenue_share_pct <= 100));

-- =============================================================
-- 1. Audit trail (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'recipient', 'system')),
  action text NOT NULL CHECK (action ~ '^[a-z_]{3,60}$'),
  entity text NOT NULL CHECK (entity ~ '^[a-z_]{3,40}$'),
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exit_audit_owner ON public.exit_audit_events(account_owner_id, created_at DESC);

ALTER TABLE public.exit_audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_audit_owner_select" ON public.exit_audit_events;
CREATE POLICY "exit_audit_owner_select" ON public.exit_audit_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
REVOKE INSERT, UPDATE, DELETE ON public.exit_audit_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public._exit_audit(
  p_owner uuid, p_actor_kind text, p_action text, p_entity text, p_entity_id uuid, p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO exit_audit_events (account_owner_id, actor_user_id, actor_kind, action, entity, entity_id, detail)
  VALUES (p_owner, CASE WHEN p_actor_kind = 'owner' THEN auth.uid() END, p_actor_kind, p_action, p_entity, p_entity_id,
          coalesce(p_detail, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public._exit_audit(uuid, text, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 2. Configurable multiple tables (inputs, never facts)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_multiple_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  industry_key text NOT NULL CHECK (industry_key IN ('hvac', 'plumbing', 'electrical', 'roofing', 'general_trades', 'custom')),
  size_band text NOT NULL CHECK (size_band IN ('under_1m', '1m_to_5m', '5m_to_20m', 'over_20m')),
  basis text NOT NULL CHECK (basis IN ('sde', 'ebitda')),
  multiple_low numeric(5,2) NOT NULL,
  multiple_mid numeric(5,2) NOT NULL,
  multiple_high numeric(5,2) NOT NULL,
  source text NOT NULL CHECK (char_length(btrim(source)) BETWEEN 3 AND 300),
  source_date date NOT NULL,
  is_illustrative boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, industry_key, size_band, basis),
  CONSTRAINT exit_multiple_table_valid CHECK (multiple_low > 0 AND multiple_low <= multiple_mid AND multiple_mid <= multiple_high AND multiple_high <= 20)
);

DROP TRIGGER IF EXISTS trg_exit_multiple_tables_touch ON public.exit_multiple_tables;
CREATE TRIGGER trg_exit_multiple_tables_touch BEFORE INSERT OR UPDATE ON public.exit_multiple_tables
  FOR EACH ROW EXECUTE FUNCTION public.exit_touch();

ALTER TABLE public.exit_multiple_tables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_multiple_tables_owner_all" ON public.exit_multiple_tables;
CREATE POLICY "exit_multiple_tables_owner_all" ON public.exit_multiple_tables FOR ALL TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());

-- =============================================================
-- 3. Lineage tables
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_lineage_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  as_of timestamptz NOT NULL,
  logic_version text NOT NULL,
  facts_count integer NOT NULL DEFAULT 0,
  run_hash text CHECK (run_hash IS NULL OR run_hash ~ '^[0-9a-f]{64}$'),
  reconciliation jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reconciliation) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exit_lineage_runs_owner ON public.exit_lineage_runs(account_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.exit_lineage_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.exit_lineage_runs(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_key text NOT NULL CHECK (metric_key ~ '^[a-z0-9_]{3,60}$'),
  label text NOT NULL,
  value jsonb NOT NULL,
  as_of timestamptz NOT NULL,
  logic_version text NOT NULL,
  logic_text text NOT NULL,
  source_table text NOT NULL,
  source_count bigint NOT NULL CHECK (source_count >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, metric_key)
);
CREATE INDEX IF NOT EXISTS idx_exit_lineage_facts_owner ON public.exit_lineage_facts(account_owner_id, metric_key, created_at DESC);

ALTER TABLE public.exit_lineage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exit_lineage_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_lineage_runs_owner_select" ON public.exit_lineage_runs;
CREATE POLICY "exit_lineage_runs_owner_select" ON public.exit_lineage_runs FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
DROP POLICY IF EXISTS "exit_lineage_facts_owner_select" ON public.exit_lineage_facts;
CREATE POLICY "exit_lineage_facts_owner_select" ON public.exit_lineage_facts FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
REVOKE INSERT, UPDATE, DELETE ON public.exit_lineage_runs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.exit_lineage_facts FROM anon, authenticated;

-- =============================================================
-- 4. Fact registry + deterministic computation
-- =============================================================
CREATE OR REPLACE FUNCTION public._exit_logic_version()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'exit_ready.v1'; $$;

CREATE OR REPLACE FUNCTION public._exit_fact_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'revenue_invoiced_12m', 'revenue_invoiced_prior_12m', 'collected_12m', 'ar_aging', 'customer_concentration',
    'recurring_revenue', 'membership_base', 'membership_renewals_12m', 'call_funnel_12m', 'jobs_12m',
    'workforce', 'compliance', 'gl_revenue_12m', 'owner_dependence'
  ];
$$;

-- label | source table | human-readable, reproducible logic. The SAME logic is executed by _exit_compute_fact.
CREATE OR REPLACE FUNCTION public._exit_fact_meta(p_key text)
RETURNS TABLE(label text, source_table text, logic_text text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT m.label, m.source_table, m.logic_text FROM (VALUES
    ('revenue_invoiced_12m', 'Invoiced revenue, last 12 months', 'ar_invoices',
     'SUM(subtotal_cents), SUM(tax_cents), COUNT(*), COUNT(DISTINCT customer_id) FROM ar_invoices WHERE user_id = :owner AND status NOT IN (''draft'',''void'') AND created_at <= :as_of AND issue_date > :as_of_date - 365 AND issue_date <= :as_of_date'),
    ('revenue_invoiced_prior_12m', 'Invoiced revenue, prior 12 months', 'ar_invoices',
     'Same as revenue_invoiced_12m with issue_date > :as_of_date - 730 AND issue_date <= :as_of_date - 365'),
    ('collected_12m', 'Cash applied to invoices, last 12 months', 'ar_invoices',
     'SUM(amount_paid_cents), COUNT(*) over the revenue_invoiced_12m invoice set (amount_paid_cents is the invoice''s current state)'),
    ('ar_aging', 'Accounts receivable aging', 'ar_invoices',
     'Open invoices (status IN sent, partially_paid, overdue AND total_cents > amount_paid_cents AND created_at <= :as_of): SUM(total_cents - amount_paid_cents) bucketed by :as_of_date - due_date: <=0 current, 1-30, 31-60, 61-90, >90'),
    ('customer_concentration', 'Customer concentration (top 1 / top 5 share of invoiced revenue)', 'ar_invoices',
     'SUM(subtotal_cents) per customer_id over the revenue_invoiced_12m invoice set; NULL customer_id excluded from ranking and reported as unassigned; shares = ranked sum / total'),
    ('recurring_revenue', 'Annualised recurring membership revenue', 'memberships',
     'SUM(CASE billing_interval WHEN monthly THEN price_cents*12 ELSE price_cents END) over memberships JOIN membership_plans WHERE status = active AND started_at <= :as_of AND (cancelled_at IS NULL OR cancelled_at > :as_of)'),
    ('membership_base', 'Membership base and 12-month retention', 'memberships',
     'active at :as_of; active at :as_of - 365d; of those, share not cancelled by :as_of'),
    ('membership_renewals_12m', 'Membership renewal outcomes, last 12 months', 'membership_renewal_cycles',
     'COUNT of cycles with period_end in (:as_of - 365d, :as_of] grouped by stage; renewalRate = renewed / (renewed + lapsed)'),
    ('call_funnel_12m', 'Call-to-booking funnel, last 12 months', 'calls',
     'COUNT calls with call_datetime in (:as_of - 365d, :as_of]; booked = calls having a job with jobs.call_id = calls.id; answer rate is not recorded in the schema and is reported as unavailable'),
    ('jobs_12m', 'Jobs, last 12 months', 'jobs',
     'created: COUNT jobs with created_at in window; completed: completed_at in window; scheduledOpen: job_status = scheduled AND completed_at IS NULL (backlog proxy)'),
    ('workforce', 'Workforce and retention proxy', 'employees',
     'COUNT employees; active = active flag; activeShare = active / total (proxy: separation dates are not stored)'),
    ('compliance', 'Compliance cleanliness', 'technician_credentials',
     'credentials: status = active AND expires_at < :as_of_date (expired) / within 90 days (expiring); documents: expires_on < :as_of_date; permits: status = expired OR (status IN issued, in_inspection AND expires_at < :as_of_date). Rescission records are not tracked in the schema'),
    ('gl_revenue_12m', 'General-ledger revenue, last 12 months', 'journal_lines',
     'SUM(credit_cents - debit_cents) on chart_of_accounts.type = revenue joined to posted journal_entries with entry_date in window'),
    ('owner_dependence', 'Owner dependence (self-reported)', 'exit_readiness_settings',
     'exit_readiness_settings.owner_revenue_share_pct as entered by the owner; not derivable from operational data')
  ) AS m(key, label, source_table, logic_text)
  WHERE m.key = p_key;
$$;

CREATE OR REPLACE FUNCTION public._exit_compute_fact(p_owner uuid, p_key text, p_as_of timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end date := (p_as_of AT TIME ZONE 'UTC')::date;
  v_start date := ((p_as_of AT TIME ZONE 'UTC')::date - 365);
  v_pstart date := ((p_as_of AT TIME ZONE 'UTC')::date - 730);
  v_start_ts timestamptz := (((p_as_of AT TIME ZONE 'UTC')::date - 365)::timestamp AT TIME ZONE 'UTC');
  v_val jsonb;
  v_cnt bigint := 0;
  r record;
BEGIN
  IF p_key = 'revenue_invoiced_12m' OR p_key = 'revenue_invoiced_prior_12m' THEN
    SELECT jsonb_build_object(
             'subtotalCents', coalesce(sum(i.subtotal_cents), 0)::bigint,
             'taxCents', coalesce(sum(i.tax_cents), 0)::bigint,
             'totalCents', coalesce(sum(i.total_cents), 0)::bigint,
             'invoices', count(*)::bigint,
             'customers', count(DISTINCT i.customer_id)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM ar_invoices i
    WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.created_at <= p_as_of
      AND i.issue_date > CASE WHEN p_key = 'revenue_invoiced_12m' THEN v_start ELSE v_pstart END
      AND i.issue_date <= CASE WHEN p_key = 'revenue_invoiced_12m' THEN v_end ELSE v_start END;

  ELSIF p_key = 'collected_12m' THEN
    SELECT jsonb_build_object(
             'paidCents', coalesce(sum(i.amount_paid_cents), 0)::bigint,
             'invoices', count(*)::bigint,
             'overpaidInvoices', count(*) FILTER (WHERE i.amount_paid_cents > i.total_cents)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM ar_invoices i
    WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.created_at <= p_as_of
      AND i.issue_date > v_start AND i.issue_date <= v_end;

  ELSIF p_key = 'ar_aging' THEN
    SELECT jsonb_build_object(
             'currentCents', coalesce(sum(x.open_c) FILTER (WHERE x.days <= 0), 0)::bigint,
             'd1to30Cents', coalesce(sum(x.open_c) FILTER (WHERE x.days BETWEEN 1 AND 30), 0)::bigint,
             'd31to60Cents', coalesce(sum(x.open_c) FILTER (WHERE x.days BETWEEN 31 AND 60), 0)::bigint,
             'd61to90Cents', coalesce(sum(x.open_c) FILTER (WHERE x.days BETWEEN 61 AND 90), 0)::bigint,
             'over90Cents', coalesce(sum(x.open_c) FILTER (WHERE x.days > 90), 0)::bigint,
             'openCents', coalesce(sum(x.open_c), 0)::bigint,
             'invoices', count(*)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM (
      SELECT (i.total_cents - i.amount_paid_cents)::bigint AS open_c, (v_end - i.due_date) AS days
      FROM ar_invoices i
      WHERE i.user_id = p_owner AND i.status IN ('sent', 'partially_paid', 'overdue')
        AND i.total_cents > i.amount_paid_cents AND i.created_at <= p_as_of
    ) x;

  ELSIF p_key = 'customer_concentration' THEN
    WITH per AS (
      SELECT i.customer_id, sum(i.subtotal_cents)::bigint AS c
      FROM ar_invoices i
      WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.created_at <= p_as_of
        AND i.issue_date > v_start AND i.issue_date <= v_end
      GROUP BY i.customer_id
    ), ranked AS (
      SELECT c, row_number() OVER (ORDER BY c DESC) AS rn FROM per WHERE customer_id IS NOT NULL
    ), tot AS (
      SELECT coalesce(sum(c), 0)::bigint AS total,
             coalesce(sum(c) FILTER (WHERE customer_id IS NULL), 0)::bigint AS unassigned,
             count(*) FILTER (WHERE customer_id IS NOT NULL)::bigint AS customers
      FROM per
    )
    SELECT jsonb_build_object(
             'top1Share', CASE WHEN t.total > 0 THEN round(coalesce((SELECT sum(c) FROM ranked WHERE rn <= 1), 0)::numeric / t.total, 4) END,
             'top5Share', CASE WHEN t.total > 0 THEN round(coalesce((SELECT sum(c) FROM ranked WHERE rn <= 5), 0)::numeric / t.total, 4) END,
             'customers', t.customers,
             'unassignedCents', t.unassigned,
             'totalCents', t.total),
           (SELECT count(*) FROM ar_invoices i WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void')
              AND i.created_at <= p_as_of AND i.issue_date > v_start AND i.issue_date <= v_end)
    INTO v_val, v_cnt
    FROM tot t;

  ELSIF p_key = 'recurring_revenue' THEN
    SELECT jsonb_build_object(
             'annualCents', coalesce(sum(CASE WHEN pl.billing_interval = 'monthly' THEN pl.price_cents::bigint * 12 ELSE pl.price_cents::bigint END), 0)::bigint,
             'activeMemberships', count(*)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM memberships m
    JOIN membership_plans pl ON pl.id = m.plan_id
    WHERE m.user_id = p_owner AND m.status = 'active' AND m.started_at IS NOT NULL AND m.started_at <= p_as_of
      AND (m.cancelled_at IS NULL OR m.cancelled_at > p_as_of);

  ELSIF p_key = 'membership_base' THEN
    SELECT jsonb_build_object(
             'activeNow', count(*) FILTER (WHERE m.started_at <= p_as_of AND (m.cancelled_at IS NULL OR m.cancelled_at > p_as_of))::bigint,
             'activeAtWindowStart', count(*) FILTER (WHERE m.started_at <= v_start_ts AND (m.cancelled_at IS NULL OR m.cancelled_at > v_start_ts))::bigint,
             'cancelledFromStartCohort', count(*) FILTER (WHERE m.started_at <= v_start_ts AND m.cancelled_at > v_start_ts AND m.cancelled_at <= p_as_of)::bigint,
             'retention12m', CASE WHEN count(*) FILTER (WHERE m.started_at <= v_start_ts AND (m.cancelled_at IS NULL OR m.cancelled_at > v_start_ts)) > 0
               THEN round(1 - (count(*) FILTER (WHERE m.started_at <= v_start_ts AND m.cancelled_at > v_start_ts AND m.cancelled_at <= p_as_of))::numeric
                 / (count(*) FILTER (WHERE m.started_at <= v_start_ts AND (m.cancelled_at IS NULL OR m.cancelled_at > v_start_ts))), 4) END),
           count(*)
    INTO v_val, v_cnt
    FROM memberships m
    WHERE m.user_id = p_owner AND m.started_at IS NOT NULL;

  ELSIF p_key = 'membership_renewals_12m' THEN
    SELECT jsonb_build_object(
             'renewed', count(*) FILTER (WHERE c.stage = 'renewed')::bigint,
             'lapsed', count(*) FILTER (WHERE c.stage = 'lapsed')::bigint,
             'cycles', count(*)::bigint,
             'renewalRate', CASE WHEN count(*) FILTER (WHERE c.stage IN ('renewed', 'lapsed')) > 0
               THEN round((count(*) FILTER (WHERE c.stage = 'renewed'))::numeric / (count(*) FILTER (WHERE c.stage IN ('renewed', 'lapsed'))), 4) END),
           count(*)
    INTO v_val, v_cnt
    FROM membership_renewal_cycles c
    WHERE c.user_id = p_owner AND c.period_end > v_start_ts AND c.period_end <= p_as_of;

  ELSIF p_key = 'call_funnel_12m' THEN
    SELECT jsonb_build_object(
             'calls', count(*)::bigint,
             'booked', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.call_id = c.id AND j.user_id = p_owner))::bigint,
             'emergency', count(*) FILTER (WHERE c.is_emergency)::bigint,
             'bookingRate', CASE WHEN count(*) > 0
               THEN round((count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.call_id = c.id AND j.user_id = p_owner)))::numeric / count(*), 4) END,
             'answerRate', NULL,
             'answerRateNote', 'Answered/missed is not recorded on the calls table.'),
           count(*)
    INTO v_val, v_cnt
    FROM calls c
    WHERE c.user_id = p_owner AND c.call_datetime > v_start_ts AND c.call_datetime <= p_as_of;

  ELSIF p_key = 'jobs_12m' THEN
    SELECT jsonb_build_object(
             'created', count(*) FILTER (WHERE j.created_at > v_start_ts AND j.created_at <= p_as_of)::bigint,
             'completed', count(*) FILTER (WHERE j.completed_at > v_start_ts AND j.completed_at <= p_as_of)::bigint,
             'scheduledOpen', count(*) FILTER (WHERE j.job_status = 'scheduled' AND j.completed_at IS NULL AND j.created_at <= p_as_of)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM jobs j
    WHERE j.user_id = p_owner AND j.created_at <= p_as_of;

  ELSIF p_key = 'workforce' THEN
    SELECT jsonb_build_object(
             'total', count(*)::bigint,
             'active', count(*) FILTER (WHERE e.active)::bigint,
             'activeShare', CASE WHEN count(*) > 0 THEN round((count(*) FILTER (WHERE e.active))::numeric / count(*), 4) END),
           count(*)
    INTO v_val, v_cnt
    FROM employees e
    WHERE e.user_id = p_owner AND e.created_at <= p_as_of;

  ELSIF p_key = 'compliance' THEN
    SELECT jsonb_build_object(
             'credentialsExpired', (SELECT count(*) FROM technician_credentials t
                WHERE t.user_id = p_owner AND t.status = 'active' AND t.expires_at IS NOT NULL AND t.expires_at < v_end),
             'credentialsExpiring90', (SELECT count(*) FROM technician_credentials t
                WHERE t.user_id = p_owner AND t.status = 'active' AND t.expires_at IS NOT NULL AND t.expires_at >= v_end AND t.expires_at < v_end + 90),
             'documentsExpired', (SELECT count(*) FROM documents d
                WHERE d.user_id = p_owner AND d.expires_on IS NOT NULL AND d.expires_on < v_end),
             'permitsLapsed', (SELECT count(*) FROM permit_applications p
                WHERE p.user_id = p_owner AND (p.status = 'expired'
                  OR (p.status IN ('issued', 'in_inspection') AND p.expires_at IS NOT NULL AND p.expires_at < v_end))),
             'rescissionTracked', false),
           (SELECT count(*) FROM technician_credentials t WHERE t.user_id = p_owner)
             + (SELECT count(*) FROM documents d WHERE d.user_id = p_owner AND d.expires_on IS NOT NULL)
             + (SELECT count(*) FROM permit_applications p WHERE p.user_id = p_owner)
    INTO v_val, v_cnt;

  ELSIF p_key = 'gl_revenue_12m' THEN
    SELECT jsonb_build_object('revenueCents', coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint, 'lines', count(*)::bigint),
           count(*)
    INTO v_val, v_cnt
    FROM journal_lines jl
    JOIN chart_of_accounts c ON c.id = jl.account_id AND c.user_id = p_owner AND c.type = 'revenue'
    JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.user_id = p_owner AND je.status = 'posted'
      AND je.entry_date > v_start AND je.entry_date <= v_end;

  ELSIF p_key = 'owner_dependence' THEN
    SELECT jsonb_build_object('ownerRevenueSharePct', s.owner_revenue_share_pct, 'selfReported', true),
           CASE WHEN s.owner_revenue_share_pct IS NULL THEN 0 ELSE 1 END
    INTO v_val, v_cnt
    FROM exit_readiness_settings s
    WHERE s.account_owner_id = p_owner;
    IF v_val IS NULL THEN
      v_val := jsonb_build_object('ownerRevenueSharePct', NULL, 'selfReported', true);
      v_cnt := 0;
    END IF;

  ELSE
    RAISE EXCEPTION 'Unknown lineage metric.' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('value', v_val, 'count', coalesce(v_cnt, 0));
END;
$$;
REVOKE ALL ON FUNCTION public._exit_compute_fact(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._exit_fact_hash(p_key text, p_version text, p_as_of timestamptz, p_count bigint, p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', p_key, p_version,
    to_char(p_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_count::text, p_value::text), 'UTF8')), 'hex');
$$;

-- =============================================================
-- 5. Reconciliation (differences are reported, never hidden)
-- =============================================================
CREATE OR REPLACE FUNCTION public._exit_recon_item(
  p_key text, p_label text, p_left_label text, p_left bigint, p_right_label text, p_right bigint, p_tol bigint, p_note text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'key', p_key, 'label', p_label, 'leftLabel', p_left_label, 'leftCents', p_left,
    'rightLabel', p_right_label, 'rightCents', p_right,
    'diffCents', CASE WHEN p_left IS NULL OR p_right IS NULL THEN NULL ELSE p_left - p_right END,
    'toleranceCents', p_tol,
    'status', CASE WHEN p_left IS NULL OR p_right IS NULL THEN 'unavailable'
                   WHEN abs(p_left - p_right) <= p_tol THEN 'match' ELSE 'difference' END,
    'note', p_note);
$$;

CREATE OR REPLACE FUNCTION public._exit_reconcile(p_owner uuid, p_as_of timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end date := (p_as_of AT TIME ZONE 'UTC')::date;
  v_start date := ((p_as_of AT TIME ZONE 'UTC')::date - 365);
  v_items jsonb := '[]'::jsonb;
  v_inv_paid bigint; v_inv_jobs bigint; v_pay_sum bigint;
  v_inv_sub bigint; v_gl bigint; v_gl_lines bigint;
  v_nojournal bigint; v_overpaid bigint;
  v_qbo boolean; v_qbo_open bigint;
BEGIN
  -- 1. Invoice-applied cash vs recorded in-person payments (jobs that have an invoice)
  SELECT count(*), coalesce(sum(i.amount_paid_cents), 0)
  INTO v_inv_jobs, v_inv_paid
  FROM ar_invoices i
  WHERE i.user_id = p_owner AND i.job_id IS NOT NULL AND i.status NOT IN ('draft', 'void')
    AND i.created_at <= p_as_of AND i.issue_date > v_start AND i.issue_date <= v_end;
  SELECT coalesce(sum(p.amount_cents), 0) INTO v_pay_sum
  FROM job_payments p
  WHERE p.user_id = p_owner AND p.status = 'succeeded' AND p.voided_at IS NULL AND p.received_at <= p_as_of
    AND p.job_id IN (SELECT i.job_id FROM ar_invoices i
                     WHERE i.user_id = p_owner AND i.job_id IS NOT NULL AND i.status NOT IN ('draft', 'void')
                       AND i.created_at <= p_as_of AND i.issue_date > v_start AND i.issue_date <= v_end);
  v_items := v_items || public._exit_recon_item('invoice_paid_vs_job_payments', 'Invoice cash applied vs recorded job payments',
    'Invoices: amount paid', CASE WHEN v_inv_jobs = 0 THEN NULL ELSE v_inv_paid END,
    'Job payments (succeeded, not voided)', CASE WHEN v_inv_jobs = 0 THEN NULL ELSE v_pay_sum END, 100,
    'job_payments records in-person payments only; a difference can come from payments applied to the invoice by another path. Review, do not assume an error.');

  -- 2. Invoiced revenue (ex-tax) vs general-ledger revenue
  SELECT coalesce(sum(i.subtotal_cents), 0) INTO v_inv_sub
  FROM ar_invoices i
  WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.created_at <= p_as_of
    AND i.issue_date > v_start AND i.issue_date <= v_end;
  SELECT coalesce(sum(jl.credit_cents - jl.debit_cents), 0), count(*) INTO v_gl, v_gl_lines
  FROM journal_lines jl
  JOIN chart_of_accounts c ON c.id = jl.account_id AND c.user_id = p_owner AND c.type = 'revenue'
  JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.user_id = p_owner AND je.status = 'posted'
    AND je.entry_date > v_start AND je.entry_date <= v_end;
  v_items := v_items || public._exit_recon_item('invoiced_vs_gl_revenue', 'Invoiced revenue vs general-ledger revenue',
    'Invoices: subtotal (ex-tax)', v_inv_sub, 'Ledger: revenue accounts', CASE WHEN v_gl_lines = 0 THEN NULL ELSE v_gl END,
    greatest(100, (v_inv_sub / 200)),
    'Tolerance is the larger of $1 or 0.5% of invoiced revenue. Timing, manual journals and non-invoice income can explain differences.');

  -- 3. Invoices not posted to the ledger
  SELECT coalesce(sum(i.total_cents), 0) INTO v_nojournal
  FROM ar_invoices i
  WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.journal_entry_id IS NULL
    AND i.created_at <= p_as_of AND i.issue_date > v_start AND i.issue_date <= v_end;
  v_items := v_items || public._exit_recon_item('invoices_without_journal', 'Invoices with no ledger entry',
    'Invoice total with no journal entry', CASE WHEN v_gl_lines = 0 THEN NULL ELSE v_nojournal END, 'Expected', CASE WHEN v_gl_lines = 0 THEN NULL ELSE 0 END, 0,
    'Only evaluated when the ledger has posted revenue activity in the window.');

  -- 4. Paid more than billed
  SELECT coalesce(sum(greatest(i.amount_paid_cents - i.total_cents, 0)), 0) INTO v_overpaid
  FROM ar_invoices i
  WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.created_at <= p_as_of
    AND i.issue_date > v_start AND i.issue_date <= v_end;
  v_items := v_items || public._exit_recon_item('paid_exceeds_billed', 'Invoices paid above their total',
    'Overpaid amount', v_overpaid, 'Expected', 0, 0,
    'Overpayments or credits applied to the wrong invoice appear here.');

  -- 5. Open accounting-sync findings (only if QuickBooks is connected)
  SELECT EXISTS (SELECT 1 FROM qbo_connections q WHERE q.user_id = p_owner) INTO v_qbo;
  IF v_qbo THEN
    SELECT coalesce(sum(f.cents_at_stake), 0) INTO v_qbo_open
    FROM qbo_recon_findings f WHERE f.user_id = p_owner AND f.status = 'open';
  END IF;
  v_items := v_items || public._exit_recon_item('qbo_open_findings', 'Open QuickBooks reconciliation findings',
    'Cents at stake in open findings', CASE WHEN v_qbo THEN v_qbo_open END, 'Expected', CASE WHEN v_qbo THEN 0 END, 0,
    'Requires a connected QuickBooks company; otherwise reported as unavailable.');

  RETURN v_items;
END;
$$;
REVOKE ALL ON FUNCTION public._exit_reconcile(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. Run lineage + verify (owner RPCs)
-- =============================================================
CREATE OR REPLACE FUNCTION public.exit_run_lineage()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_as_of timestamptz := now();
  v_version text := public._exit_logic_version();
  v_run uuid;
  v_existing uuid;
  v_key text;
  v_res jsonb;
  v_meta record;
  v_hash text;
  v_hashes text := '';
  v_recon jsonb;
  v_n integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('exit_lineage:' || v_owner::text, 0));

  -- Idempotent within 30 seconds: return the run that was just made.
  SELECT r.id INTO v_existing FROM exit_lineage_runs r
  WHERE r.account_owner_id = v_owner AND r.created_at > now() - interval '30 seconds' AND r.run_hash IS NOT NULL
  ORDER BY r.created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('runId', v_existing, 'reused', true);
  END IF;

  INSERT INTO exit_lineage_runs (account_owner_id, as_of, logic_version)
  VALUES (v_owner, v_as_of, v_version) RETURNING id INTO v_run;

  FOREACH v_key IN ARRAY public._exit_fact_keys() LOOP
    v_res := public._exit_compute_fact(v_owner, v_key, v_as_of);
    SELECT * INTO v_meta FROM public._exit_fact_meta(v_key);
    v_hash := public._exit_fact_hash(v_key, v_version, v_as_of, (v_res ->> 'count')::bigint, v_res -> 'value');
    INSERT INTO exit_lineage_facts (run_id, account_owner_id, metric_key, label, value, as_of, logic_version, logic_text,
                                    source_table, source_count, content_hash)
    VALUES (v_run, v_owner, v_key, v_meta.label, v_res -> 'value', v_as_of, v_version, v_meta.logic_text,
            v_meta.source_table, (v_res ->> 'count')::bigint, v_hash);
    v_hashes := v_hashes || v_key || ':' || v_hash || ';';
    v_n := v_n + 1;
  END LOOP;

  v_recon := public._exit_reconcile(v_owner, v_as_of);
  UPDATE exit_lineage_runs
  SET facts_count = v_n,
      reconciliation = v_recon,
      run_hash = encode(sha256(convert_to(v_hashes || v_recon::text, 'UTF8')), 'hex')
  WHERE id = v_run;

  PERFORM public._exit_audit(v_owner, 'owner', 'lineage_run', 'lineage_run', v_run, jsonb_build_object('facts', v_n));
  RETURN jsonb_build_object('runId', v_run, 'reused', false);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_run_lineage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_run_lineage() TO authenticated;

-- Recompute one stored fact from live data at its original as-of time and compare hashes.
-- A mismatch means underlying records changed since the run (mutable fields such as invoice status/paid
-- amount reflect their CURRENT state). It is reported, never hidden.
CREATE OR REPLACE FUNCTION public.exit_verify_fact(p_fact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_f exit_lineage_facts%ROWTYPE;
  v_res jsonb;
  v_hash text;
BEGIN
  SELECT * INTO v_f FROM exit_lineage_facts WHERE id = p_fact_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fact not found.' USING ERRCODE = 'P0002';
  END IF;
  v_res := public._exit_compute_fact(v_owner, v_f.metric_key, v_f.as_of);
  v_hash := public._exit_fact_hash(v_f.metric_key, v_f.logic_version, v_f.as_of, (v_res ->> 'count')::bigint, v_res -> 'value');
  RETURN jsonb_build_object(
    'factId', v_f.id, 'metricKey', v_f.metric_key, 'matches', v_hash = v_f.content_hash,
    'storedHash', v_f.content_hash, 'recomputedHash', v_hash,
    'storedCount', v_f.source_count, 'recomputedCount', (v_res ->> 'count')::bigint,
    'recomputedValue', v_res -> 'value', 'asOf', v_f.as_of);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_verify_fact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_verify_fact(uuid) TO authenticated;

-- =============================================================
-- 7. Staged data room: columns
-- =============================================================
ALTER TABLE public.exit_dataroom_packages
  ADD COLUMN IF NOT EXISTS stage_content jsonb,
  ADD COLUMN IF NOT EXISTS lineage_run_id uuid REFERENCES public.exit_lineage_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.exit_dataroom_links
  ADD COLUMN IF NOT EXISTS room_mode text NOT NULL DEFAULT 'legacy' CHECK (room_mode IN ('legacy', 'staged')),
  ADD COLUMN IF NOT EXISTS stage_ceiling text NOT NULL DEFAULT 'teaser' CHECK (stage_ceiling IN ('teaser', 'nda', 'detailed')),
  ADD COLUMN IF NOT EXISTS pii_level text NOT NULL DEFAULT 'aggregated' CHECK (pii_level IN ('aggregated', 'pseudonymized', 'named')),
  ADD COLUMN IF NOT EXISTS nda_text text CHECK (nda_text IS NULL OR char_length(nda_text) BETWEEN 50 AND 20000),
  ADD COLUMN IF NOT EXISTS nda_text_hash text CHECK (nda_text_hash IS NULL OR nda_text_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS nda_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS detailed_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS detailed_content jsonb,
  ADD COLUMN IF NOT EXISTS view_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS watermark_text text CHECK (watermark_text IS NULL OR char_length(watermark_text) <= 200);

-- =============================================================
-- 8. NDA acceptances, documents, doc access logs, Q&A
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_dataroom_nda_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.exit_dataroom_links(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  signer_name text NOT NULL CHECK (char_length(btrim(signer_name)) BETWEEN 2 AND 120),
  signer_email text NOT NULL CHECK (char_length(signer_email) <= 200 AND signer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nda_text_hash text NOT NULL CHECK (nda_text_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 64),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id)
);

CREATE TABLE IF NOT EXISTS public.exit_dataroom_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.exit_dataroom_links(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  min_stage text NOT NULL DEFAULT 'detailed' CHECK (min_stage IN ('nda', 'detailed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.exit_dataroom_doc_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid REFERENCES public.exit_dataroom_links(id) ON DELETE CASCADE,
  account_owner_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  document_id uuid,
  action text NOT NULL CHECK (action IN ('view', 'denied_stage', 'denied_not_shared')),
  ip_hash text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 64),
  accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exit_doc_logs_owner ON public.exit_dataroom_doc_access_logs(account_owner_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS public.exit_dataroom_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.exit_dataroom_links(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 3 AND 2000),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answer text CHECK (answer IS NULL OR char_length(btrim(answer)) BETWEEN 1 AND 4000),
  answered_at timestamptz,
  answered_by uuid,
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_exit_questions_owner ON public.exit_dataroom_questions(account_owner_id, asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_exit_questions_link ON public.exit_dataroom_questions(link_id, asked_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exit_dataroom_nda_acceptances', 'exit_dataroom_documents', 'exit_dataroom_doc_access_logs', 'exit_dataroom_questions']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner())', t || '_owner_select', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- =============================================================
-- 9. Owner RPCs: create staged room, set stage, share document, answer, revoke-aware
-- =============================================================
CREATE OR REPLACE FUNCTION public._exit_band(p_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_cents IS NULL THEN 'undisclosed'
    WHEN p_cents < 100000000 THEN 'under $1M'
    WHEN p_cents < 250000000 THEN '$1M-$2.5M'
    WHEN p_cents < 500000000 THEN '$2.5M-$5M'
    WHEN p_cents < 1000000000 THEN '$5M-$10M'
    WHEN p_cents < 2000000000 THEN '$10M-$20M'
    ELSE 'over $20M' END;
$$;

CREATE OR REPLACE FUNCTION public.exit_create_staged_room(
  p_label text, p_recipient text, p_expires_hours integer, p_max_views integer, p_nda_text text,
  p_valuation jsonb, p_token_hash text, p_token_hint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_run exit_lineage_runs%ROWTYPE;
  v_facts jsonb;
  v_rev bigint;
  v_content jsonb;
  v_teaser jsonb;
  v_nda jsonb;
  v_package uuid;
  v_link uuid;
  v_expires timestamptz;
  v_addbacks jsonb;
BEGIN
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Name the data room (2-120 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'Links last between 1 hour and 30 days.' USING ERRCODE = '22023';
  END IF;
  IF p_max_views IS NULL OR p_max_views NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Choose between 1 and 1000 views.' USING ERRCODE = '22023';
  END IF;
  IF p_recipient IS NOT NULL AND char_length(p_recipient) > 120 THEN
    RAISE EXCEPTION 'Recipient label too long.' USING ERRCODE = '22023';
  END IF;
  IF p_nda_text IS NULL OR char_length(btrim(p_nda_text)) NOT BETWEEN 50 AND 20000 THEN
    RAISE EXCEPTION 'Paste the NDA text your lawyer approved (50-20000 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_token_hint IS NULL OR char_length(p_token_hint) <> 4 THEN
    RAISE EXCEPTION 'Invalid link token.' USING ERRCODE = '22023';
  END IF;
  IF p_valuation IS NOT NULL AND (jsonb_typeof(p_valuation) <> 'object' OR octet_length(p_valuation::text) > 50000) THEN
    RAISE EXCEPTION 'Invalid estimate summary.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM exit_dataroom_links l
      WHERE l.account_owner_id = v_owner AND l.revoked_at IS NULL AND l.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'You already have 25 active links. Revoke one first.' USING ERRCODE = '53400';
  END IF;

  SELECT * INTO v_run FROM exit_lineage_runs r
  WHERE r.account_owner_id = v_owner AND r.run_hash IS NOT NULL
  ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_run.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Run the lineage check first (it must be less than 24 hours old).' USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(jsonb_object_agg(f.metric_key, jsonb_build_object(
           'label', f.label, 'value', f.value, 'asOf', f.as_of, 'sourceCount', f.source_count, 'hash', f.content_hash)), '{}'::jsonb)
  INTO v_facts FROM exit_lineage_facts f WHERE f.run_id = v_run.id;

  v_rev := nullif(v_facts #>> '{revenue_invoiced_12m,value,subtotalCents}', '')::bigint;

  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'amountCents', a.amount_cents, 'justification', a.justification)
                   ORDER BY a.created_at), '[]'::jsonb)
  INTO v_addbacks FROM exit_addbacks a WHERE a.account_owner_id = v_owner AND a.active;

  v_teaser := jsonb_build_object(
    'revenueBand', public._exit_band(v_rev),
    'jobsCompleted12mBand', CASE
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint IS NULL THEN 'undisclosed'
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint < 500 THEN 'under 500'
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint < 2000 THEN '500-2,000'
        ELSE 'over 2,000' END,
    'hasRecurringRevenue', coalesce((v_facts #>> '{recurring_revenue,value,activeMemberships}')::bigint, 0) > 0,
    'asOf', v_run.as_of,
    'note', 'Teaser contains banded, non-identifying information only.');

  v_nda := jsonb_build_object(
    'facts', v_facts,
    'reconciliation', v_run.reconciliation,
    'addBacks', v_addbacks,
    'estimate', p_valuation,
    'runHash', v_run.run_hash,
    'piiPolicy', 'Aggregates only. No customer names, contacts or addresses.');

  v_content := jsonb_build_object('teaser', v_teaser, 'nda', v_nda);

  INSERT INTO exit_dataroom_packages (account_owner_id, label, sections, include_names, content, stage_content, lineage_run_id, content_hash)
  VALUES (v_owner, btrim(p_label), ARRAY['kpis'], false, '{}'::jsonb, v_content, v_run.id,
          encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex'))
  RETURNING id INTO v_package;

  v_expires := now() + make_interval(hours => p_expires_hours);
  INSERT INTO exit_dataroom_links (package_id, account_owner_id, recipient_label, token_hash, token_hint, expires_at, max_views,
                                   room_mode, stage_ceiling, nda_text, nda_text_hash, view_only, watermark_text)
  VALUES (v_package, v_owner, nullif(btrim(coalesce(p_recipient, '')), ''), p_token_hash, p_token_hint, v_expires, p_max_views,
          'staged', 'teaser', btrim(p_nda_text), encode(sha256(convert_to(btrim(p_nda_text), 'UTF8')), 'hex'), true,
          left(coalesce(nullif(btrim(p_recipient), ''), 'Recipient') || ' | ' || p_token_hint || ' | ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 200))
  RETURNING id INTO v_link;

  PERFORM public._exit_audit(v_owner, 'owner', 'room_created', 'link', v_link, jsonb_build_object('package', v_package, 'runId', v_run.id));
  RETURN jsonb_build_object('linkId', v_link, 'packageId', v_package, 'expiresAt', v_expires);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) TO authenticated;

-- Owner moves a link between stages. 'detailed' requires an accepted NDA and builds the detailed content NOW
-- (frozen at approval) with the chosen PII level. Lowering the ceiling erases any detailed content.
CREATE OR REPLACE FUNCTION public.exit_set_stage(p_link_id uuid, p_ceiling text, p_pii_level text, p_sections text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_link exit_dataroom_links%ROWTYPE;
  v_allowed text[] := ARRAY['financials', 'kpis', 'contracts', 'equipment', 'credentials'];
  v_detailed jsonb;
BEGIN
  IF p_ceiling NOT IN ('teaser', 'nda', 'detailed') THEN
    RAISE EXCEPTION 'Invalid stage.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE id = p_link_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_link.room_mode <> 'staged' THEN
    RAISE EXCEPTION 'Staged room link not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now() THEN
    RAISE EXCEPTION 'This link is revoked or expired.' USING ERRCODE = '55000';
  END IF;

  IF p_ceiling = 'detailed' THEN
    IF v_link.nda_accepted_at IS NULL THEN
      RAISE EXCEPTION 'The recipient must accept the NDA before the detailed stage can be approved.' USING ERRCODE = '55000';
    END IF;
    IF p_pii_level IS NULL OR p_pii_level NOT IN ('aggregated', 'pseudonymized', 'named') THEN
      RAISE EXCEPTION 'Choose a customer-data disclosure level.' USING ERRCODE = '22023';
    END IF;
    IF p_sections IS NULL OR cardinality(p_sections) < 1 OR NOT (p_sections <@ v_allowed) THEN
      RAISE EXCEPTION 'Choose at least one valid detailed section.' USING ERRCODE = '22023';
    END IF;
    v_detailed := public._exit_build_package(v_owner, p_sections, p_pii_level = 'named', NULL);
    IF octet_length(v_detailed::text) > 4000000 THEN
      RAISE EXCEPTION 'Detailed package is too large. Share fewer sections.' USING ERRCODE = '54000';
    END IF;
    UPDATE exit_dataroom_links
    SET stage_ceiling = 'detailed', pii_level = p_pii_level, detailed_content = v_detailed, detailed_approved_at = now()
    WHERE id = p_link_id;
  ELSE
    UPDATE exit_dataroom_links
    SET stage_ceiling = p_ceiling, pii_level = 'aggregated', detailed_content = NULL, detailed_approved_at = NULL
    WHERE id = p_link_id;
  END IF;

  PERFORM public._exit_audit(v_owner, 'owner', 'stage_set', 'link', p_link_id,
    jsonb_build_object('ceiling', p_ceiling, 'piiLevel', CASE WHEN p_ceiling = 'detailed' THEN p_pii_level ELSE 'aggregated' END));
  RETURN jsonb_build_object('linkId', p_link_id, 'stageCeiling', p_ceiling);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_set_stage(uuid, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_set_stage(uuid, text, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.exit_share_document(p_link_id uuid, p_document_id uuid, p_min_stage text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
BEGIN
  IF p_min_stage NOT IN ('nda', 'detailed') THEN
    RAISE EXCEPTION 'Invalid stage.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM exit_dataroom_links l WHERE l.id = p_link_id AND l.account_owner_id = v_owner AND l.room_mode = 'staged') THEN
    RAISE EXCEPTION 'Staged room link not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = p_document_id AND d.user_id = v_owner) THEN
    RAISE EXCEPTION 'Document not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO exit_dataroom_documents (link_id, account_owner_id, document_id, min_stage)
  VALUES (p_link_id, v_owner, p_document_id, p_min_stage)
  ON CONFLICT (link_id, document_id) DO UPDATE SET min_stage = EXCLUDED.min_stage;
  PERFORM public._exit_audit(v_owner, 'owner', 'document_shared', 'document', p_document_id,
    jsonb_build_object('linkId', p_link_id, 'minStage', p_min_stage));
END;
$$;
REVOKE ALL ON FUNCTION public.exit_share_document(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_share_document(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.exit_unshare_document(p_link_id uuid, p_document_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_rows integer;
BEGIN
  DELETE FROM exit_dataroom_documents WHERE link_id = p_link_id AND document_id = p_document_id AND account_owner_id = v_owner;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Shared document not found.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._exit_audit(v_owner, 'owner', 'document_unshared', 'document', p_document_id, jsonb_build_object('linkId', p_link_id));
END;
$$;
REVOKE ALL ON FUNCTION public.exit_unshare_document(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_unshare_document(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.exit_answer_question(p_question_id uuid, p_answer text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_rows integer;
BEGIN
  IF p_answer IS NULL OR char_length(btrim(p_answer)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'Write an answer (1-4000 characters).' USING ERRCODE = '22023';
  END IF;
  UPDATE exit_dataroom_questions
  SET answer = btrim(p_answer), answered_at = now(), answered_by = auth.uid()
  WHERE id = p_question_id AND account_owner_id = v_owner;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Question not found.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._exit_audit(v_owner, 'owner', 'question_answered', 'question', p_question_id);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_answer_question(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_answer_question(uuid, text) TO authenticated;

-- Existing revoke RPC: add an audit row (behaviour otherwise unchanged).
CREATE OR REPLACE FUNCTION public.exit_revoke_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_rows integer;
BEGIN
  UPDATE exit_dataroom_links
  SET revoked_at = now(), detailed_content = NULL
  WHERE id = p_link_id AND account_owner_id = v_owner AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Link not found or already revoked.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._exit_audit(v_owner, 'owner', 'link_revoked', 'link', p_link_id);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_revoke_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_revoke_link(uuid) TO authenticated;

-- =============================================================
-- 10. Buyer RPCs (service_role only; called by exit-dataroom-public)
-- =============================================================
-- Shared link-state check. Returns the locked link row and an outcome; logs the attempt.
CREATE OR REPLACE FUNCTION public._exit_effective_stage(p_link exit_dataroom_links)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_link.stage_ceiling = 'detailed' AND p_link.nda_accepted_at IS NOT NULL AND p_link.detailed_content IS NOT NULL THEN 'detailed'
    WHEN p_link.stage_ceiling IN ('nda', 'detailed') AND p_link.nda_accepted_at IS NOT NULL THEN 'nda'
    ELSE 'teaser' END;
$$;

CREATE OR REPLACE FUNCTION public.exit_dataroom_open(p_token_hash text, p_ip_hash text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_content jsonb;
  v_label text;
  v_outcome text;
  v_ua text := left(coalesce(p_user_agent, ''), 200);
  v_stage text;
  v_body jsonb;
  v_docs jsonb;
  v_qa jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  IF p_ip_hash IS NOT NULL AND (
    SELECT count(*) FROM exit_dataroom_access_logs
    WHERE ip_hash = p_ip_hash AND accessed_at > now() - interval '10 minutes'
  ) >= 30 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited');
  END IF;

  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
    VALUES (NULL, NULL, 'invalid_token', left(p_ip_hash, 64), nullif(v_ua, ''));
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  IF v_link.revoked_at IS NOT NULL THEN
    v_outcome := 'revoked';
  ELSIF v_link.expires_at <= now() THEN
    v_outcome := 'expired';
  ELSIF v_link.view_count >= v_link.max_views THEN
    v_outcome := 'exhausted';
  ELSE
    v_outcome := 'granted';
  END IF;

  INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
  VALUES (v_link.id, v_link.account_owner_id, v_outcome, left(p_ip_hash, 64), nullif(v_ua, ''));

  IF v_outcome <> 'granted' THEN
    RETURN jsonb_build_object('outcome', v_outcome);
  END IF;

  UPDATE exit_dataroom_links
  SET view_count = view_count + 1, last_viewed_at = now()
  WHERE id = v_link.id;

  SELECT p.content, p.label INTO v_content, v_label FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;

  IF v_link.room_mode = 'legacy' THEN
    RETURN jsonb_build_object(
      'outcome', 'granted',
      'label', v_label,
      'expiresAt', v_link.expires_at,
      'viewsRemaining', v_link.max_views - v_link.view_count - 1,
      'content', v_content
    );
  END IF;

  v_stage := public._exit_effective_stage(v_link);
  SELECT p.stage_content INTO v_content FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;

  v_body := jsonb_build_object('teaser', v_content -> 'teaser');
  IF v_stage IN ('nda', 'detailed') THEN
    v_body := v_body || jsonb_build_object('nda', v_content -> 'nda');
  END IF;
  IF v_stage = 'detailed' THEN
    v_body := v_body || jsonb_build_object('detailed', v_link.detailed_content);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('documentId', d.id, 'title', d.title, 'category', d.category,
           'fileName', d.current_file_name, 'minStage', x.min_stage) ORDER BY d.title), '[]'::jsonb)
  INTO v_docs
  FROM exit_dataroom_documents x
  JOIN documents d ON d.id = x.document_id
  WHERE x.link_id = v_link.id
    AND (x.min_stage = 'nda' AND v_stage IN ('nda', 'detailed') OR x.min_stage = 'detailed' AND v_stage = 'detailed');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'askedAt', q.asked_at,
           'answer', q.answer, 'answeredAt', q.answered_at) ORDER BY q.asked_at), '[]'::jsonb)
  INTO v_qa
  FROM exit_dataroom_questions q WHERE q.link_id = v_link.id;

  RETURN jsonb_build_object(
    'outcome', 'granted',
    'mode', 'staged',
    'label', v_label,
    'expiresAt', v_link.expires_at,
    'viewsRemaining', v_link.max_views - v_link.view_count - 1,
    'stage', v_stage,
    'stageCeiling', v_link.stage_ceiling,
    'ndaRequired', v_link.stage_ceiling IN ('nda', 'detailed') AND v_link.nda_accepted_at IS NULL,
    'ndaText', CASE WHEN v_link.stage_ceiling IN ('nda', 'detailed') AND v_link.nda_accepted_at IS NULL THEN v_link.nda_text END,
    'viewOnly', v_link.view_only,
    'watermark', v_link.watermark_text,
    'content', v_body,
    'documents', v_docs,
    'questions', v_qa
  );
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_open(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_open(text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.exit_dataroom_accept_nda(
  p_token_hash text, p_ip_hash text, p_signer_name text, p_signer_email text, p_agree boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_agree IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_link.room_mode <> 'staged' OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  IF v_link.stage_ceiling = 'teaser' OR v_link.nda_text_hash IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_offered');
  END IF;
  IF v_link.nda_accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_accepted');
  END IF;
  IF p_signer_name IS NULL OR char_length(btrim(p_signer_name)) NOT BETWEEN 2 AND 120
     OR p_signer_email IS NULL OR char_length(p_signer_email) > 200 OR p_signer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  INSERT INTO exit_dataroom_nda_acceptances (link_id, account_owner_id, signer_name, signer_email, nda_text_hash, ip_hash)
  VALUES (v_link.id, v_link.account_owner_id, btrim(p_signer_name), btrim(p_signer_email), v_link.nda_text_hash, left(p_ip_hash, 64));
  UPDATE exit_dataroom_links SET nda_accepted_at = now() WHERE id = v_link.id;
  PERFORM public._exit_audit(v_link.account_owner_id, 'recipient', 'nda_accepted', 'link', v_link.id,
    jsonb_build_object('signerEmailDomain', split_part(btrim(p_signer_email), '@', 2)));
  RETURN jsonb_build_object('outcome', 'accepted');
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_accept_nda(text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_accept_nda(text, text, text, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.exit_dataroom_ask(p_token_hash text, p_ip_hash text, p_question text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_question IS NULL
     OR char_length(btrim(p_question)) NOT BETWEEN 3 AND 2000 THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_link.room_mode <> 'staged' OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  IF public._exit_effective_stage(v_link) = 'teaser' THEN
    RETURN jsonb_build_object('outcome', 'nda_required');
  END IF;
  IF (SELECT count(*) FROM exit_dataroom_questions q WHERE q.link_id = v_link.id AND q.asked_at > now() - interval '1 day') >= 20 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited');
  END IF;
  INSERT INTO exit_dataroom_questions (link_id, account_owner_id, question)
  VALUES (v_link.id, v_link.account_owner_id, btrim(p_question)) RETURNING id INTO v_id;
  PERFORM public._exit_audit(v_link.account_owner_id, 'recipient', 'question_asked', 'question', v_id);
  RETURN jsonb_build_object('outcome', 'asked', 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_ask(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_ask(text, text, text) TO service_role;

-- Authorises one document view for a staged link and logs it. The edge function (Part 4) serves the file
-- only when this returns granted = true.
CREATE OR REPLACE FUNCTION public.exit_dataroom_authorize_document(p_token_hash text, p_ip_hash text, p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_min text;
  v_stage text;
  v_path text;
  v_name text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_document_id IS NULL THEN
    RETURN jsonb_build_object('granted', false);
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash;
  IF NOT FOUND OR v_link.room_mode <> 'staged' OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now() THEN
    RETURN jsonb_build_object('granted', false);
  END IF;
  SELECT x.min_stage INTO v_min FROM exit_dataroom_documents x WHERE x.link_id = v_link.id AND x.document_id = p_document_id;
  IF NOT FOUND THEN
    INSERT INTO exit_dataroom_doc_access_logs (link_id, account_owner_id, document_id, action, ip_hash)
    VALUES (v_link.id, v_link.account_owner_id, p_document_id, 'denied_not_shared', left(p_ip_hash, 64));
    RETURN jsonb_build_object('granted', false);
  END IF;
  v_stage := public._exit_effective_stage(v_link);
  IF NOT (v_min = 'nda' AND v_stage IN ('nda', 'detailed') OR v_min = 'detailed' AND v_stage = 'detailed') THEN
    INSERT INTO exit_dataroom_doc_access_logs (link_id, account_owner_id, document_id, action, ip_hash)
    VALUES (v_link.id, v_link.account_owner_id, p_document_id, 'denied_stage', left(p_ip_hash, 64));
    RETURN jsonb_build_object('granted', false);
  END IF;
  SELECT v.storage_path, v.file_name INTO v_path, v_name
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
  WHERE d.id = p_document_id AND d.user_id = v_link.account_owner_id;
  IF v_path IS NULL THEN
    RETURN jsonb_build_object('granted', false);
  END IF;
  INSERT INTO exit_dataroom_doc_access_logs (link_id, account_owner_id, document_id, action, ip_hash)
  VALUES (v_link.id, v_link.account_owner_id, p_document_id, 'view', left(p_ip_hash, 64));
  RETURN jsonb_build_object('granted', true, 'storagePath', v_path, 'fileName', v_name,
                            'viewOnly', v_link.view_only, 'watermark', v_link.watermark_text);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_authorize_document(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_authorize_document(text, text, uuid) TO service_role;

/*
  ROLLBACK (manual; run only if you must undo this migration - it deletes lineage/Q&A/NDA records):
    DROP FUNCTION IF EXISTS public.exit_dataroom_authorize_document(text, text, uuid);
    DROP FUNCTION IF EXISTS public.exit_dataroom_ask(text, text, text);
    DROP FUNCTION IF EXISTS public.exit_dataroom_accept_nda(text, text, text, text, boolean);
    DROP FUNCTION IF EXISTS public._exit_effective_stage(exit_dataroom_links);
    DROP FUNCTION IF EXISTS public.exit_answer_question(uuid, text);
    DROP FUNCTION IF EXISTS public.exit_unshare_document(uuid, uuid);
    DROP FUNCTION IF EXISTS public.exit_share_document(uuid, uuid, text);
    DROP FUNCTION IF EXISTS public.exit_set_stage(uuid, text, text, text[]);
    DROP FUNCTION IF EXISTS public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text);
    DROP FUNCTION IF EXISTS public._exit_band(bigint);
    DROP FUNCTION IF EXISTS public.exit_verify_fact(uuid);
    DROP FUNCTION IF EXISTS public.exit_run_lineage();
    DROP TABLE IF EXISTS public.exit_dataroom_questions, public.exit_dataroom_doc_access_logs,
      public.exit_dataroom_documents, public.exit_dataroom_nda_acceptances, public.exit_lineage_facts,
      public.exit_lineage_runs, public.exit_multiple_tables, public.exit_audit_events CASCADE;
    -- Then restore exit_dataroom_open() and exit_revoke_link() from 20271121000000_exit_readiness.sql.
    -- Columns added to exit_dataroom_links / exit_dataroom_packages / exit_readiness_settings are harmless and may stay.
*/
