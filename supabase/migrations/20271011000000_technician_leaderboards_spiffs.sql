/*
  # Technician leaderboards + spiffs

  ## What this adds
  - leaderboard_settings   per-account: enabled KPIs, composite weights, minimum sample sizes,
                           payout settle delay, auto-approve, name visibility for technicians.
  - leaderboard_optouts    per-technician opt-out (a technician can opt themselves out).
  - spiff_rules            bonus rules: `threshold` (hit a KPI target -> flat payout) or
                           `rank` (finish top N -> payout ladder), weekly or monthly.
  - spiff_payouts          one immutable line per (rule, technician, period). Idempotent.
  - RPCs                   get_leaderboard, generate_spiff_payouts, review_spiff_payout,
                           get_spiff_payouts, get_my_spiffs, set_leaderboard_opt_out.
  - Payroll integration    create_pay_run() is wrapped: it first settles any closed periods, runs
                           the existing implementation untouched, then adds every approved,
                           unpaid spiff to `pay_run_items.bonus_cents` (tax withheld at the
                           employee's default rate). approve_and_post_pay_run already books
                           bonus_cents as wages, so the ledger stays balanced with no change.
                           Voiding a pay run releases its spiffs; paying it marks them paid.

  ## KPI definitions (all per technician, completed jobs in the period)
  - first_time_fix_rate  100 - % of completed jobs that were later reworked (jobs.is_rework /
                         rework_of_job_id), same signal as Performance OS / Rework Intelligence.
  - upsell_rate          % of completed jobs whose ACCEPTED quote offered 2+ options and whose
                         selected option costs more than the cheapest option offered.
  - csat_avg             mean review_requests.rating for those jobs; hidden below
                         min_csat_responses.
  - revenue_cents        sum of jobs.invoice_amount.
  - jobs_completed, overall (weighted composite of the enabled KPIs, 0-100).

  ## Honest limitations
  - Periods are ISO weeks (Monday start) and calendar months, evaluated on UTC dates.
  - A period only pays out once it is `payout_delay_days` old so callbacks/reviews can arrive;
    a rework after that does NOT claw back an already-generated spiff (void the line instead).
  - Rank ties split the tied positions' payouts evenly (cents rounded down).
  - Rank rules need at least 2 eligible technicians.

  ## Security
  Writes only through SECURITY DEFINER RPCs gated by can_manage_commissions(); RLS is on
  everywhere, scoped by get_account_owner_id().
*/

-- lint:allow-destructive wraps create_pay_run by renaming the live implementation to _create_pay_run_base (guarded, idempotent)

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS leaderboard_settings (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  enabled_kpis text[] NOT NULL DEFAULT ARRAY['first_time_fix_rate','upsell_rate','csat_avg','revenue_cents'],
  kpi_weights jsonb NOT NULL DEFAULT '{"first_time_fix_rate":30,"upsell_rate":20,"csat_avg":30,"revenue_cents":20,"jobs_completed":0}'::jsonb,
  min_jobs_to_rank integer NOT NULL DEFAULT 3 CHECK (min_jobs_to_rank BETWEEN 0 AND 100),
  min_csat_responses integer NOT NULL DEFAULT 3 CHECK (min_csat_responses BETWEEN 1 AND 50),
  payout_delay_days integer NOT NULL DEFAULT 7 CHECK (payout_delay_days BETWEEN 0 AND 60),
  auto_approve_payouts boolean NOT NULL DEFAULT true,
  show_names_to_technicians boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leaderboard_kpis_valid CHECK (
    enabled_kpis <@ ARRAY['first_time_fix_rate','upsell_rate','csat_avg','revenue_cents','jobs_completed']::text[]
    AND cardinality(enabled_kpis) >= 1
  )
);
ALTER TABLE leaderboard_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS leaderboard_optouts (
  team_member_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  opted_out_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_optouts_user ON leaderboard_optouts(user_id);
ALTER TABLE leaderboard_optouts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS spiff_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  kpi text NOT NULL CHECK (kpi IN ('first_time_fix_rate','upsell_rate','csat_avg','revenue_cents','jobs_completed','overall')),
  period text NOT NULL CHECK (period IN ('weekly','monthly')),
  rule_type text NOT NULL CHECK (rule_type IN ('threshold','rank')),
  threshold numeric CHECK (threshold IS NULL OR threshold >= 0),
  payout_cents integer CHECK (payout_cents IS NULL OR payout_cents BETWEEN 1 AND 1000000),
  rank_payouts_cents integer[],
  min_jobs integer NOT NULL DEFAULT 0 CHECK (min_jobs BETWEEN 0 AND 1000),
  active boolean NOT NULL DEFAULT true,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spiff_rule_shape CHECK (
    (rule_type = 'threshold' AND threshold IS NOT NULL AND payout_cents IS NOT NULL AND rank_payouts_cents IS NULL)
    OR
    (rule_type = 'rank' AND rank_payouts_cents IS NOT NULL AND payout_cents IS NULL
       AND cardinality(rank_payouts_cents) BETWEEN 1 AND 10
       AND rank_payouts_cents[1] > 0
       AND 0 <= ALL (rank_payouts_cents) AND 1000000 >= ALL (rank_payouts_cents))
  ),
  CONSTRAINT spiff_rule_dates CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_spiff_rules_user_active ON spiff_rules(user_id, active);
ALTER TABLE spiff_rules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS spiff_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rule_id uuid NOT NULL REFERENCES spiff_rules(id) ON DELETE RESTRICT,
  rule_name text NOT NULL,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('weekly','monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  rank integer,
  kpi_value numeric,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  pay_run_item_id uuid REFERENCES pay_run_items(id) ON DELETE SET NULL,
  calc_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid,
  review_note text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: one line per rule x technician x period, however often generation runs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_spiff_payout_once ON spiff_payouts(rule_id, team_member_id, period_start);
CREATE INDEX IF NOT EXISTS idx_spiff_payouts_user_status ON spiff_payouts(user_id, status, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_spiff_payouts_tm ON spiff_payouts(team_member_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_spiff_payouts_item ON spiff_payouts(pay_run_item_id) WHERE pay_run_item_id IS NOT NULL;
ALTER TABLE spiff_payouts ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 2. RLS  (writes go through RPCs; spiff_payouts/optouts have no client write policy)
-- =============================================================

DROP POLICY IF EXISTS lb_settings_read ON leaderboard_settings;
CREATE POLICY lb_settings_read ON leaderboard_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS lb_settings_write ON leaderboard_settings;
CREATE POLICY lb_settings_write ON leaderboard_settings FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS spiff_rules_read ON spiff_rules;
CREATE POLICY spiff_rules_read ON spiff_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS spiff_rules_write ON spiff_rules;
CREATE POLICY spiff_rules_write ON spiff_rules FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS spiff_payouts_manager_read ON spiff_payouts;
CREATE POLICY spiff_payouts_manager_read ON spiff_payouts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

DROP POLICY IF EXISTS lb_optouts_manager_read ON leaderboard_optouts;
CREATE POLICY lb_optouts_manager_read ON leaderboard_optouts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_commissions());

-- =============================================================
-- 3. INTERNAL HELPERS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._lb_period(p_period text, p_anchor date)
RETURNS TABLE (period_start date, period_end date)
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
  IF p_period = 'weekly' THEN
    period_start := date_trunc('week', p_anchor)::date;
    period_end := period_start + 6;
  ELSIF p_period = 'monthly' THEN
    period_start := date_trunc('month', p_anchor)::date;
    period_end := (date_trunc('month', p_anchor) + interval '1 month - 1 day')::date;
  ELSE
    RAISE EXCEPTION 'Unknown period: %', p_period USING ERRCODE = '22023';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public._lb_option_total(p_option jsonb)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_total numeric := 0; li jsonb;
BEGIN
  IF jsonb_typeof(p_option->'line_items') <> 'array' THEN RETURN 0; END IF;
  FOR li IN SELECT * FROM jsonb_array_elements(p_option->'line_items') LOOP
    v_total := v_total + coalesce((li->>'quantity')::numeric, 1) * coalesce((li->>'unit_price_cents')::numeric, 0);
  END LOOP;
  RETURN v_total;
EXCEPTION WHEN others THEN
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public._lb_pick(
  p_kpi text, p_ftf numeric, p_ups numeric, p_csat numeric, p_rev bigint, p_jobs integer, p_overall numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_kpi
    WHEN 'first_time_fix_rate' THEN p_ftf
    WHEN 'upsell_rate' THEN p_ups
    WHEN 'csat_avg' THEN p_csat
    WHEN 'revenue_cents' THEN p_rev::numeric
    WHEN 'jobs_completed' THEN p_jobs::numeric
    WHEN 'overall' THEN p_overall
  END;
$$;

-- One row per active technician: KPIs, composite score, eligibility and per-KPI ranks.
CREATE OR REPLACE FUNCTION public._lb_board(p_owner uuid, p_start date, p_end date)
RETURNS TABLE (
  team_member_id uuid, member_name text, jobs_completed integer,
  first_time_fix_rate numeric, upsell_rate numeric, upsell_opportunities integer,
  csat_avg numeric, csat_responses integer, revenue_cents bigint,
  opted_out boolean, eligible boolean, overall_score numeric,
  rank_overall integer, rank_first_time_fix integer, rank_upsell integer,
  rank_csat integer, rank_revenue integer, rank_jobs integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s leaderboard_settings%ROWTYPE;
  w jsonb;
  en text[];
BEGIN
  SELECT * INTO s FROM leaderboard_settings WHERE user_id = p_owner;
  IF s.user_id IS NULL THEN
    s.min_jobs_to_rank := 3; s.min_csat_responses := 3;
    s.enabled_kpis := ARRAY['first_time_fix_rate','upsell_rate','csat_avg','revenue_cents'];
    s.kpi_weights := '{"first_time_fix_rate":30,"upsell_rate":20,"csat_avg":30,"revenue_cents":20,"jobs_completed":0}'::jsonb;
  END IF;
  w := s.kpi_weights; en := s.enabled_kpis;

  RETURN QUERY
  WITH done AS (
    SELECT j.id, j.assigned_technician_id AS tm, j.quote_id,
           round(coalesce(j.invoice_amount, 0) * 100)::bigint AS rev,
           EXISTS (SELECT 1 FROM jobs rw WHERE rw.user_id = p_owner AND rw.is_rework AND rw.rework_of_job_id = j.id) AS reworked
    FROM jobs j
    WHERE j.user_id = p_owner AND j.job_status = 'completed' AND j.assigned_technician_id IS NOT NULL
      AND coalesce(j.completed_at, j.scheduled_datetime)::date BETWEEN p_start AND p_end
  ),
  ups AS (
    SELECT d.id, d.tm, (tot.sel_total IS NOT NULL AND tot.sel_total > tot.min_total) AS upsold
    FROM done d
    JOIN quotes q ON q.id = d.quote_id AND q.user_id = p_owner AND q.status = 'accepted'
                 AND jsonb_typeof(q.options) = 'array' AND jsonb_array_length(q.options) > 1
                 AND q.selected_option_id IS NOT NULL
    CROSS JOIN LATERAL (
      SELECT min(x.t) AS min_total, max(x.t) FILTER (WHERE x.oid = q.selected_option_id) AS sel_total
      FROM (SELECT o->>'id' AS oid, public._lb_option_total(o) AS t FROM jsonb_array_elements(q.options) o) x
    ) tot
  ),
  csat AS (
    SELECT j.assigned_technician_id AS tm, count(*)::int AS n, avg(r.rating)::numeric AS avg_rating
    FROM review_requests r JOIN jobs j ON j.id = r.job_id
    WHERE j.user_id = p_owner AND r.rating IS NOT NULL
      AND coalesce(r.completed_at, r.sent_at)::date BETWEEN p_start AND p_end
    GROUP BY j.assigned_technician_id
  ),
  agg AS (
    SELECT tm.id AS tmid,
           coalesce(nullif(btrim(tm.member_name), ''), tm.member_email) AS nm,
           (SELECT count(*)::int FROM done d WHERE d.tm = tm.id) AS jobs_n,
           (SELECT round(100 - 100.0 * count(*) FILTER (WHERE d.reworked) / nullif(count(*), 0), 1) FROM done d WHERE d.tm = tm.id) AS ftf,
           (SELECT round(100.0 * count(*) FILTER (WHERE u.upsold) / nullif(count(*), 0), 1) FROM ups u WHERE u.tm = tm.id) AS ups_rate,
           (SELECT count(*)::int FROM ups u WHERE u.tm = tm.id) AS ups_n,
           CASE WHEN c.n >= s.min_csat_responses THEN round(c.avg_rating, 2) END AS csat_v,
           coalesce(c.n, 0) AS csat_n,
           coalesce((SELECT sum(d.rev) FROM done d WHERE d.tm = tm.id), 0)::bigint AS rev_v,
           EXISTS (SELECT 1 FROM leaderboard_optouts o WHERE o.team_member_id = tm.id) AS oo
    FROM team_members tm
    LEFT JOIN csat c ON c.tm = tm.id
    WHERE tm.account_owner_id = p_owner AND tm.role = 'technician' AND tm.invite_status = 'active'
  ),
  el AS (
    SELECT a.*, (NOT a.oo AND a.jobs_n >= s.min_jobs_to_rank AND a.jobs_n > 0) AS is_el FROM agg a
  ),
  mx AS (
    SELECT greatest(max(e.rev_v) FILTER (WHERE e.is_el), 1) AS max_rev,
           greatest(max(e.jobs_n) FILTER (WHERE e.is_el), 1) AS max_jobs
    FROM el e
  ),
  sc AS (
    SELECT e.*,
      (CASE WHEN 'first_time_fix_rate' = ANY (en) AND e.ftf IS NOT NULL THEN coalesce((w->>'first_time_fix_rate')::numeric, 0) ELSE 0 END) AS wf,
      (CASE WHEN 'upsell_rate' = ANY (en) AND e.ups_rate IS NOT NULL THEN coalesce((w->>'upsell_rate')::numeric, 0) ELSE 0 END) AS wu,
      (CASE WHEN 'csat_avg' = ANY (en) AND e.csat_v IS NOT NULL THEN coalesce((w->>'csat_avg')::numeric, 0) ELSE 0 END) AS wc,
      (CASE WHEN 'revenue_cents' = ANY (en) THEN coalesce((w->>'revenue_cents')::numeric, 0) ELSE 0 END) AS wr,
      (CASE WHEN 'jobs_completed' = ANY (en) THEN coalesce((w->>'jobs_completed')::numeric, 0) ELSE 0 END) AS wj,
      m.max_rev, m.max_jobs
    FROM el e CROSS JOIN mx m
  ),
  ov AS (
    SELECT q.*,
      CASE WHEN (q.wf + q.wu + q.wc + q.wr + q.wj) > 0 THEN round((
        q.wf * coalesce(q.ftf, 0) + q.wu * coalesce(q.ups_rate, 0)
        + q.wc * coalesce((q.csat_v - 1) / 4.0 * 100, 0)
        + q.wr * (q.rev_v::numeric / q.max_rev * 100)
        + q.wj * (q.jobs_n::numeric / q.max_jobs * 100)
      ) / (q.wf + q.wu + q.wc + q.wr + q.wj), 1) END AS overall_v
    FROM sc q
  )
  SELECT o.tmid, o.nm, o.jobs_n, o.ftf, o.ups_rate, o.ups_n, o.csat_v, o.csat_n, o.rev_v, o.oo, o.is_el, o.overall_v,
    CASE WHEN o.is_el AND o.overall_v IS NOT NULL THEN rank() OVER (PARTITION BY (o.is_el AND o.overall_v IS NOT NULL) ORDER BY o.overall_v DESC)::int END,
    CASE WHEN o.is_el AND o.ftf IS NOT NULL THEN rank() OVER (PARTITION BY (o.is_el AND o.ftf IS NOT NULL) ORDER BY o.ftf DESC)::int END,
    CASE WHEN o.is_el AND o.ups_rate IS NOT NULL THEN rank() OVER (PARTITION BY (o.is_el AND o.ups_rate IS NOT NULL) ORDER BY o.ups_rate DESC)::int END,
    CASE WHEN o.is_el AND o.csat_v IS NOT NULL THEN rank() OVER (PARTITION BY (o.is_el AND o.csat_v IS NOT NULL) ORDER BY o.csat_v DESC)::int END,
    CASE WHEN o.is_el THEN rank() OVER (PARTITION BY o.is_el ORDER BY o.rev_v DESC)::int END,
    CASE WHEN o.is_el THEN rank() OVER (PARTITION BY o.is_el ORDER BY o.jobs_n DESC)::int END
  FROM ov o;
END;
$$;

REVOKE ALL ON FUNCTION public._lb_period(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lb_option_total(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lb_pick(text, numeric, numeric, numeric, bigint, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lb_board(uuid, date, date) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 4. GENERATION (internal) — idempotent, one pass per period
-- =============================================================

CREATE OR REPLACE FUNCTION public._spiff_generate_period(p_owner uuid, p_period text, p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s leaderboard_settings%ROWTYPE;
  r spiff_rules%ROWTYPE;
  rec RECORD;
  v_status text;
  v_amount integer;
  v_inserted integer := 0;
  v_total bigint := 0;
  v_rows integer;
  v_min_jobs integer;
BEGIN
  SELECT * INTO s FROM leaderboard_settings WHERE user_id = p_owner;
  IF s.user_id IS NOT NULL AND NOT s.enabled THEN
    RETURN jsonb_build_object('inserted', 0, 'total_cents', 0);
  END IF;
  v_status := CASE WHEN s.user_id IS NULL OR s.auto_approve_payouts THEN 'approved' ELSE 'pending' END;

  FOR r IN
    SELECT * FROM spiff_rules
    WHERE user_id = p_owner AND active AND period = p_period
      AND starts_on <= p_end AND (ends_on IS NULL OR ends_on >= p_start)
  LOOP
    v_min_jobs := greatest(r.min_jobs, coalesce(s.min_jobs_to_rank, 3), 1);

    FOR rec IN
      SELECT x.team_member_id, x.v, x.jobs_completed,
             rank() OVER (ORDER BY x.v DESC)::int AS rnk,
             count(*) OVER ()::int AS cohort,
             count(*) OVER (PARTITION BY x.v)::int AS tie_size
      FROM (
        SELECT b.team_member_id, b.jobs_completed,
               public._lb_pick(r.kpi, b.first_time_fix_rate, b.upsell_rate, b.csat_avg, b.revenue_cents, b.jobs_completed, b.overall_score) AS v
        FROM public._lb_board(p_owner, p_start, p_end) b
        WHERE NOT b.opted_out AND b.jobs_completed >= v_min_jobs
      ) x
      WHERE x.v IS NOT NULL
    LOOP
      v_amount := 0;
      IF r.rule_type = 'threshold' THEN
        IF rec.v >= r.threshold THEN v_amount := r.payout_cents; END IF;
      ELSIF rec.cohort >= 2 AND rec.rnk <= cardinality(r.rank_payouts_cents) THEN
        -- tied positions share the pooled payouts of the places they occupy
        SELECT coalesce(sum(r.rank_payouts_cents[i]), 0)::int / rec.tie_size INTO v_amount
        FROM generate_series(rec.rnk, least(rec.rnk + rec.tie_size - 1, cardinality(r.rank_payouts_cents))) i;
      END IF;

      IF v_amount > 0 THEN
        INSERT INTO spiff_payouts (user_id, rule_id, rule_name, team_member_id, period, period_start, period_end,
                                   rank, kpi_value, amount_cents, status, calc_detail)
        VALUES (p_owner, r.id, r.name, rec.team_member_id, p_period, p_start, p_end,
                CASE WHEN r.rule_type = 'rank' THEN rec.rnk END, rec.v, v_amount, v_status,
                jsonb_build_object('kpi', r.kpi, 'rule_type', r.rule_type, 'threshold', r.threshold,
                                   'cohort', rec.cohort, 'tie_size', rec.tie_size, 'jobs_completed', rec.jobs_completed))
        ON CONFLICT (rule_id, team_member_id, period_start) DO NOTHING;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
          v_inserted := v_inserted + 1;
          v_total := v_total + v_amount;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'total_cents', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public._spiff_generate_period(uuid, text, date, date) FROM PUBLIC, anon, authenticated;

-- Settle every closed, old-enough weekly/monthly period up to p_cutoff (recent look-back only).
CREATE OR REPLACE FUNCTION public._spiff_generate_settled(p_owner uuid, p_cutoff date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s leaderboard_settings%ROWTYPE;
  v_cut date;
  i integer;
  p RECORD;
  v_n integer := 0;
  res jsonb;
BEGIN
  SELECT * INTO s FROM leaderboard_settings WHERE user_id = p_owner;
  v_cut := least(p_cutoff, current_date - coalesce(s.payout_delay_days, 7));
  FOR i IN 0..5 LOOP
    SELECT * INTO p FROM public._lb_period('weekly', (date_trunc('week', v_cut)::date - 7 * i));
    IF p.period_end <= v_cut THEN
      res := public._spiff_generate_period(p_owner, 'weekly', p.period_start, p.period_end);
      v_n := v_n + (res->>'inserted')::int;
    END IF;
  END LOOP;
  FOR i IN 0..2 LOOP
    SELECT * INTO p FROM public._lb_period('monthly', (date_trunc('month', v_cut) - make_interval(months => i))::date);
    IF p.period_end <= v_cut THEN
      res := public._spiff_generate_period(p_owner, 'monthly', p.period_start, p.period_end);
      v_n := v_n + (res->>'inserted')::int;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._spiff_generate_settled(uuid, date) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. PAYROLL INTEGRATION
-- =============================================================

CREATE OR REPLACE FUNCTION public._spiff_attach_to_pay_run(p_owner uuid, p_run uuid, p_period_end date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec RECORD;
  v_item uuid;
  v_tax integer;
  v_gross_add bigint := 0;
  v_tax_add bigint := 0;
  v_net_add bigint := 0;
  v_lines integer := 0;
BEGIN
  FOR rec IN
    SELECT e.id AS employee_id, e.default_tax_withholding_percent AS tax_pct,
           array_agg(sp.id) AS ids, sum(sp.amount_cents)::int AS total
    FROM spiff_payouts sp
    JOIN employees e ON e.team_member_id = sp.team_member_id AND e.user_id = p_owner AND e.active
    WHERE sp.user_id = p_owner AND sp.status = 'approved' AND sp.pay_run_item_id IS NULL
      AND sp.period_end <= p_period_end
    GROUP BY e.id, e.default_tax_withholding_percent
  LOOP
    v_tax := round(rec.total * rec.tax_pct / 100.0);

    SELECT id INTO v_item FROM pay_run_items WHERE pay_run_id = p_run AND employee_id = rec.employee_id;
    IF v_item IS NULL THEN
      INSERT INTO pay_run_items (pay_run_id, employee_id, bonus_cents, tax_withholding_cents, net_pay_cents)
      VALUES (p_run, rec.employee_id, rec.total, v_tax, rec.total - v_tax)
      RETURNING id INTO v_item;
    ELSE
      UPDATE pay_run_items
      SET bonus_cents = bonus_cents + rec.total,
          tax_withholding_cents = tax_withholding_cents + v_tax,
          net_pay_cents = net_pay_cents + rec.total - v_tax
      WHERE id = v_item;
    END IF;

    UPDATE spiff_payouts SET pay_run_item_id = v_item WHERE id = ANY (rec.ids);

    v_gross_add := v_gross_add + rec.total;
    v_tax_add := v_tax_add + v_tax;
    v_net_add := v_net_add + (rec.total - v_tax);
    v_lines := v_lines + array_length(rec.ids, 1);
  END LOOP;

  IF v_lines > 0 THEN
    UPDATE pay_runs
    SET total_gross_cents = total_gross_cents + v_gross_add,
        total_tax_cents = total_tax_cents + v_tax_add,
        total_net_cents = total_net_cents + v_net_add,
        updated_at = now()
    WHERE id = p_run;
  END IF;
  RETURN v_lines;
END;
$$;
REVOKE ALL ON FUNCTION public._spiff_attach_to_pay_run(uuid, uuid, date) FROM PUBLIC, anon, authenticated;

-- Wrap the live create_pay_run (whatever its current body) instead of redefining it.
DO $$
BEGIN
  IF to_regprocedure('public._create_pay_run_base(date,date,date)') IS NULL THEN
    ALTER FUNCTION public.create_pay_run(date, date, date) RENAME TO _create_pay_run_base;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._create_pay_run_base(date, date, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_pay_run(p_period_start date, p_period_end date, p_pay_date date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_run uuid;
BEGIN
  PERFORM public._spiff_generate_settled(v_owner, p_period_end);
  v_run := public._create_pay_run_base(p_period_start, p_period_end, p_pay_date);
  PERFORM public._spiff_attach_to_pay_run(v_owner, v_run, p_period_end);
  RETURN v_run;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_pay_run(date, date, date) TO authenticated;

-- Pay run item paid -> spiff lines paid.
CREATE OR REPLACE FUNCTION public._spiff_sync_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
    UPDATE spiff_payouts SET status = 'paid', paid_at = NEW.paid_at
    WHERE pay_run_item_id = NEW.id AND status = 'approved';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_spiff_sync_paid ON pay_run_items;
CREATE TRIGGER trg_spiff_sync_paid AFTER UPDATE OF paid_at ON pay_run_items
  FOR EACH ROW EXECUTE FUNCTION public._spiff_sync_paid();

-- Pay run voided -> spiff lines return to the approved pool for the next run.
CREATE OR REPLACE FUNCTION public._spiff_release_on_void()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN
    UPDATE spiff_payouts SET pay_run_item_id = NULL, status = 'approved', paid_at = NULL
    WHERE pay_run_item_id IN (SELECT id FROM pay_run_items WHERE pay_run_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_spiff_release_on_void ON pay_runs;
CREATE TRIGGER trg_spiff_release_on_void AFTER UPDATE OF status ON pay_runs
  FOR EACH ROW EXECUTE FUNCTION public._spiff_release_on_void();

-- =============================================================
-- 6. PUBLIC RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_leaderboard(p_period text DEFAULT 'weekly', p_anchor date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean;
  v_me uuid;
  s leaderboard_settings%ROWTYPE;
  v_start date; v_end date;
  v_rows jsonb; v_optouts jsonb; v_me_opted boolean := false;
  v_delay integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_manager := public.can_manage_commissions();
  v_me := public.get_my_team_member_id();
  IF NOT v_manager AND v_me IS NULL THEN
    RAISE EXCEPTION 'Not a member of this account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO s FROM leaderboard_settings WHERE user_id = v_owner;
  IF s.user_id IS NULL THEN
    s.enabled := true; s.show_names_to_technicians := true; s.payout_delay_days := 7;
    s.enabled_kpis := ARRAY['first_time_fix_rate','upsell_rate','csat_avg','revenue_cents'];
    s.min_jobs_to_rank := 3; s.min_csat_responses := 3;
  END IF;
  v_delay := s.payout_delay_days;

  SELECT period_start, period_end INTO v_start, v_end FROM public._lb_period(p_period, p_anchor);
  IF v_me IS NOT NULL THEN
    v_me_opted := EXISTS (SELECT 1 FROM leaderboard_optouts WHERE team_member_id = v_me);
  END IF;

  IF NOT s.enabled AND NOT v_manager THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'team_member_id', CASE WHEN v_manager OR s.show_names_to_technicians OR b.team_member_id = v_me THEN b.team_member_id END,
      'name', CASE WHEN v_manager OR s.show_names_to_technicians OR b.team_member_id = v_me THEN b.member_name ELSE 'Technician' END,
      'is_me', b.team_member_id = v_me,
      'jobs_completed', b.jobs_completed,
      'first_time_fix_rate', b.first_time_fix_rate,
      'upsell_rate', b.upsell_rate, 'upsell_opportunities', b.upsell_opportunities,
      'csat_avg', b.csat_avg, 'csat_responses', b.csat_responses,
      'revenue_cents', CASE WHEN v_manager OR b.team_member_id = v_me OR s.show_names_to_technicians THEN b.revenue_cents END,
      'overall_score', b.overall_score, 'eligible', b.eligible,
      'ranks', jsonb_build_object('overall', b.rank_overall, 'first_time_fix_rate', b.rank_first_time_fix,
                                  'upsell_rate', b.rank_upsell, 'csat_avg', b.rank_csat,
                                  'revenue_cents', b.rank_revenue, 'jobs_completed', b.rank_jobs)
    ) ORDER BY b.rank_overall NULLS LAST, b.jobs_completed DESC, b.member_name), '[]'::jsonb)
  INTO v_rows
  FROM public._lb_board(v_owner, v_start, v_end) b
  WHERE NOT b.opted_out;

  IF v_manager THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('team_member_id', b.team_member_id, 'name', b.member_name) ORDER BY b.member_name), '[]'::jsonb)
    INTO v_optouts FROM public._lb_board(v_owner, v_start, v_end) b WHERE b.opted_out;
  ELSE
    v_optouts := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'enabled', s.enabled,
    'period', jsonb_build_object('type', p_period, 'start', v_start, 'end', v_end,
                                 'closed', v_end < current_date,
                                 'settled', v_end <= current_date - v_delay),
    'settings', jsonb_build_object('enabled_kpis', to_jsonb(s.enabled_kpis), 'min_jobs_to_rank', s.min_jobs_to_rank,
                                   'min_csat_responses', s.min_csat_responses, 'show_names', s.show_names_to_technicians),
    'viewer', jsonb_build_object('team_member_id', v_me, 'is_manager', v_manager, 'opted_out', v_me_opted),
    'rows', v_rows,
    'opted_out', v_optouts
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_leaderboard(text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_leaderboard_opt_out(p_opted_out boolean, p_team_member_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_target uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  v_target := coalesce(p_team_member_id, v_me);
  IF v_target IS NULL THEN RAISE EXCEPTION 'No technician selected' USING ERRCODE = '22023'; END IF;
  IF v_target IS DISTINCT FROM v_me AND NOT public.can_manage_commissions() THEN
    RAISE EXCEPTION 'You can only change your own leaderboard preference' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = v_target AND account_owner_id = v_owner AND role = 'technician') THEN
    RAISE EXCEPTION 'Technician not found' USING ERRCODE = '22023';
  END IF;
  IF p_opted_out THEN
    INSERT INTO leaderboard_optouts (team_member_id, user_id) VALUES (v_target, v_owner) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM leaderboard_optouts WHERE team_member_id = v_target AND user_id = v_owner;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_leaderboard_opt_out(boolean, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_spiff_payouts(p_period text, p_anchor date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s leaderboard_settings%ROWTYPE;
  v_start date; v_end date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_commissions() THEN
    RAISE EXCEPTION 'Not authorized to manage spiffs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM leaderboard_settings WHERE user_id = v_owner;
  SELECT period_start, period_end INTO v_start, v_end
  FROM public._lb_period(p_period, coalesce(p_anchor, current_date - 7 - coalesce(s.payout_delay_days, 7)));
  IF v_end > current_date - coalesce(s.payout_delay_days, 7) THEN
    RAISE EXCEPTION 'This period is not settled yet - callbacks and reviews can still arrive' USING ERRCODE = '22023';
  END IF;
  RETURN public._spiff_generate_period(v_owner, p_period, v_start, v_end)
         || jsonb_build_object('period_start', v_start, 'period_end', v_end);
END;
$$;
GRANT EXECUTE ON FUNCTION public.generate_spiff_payouts(text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_spiff_payout(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  sp spiff_payouts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_commissions() THEN
    RAISE EXCEPTION 'Not authorized to manage spiffs' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'Unknown action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO sp FROM spiff_payouts WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF sp.id IS NULL THEN RAISE EXCEPTION 'Payout not found' USING ERRCODE = '22023'; END IF;
  IF sp.pay_run_item_id IS NOT NULL OR sp.status IN ('paid', 'rejected') THEN
    RAISE EXCEPTION 'This payout is already in a pay run or closed' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'reject' AND char_length(btrim(coalesce(p_note, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required to reject a payout' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'approve' AND sp.status <> 'pending' THEN RAISE EXCEPTION 'Only pending payouts can be approved' USING ERRCODE = '22023'; END IF;
  UPDATE spiff_payouts
  SET status = CASE p_action WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
      reviewed_by = auth.uid(), review_note = left(btrim(coalesce(p_note, '')), 500)
  WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.review_spiff_payout(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_spiff_payouts(p_status text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, rule_name text, team_member_id uuid, technician_name text, period text, period_start date, period_end date,
  rank integer, kpi_value numeric, amount_cents integer, status text, pay_run_id uuid, has_payroll_profile boolean,
  review_note text, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_commissions() THEN
    RAISE EXCEPTION 'Not authorized to manage spiffs' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT sp.id, sp.rule_name, sp.team_member_id, coalesce(nullif(btrim(tm.member_name), ''), tm.member_email),
         sp.period, sp.period_start, sp.period_end, sp.rank, sp.kpi_value, sp.amount_cents, sp.status,
         pri.pay_run_id,
         EXISTS (SELECT 1 FROM employees e WHERE e.team_member_id = sp.team_member_id AND e.user_id = v_owner AND e.active),
         sp.review_note, sp.created_at
  FROM spiff_payouts sp
  JOIN team_members tm ON tm.id = sp.team_member_id
  LEFT JOIN pay_run_items pri ON pri.id = sp.pay_run_item_id
  WHERE sp.user_id = v_owner AND (p_status IS NULL OR sp.status = p_status)
  ORDER BY sp.period_end DESC, sp.created_at DESC
  LIMIT least(greatest(p_limit, 1), 500);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_spiff_payouts(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_spiffs(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Not a technician' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'opted_out', EXISTS (SELECT 1 FROM leaderboard_optouts WHERE team_member_id = v_me),
    'payouts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', sp.id, 'rule_name', sp.rule_name, 'period', sp.period,
               'period_start', sp.period_start, 'period_end', sp.period_end, 'rank', sp.rank,
               'amount_cents', sp.amount_cents, 'status', sp.status) ORDER BY sp.period_end DESC)
      FROM (SELECT * FROM spiff_payouts WHERE team_member_id = v_me AND user_id = v_owner AND status <> 'rejected'
            ORDER BY period_end DESC LIMIT least(greatest(p_limit, 1), 200)) sp
    ), '[]'::jsonb),
    'rules', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kpi', r.kpi, 'period', r.period, 'rule_type', r.rule_type,
               'threshold', r.threshold, 'payout_cents', r.payout_cents, 'rank_payouts_cents', to_jsonb(r.rank_payouts_cents)))
      FROM spiff_rules r WHERE r.user_id = v_owner AND r.active
    ), '[]'::jsonb)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_spiffs(integer) TO authenticated;
