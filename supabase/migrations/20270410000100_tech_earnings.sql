/*
  # Technician earnings (/tech/earnings)

  Lets a technician see THEIR OWN earnings, commissions and tips per pay period.
  Builds on 20261204000000_payroll.sql (employees, timesheets, commission_records,
  pay_runs, pay_run_items). Additive only.

  ## Why RPCs and not table reads
  The payroll tables are scoped with `user_id = get_account_owner_id()`. For a
  team member that resolves to the ACCOUNT OWNER, so a technician session can
  read every colleague's pay rows through those policies. The functions below
  therefore never rely on them: they are SECURITY DEFINER, resolve the caller's
  own employee row (employees.team_member_id = get_my_team_member_id()) and only
  ever return that person's data.
  (Heads-up: the existing payroll policies are worth tightening separately.)

  ## What this adds
  - job_tips: tips received on a job, credited to the assigned technician.
    Manager-only table (owner/admin); technicians read theirs through the RPCs.
  - record_job_tip(): manager action to record a tip (technician is taken from
    the job, never from the client).
  - get_my_earnings(): current (not yet paid) period estimate + the last N
    finalized pay periods (approved / paid runs; drafts stay hidden).
  - get_my_earnings_detail(): the commission lines, hours and tips behind one
    period (or behind the current estimate).

  ## Rules
  - A pay period is an approved/paid pay run. Draft runs are not final, so their
    numbers are still shown inside "current (estimate)".
  - Tips are not part of pay runs (they are passed through); they belong to the
    period whose dates contain the day they were received.
*/

-- =============================================================
-- 1. TIPS
-- =============================================================

CREATE OR REPLACE FUNCTION public.tech_pay_can_manage()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND tm.user_id = auth.uid()
        AND tm.role = 'admin' AND tm.invite_status = 'active'
    ),
    false
  );
$$;

CREATE TABLE IF NOT EXISTS job_tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  source text NOT NULL DEFAULT 'other' CHECK (source IN ('cash', 'card', 'invoice', 'other')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  received_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_tips_tech_received ON job_tips(user_id, technician_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_tips_job ON job_tips(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE job_tips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_manage_job_tips" ON job_tips;
CREATE POLICY "managers_manage_job_tips" ON job_tips FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());

CREATE OR REPLACE FUNCTION public.record_job_tip(
  p_job_id uuid,
  p_amount_cents integer,
  p_source text DEFAULT 'other',
  p_note text DEFAULT NULL,
  p_received_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tech uuid;
  v_id uuid;
BEGIN
  IF NOT public.tech_pay_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 10000000 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('cash', 'card', 'invoice', 'other') THEN
    RETURN jsonb_build_object('status', 'invalid_source');
  END IF;

  SELECT j.assigned_technician_id INTO v_tech FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'job_not_found'); END IF;
  IF v_tech IS NULL THEN RETURN jsonb_build_object('status', 'no_technician'); END IF;

  INSERT INTO job_tips (user_id, job_id, technician_id, amount_cents, source, note, received_at)
  VALUES (v_owner, p_job_id, v_tech, p_amount_cents, p_source, NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''), COALESCE(p_received_at, now()))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'applied', 'id', v_id);
END;
$$;

-- =============================================================
-- 2. Internal context: who is the caller, as an employee?
-- =============================================================

CREATE OR REPLACE FUNCTION public.my_pay_context()
RETURNS TABLE (owner_id uuid, team_member_id uuid, employee_id uuid, last_final_end date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.get_account_owner_id(),
    public.get_my_team_member_id(),
    (SELECT e.id FROM employees e
      WHERE e.user_id = public.get_account_owner_id() AND e.team_member_id = public.get_my_team_member_id()
      ORDER BY e.active DESC, e.created_at LIMIT 1),
    (SELECT max(r.pay_period_end) FROM pay_runs r
      WHERE r.user_id = public.get_account_owner_id() AND r.status IN ('approved', 'paid'));
$$;

REVOKE ALL ON FUNCTION public.my_pay_context() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 3. READ: summary
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_my_earnings(p_limit integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  e employees%ROWTYPE;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 12), 1), 52);
  v_reg_hours numeric;
  v_ot_hours numeric;
  v_pending_sheets integer;
  v_reg_pay integer := 0;
  v_ot_pay integer := 0;
  v_salary_pay integer := 0;
  v_periods_per_year integer;
  v_commission integer;
  v_commission_n integer;
  v_tips integer;
  v_periods jsonb;
BEGIN
  SELECT * INTO c FROM public.my_pay_context();
  IF c.team_member_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_a_technician');
  END IF;
  IF c.employee_id IS NULL THEN
    RETURN jsonb_build_object('error', 'no_pay_profile');
  END IF;
  SELECT * INTO e FROM employees WHERE id = c.employee_id;

  -- Current (not yet final): timesheets / commissions not on an approved or paid run.
  SELECT COALESCE(SUM(t.regular_hours), 0), COALESCE(SUM(t.overtime_hours), 0),
         COUNT(*) FILTER (WHERE t.status = 'pending')::integer
    INTO v_reg_hours, v_ot_hours, v_pending_sheets
    FROM timesheets t
    LEFT JOIN pay_run_items i ON i.id = t.pay_run_item_id
    LEFT JOIN pay_runs r ON r.id = i.pay_run_id
   WHERE t.employee_id = e.id AND t.status IN ('pending', 'approved')
     AND (t.pay_run_item_id IS NULL OR r.status = 'draft');

  SELECT COALESCE(SUM(cr.commission_cents), 0)::integer, COUNT(*)::integer
    INTO v_commission, v_commission_n
    FROM commission_records cr
    LEFT JOIN pay_run_items i ON i.id = cr.pay_run_item_id
    LEFT JOIN pay_runs r ON r.id = i.pay_run_id
   WHERE cr.employee_id = e.id AND cr.status IN ('pending', 'approved')
     AND (cr.pay_run_item_id IS NULL OR r.status = 'draft');

  SELECT COALESCE(SUM(jt.amount_cents), 0)::integer INTO v_tips
    FROM job_tips jt
   WHERE jt.user_id = c.owner_id AND jt.technician_id = c.team_member_id
     AND (c.last_final_end IS NULL OR jt.received_at::date > c.last_final_end);

  IF e.pay_type = 'hourly' THEN
    v_reg_pay := round(COALESCE(e.hourly_rate_cents, 0) * v_reg_hours);
    v_ot_pay := round(COALESCE(e.hourly_rate_cents, 0) * e.overtime_multiplier * v_ot_hours);
  ELSIF e.pay_type IN ('salary', 'salary_plus_commission') THEN
    v_periods_per_year := CASE e.pay_schedule WHEN 'weekly' THEN 52 WHEN 'biweekly' THEN 26 WHEN 'semimonthly' THEN 24 ELSE 12 END;
    v_salary_pay := round(COALESCE(e.annual_salary_cents, 0)::numeric / v_periods_per_year);
  END IF;

  SELECT COALESCE(jsonb_agg(p ORDER BY p.pay_date DESC, p.pay_period_end DESC), '[]'::jsonb) INTO v_periods
  FROM (
    SELECT
      r.id AS pay_run_id, r.pay_period_start, r.pay_period_end, r.pay_date, r.status,
      i.id AS item_id, i.regular_hours, i.overtime_hours, i.regular_pay_cents, i.overtime_pay_cents,
      i.salary_pay_cents, i.commission_cents, i.bonus_cents, i.gross_pay_cents,
      i.tax_withholding_cents, i.other_deductions_cents, i.net_pay_cents, i.paid_at,
      COALESCE((
        SELECT SUM(jt.amount_cents)::integer FROM job_tips jt
         WHERE jt.user_id = c.owner_id AND jt.technician_id = c.team_member_id
           AND jt.received_at::date BETWEEN r.pay_period_start AND r.pay_period_end
      ), 0) AS tips_cents
    FROM pay_run_items i
    JOIN pay_runs r ON r.id = i.pay_run_id
    WHERE i.employee_id = e.id AND r.user_id = c.owner_id AND r.status IN ('approved', 'paid')
    ORDER BY r.pay_date DESC, r.pay_period_end DESC
    LIMIT v_limit
  ) p;

  RETURN jsonb_build_object(
    'employee', jsonb_build_object(
      'id', e.id, 'full_name', e.full_name, 'pay_type', e.pay_type, 'pay_schedule', e.pay_schedule,
      'commission_rate_percent', e.commission_rate_percent, 'employment_type', e.employment_type
    ),
    'current', jsonb_build_object(
      'since', CASE WHEN c.last_final_end IS NULL THEN NULL ELSE c.last_final_end + 1 END,
      'regular_hours', v_reg_hours, 'overtime_hours', v_ot_hours, 'pending_timesheets', v_pending_sheets,
      'regular_pay_cents', v_reg_pay, 'overtime_pay_cents', v_ot_pay, 'salary_pay_cents', v_salary_pay,
      'commission_cents', v_commission, 'commission_count', v_commission_n, 'tips_cents', v_tips
    ),
    'periods', v_periods,
    'generated_at', to_jsonb(now())
  );
END;
$$;

-- =============================================================
-- 4. READ: detail behind one period (or behind the current estimate)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_my_earnings_detail(p_item_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_start date;
  v_end date;
  v_commissions jsonb;
  v_sheets jsonb;
  v_tips jsonb;
BEGIN
  SELECT * INTO c FROM public.my_pay_context();
  IF c.team_member_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_technician'); END IF;
  IF c.employee_id IS NULL THEN RETURN jsonb_build_object('error', 'no_pay_profile'); END IF;

  IF p_item_id IS NOT NULL THEN
    SELECT r.pay_period_start, r.pay_period_end INTO v_start, v_end
      FROM pay_run_items i JOIN pay_runs r ON r.id = i.pay_run_id
     WHERE i.id = p_item_id AND i.employee_id = c.employee_id AND r.user_id = c.owner_id AND r.status IN ('approved', 'paid');
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_commissions
  FROM (
    SELECT cr.id, cr.job_id, j.customer_name, j.service_type, cr.basis_amount_cents, cr.commission_rate_percent,
           cr.commission_cents, cr.status, cr.created_at
      FROM commission_records cr
      LEFT JOIN jobs j ON j.id = cr.job_id
      LEFT JOIN pay_run_items i ON i.id = cr.pay_run_item_id
      LEFT JOIN pay_runs r ON r.id = i.pay_run_id
     WHERE cr.employee_id = c.employee_id
       AND CASE WHEN p_item_id IS NOT NULL THEN cr.pay_run_item_id = p_item_id
                ELSE cr.status IN ('pending', 'approved') AND (cr.pay_run_item_id IS NULL OR r.status = 'draft') END
     ORDER BY cr.created_at DESC
     LIMIT 200
  ) x;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.work_date DESC), '[]'::jsonb) INTO v_sheets
  FROM (
    SELECT t.id, t.work_date, t.regular_hours, t.overtime_hours, t.status, j.customer_name
      FROM timesheets t
      LEFT JOIN jobs j ON j.id = t.job_id
      LEFT JOIN pay_run_items i ON i.id = t.pay_run_item_id
      LEFT JOIN pay_runs r ON r.id = i.pay_run_id
     WHERE t.employee_id = c.employee_id
       AND CASE WHEN p_item_id IS NOT NULL THEN t.pay_run_item_id = p_item_id
                ELSE t.status IN ('pending', 'approved') AND (t.pay_run_item_id IS NULL OR r.status = 'draft') END
     ORDER BY t.work_date DESC
     LIMIT 200
  ) x;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.received_at DESC), '[]'::jsonb) INTO v_tips
  FROM (
    SELECT jt.id, jt.amount_cents, jt.source, jt.note, jt.received_at, j.customer_name
      FROM job_tips jt
      LEFT JOIN jobs j ON j.id = jt.job_id
     WHERE jt.user_id = c.owner_id AND jt.technician_id = c.team_member_id
       AND CASE WHEN p_item_id IS NOT NULL THEN jt.received_at::date BETWEEN v_start AND v_end
                ELSE (c.last_final_end IS NULL OR jt.received_at::date > c.last_final_end) END
     ORDER BY jt.received_at DESC
     LIMIT 200
  ) x;

  RETURN jsonb_build_object('commissions', v_commissions, 'timesheets', v_sheets, 'tips', v_tips);
END;
$$;

-- =============================================================
-- 5. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.get_my_earnings(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_earnings_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_job_tip(uuid, integer, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_earnings(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_earnings_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_job_tip(uuid, integer, text, text, timestamptz) TO authenticated;
