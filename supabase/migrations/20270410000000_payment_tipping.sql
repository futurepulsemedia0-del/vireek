/*
  # Tipping on payment links + technician collect-payment

  - payment_requests: public_token (permanent public link), technician_id, collected_via, tip_cents
  - tips: one row per paid tip, routed to the technician (team_member)
  - pay_run_items.tip_cents / pay_runs.total_tip_cents: tips flow through payroll
  - GL: tip receipt = Dr Cash / Cr Tips Payable (2310); pay run = Dr Tips Payable
  - finalize_paid_payment_request(): single atomic, idempotent "payment succeeded" RPC (service role only)

  NOTE: this file re-creates create_pay_run, approve_and_post_pay_run and get_ytd_payroll.
  Diff them against your LIVE database before applying (see answer notes).
*/

-- 1. payment_requests ---------------------------------------------------------
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS public_token text,
  ADD COLUMN IF NOT EXISTS technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS collected_via text NOT NULL DEFAULT 'office',
  ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_charged_cents integer;

ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_collected_via_check;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_collected_via_check
  CHECK (collected_via IN ('office', 'technician'));
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_tip_cents_check;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_tip_cents_check CHECK (tip_cents >= 0);

UPDATE payment_requests
  SET public_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE public_token IS NULL;
ALTER TABLE payment_requests ALTER COLUMN public_token
  SET DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
ALTER TABLE payment_requests ALTER COLUMN public_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_public_token ON payment_requests(public_token);
CREATE INDEX IF NOT EXISTS idx_payment_requests_technician ON payment_requests(technician_id) WHERE technician_id IS NOT NULL;

-- 2. per-business switch --------------------------------------------------------
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS tip_enabled boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.set_tipping_enabled(p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE stripe_connect_accounts SET tip_enabled = p_enabled WHERE user_id = public.get_account_owner_id();
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_tipping_enabled(boolean) TO authenticated;

-- 3. tips ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payment_request_id uuid NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded', 'refunded_after_payout')),
  stripe_payment_intent_id text,
  receipt_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  pay_run_item_id uuid REFERENCES pay_run_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tips_unassigned ON tips(team_member_id, status) WHERE pay_run_item_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tips_pi ON tips(stripe_payment_intent_id);

ALTER TABLE tips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_tips" ON tips;
CREATE POLICY "select_own_tips" ON tips FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No write policies: tips are written only by finalize_paid_payment_request (service role).

-- 4. payroll columns ---------------------------------------------------------------
ALTER TABLE pay_run_items ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0;
ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS total_tip_cents integer NOT NULL DEFAULT 0;

-- Voiding a pay run releases its tips so the next run picks them up again.
CREATE OR REPLACE FUNCTION public._release_tips_on_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    UPDATE tips SET pay_run_item_id = NULL
      WHERE pay_run_item_id IN (SELECT id FROM pay_run_items WHERE pay_run_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_release_tips_on_void ON pay_runs;
CREATE TRIGGER trg_release_tips_on_void AFTER UPDATE OF status ON pay_runs
  FOR EACH ROW EXECUTE FUNCTION public._release_tips_on_void();

-- 5. chart of accounts + GL receipt -----------------------------------------------
CREATE OR REPLACE FUNCTION public._ensure_tip_accounts(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system)
  VALUES (p_user_id, '2310', 'Tips Payable', 'liability', 'credit', true)
  ON CONFLICT (user_id, code) DO NOTHING;
END;
$$;

-- Best effort: a locked period or a missing cash account must never block a customer's payment.
CREATE OR REPLACE FUNCTION public._post_tip_receipt(p_tip_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t tips%ROWTYPE; v_cash uuid; v_liab uuid; v_je uuid;
BEGIN
  SELECT * INTO t FROM tips WHERE id = p_tip_id;
  IF t.id IS NULL OR t.receipt_journal_entry_id IS NOT NULL THEN RETURN; END IF;
  BEGIN
    PERFORM public._ensure_tip_accounts(t.user_id);
    SELECT id INTO v_cash FROM chart_of_accounts WHERE user_id = t.user_id AND code = '1000';
    SELECT id INTO v_liab FROM chart_of_accounts WHERE user_id = t.user_id AND code = '2310';
    IF v_cash IS NULL OR v_liab IS NULL THEN RETURN; END IF;
    PERFORM public._gl_assert_period_open(t.user_id, current_date);
    INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id)
    VALUES (t.user_id, public._gl_next_number(t.user_id, 'JE', 'journal_entries'), current_date, 'Customer tip received', 'manual', t.id)
    RETURNING id INTO v_je;
    INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description) VALUES
      (v_je, 1, v_cash, t.amount_cents, 0, 'Tip received'),
      (v_je, 2, v_liab, 0, t.amount_cents, 'Tip owed to technician');
    UPDATE tips SET receipt_journal_entry_id = v_je WHERE id = t.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tip receipt GL posting skipped for %: %', p_tip_id, SQLERRM;
  END;
END;
$$;

-- 6. finalize_paid_payment_request: atomic + idempotent ---------------------------
CREATE OR REPLACE FUNCTION public.finalize_paid_payment_request(
  p_request_id uuid, p_session_id text, p_payment_intent_id text, p_amount_total_cents integer, p_tip_cents integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r payment_requests%ROWTYPE;
  v_base integer;
  v_tip_id uuid;
  emp RECORD;
BEGIN
  SELECT * INTO r FROM payment_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF r.status = 'paid' THEN RETURN jsonb_build_object('status', 'already_paid'); END IF;

  v_base := round(r.amount * 100)::integer;
  IF p_tip_cents < 0 OR p_amount_total_cents IS NULL OR p_amount_total_cents <> v_base + p_tip_cents THEN
    RETURN jsonb_build_object('status', 'amount_mismatch', 'expected', v_base + p_tip_cents, 'got', p_amount_total_cents);
  END IF;

  UPDATE payment_requests
    SET status = 'paid', paid_at = now(), stripe_payment_intent_id = p_payment_intent_id,
        stripe_checkout_session_id = p_session_id, tip_cents = p_tip_cents, total_charged_cents = p_amount_total_cents
    WHERE id = r.id;
  IF r.job_id IS NOT NULL THEN UPDATE jobs SET invoice_status = 'paid' WHERE id = r.job_id; END IF;

  IF p_tip_cents > 0 AND r.technician_id IS NOT NULL THEN
    INSERT INTO tips (user_id, payment_request_id, job_id, team_member_id, amount_cents, stripe_payment_intent_id)
    VALUES (r.user_id, r.id, r.job_id, r.technician_id, p_tip_cents, p_payment_intent_id)
    ON CONFLICT (payment_request_id) DO NOTHING
    RETURNING id INTO v_tip_id;
    IF v_tip_id IS NOT NULL THEN PERFORM public._post_tip_receipt(v_tip_id); END IF;
  END IF;

  -- Commission is earned on the invoice amount ONLY, never on the tip.
  -- Skipped if a commission record for this job + employee already exists (manual entry).
  IF r.technician_id IS NOT NULL AND r.job_id IS NOT NULL THEN
    SELECT * INTO emp FROM employees
      WHERE user_id = r.user_id AND team_member_id = r.technician_id AND active AND commission_rate_percent > 0
      LIMIT 1;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM commission_records WHERE job_id = r.job_id AND employee_id = emp.id) THEN
      INSERT INTO commission_records (user_id, employee_id, job_id, basis_amount_cents, commission_rate_percent)
      VALUES (r.user_id, emp.id, r.job_id, v_base, emp.commission_rate_percent);
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'paid', 'tip_cents', p_tip_cents);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_tip_refunded(p_payment_intent_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE tips
    SET status = CASE WHEN pay_run_item_id IS NULL THEN 'refunded' ELSE 'refunded_after_payout' END
    WHERE stripe_payment_intent_id = p_payment_intent_id AND status = 'paid';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_paid_payment_request(uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_tip_refunded(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._post_tip_receipt(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ensure_tip_accounts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_payment_request(uuid, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_tip_refunded(text) TO service_role;

-- 7. create_pay_run (original + tips) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.create_pay_run(p_period_start date, p_period_end date, p_pay_date date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_run_id uuid;
  emp RECORD;
  v_reg_hours numeric;
  v_ot_hours numeric;
  v_commission_cents integer;
  v_tip_cents integer;
  v_reg_pay integer;
  v_ot_pay integer;
  v_salary_pay integer;
  v_periods_per_year integer;
  v_gross integer;
  v_taxable integer;
  v_tax integer;
  v_item_id uuid;
  v_total_gross integer := 0;
  v_total_tips integer := 0;
  v_total_tax integer := 0;
  v_total_net integer := 0;
BEGIN
  v_user_id := public.get_account_owner_id();
  PERFORM public.ensure_payroll_chart_of_accounts();
  PERFORM public._ensure_tip_accounts(v_user_id);

  INSERT INTO pay_runs (user_id, pay_period_start, pay_period_end, pay_date)
  VALUES (v_user_id, p_period_start, p_period_end, p_pay_date)
  RETURNING id INTO v_run_id;

  FOR emp IN SELECT * FROM employees WHERE user_id = v_user_id AND active LOOP
    SELECT coalesce(sum(regular_hours), 0), coalesce(sum(overtime_hours), 0)
      INTO v_reg_hours, v_ot_hours
      FROM timesheets
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND work_date BETWEEN p_period_start AND p_period_end;

    SELECT coalesce(sum(commission_cents), 0) INTO v_commission_cents
      FROM commission_records
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND created_at::date <= p_period_end;

    SELECT coalesce(sum(amount_cents), 0) INTO v_tip_cents
      FROM tips
      WHERE user_id = v_user_id AND team_member_id = emp.team_member_id AND status = 'paid'
        AND pay_run_item_id IS NULL AND created_at::date <= p_period_end;

    v_reg_pay := 0; v_ot_pay := 0; v_salary_pay := 0;

    IF emp.pay_type IN ('hourly') THEN
      v_reg_pay := round(coalesce(emp.hourly_rate_cents, 0) * v_reg_hours);
      v_ot_pay := round(coalesce(emp.hourly_rate_cents, 0) * emp.overtime_multiplier * v_ot_hours);
    END IF;

    IF emp.pay_type IN ('salary', 'salary_plus_commission') THEN
      v_periods_per_year := CASE emp.pay_schedule
        WHEN 'weekly' THEN 52 WHEN 'biweekly' THEN 26 WHEN 'semimonthly' THEN 24 ELSE 12 END;
      v_salary_pay := round(coalesce(emp.annual_salary_cents, 0)::numeric / v_periods_per_year);
    END IF;

    IF emp.pay_type = 'commission_only' AND v_commission_cents = 0 AND v_tip_cents = 0 AND v_reg_hours = 0 AND v_ot_hours = 0 THEN
      CONTINUE;
    END IF;
    IF emp.pay_type != 'commission_only' AND v_reg_pay = 0 AND v_ot_pay = 0 AND v_salary_pay = 0 AND v_commission_cents = 0 AND v_tip_cents = 0 THEN
      CONTINUE;
    END IF;

    v_gross := v_reg_pay + v_ot_pay + v_salary_pay + v_commission_cents;   -- tips are NOT in gross_pay_cents
    v_taxable := v_gross + v_tip_cents;                                    -- ...but tips are taxable income
    v_tax := round(v_taxable * emp.default_tax_withholding_percent / 100.0);

    INSERT INTO pay_run_items (
      pay_run_id, employee_id, regular_hours, overtime_hours, regular_pay_cents, overtime_pay_cents,
      salary_pay_cents, commission_cents, tip_cents, tax_withholding_cents, net_pay_cents
    ) VALUES (
      v_run_id, emp.id, v_reg_hours, v_ot_hours, v_reg_pay, v_ot_pay, v_salary_pay, v_commission_cents,
      v_tip_cents, v_tax, v_taxable - v_tax
    ) RETURNING id INTO v_item_id;

    UPDATE timesheets SET pay_run_item_id = v_item_id
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND work_date BETWEEN p_period_start AND p_period_end;

    UPDATE commission_records SET pay_run_item_id = v_item_id
      WHERE employee_id = emp.id AND status = 'approved' AND pay_run_item_id IS NULL
        AND created_at::date <= p_period_end;

    UPDATE tips SET pay_run_item_id = v_item_id
      WHERE user_id = v_user_id AND team_member_id = emp.team_member_id AND status = 'paid'
        AND pay_run_item_id IS NULL AND created_at::date <= p_period_end;

    v_total_gross := v_total_gross + v_gross;
    v_total_tips := v_total_tips + v_tip_cents;
    v_total_tax := v_total_tax + v_tax;
    v_total_net := v_total_net + (v_taxable - v_tax);
  END LOOP;

  UPDATE pay_runs
    SET total_gross_cents = v_total_gross, total_tip_cents = v_total_tips, total_tax_cents = v_total_tax,
        total_net_cents = v_total_net, updated_at = now()
    WHERE id = v_run_id;

  RETURN v_run_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_pay_run(date, date, date) TO authenticated;

-- 8. approve_and_post_pay_run (original + Tips Payable line) -----------------------
CREATE OR REPLACE FUNCTION public.approve_and_post_pay_run(p_pay_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid;
  v_run pay_runs%ROWTYPE;
  v_wages_cents integer;
  v_commission_cents integer;
  v_je_id uuid;
  v_payroll_expense uuid;
  v_commission_expense uuid;
  v_tips_payable uuid;
  v_tax_payable uuid;
  v_cash uuid;
BEGIN
  v_user_id := public.get_account_owner_id();

  SELECT * INTO v_run FROM pay_runs WHERE id = p_pay_run_id AND user_id = v_user_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'Pay run not found'; END IF;
  IF v_run.status != 'draft' THEN RAISE EXCEPTION 'Pay run is not in draft status'; END IF;

  PERFORM public._ensure_tip_accounts(v_user_id);

  SELECT coalesce(sum(regular_pay_cents + overtime_pay_cents + salary_pay_cents + bonus_cents), 0),
         coalesce(sum(commission_cents), 0)
    INTO v_wages_cents, v_commission_cents
    FROM pay_run_items WHERE pay_run_id = p_pay_run_id;

  SELECT id INTO v_payroll_expense FROM chart_of_accounts WHERE user_id = v_user_id AND code = '6000';
  SELECT id INTO v_commission_expense FROM chart_of_accounts WHERE user_id = v_user_id AND code = '6050';
  SELECT id INTO v_tips_payable FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2310';
  SELECT id INTO v_tax_payable FROM chart_of_accounts WHERE user_id = v_user_id AND code = '2300';
  SELECT id INTO v_cash FROM chart_of_accounts WHERE user_id = v_user_id AND code = '1000';

  -- Dr wages + commission + tips payable = Cr tax payable + cash (net). Tips are a pass-through, not an expense.
  v_je_id := public.post_journal_entry(
    v_run.pay_date, 'Pay run ' || to_char(v_run.pay_period_start, 'YYYY-MM-DD') || ' to ' || to_char(v_run.pay_period_end, 'YYYY-MM-DD'),
    'manual', p_pay_run_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_payroll_expense, 'debit_cents', v_wages_cents, 'credit_cents', 0, 'description', 'Wages and salaries'),
      jsonb_build_object('account_id', v_commission_expense, 'debit_cents', v_commission_cents, 'credit_cents', 0, 'description', 'Commission'),
      jsonb_build_object('account_id', v_tips_payable, 'debit_cents', v_run.total_tip_cents, 'credit_cents', 0, 'description', 'Customer tips paid to technicians'),
      jsonb_build_object('account_id', v_tax_payable, 'debit_cents', 0, 'credit_cents', v_run.total_tax_cents, 'description', 'Withheld payroll tax'),
      jsonb_build_object('account_id', v_cash, 'debit_cents', 0, 'credit_cents', v_run.total_net_cents, 'description', 'Net pay disbursed')
    )
  );

  UPDATE pay_runs SET status = 'approved', journal_entry_id = v_je_id, updated_at = now() WHERE id = p_pay_run_id;
  RETURN v_je_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_and_post_pay_run(uuid) TO authenticated;

-- 9. get_ytd_payroll (+ tip_cents) ---------------------------------------------------
DROP FUNCTION IF EXISTS public.get_ytd_payroll(integer);
CREATE FUNCTION public.get_ytd_payroll(p_year integer)
RETURNS TABLE (employee_id uuid, full_name text, gross_cents bigint, tax_cents bigint, net_cents bigint, commission_cents bigint, tip_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();
  RETURN QUERY
  SELECT e.id, e.full_name,
    coalesce(sum(i.gross_pay_cents), 0)::bigint, coalesce(sum(i.tax_withholding_cents), 0)::bigint,
    coalesce(sum(i.net_pay_cents), 0)::bigint, coalesce(sum(i.commission_cents), 0)::bigint,
    coalesce(sum(i.tip_cents), 0)::bigint
  FROM employees e
  LEFT JOIN pay_runs r ON r.user_id = v_user_id AND r.status IN ('approved', 'paid') AND extract(year FROM r.pay_date) = p_year
  LEFT JOIN pay_run_items i ON i.pay_run_id = r.id AND i.employee_id = e.id
  WHERE e.user_id = v_user_id
  GROUP BY e.id, e.full_name
  ORDER BY e.full_name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_ytd_payroll(integer) TO authenticated;
