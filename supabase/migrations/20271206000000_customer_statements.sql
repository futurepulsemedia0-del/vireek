/*
  # Customer statements of account — consolidated billing + scheduled send

  Adds:
  - customers.bill_to_customer_id  → consolidated billing (a payer account rolls up
    the invoices of the customers/sites that point at it; one level only, no cycles)
  - statement_schedules            → weekly/monthly scheduled sends (timezone aware)
  - statement_sends                → per-customer delivery log (idempotent for schedules)
  - _statement_build / get_customer_statement   → opening balance, lines, aging, closing
  - _statement_accounts / list_statement_accounts → overview of every payer account
  - set_statement_bill_to          → link / unlink a customer to a payer
  - statement_schedule_claim_due   → service_role only, atomic at-most-once claim

  Balance model (same as invoice detail):
    invoice balance = total − payments + refunds, drafts and voids excluded.
    Invoice date = COALESCE(sent_at, created_at) in UTC.

  ## Scheduling (run once after deploying the edge function `statements-run`)
    Replace <project-ref>, <service-role-key>, <CRON_SECRET>.

    select cron.schedule('statements-tick', '0-59/10 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/statements-run',
        headers := jsonb_build_object('Content-Type','application/json',
                                      'Authorization','Bearer <service-role-key>',
                                      'X-Cron-Secret','<CRON_SECRET>'),
        body := jsonb_build_object('action','tick')
      );
    $$);
*/

-- =============================================================
-- 1. Consolidated billing link
-- =============================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bill_to_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_bill_to ON customers(bill_to_customer_id) WHERE bill_to_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id) WHERE customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._customers_bill_to_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_parent customers%ROWTYPE;
BEGIN
  IF NEW.bill_to_customer_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.bill_to_customer_id = NEW.id THEN
    RAISE EXCEPTION 'A customer cannot be billed to itself';
  END IF;
  SELECT * INTO v_parent FROM customers WHERE id = NEW.bill_to_customer_id;
  IF NOT FOUND OR v_parent.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'Payer account not found';
  END IF;
  IF v_parent.bill_to_customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'That customer is itself billed to another account — pick the top-level payer';
  END IF;
  IF EXISTS (SELECT 1 FROM customers WHERE bill_to_customer_id = NEW.id) THEN
    RAISE EXCEPTION 'This customer is a payer for other accounts — unlink them first';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_bill_to_guard ON customers;
CREATE TRIGGER trg_customers_bill_to_guard
  BEFORE INSERT OR UPDATE OF bill_to_customer_id ON customers
  FOR EACH ROW EXECUTE FUNCTION public._customers_bill_to_guard();

-- =============================================================
-- 2. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS statement_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_by uuid DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  scope text NOT NULL DEFAULT 'all_open' CHECK (scope IN ('all_open', 'overdue_only', 'selected')),
  customer_ids uuid[] NOT NULL DEFAULT '{}',
  period_mode text NOT NULL DEFAULT 'previous_month' CHECK (period_mode IN ('previous_month', 'last_30_days', 'year_to_date')),
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'monthly')),
  weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  month_day smallint NOT NULL DEFAULT 1 CHECK (month_day BETWEEN 1 AND 28),
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  min_balance_cents bigint NOT NULL DEFAULT 100 CHECK (min_balance_cents >= 0),
  consolidate boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'partial', 'failed', 'skipped', 'empty')),
  last_summary jsonb,
  consecutive_failures int NOT NULL DEFAULT 0,
  paused_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_schedules_selected_has_customers CHECK (scope <> 'selected' OR cardinality(customer_ids) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_statement_schedules_user ON statement_schedules(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_statement_schedules_due ON statement_schedules(next_run_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS statement_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  schedule_id uuid REFERENCES statement_schedules(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipient text,
  period_from date NOT NULL,
  period_to date NOT NULL,
  closing_balance_cents bigint NOT NULL DEFAULT 0,
  consolidated boolean NOT NULL DEFAULT false,
  error text,
  sent_by uuid,
  sent_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_statement_sends_user ON statement_sends(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_statement_sends_customer ON statement_sends(customer_id, created_at DESC);
-- A scheduled statement for the same customer + period is never sent twice (retry / overlapping tick safe).
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_sends_schedule_once
  ON statement_sends(schedule_id, customer_id, period_to)
  WHERE trigger = 'schedule' AND status = 'sent';

ALTER TABLE statement_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_statement_schedules" ON statement_schedules;
CREATE POLICY "select_statement_schedules" ON statement_schedules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));
DROP POLICY IF EXISTS "select_statement_sends" ON statement_sends;
CREATE POLICY "select_statement_sends" ON statement_sends FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));
-- Writes go through the RPCs below (schedules) and the edge function (sends). No client write policies.

-- =============================================================
-- 3. Next-run calculator (timezone + DST aware)
-- =============================================================
CREATE OR REPLACE FUNCTION public.statement_next_run(
  p_frequency text, p_weekday int, p_month_day int, p_send_hour int, p_tz text, p_after timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  local_after timestamp;
  d date;
  candidate timestamp;
BEGIN
  local_after := p_after AT TIME ZONE p_tz;
  IF p_frequency = 'weekly' THEN
    d := local_after::date + ((p_weekday - extract(dow FROM local_after)::int + 7) % 7);
    candidate := d + make_interval(hours => p_send_hour);
    IF candidate <= local_after THEN candidate := candidate + interval '7 days'; END IF;
  ELSE
    d := make_date(extract(year FROM local_after)::int, extract(month FROM local_after)::int, p_month_day);
    candidate := d + make_interval(hours => p_send_hour);
    IF candidate <= local_after THEN
      d := (date_trunc('month', local_after) + interval '1 month')::date + (p_month_day - 1);
      candidate := d + make_interval(hours => p_send_hour);
    END IF;
  END IF;
  RETURN candidate AT TIME ZONE p_tz;
END;
$$;

-- =============================================================
-- 4. Statement engine
-- =============================================================
-- Customers whose invoices roll into p_customer: itself, plus (when consolidating)
-- every customer billed to it.
CREATE OR REPLACE FUNCTION public._statement_members(p_owner uuid, p_customer_id uuid, p_consolidate boolean)
RETURNS TABLE (member_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id FROM customers c
   WHERE c.user_id = p_owner
     AND (c.id = p_customer_id OR (p_consolidate AND c.bill_to_customer_id = p_customer_id));
$$;

-- One row per billable invoice with its resolved customer.
CREATE OR REPLACE FUNCTION public._statement_invoices(p_owner uuid, p_member_ids uuid[], p_emails text[])
RETURNS TABLE (
  invoice_id uuid, invoice_number text, invoice_token uuid, job_id uuid, customer_id uuid, customer_name text,
  invoice_date date, due_date date, total_cents bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.invoice_number, i.invoice_token, i.job_id, i.customer_id, i.customer_name,
         (COALESCE(i.sent_at, i.created_at) AT TIME ZONE 'UTC')::date,
         i.due_date,
         public.invoice_total_cents(i.line_items, i.tax_percent)
    FROM invoices i
   WHERE i.user_id = p_owner
     AND i.status NOT IN ('draft', 'void')
     AND (
       i.customer_id = ANY (p_member_ids)
       OR (i.customer_id IS NULL AND i.customer_email IS NOT NULL AND lower(btrim(i.customer_email)) = ANY (p_emails))
     );
$$;

CREATE OR REPLACE FUNCTION public._statement_build(
  p_owner uuid, p_customer_id uuid, p_from date, p_to date, p_consolidate boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust customers%ROWTYPE;
  v_members uuid[];
  v_emails text[];
  v_opening bigint := 0;
  v_charges bigint := 0;
  v_payments bigint := 0;
  v_refunds bigint := 0;
  v_lines jsonb;
  v_open jsonb;
  v_aging jsonb;
  v_has_children boolean;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Invalid statement period';
  END IF;
  IF p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'Statement period is too long (max 3 years)';
  END IF;

  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_cust.bill_to_customer_id IS NOT NULL AND p_consolidate THEN
    -- A child account is never consolidated into its own statement.
    p_consolidate := false;
  END IF;

  SELECT COALESCE(array_agg(member_id), '{}') INTO v_members FROM public._statement_members(p_owner, p_customer_id, p_consolidate);
  SELECT COALESCE(array_agg(DISTINCT lower(btrim(c.email))), '{}') INTO v_emails
    FROM customers c WHERE c.id = ANY (v_members) AND c.email IS NOT NULL AND btrim(c.email) <> '';
  v_has_children := p_consolidate AND EXISTS (SELECT 1 FROM customers WHERE bill_to_customer_id = p_customer_id AND user_id = p_owner);

  -- Opening balance (everything before p_from)
  SELECT
    COALESCE((SELECT sum(total_cents) FROM public._statement_invoices(p_owner, v_members, v_emails) WHERE invoice_date < p_from), 0)
    - COALESCE((SELECT sum(p.amount_cents) FROM invoice_payments p JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = p.invoice_id WHERE (p.paid_at AT TIME ZONE 'UTC')::date < p_from), 0)
    + COALESCE((SELECT sum(r.amount_cents) FROM invoice_refunds r JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = r.invoice_id WHERE (r.refunded_at AT TIME ZONE 'UTC')::date < p_from), 0)
  INTO v_opening;

  SELECT COALESCE(sum(total_cents), 0) INTO v_charges FROM public._statement_invoices(p_owner, v_members, v_emails) WHERE invoice_date BETWEEN p_from AND p_to;
  SELECT COALESCE(sum(p.amount_cents), 0) INTO v_payments
    FROM invoice_payments p JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = p.invoice_id WHERE (p.paid_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to;
  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_refunds
    FROM invoice_refunds r JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = r.invoice_id WHERE (r.refunded_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to;

  -- Period activity with running balance
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'date', t.d, 'kind', t.kind, 'reference', t.ref, 'description', t.descr,
      'customer_name', t.cname, 'invoice_number', t.inv_no,
      'charge_cents', t.charge, 'credit_cents', t.credit,
      'balance_cents', v_opening + t.running
    ) ORDER BY t.d, t.ord, t.ref), '[]'::jsonb)
  INTO v_lines
  FROM (
    SELECT x.*, sum(x.charge - x.credit) OVER (ORDER BY x.d, x.ord, x.ref ROWS UNBOUNDED PRECEDING) AS running
    FROM (
      SELECT i.invoice_date AS d, 1 AS ord, 'invoice'::text AS kind, COALESCE(i.invoice_number, 'Invoice') AS ref,
             'Invoice ' || COALESCE(i.invoice_number, '') AS descr, i.customer_name AS cname, i.invoice_number AS inv_no,
             i.total_cents AS charge, 0::bigint AS credit
        FROM public._statement_invoices(p_owner, v_members, v_emails) i WHERE i.invoice_date BETWEEN p_from AND p_to
      UNION ALL
      SELECT (p.paid_at AT TIME ZONE 'UTC')::date, 2, 'payment', COALESCE(i.invoice_number, 'Payment') || ' · ' || p.id::text,
             'Payment (' || replace(p.method, '_', ' ') || ') for ' || COALESCE(i.invoice_number, 'invoice')
               || COALESCE(' · ' || NULLIF(btrim(p.reference), ''), ''),
             i.customer_name, i.invoice_number, 0::bigint, p.amount_cents
        FROM invoice_payments p JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = p.invoice_id
       WHERE (p.paid_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT (r.refunded_at AT TIME ZONE 'UTC')::date, 3, 'refund', COALESCE(i.invoice_number, 'Refund') || ' · ' || r.id::text,
             'Refund for ' || COALESCE(i.invoice_number, 'invoice'), i.customer_name, i.invoice_number, r.amount_cents, 0::bigint
        FROM invoice_refunds r JOIN public._statement_invoices(p_owner, v_members, v_emails) i ON i.invoice_id = r.invoice_id
       WHERE (r.refunded_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to
    ) x
  ) t;

  -- Open invoices as of p_to (balance net of payments/refunds up to p_to), with aging
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'invoice_id', o.invoice_id, 'invoice_number', o.invoice_number, 'invoice_token', o.invoice_token,
      'customer_name', o.customer_name, 'invoice_date', o.invoice_date, 'due_date', o.due_date,
      'total_cents', o.total_cents, 'balance_cents', o.bal,
      'days_past_due', GREATEST(0, p_to - COALESCE(o.due_date, o.invoice_date)),
      'bucket', CASE
          WHEN COALESCE(o.due_date, o.invoice_date) >= p_to THEN 'current'
          WHEN p_to - COALESCE(o.due_date, o.invoice_date) <= 30 THEN 'd1_30'
          WHEN p_to - COALESCE(o.due_date, o.invoice_date) <= 60 THEN 'd31_60'
          WHEN p_to - COALESCE(o.due_date, o.invoice_date) <= 90 THEN 'd61_90'
          ELSE 'd90_plus' END
    ) ORDER BY COALESCE(o.due_date, o.invoice_date), o.invoice_number), '[]'::jsonb)
  INTO v_open
  FROM (
    SELECT i.*,
           i.total_cents
             - COALESCE((SELECT sum(p.amount_cents) FROM invoice_payments p WHERE p.invoice_id = i.invoice_id AND (p.paid_at AT TIME ZONE 'UTC')::date <= p_to), 0)
             + COALESCE((SELECT sum(r.amount_cents) FROM invoice_refunds r WHERE r.invoice_id = i.invoice_id AND (r.refunded_at AT TIME ZONE 'UTC')::date <= p_to), 0) AS bal
      FROM public._statement_invoices(p_owner, v_members, v_emails) i WHERE i.invoice_date <= p_to
  ) o
  WHERE o.bal > 0;

  SELECT jsonb_build_object(
      'current',  COALESCE(sum((e->>'balance_cents')::bigint) FILTER (WHERE e->>'bucket' = 'current'), 0),
      'd1_30',    COALESCE(sum((e->>'balance_cents')::bigint) FILTER (WHERE e->>'bucket' = 'd1_30'), 0),
      'd31_60',   COALESCE(sum((e->>'balance_cents')::bigint) FILTER (WHERE e->>'bucket' = 'd31_60'), 0),
      'd61_90',   COALESCE(sum((e->>'balance_cents')::bigint) FILTER (WHERE e->>'bucket' = 'd61_90'), 0),
      'd90_plus', COALESCE(sum((e->>'balance_cents')::bigint) FILTER (WHERE e->>'bucket' = 'd90_plus'), 0)
    ) INTO v_aging
  FROM jsonb_array_elements(v_open) e;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'email', v_cust.email, 'phone', v_cust.phone, 'address', v_cust.address),
    'period_from', p_from, 'period_to', p_to,
    'consolidated', v_has_children,
    'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name), '[]'::jsonb) FROM customers c WHERE c.id = ANY (v_members)),
    'opening_cents', v_opening,
    'charges_cents', v_charges,
    'payments_cents', v_payments,
    'refunds_cents', v_refunds,
    'closing_cents', v_opening + v_charges - v_payments + v_refunds,
    'lines', v_lines,
    'open_invoices', v_open,
    'aging', v_aging
  );
END;
$$;

REVOKE ALL ON FUNCTION public._statement_build(uuid, uuid, date, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._statement_build(uuid, uuid, date, date, boolean) TO service_role;
REVOKE ALL ON FUNCTION public._statement_members(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._statement_invoices(uuid, uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._statement_members(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._statement_invoices(uuid, uuid[], text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.get_customer_statement(
  p_customer_id uuid, p_from date, p_to date, p_consolidate boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN public._statement_build(v_owner, p_customer_id, p_from, p_to, COALESCE(p_consolidate, true));
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_statement(uuid, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date, boolean) TO authenticated;

-- =============================================================
-- 5. Accounts overview (one row per payer account, consolidated)
-- =============================================================
CREATE OR REPLACE FUNCTION public._statement_accounts(p_owner uuid, p_as_of date)
RETURNS TABLE (
  customer_id uuid, name text, email text, phone text, customer_type text,
  child_count int, invoice_count int, balance_cents bigint, overdue_cents bigint,
  oldest_due date, last_sent_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inv AS (
    SELECT i.id AS invoice_id, i.due_date, i.invoice_number,
           COALESCE(i.customer_id, ce.id) AS cust_id,
           public.invoice_total_cents(i.line_items, i.tax_percent)
             - COALESCE((SELECT sum(p.amount_cents) FROM invoice_payments p WHERE p.invoice_id = i.id AND (p.paid_at AT TIME ZONE 'UTC')::date <= p_as_of), 0)
             + COALESCE((SELECT sum(r.amount_cents) FROM invoice_refunds r WHERE r.invoice_id = i.id AND (r.refunded_at AT TIME ZONE 'UTC')::date <= p_as_of), 0) AS bal
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT c.id FROM customers c
         WHERE c.user_id = p_owner AND i.customer_id IS NULL AND i.customer_email IS NOT NULL
           AND c.email IS NOT NULL AND lower(btrim(c.email)) = lower(btrim(i.customer_email))
         ORDER BY c.created_at LIMIT 1
      ) ce ON true
     WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void')
       AND (COALESCE(i.sent_at, i.created_at) AT TIME ZONE 'UTC')::date <= p_as_of
  ),
  rolled AS (
    SELECT COALESCE(c.bill_to_customer_id, c.id) AS payer_id, inv.*
      FROM inv JOIN customers c ON c.id = inv.cust_id AND c.user_id = p_owner
     WHERE inv.bal > 0
  )
  SELECT c.id, c.name, c.email, c.phone, c.customer_type,
         (SELECT count(*)::int FROM customers k WHERE k.bill_to_customer_id = c.id AND k.user_id = p_owner),
         count(r.invoice_id)::int,
         COALESCE(sum(r.bal), 0)::bigint,
         COALESCE(sum(r.bal) FILTER (WHERE r.due_date IS NOT NULL AND r.due_date < p_as_of), 0)::bigint,
         min(r.due_date) FILTER (WHERE r.due_date IS NOT NULL),
         (SELECT max(s.created_at) FROM statement_sends s WHERE s.customer_id = c.id AND s.status = 'sent')
    FROM customers c
    LEFT JOIN rolled r ON r.payer_id = c.id
   WHERE c.user_id = p_owner AND c.bill_to_customer_id IS NULL
   GROUP BY c.id
   ORDER BY COALESCE(sum(r.bal), 0) DESC, c.name;
$$;

REVOKE ALL ON FUNCTION public._statement_accounts(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._statement_accounts(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.list_statement_accounts(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  customer_id uuid, name text, email text, phone text, customer_type text,
  child_count int, invoice_count int, balance_cents bigint, overdue_cents bigint,
  oldest_due date, last_sent_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY SELECT * FROM public._statement_accounts(v_owner, COALESCE(p_as_of, (now() AT TIME ZONE 'UTC')::date));
END;
$$;

REVOKE ALL ON FUNCTION public.list_statement_accounts(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_statement_accounts(date) TO authenticated;

-- =============================================================
-- 6. Link / unlink a customer to a payer account
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_statement_bill_to(p_customer_id uuid, p_payer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE customers SET bill_to_customer_id = p_payer_id
   WHERE id = p_customer_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  INSERT INTO audit_log (user_id, actor_id, actor_email, action, target_table, target_id, details)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          CASE WHEN p_payer_id IS NULL THEN 'statement_bill_to_removed' ELSE 'statement_bill_to_set' END,
          'customers', p_customer_id::text, jsonb_build_object('payer_id', p_payer_id));
END;
$$;

REVOKE ALL ON FUNCTION public.set_statement_bill_to(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_statement_bill_to(uuid, uuid) TO authenticated;

-- =============================================================
-- 7. Schedules: save / toggle / delete (validated, next_run_at DB-computed)
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_statement_schedule(
  p_id uuid, p_name text, p_scope text, p_customer_ids uuid[], p_period_mode text, p_frequency text,
  p_weekday int, p_month_day int, p_send_hour int, p_timezone text, p_min_balance_cents bigint,
  p_consolidate boolean, p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_ids uuid[] := COALESCE(p_customer_ids, '{}');
  v_next timestamptz;
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone';
  END IF;
  IF p_scope = 'selected' THEN
    v_ids := ARRAY(SELECT c.id FROM customers c WHERE c.user_id = v_owner AND c.id = ANY (v_ids));
    IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'Pick at least one customer'; END IF;
  ELSE
    v_ids := '{}';
  END IF;
  v_next := public.statement_next_run(p_frequency, p_weekday, p_month_day, p_send_hour, p_timezone, now());

  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM statement_schedules WHERE user_id = v_owner) >= 25 THEN
      RAISE EXCEPTION 'Schedule limit reached (25)';
    END IF;
    INSERT INTO statement_schedules (user_id, name, scope, customer_ids, period_mode, frequency, weekday, month_day, send_hour,
                                     timezone, min_balance_cents, consolidate, is_active, next_run_at)
    VALUES (v_owner, btrim(p_name), p_scope, v_ids, p_period_mode, p_frequency, p_weekday, p_month_day, p_send_hour,
            p_timezone, GREATEST(0, COALESCE(p_min_balance_cents, 0)), COALESCE(p_consolidate, true), COALESCE(p_is_active, true),
            CASE WHEN COALESCE(p_is_active, true) THEN v_next END)
    RETURNING id INTO v_id;
  ELSE
    UPDATE statement_schedules SET
      name = btrim(p_name), scope = p_scope, customer_ids = v_ids, period_mode = p_period_mode, frequency = p_frequency,
      weekday = p_weekday, month_day = p_month_day, send_hour = p_send_hour, timezone = p_timezone,
      min_balance_cents = GREATEST(0, COALESCE(p_min_balance_cents, 0)), consolidate = COALESCE(p_consolidate, true),
      is_active = COALESCE(p_is_active, true),
      next_run_at = CASE WHEN COALESCE(p_is_active, true) THEN v_next END,
      consecutive_failures = 0, paused_reason = NULL, updated_at = now()
     WHERE id = p_id AND user_id = v_owner
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Schedule not found'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_statement_schedule(uuid, text, text, uuid[], text, text, int, int, int, text, bigint, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_statement_schedule(uuid, text, text, uuid[], text, text, int, int, int, text, bigint, boolean, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_statement_schedule_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE statement_schedules s SET
    is_active = p_active,
    next_run_at = CASE WHEN p_active THEN public.statement_next_run(s.frequency, s.weekday, s.month_day, s.send_hour, s.timezone, now()) END,
    consecutive_failures = CASE WHEN p_active THEN 0 ELSE s.consecutive_failures END,
    paused_reason = CASE WHEN p_active THEN NULL ELSE COALESCE(s.paused_reason, 'Paused manually') END,
    updated_at = now()
   WHERE s.id = p_id AND s.user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_statement_schedule_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_statement_schedule_active(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_statement_schedule(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  DELETE FROM statement_schedules WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_statement_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_statement_schedule(uuid) TO authenticated;

-- =============================================================
-- 8. Atomic claim (cron) — service_role only, at-most-once
-- =============================================================
CREATE OR REPLACE FUNCTION public.statement_schedule_claim_due(p_limit int DEFAULT 10)
RETURNS TABLE (o_schedule_id uuid, o_scheduled_for timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r statement_schedules%ROWTYPE;
BEGIN
  FOR r IN
    SELECT * FROM statement_schedules
     WHERE is_active AND next_run_at IS NOT NULL AND next_run_at <= now()
     ORDER BY next_run_at
     LIMIT GREATEST(1, LEAST(p_limit, 50))
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE statement_schedules
       SET next_run_at = public.statement_next_run(r.frequency, r.weekday, r.month_day, r.send_hour, r.timezone, now()),
           updated_at = now()
     WHERE id = r.id;
    IF r.next_run_at < now() - interval '48 hours' THEN
      UPDATE statement_schedules SET last_run_at = now(), last_status = 'skipped',
             last_summary = jsonb_build_object('note', 'Missed run window (over 48 hours late) — skipped.')
       WHERE id = r.id;
      CONTINUE;
    END IF;
    o_schedule_id := r.id;
    o_scheduled_for := r.next_run_at;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.statement_schedule_claim_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.statement_schedule_claim_due(int) TO service_role;

COMMENT ON TABLE statement_schedules IS 'Scheduled customer statement emails (weekly/monthly, per-schedule timezone). next_run_at is DB-computed.';
COMMENT ON TABLE statement_sends IS 'Delivery log of customer statements (scheduled + manual).';
