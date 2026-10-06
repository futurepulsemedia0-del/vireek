/*
  # Service Receivables Intelligence (Cash Realization Intelligence)

  ## Why
  Answers: "Which revenue is actually collectable, and what is delaying it?"
  Walks the real chain  Job -> Quote -> Approval -> Contract -> Invoice ->
  Payment -> Dispute -> Collection  and links operational causes (approval
  workflow, slow invoicing, disputes) to billing delay and cash-flow impact.

  ## Design
  - Read-only analytics over existing tables: invoices, quotes, jobs,
    commercial_contracts, payment_requests. No existing table is altered.
  - One cached result row per account (receivables_intelligence_analyses),
    written only by the SECURITY DEFINER RPC below (same pattern as
    causal_chain_analyses).
  - Billing-sensitive: only the account owner or a team member with
    permissions.can_view_billing = true can read or compute.
  - Collectability uses an aging prior adjusted for disputes and reminder
    exhaustion. It is an ESTIMATE and is labelled as such in the output.
*/

-- =============================================================
-- ACCESS HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_view_receivables_intel()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_receivables_intel() TO authenticated;

-- =============================================================
-- CACHE TABLE
-- =============================================================
CREATE TABLE IF NOT EXISTS receivables_intelligence_analyses (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  result jsonb,
  computed_at timestamptz
);

ALTER TABLE receivables_intelligence_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_receivables_intelligence" ON receivables_intelligence_analyses;
CREATE POLICY "select_own_receivables_intelligence" ON receivables_intelligence_analyses
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_receivables_intel());
-- No client INSERT/UPDATE/DELETE policy — only the RPC below writes here.

-- =============================================================
-- THE ENGINE
-- =============================================================
CREATE OR REPLACE FUNCTION public.compute_receivables_intelligence(p_days integer DEFAULT 365)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
  v_since timestamptz;
  v_invoices integer;
  v_paid integer;
  v_confidence text;
  v_median_cash numeric;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL OR NOT public.can_view_receivables_intel() THEN
    RAISE EXCEPTION 'Not authorized to view receivables intelligence' USING ERRCODE = '42501';
  END IF;

  p_days := LEAST(GREATEST(COALESCE(p_days, 365), 30), 1095);
  v_since := now() - make_interval(days => p_days);

  DROP TABLE IF EXISTS _ri_inv;
  CREATE TEMP TABLE _ri_inv ON COMMIT DROP AS
  WITH base AS (
    SELECT
      i.id,
      i.invoice_number,
      i.customer_name,
      i.status,
      i.job_id,
      COALESCE(NULLIF(btrim(j.service_type), ''), 'Unspecified') AS service_type,
      (i.quote_id IS NOT NULL) AS approval_gated,
      EXISTS (
        SELECT 1 FROM commercial_contracts c
        WHERE c.user_id = v_user_id AND c.job_id = i.job_id
          AND c.status IN ('active', 'expiring_soon', 'renewed')
      ) AS has_contract,
      COALESCE(j.customer_disputed, false) AS disputed,
      COALESCE((SELECT max(pr.reminder_count) FROM payment_requests pr
                WHERE pr.user_id = v_user_id AND pr.job_id = i.job_id), 0) AS reminders,
      ROUND(
        CASE WHEN jsonb_typeof(i.line_items) = 'array' THEN
          (SELECT COALESCE(sum(
              COALESCE((li ->> 'quantity')::numeric, 0) * COALESCE((li ->> 'unit_price_cents')::numeric, 0)
           ), 0) FROM jsonb_array_elements(i.line_items) li)
        ELSE 0 END * (1 + COALESCE(i.tax_percent, 0) / 100)
      )::bigint AS total_cents,
      COALESCE(i.sent_at, i.created_at) AS billed_at,
      i.paid_at,
      COALESCE(i.due_date, (COALESCE(i.sent_at, i.created_at))::date + 30) AS due,
      q.sent_at AS q_sent,
      q.responded_at AS q_resp,
      q.status AS q_status,
      j.completed_at AS j_completed
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id AND j.user_id = v_user_id
    LEFT JOIN quotes q ON q.id = i.quote_id AND q.user_id = v_user_id
    WHERE i.user_id = v_user_id
      AND i.status NOT IN ('draft', 'void')
      AND COALESCE(i.sent_at, i.created_at) >= v_since
  )
  SELECT
    b.*,
    (b.status <> 'paid') AS is_open,
    CASE WHEN b.status = 'paid' AND b.paid_at IS NOT NULL
         THEN GREATEST(EXTRACT(epoch FROM (b.paid_at - b.billed_at)) / 86400, 0) END AS d_cash,
    CASE WHEN b.q_status = 'accepted' AND b.q_resp IS NOT NULL AND b.q_sent IS NOT NULL
         THEN GREATEST(EXTRACT(epoch FROM (b.q_resp - b.q_sent)) / 86400, 0) END AS d_approval,
    CASE WHEN b.q_resp IS NOT NULL
         THEN GREATEST(EXTRACT(epoch FROM (b.billed_at - b.q_resp)) / 86400, 0) END AS d_approval_to_inv,
    CASE WHEN b.j_completed IS NOT NULL
         THEN GREATEST(EXTRACT(epoch FROM (b.billed_at - b.j_completed)) / 86400, 0) END AS d_job_to_inv,
    CASE WHEN b.status <> 'paid' THEN GREATEST((current_date - b.due), 0) ELSE 0 END AS days_past_due,
    CASE
      WHEN b.status = 'paid' THEN 1.0
      ELSE ROUND((
        CASE
          WHEN current_date - b.due <= 0 THEN 0.95
          WHEN current_date - b.due <= 30 THEN 0.85
          WHEN current_date - b.due <= 60 THEN 0.65
          WHEN current_date - b.due <= 90 THEN 0.45
          ELSE 0.25
        END
        * CASE WHEN b.disputed THEN 0.5 ELSE 1 END
        * CASE WHEN b.reminders >= 3 THEN 0.85 ELSE 1 END
      )::numeric, 3)
    END AS collect_prob
  FROM base b;

  SELECT count(*), count(*) FILTER (WHERE NOT is_open),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY d_cash) FILTER (WHERE d_cash IS NOT NULL)
  INTO v_invoices, v_paid, v_median_cash
  FROM _ri_inv;

  v_confidence := CASE WHEN v_paid >= 30 THEN 'high' WHEN v_paid >= 10 THEN 'medium' ELSE 'low' END;

  SELECT jsonb_build_object(
    'window_days', p_days,
    'invoices_analyzed', v_invoices,
    'paid_invoices', v_paid,
    'confidence', v_confidence,
    'method', 'aging_prior_adjusted',

    'summary', (
      SELECT jsonb_build_object(
        'billed_cents', COALESCE(sum(total_cents), 0),
        'collected_cents', COALESCE(sum(total_cents) FILTER (WHERE NOT is_open), 0),
        'open_cents', COALESCE(sum(total_cents) FILTER (WHERE is_open), 0),
        'overdue_cents', COALESCE(sum(total_cents) FILTER (WHERE is_open AND days_past_due > 0), 0),
        'disputed_open_cents', COALESCE(sum(total_cents) FILTER (WHERE is_open AND disputed), 0),
        'expected_collectable_cents', COALESCE(ROUND(sum(total_cents * collect_prob) FILTER (WHERE is_open)), 0),
        'at_risk_cents', COALESCE(ROUND(sum(total_cents * (1 - collect_prob)) FILTER (WHERE is_open)), 0),
        'median_days_to_cash', ROUND(v_median_cash, 1),
        'p90_days_to_cash', ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY d_cash) FILTER (WHERE d_cash IS NOT NULL))::numeric, 1),
        'dso_days', ROUND((
          sum(total_cents) FILTER (WHERE is_open)::numeric
          / NULLIF((SELECT sum(x.total_cents) FROM _ri_inv x WHERE x.billed_at >= now() - interval '90 days'), 0)
          * 90), 1)
      ) FROM _ri_inv
    ),

    'aging', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', bucket, 'count', n, 'cents', cents) ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT CASE WHEN days_past_due = 0 THEN 'current'
                    WHEN days_past_due <= 30 THEN '1-30'
                    WHEN days_past_due <= 60 THEN '31-60'
                    WHEN days_past_due <= 90 THEN '61-90'
                    ELSE '90+' END AS bucket,
               CASE WHEN days_past_due = 0 THEN 1 WHEN days_past_due <= 30 THEN 2
                    WHEN days_past_due <= 60 THEN 3 WHEN days_past_due <= 90 THEN 4 ELSE 5 END AS ord,
               count(*) AS n, sum(total_cents) AS cents
        FROM _ri_inv WHERE is_open GROUP BY 1, 2
      ) a
    ),

    'graph', jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('key', 'job',      'count', (SELECT count(*) FROM _ri_inv WHERE job_id IS NOT NULL)),
        jsonb_build_object('key', 'quote',    'count', (SELECT count(*) FROM _ri_inv WHERE approval_gated)),
        jsonb_build_object('key', 'approval', 'count', (SELECT count(*) FROM _ri_inv WHERE q_status = 'accepted')),
        jsonb_build_object('key', 'contract', 'count', (SELECT count(*) FROM _ri_inv WHERE has_contract)),
        jsonb_build_object('key', 'invoice',  'count', v_invoices),
        jsonb_build_object('key', 'payment',  'count', v_paid),
        jsonb_build_object('key', 'dispute',  'count', (SELECT count(*) FROM _ri_inv WHERE disputed)),
        jsonb_build_object('key', 'collection', 'count', (SELECT count(*) FROM _ri_inv WHERE is_open AND (days_past_due > 0 OR reminders > 0)))
      ),
      'transitions', (
        SELECT jsonb_build_object(
          'quote_to_approval_days', ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_approval) FILTER (WHERE d_approval IS NOT NULL))::numeric, 1),
          'approval_to_invoice_days', ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_approval_to_inv) FILTER (WHERE d_approval_to_inv IS NOT NULL))::numeric, 1),
          'job_to_invoice_days', ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_job_to_inv) FILTER (WHERE d_job_to_inv IS NOT NULL))::numeric, 1),
          'invoice_to_payment_days', ROUND(v_median_cash, 1)
        ) FROM _ri_inv
      )
    ),

    'segments', (
      SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.billed_cents DESC), '[]'::jsonb)
      FROM (
        SELECT
          service_type,
          approval_gated,
          has_contract,
          count(*) AS invoices,
          count(*) FILTER (WHERE NOT is_open) AS paid,
          COALESCE(sum(total_cents), 0) AS billed_cents,
          COALESCE(sum(total_cents) FILTER (WHERE is_open), 0) AS open_cents,
          ROUND(avg(total_cents)) AS avg_ticket_cents,
          ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_cash) FILTER (WHERE d_cash IS NOT NULL))::numeric, 1) AS median_days_to_cash,
          ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_approval) FILTER (WHERE d_approval IS NOT NULL))::numeric, 1) AS median_approval_days,
          ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_approval_to_inv) FILTER (WHERE d_approval_to_inv IS NOT NULL))::numeric, 1) AS median_approval_to_invoice_days,
          ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY d_job_to_inv) FILTER (WHERE d_job_to_inv IS NOT NULL))::numeric, 1) AS median_job_to_invoice_days,
          ROUND(avg((disputed)::int)::numeric, 3) AS dispute_rate,
          ROUND(avg((is_open AND days_past_due > 0)::int)::numeric, 3) AS overdue_rate
        FROM _ri_inv
        GROUP BY service_type, approval_gated, has_contract
        HAVING count(*) >= 3
        ORDER BY sum(total_cents) DESC
        LIMIT 20
      ) s
    ),

    'at_risk_invoices', (
      SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      FROM (
        SELECT id, invoice_number, customer_name, service_type, total_cents,
               days_past_due, collect_prob, disputed, reminders, approval_gated, has_contract,
               ROUND(total_cents * (1 - collect_prob)) AS at_risk_cents
        FROM _ri_inv WHERE is_open
        ORDER BY total_cents * (1 - collect_prob) DESC
        LIMIT 10
      ) r
    ),

    'weekly', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'week_start', w.wk,
          'billed_cents', COALESCE((SELECT sum(total_cents) FROM _ri_inv x WHERE date_trunc('week', x.billed_at)::date = w.wk), 0),
          'collected_cents', COALESCE((SELECT sum(total_cents) FROM _ri_inv x WHERE x.paid_at IS NOT NULL AND NOT x.is_open AND date_trunc('week', x.paid_at)::date = w.wk), 0)
        ) ORDER BY w.wk), '[]'::jsonb)
      FROM (
        SELECT gs::date AS wk
        FROM generate_series(date_trunc('week', now() - interval '11 weeks')::date, date_trunc('week', now())::date, interval '1 week') gs
      ) w
    )
  ) INTO v_result;

  INSERT INTO receivables_intelligence_analyses (user_id, result, computed_at)
  VALUES (v_user_id, v_result, now())
  ON CONFLICT (user_id) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_receivables_intelligence(integer) TO authenticated;
