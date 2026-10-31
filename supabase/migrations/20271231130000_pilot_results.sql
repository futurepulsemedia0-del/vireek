/*
  # Pilot Results — minimal outcome measurement (tenant-facing, one page)

  ## What
  - pilot_outcomes : one row per tenant. Created by pilot_start(), which freezes a BASELINE computed
                     from the tenant's own records at that moment. The baseline can never be edited.
                     Only fee_pct (optional, % of attributed recovered $) can change later.
  - pilot_hours    : manual time entries (minutes). Labeled "manual entry" everywhere.
  Everything else is COMPUTED ON READ from existing tables (warranty_claims, warranty_eligible_jobs,
  invoices, payment_requests, jobs, supplier_claim_packets). Nothing is stored that could drift,
  nothing is AI-estimated.

  ## Definitions (single source of truth = this file; all dates are UTC)
  - unclaimed-eligible warranty $ = SUM(jobs.invoice_amount) over DISTINCT jobs in warranty_eligible_jobs.
      This is the job's invoice total, NOT the claimable part/labor cost, so it is an upper bound and is
      labeled "estimate" in the payload.
  - claims filed (6 mo) = warranty_claims.submitted_at in the last 6 months.
  - claims paid (6 mo)  = warranty_claims.credit_received_cents > 0 with credit_received_at in the last 6 months.
  - invoices > 60 days  = invoices status sent|viewed, not trashed, whose age basis is more than 60 days old.
      age basis = due_date, else the date it was sent. Total = pilot_invoice_total_cents(line_items, tax_percent).
  - avg days-to-pay (commercial) = AVG(paid date - sent date) over invoices paid in the last 6 months whose
      job has customer_type = 'commercial'. NULL (never 0) when there is no sample.

  ## Attribution (a recovered $ counts ONLY with a documented preceding action)
  Candidates (both must have happened on/after the pilot start date):
    - warranty claim with credit_received_cents > 0            -> amount = credit_received_cents
    - invoice paid AFTER its due_date                          -> amount = invoice total
  Counted only if an action exists on/after the pilot start date and on/before the recovery date:
    - packet_sent       : warranty_claims.submitted_at, or supplier_claim_packets.sent_marked_at
    - approval_attached : supplier_claim_packets.approved_at (human approval) for that claim
    - reminder          : payment_requests.last_reminder_sent_at for the invoice's job, at most 14 days
                          before payment (same window as the Money Recovered engine, conservative-v1)
  No action => counted = false (reason 'no_preceding_action'), shown but never added to the total.

  ## Security
  - RLS on both tables keyed to get_account_owner_id() + reports_can_access() (owner or can_view_billing).
  - No client INSERT/UPDATE/DELETE on pilot_outcomes; writes go through owner-only SECURITY DEFINER RPCs.
  - pilot_figures / pilot_attributions / pilot_results_core are SECURITY DEFINER and executable by
    service_role ONLY; every query inside is explicitly filtered by p_tenant.
  - pilot_results() (authenticated) re-derives the tenant from the session and re-checks access.

  ## Depends on
  20260922000000 (revenue_recovery_events), 20261121000000 (warranty_claims, warranty_eligible_jobs),
  20261205000000 (invoices), 20260916010000 (payment_requests), 20260913080000 (jobs.customer_type),
  20271122000000 (supplier_claim_packets, supplier_audit_findings), 20270415000000 (reports_can_access),
  20270402000000 (invoices.deleted_at).

  ## Rollback
  DROP FUNCTION pilot_results(), pilot_start(), pilot_set_fee_pct(numeric), pilot_results_core(uuid),
  pilot_attributions(uuid), pilot_figures(uuid), pilot_invoice_total_cents(jsonb, numeric);
  then DROP TABLE pilot_hours, pilot_outcomes. (Baselines are lost on rollback; keep a copy if needed.)
*/

-- =============================================================
-- 1. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS pilot_outcomes (
  tenant_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline) = 'object' AND pg_column_size(baseline) <= 4096),
  fee_pct numeric(5, 2) CHECK (fee_pct IS NULL OR fee_pct BETWEEN 0 AND 100),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pilot_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_hours_not_future CHECK (entry_on <= ((now() AT TIME ZONE 'UTC')::date) + 1)
);
CREATE INDEX IF NOT EXISTS idx_pilot_hours_tenant ON pilot_hours(tenant_id, entry_on DESC);

-- The baseline and start time are immutable; only fee_pct may change.
CREATE OR REPLACE FUNCTION public.pilot_outcomes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.baseline IS DISTINCT FROM OLD.baseline
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The pilot baseline cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pilot_outcomes_guard ON pilot_outcomes;
CREATE TRIGGER trg_pilot_outcomes_guard
  BEFORE UPDATE ON pilot_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.pilot_outcomes_guard();

-- =============================================================
-- 2. RLS
-- =============================================================
ALTER TABLE pilot_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pilot_outcomes_select" ON pilot_outcomes;
CREATE POLICY "pilot_outcomes_select" ON pilot_outcomes FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.reports_can_access(tenant_id));
-- No INSERT / UPDATE / DELETE policy on pilot_outcomes: pilot_start() and pilot_set_fee_pct() only.
REVOKE INSERT, UPDATE, DELETE ON pilot_outcomes FROM anon, authenticated;

DROP POLICY IF EXISTS "pilot_hours_select" ON pilot_hours;
CREATE POLICY "pilot_hours_select" ON pilot_hours FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.reports_can_access(tenant_id));
DROP POLICY IF EXISTS "pilot_hours_insert" ON pilot_hours;
CREATE POLICY "pilot_hours_insert" ON pilot_hours FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.reports_can_access(tenant_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "pilot_hours_delete" ON pilot_hours;
CREATE POLICY "pilot_hours_delete" ON pilot_hours FOR DELETE TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.reports_can_access(tenant_id) AND created_by = auth.uid());
REVOKE UPDATE ON pilot_hours FROM anon, authenticated;

-- =============================================================
-- 3. MATH HELPERS (DB only)
-- =============================================================
-- Invoice total in cents from the shared line_items shape {description, quantity, unit_price_cents}.
-- Malformed items count as 0 instead of failing the whole report.
CREATE OR REPLACE FUNCTION public.pilot_invoice_total_cents(p_items jsonb, p_tax numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(
    round(
      COALESCE(sum(
        CASE
          WHEN (e ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$' AND (e ->> 'unit_price_cents') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN (e ->> 'quantity')::numeric * (e ->> 'unit_price_cents')::numeric
          ELSE 0
        END
      ), 0) * (1 + GREATEST(COALESCE(p_tax, 0), 0) / 100)
    )::bigint,
    0
  )
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) AS e
$$;

-- The four baseline figures (+ claim counts), as of NOW. Used for the frozen baseline AND the live "now" column.
CREATE OR REPLACE FUNCTION public.pilot_figures(p_tenant uuid)
RETURNS TABLE (
  unclaimed_warranty_cents bigint,
  unclaimed_warranty_jobs integer,
  claims_filed_6m integer,
  claims_paid_6m integer,
  claims_paid_cents_6m bigint,
  overdue60_cents bigint,
  overdue60_count integer,
  avg_days_to_pay_commercial numeric,
  avg_days_sample integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (SELECT now() AS t, (now() AT TIME ZONE 'UTC')::date AS d),
  elig AS (
    SELECT DISTINCT ON (e.job_id) e.job_id, COALESCE(e.invoice_amount, 0) AS amt
    FROM warranty_eligible_jobs e
    WHERE e.user_id = p_tenant
    ORDER BY e.job_id
  ),
  cl AS (
    SELECT
      (count(*) FILTER (WHERE c.submitted_at >= w.t - interval '6 months'))::integer AS filed,
      (count(*) FILTER (WHERE COALESCE(c.credit_received_cents, 0) > 0 AND c.credit_received_at >= w.d - interval '6 months'))::integer AS paid,
      COALESCE(sum(c.credit_received_cents) FILTER (WHERE COALESCE(c.credit_received_cents, 0) > 0 AND c.credit_received_at >= w.d - interval '6 months'), 0)::bigint AS paid_cents
    FROM warranty_claims c, w
    WHERE c.user_id = p_tenant
  ),
  od AS (
    SELECT
      count(*)::integer AS n,
      COALESCE(sum(public.pilot_invoice_total_cents(i.line_items, i.tax_percent)), 0)::bigint AS cents
    FROM invoices i, w
    WHERE i.user_id = p_tenant
      AND i.deleted_at IS NULL
      AND i.status IN ('sent', 'viewed')
      AND COALESCE(i.due_date, (i.sent_at AT TIME ZONE 'UTC')::date) < w.d - 60
  ),
  dp AS (
    SELECT
      round(avg(((i.paid_at AT TIME ZONE 'UTC')::date - (i.sent_at AT TIME ZONE 'UTC')::date)::numeric), 2) AS avg_days,
      count(*)::integer AS n
    FROM invoices i
    JOIN jobs j ON j.id = i.job_id AND j.user_id = p_tenant, w
    WHERE i.user_id = p_tenant
      AND i.deleted_at IS NULL
      AND i.status = 'paid'
      AND i.sent_at IS NOT NULL
      AND i.paid_at IS NOT NULL
      AND i.paid_at >= i.sent_at
      AND i.paid_at >= w.t - interval '6 months'
      AND j.customer_type = 'commercial'
  )
  SELECT
    round(COALESCE((SELECT sum(amt) FROM elig), 0) * 100)::bigint,
    (SELECT count(*) FROM elig)::integer,
    cl.filed, cl.paid, cl.paid_cents,
    od.cents, od.n,
    dp.avg_days, dp.n
  FROM cl, od, dp
$$;

-- Every candidate recovered $ since the pilot started, with the preceding action (or why it is not counted).
CREATE OR REPLACE FUNCTION public.pilot_attributions(p_tenant uuid)
RETURNS TABLE (
  kind text,
  ref_id uuid,
  ref_label text,
  amount_cents bigint,
  recovered_on date,
  action_kind text,
  action_on date,
  counted boolean,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH po AS (
    SELECT (started_at AT TIME ZONE 'UTC')::date AS d FROM pilot_outcomes WHERE tenant_id = p_tenant
  ),
  claim_actions AS (
    SELECT c.id AS claim_id, 'packet_sent'::text AS akind, (c.submitted_at AT TIME ZONE 'UTC')::date AS aon
    FROM warranty_claims c
    WHERE c.user_id = p_tenant AND c.submitted_at IS NOT NULL
    UNION ALL
    SELECT f.warranty_claim_id, 'packet_sent'::text, (p.sent_marked_at AT TIME ZONE 'UTC')::date
    FROM supplier_claim_packets p
    JOIN supplier_audit_findings f ON f.id = p.finding_id AND f.user_id = p_tenant
    WHERE p.user_id = p_tenant AND p.status = 'marked_sent' AND p.sent_marked_at IS NOT NULL AND f.warranty_claim_id IS NOT NULL
    UNION ALL
    SELECT f.warranty_claim_id, 'approval_attached'::text, (p.approved_at AT TIME ZONE 'UTC')::date
    FROM supplier_claim_packets p
    JOIN supplier_audit_findings f ON f.id = p.finding_id AND f.user_id = p_tenant
    WHERE p.user_id = p_tenant AND p.status IN ('approved', 'marked_sent') AND p.approved_at IS NOT NULL AND f.warranty_claim_id IS NOT NULL
  ),
  claim_rows AS (
    SELECT
      'warranty_claim'::text AS kind,
      c.id AS ref_id,
      COALESCE(NULLIF(btrim(c.claim_number), ''), NULLIF(btrim(c.rma_number), ''), left(c.id::text, 8)) AS ref_label,
      c.credit_received_cents::bigint AS amount_cents,
      c.credit_received_at AS recovered_on,
      a.akind AS action_kind,
      a.aon AS action_on
    FROM warranty_claims c
    JOIN po ON true
    LEFT JOIN LATERAL (
      SELECT x.akind, x.aon
      FROM claim_actions x
      WHERE x.claim_id = c.id AND x.aon >= po.d AND x.aon <= c.credit_received_at
      ORDER BY x.aon DESC, (x.akind = 'approval_attached') DESC
      LIMIT 1
    ) a ON true
    WHERE c.user_id = p_tenant
      AND COALESCE(c.credit_received_cents, 0) > 0
      AND c.credit_received_at IS NOT NULL
      AND c.credit_received_at >= po.d
  ),
  invoice_rows AS (
    SELECT
      'invoice'::text AS kind,
      i.id AS ref_id,
      COALESCE(NULLIF(btrim(i.invoice_number), ''), left(i.id::text, 8)) AS ref_label,
      public.pilot_invoice_total_cents(i.line_items, i.tax_percent) AS amount_cents,
      (i.paid_at AT TIME ZONE 'UTC')::date AS recovered_on,
      r.akind AS action_kind,
      r.aon AS action_on
    FROM invoices i
    JOIN po ON true
    LEFT JOIN LATERAL (
      SELECT 'reminder'::text AS akind, (pr.last_reminder_sent_at AT TIME ZONE 'UTC')::date AS aon
      FROM payment_requests pr
      WHERE pr.user_id = p_tenant
        AND i.job_id IS NOT NULL
        AND pr.job_id = i.job_id
        AND pr.reminder_count >= 1
        AND pr.last_reminder_sent_at IS NOT NULL
        AND (pr.last_reminder_sent_at AT TIME ZONE 'UTC')::date >= po.d
        AND (pr.last_reminder_sent_at AT TIME ZONE 'UTC')::date <= (i.paid_at AT TIME ZONE 'UTC')::date
        AND (i.paid_at AT TIME ZONE 'UTC')::date - (pr.last_reminder_sent_at AT TIME ZONE 'UTC')::date <= 14
      ORDER BY pr.last_reminder_sent_at DESC
      LIMIT 1
    ) r ON true
    WHERE i.user_id = p_tenant
      AND i.deleted_at IS NULL
      AND i.status = 'paid'
      AND i.paid_at IS NOT NULL
      AND i.due_date IS NOT NULL
      AND (i.paid_at AT TIME ZONE 'UTC')::date > i.due_date
      AND (i.paid_at AT TIME ZONE 'UTC')::date >= po.d
      AND public.pilot_invoice_total_cents(i.line_items, i.tax_percent) > 0
  )
  SELECT u.kind, u.ref_id, u.ref_label, u.amount_cents, u.recovered_on, u.action_kind, u.action_on,
         (u.action_kind IS NOT NULL) AS counted,
         CASE WHEN u.action_kind IS NULL THEN 'no_preceding_action' END AS reason
  FROM (SELECT * FROM claim_rows UNION ALL SELECT * FROM invoice_rows) u
$$;

-- =============================================================
-- 4. RESULTS PAYLOAD
-- =============================================================
CREATE OR REPLACE FUNCTION public.pilot_results_core(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  po pilot_outcomes%ROWTYPE;
BEGIN
  SELECT * INTO po FROM pilot_outcomes WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('started', false);
  END IF;

  RETURN jsonb_build_object(
    'started', true,
    'started_at', po.started_at,
    'generated_at', now(),
    'fee_pct', po.fee_pct,
    'baseline', po.baseline,
    'now', (SELECT to_jsonb(f) FROM pilot_figures(p_tenant) f),
    'estimate_fields', jsonb_build_array('unclaimed_warranty_cents'),
    'recovered', jsonb_build_object(
      'counted_cents', (SELECT COALESCE(sum(a.amount_cents) FILTER (WHERE a.counted), 0) FROM pilot_attributions(p_tenant) a),
      'counted_count', (SELECT count(*) FILTER (WHERE a.counted) FROM pilot_attributions(p_tenant) a),
      'not_counted_cents', (SELECT COALESCE(sum(a.amount_cents) FILTER (WHERE NOT a.counted), 0) FROM pilot_attributions(p_tenant) a),
      'not_counted_count', (SELECT count(*) FILTER (WHERE NOT a.counted) FROM pilot_attributions(p_tenant) a),
      'rows', (
        SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.recovered_on DESC, x.ref_id), '[]'::jsonb)
        FROM (SELECT * FROM pilot_attributions(p_tenant) ORDER BY recovered_on DESC LIMIT 500) x
      )
    ),
    'hours_minutes', (
      SELECT COALESCE(sum(h.minutes), 0) FROM pilot_hours h
      WHERE h.tenant_id = p_tenant AND h.entry_on >= (po.started_at AT TIME ZONE 'UTC')::date
    ),
    'claims_by_status', (
      SELECT COALESCE(jsonb_object_agg(s.status, jsonb_build_object('count', s.n, 'cents', s.cents)), '{}'::jsonb)
      FROM (
        SELECT c.status, count(*) AS n, COALESCE(sum(COALESCE(c.claimed_amount_cents, 0)), 0)::bigint AS cents
        FROM warranty_claims c WHERE c.user_id = p_tenant GROUP BY c.status
      ) s
    ),
    'invoices_by_status', (
      SELECT COALESCE(jsonb_object_agg(s.status, jsonb_build_object('count', s.n, 'cents', s.cents)), '{}'::jsonb)
      FROM (
        SELECT i.status, count(*) AS n, COALESCE(sum(public.pilot_invoice_total_cents(i.line_items, i.tax_percent)), 0)::bigint AS cents
        FROM invoices i WHERE i.user_id = p_tenant AND i.deleted_at IS NULL GROUP BY i.status
      ) s
    )
  );
END $$;

-- Browser entry point: the tenant comes from the session, never from an argument.
CREATE OR REPLACE FUNCTION public.pilot_results()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.reports_can_access(v_owner) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN public.pilot_results_core(v_owner);
END $$;

-- Owner only. Idempotent: a second call keeps the original baseline.
CREATE OR REPLACE FUNCTION public.pilot_start()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the account owner can start the pilot' USING ERRCODE = '42501';
  END IF;
  INSERT INTO pilot_outcomes (tenant_id, baseline, created_by)
  SELECT auth.uid(), to_jsonb(f), auth.uid() FROM pilot_figures(auth.uid()) f
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN public.pilot_results_core(auth.uid());
END $$;

-- Owner only. NULL clears it. Display-only: nothing in the system ever charges this.
CREATE OR REPLACE FUNCTION public.pilot_set_fee_pct(p_pct numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the account owner can set the fee' USING ERRCODE = '42501';
  END IF;
  IF p_pct IS NOT NULL AND (p_pct < 0 OR p_pct > 100) THEN
    RAISE EXCEPTION 'Fee must be between 0 and 100' USING ERRCODE = '22023';
  END IF;
  UPDATE pilot_outcomes SET fee_pct = round(p_pct, 2) WHERE tenant_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Start the pilot first' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- =============================================================
-- 5. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.pilot_figures(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pilot_attributions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pilot_results_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pilot_figures(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pilot_attributions(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pilot_results_core(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.pilot_results() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pilot_start() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pilot_set_fee_pct(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pilot_results() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pilot_start() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pilot_set_fee_pct(numeric) TO authenticated;
