/*
  # Multi-technician job crews (lead + helpers)

  Reuses job_technician_assignments. Until now that table was a pure history
  log written by a trigger (one row per lead re-assignment, crew_role NULL).
  Crew roster rows live in the SAME table and are told apart by crew_role:

    crew_role IS NULL      -> history row (unchanged behaviour)
    crew_role IS NOT NULL  -> live crew roster row (lead | helper | apprentice)

  ## Rules
  - The LEAD is always jobs.assigned_technician_id, so every existing feature
    (schedule, ETA, commissions, job brief) keeps working untouched.
  - A crew has 2..12 members, exactly one lead, no duplicate technicians.
  - labor_share_bps / commission_share_bps are basis points (10000 = 100%)
    and always sum to 10000 (largest-remainder allocation, no lost cents).
  - Split modes
      labor:       role_weights | equal | manual | actual_hours
      commission:  role_weights | equal | manual | labor
    role weights: lead 50, helper 30, apprentice 20.
    actual_hours uses each technician's own time-clock segments for the job
    (time_shift_jobs, breaks removed) - separate time tracking per person.
  - required_skills are checked against team_members.skills; gaps are
    returned as warnings, never silently ignored.
  - Commissions: crew jobs are split per member by commission share. The
    existing generator is renamed to _commission_generate_single and wrapped
    by a dispatcher, so solo jobs behave exactly as before.

  ## Security
  Clients can only READ roster rows (existing select policy). Every write goes
  through set_job_crew(), which checks can_manage_job_crews() (owner/admin or
  can_view_all_jobs). Money-related fields are returned only to managers
  (can_view_billing) or to the technician for their own row.
*/

-- =============================================================
-- SCHEMA (additive)
-- =============================================================
ALTER TABLE job_technician_assignments
  ADD COLUMN IF NOT EXISTS crew_role text CHECK (crew_role IS NULL OR crew_role IN ('lead', 'helper', 'apprentice')),
  ADD COLUMN IF NOT EXISTS labor_share_bps integer CHECK (labor_share_bps IS NULL OR labor_share_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS commission_share_bps integer CHECK (commission_share_bps IS NULL OR commission_share_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS crew_updated_at timestamptz;

ALTER TABLE job_technician_assignments DROP CONSTRAINT IF EXISTS chk_jta_crew_shares;
ALTER TABLE job_technician_assignments ADD CONSTRAINT chk_jta_crew_shares
  CHECK (crew_role IS NULL OR (labor_share_bps IS NOT NULL AND commission_share_bps IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_jta_crew_member
  ON job_technician_assignments(job_id, technician_id) WHERE crew_role IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jta_crew_lead
  ON job_technician_assignments(job_id) WHERE crew_role = 'lead';
CREATE INDEX IF NOT EXISTS idx_jta_crew_tech
  ON job_technician_assignments(technician_id, job_id) WHERE crew_role IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_crew_settings (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  labor_split_mode text NOT NULL DEFAULT 'role_weights'
    CHECK (labor_split_mode IN ('role_weights', 'equal', 'manual', 'actual_hours')),
  commission_split_mode text NOT NULL DEFAULT 'role_weights'
    CHECK (commission_split_mode IN ('role_weights', 'equal', 'manual', 'labor')),
  required_skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_skills) <= 20),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE job_crew_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_crew_settings" ON job_crew_settings;
CREATE POLICY "select_own_job_crew_settings" ON job_crew_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE policy: writes only via set_job_crew().

-- =============================================================
-- HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_job_crews()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND (
          COALESCE(tm.permissions ->> 'can_view_all_jobs', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_all_jobs', 'false') = 'true'
        )
    );
$$;
REVOKE ALL ON FUNCTION public.can_manage_job_crews() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_job_crews() TO authenticated;

-- Crew rows carry money-related shares: only managers, dispatchers and the technician
-- themselves may read them. History rows (crew_role IS NULL) keep the old account-wide rule.
DROP POLICY IF EXISTS "select_own_job_technician_assignments" ON job_technician_assignments;
CREATE POLICY "select_own_job_technician_assignments" ON job_technician_assignments FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (
      crew_role IS NULL
      OR public.can_manage_job_crews()
      OR public.time_is_manager()
      OR technician_id = public.get_my_team_member_id()
    )
  );

CREATE OR REPLACE FUNCTION public._crew_role_weight(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role WHEN 'lead' THEN 50 WHEN 'helper' THEN 30 WHEN 'apprentice' THEN 20 ELSE 0 END;
$$;

-- Largest-remainder allocation: the result always sums to p_total exactly.
-- Ties go to the earliest index. All-zero weights fall back to equal.
CREATE OR REPLACE FUNCTION public._crew_allocate(p_weights numeric[], p_total bigint)
RETURNS bigint[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n integer := COALESCE(array_length(p_weights, 1), 0);
  w numeric[] := p_weights;
  s numeric := 0;
  res bigint[] := '{}';
  rem numeric[] := '{}';
  used bigint := 0;
  left_ bigint;
  i integer;
  idx integer;
BEGIN
  IF n = 0 THEN RETURN '{}'; END IF;
  IF p_total < 0 THEN RAISE EXCEPTION 'crew_invalid_total'; END IF;
  FOR i IN 1..n LOOP
    IF w[i] IS NULL OR w[i] < 0 THEN RAISE EXCEPTION 'crew_invalid_weight'; END IF;
    s := s + w[i];
  END LOOP;
  IF s = 0 THEN
    FOR i IN 1..n LOOP w[i] := 1; END LOOP;
    s := n;
  END IF;
  FOR i IN 1..n LOOP
    res[i] := floor(p_total * w[i] / s)::bigint;
    rem[i] := (p_total * w[i] / s) - res[i];
    used := used + res[i];
  END LOOP;
  left_ := p_total - used;
  WHILE left_ > 0 LOOP
    idx := 1;
    FOR i IN 2..n LOOP
      IF rem[i] > rem[idx] THEN idx := i; END IF;
    END LOOP;
    res[idx] := res[idx] + 1;
    rem[idx] := -1;
    left_ := left_ - 1;
  END LOOP;
  RETURN res;
END;
$$;

-- Net worked minutes per technician on one job (closed segments, breaks removed).
CREATE OR REPLACE FUNCTION public._crew_job_minutes(p_job uuid)
RETURNS TABLE (team_member_id uuid, net_minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.team_member_id,
         round(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (j.ended_at - j.started_at))
           - COALESCE((
               SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(j.ended_at, b.ended_at) - GREATEST(j.started_at, b.started_at)))))
               FROM time_shift_breaks b
               WHERE b.shift_id = j.shift_id AND b.started_at < j.ended_at AND b.ended_at > j.started_at
             ), 0)
         )) / 60.0)::integer AS net_minutes
  FROM time_shift_jobs j
  JOIN time_shifts s ON s.id = j.shift_id
  WHERE j.job_id = p_job AND j.ended_at IS NOT NULL
  GROUP BY s.team_member_id;
$$;
REVOKE ALL ON FUNCTION public._crew_job_minutes(uuid) FROM PUBLIC, anon, authenticated;

-- Effective shares per roster row (planned shares, or actual-hours based).
CREATE OR REPLACE FUNCTION public._crew_effective(p_job uuid)
RETURNS TABLE (assignment_id uuid, technician_id uuid, crew_role text, net_minutes integer, labor_bps integer, commission_bps integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s job_crew_settings%ROWTYPE;
  ids uuid[]; techs uuid[]; roles text[]; mins integer[]; lab bigint[]; com bigint[];
  n integer; tot bigint; i integer;
BEGIN
  SELECT * INTO s FROM job_crew_settings WHERE job_id = p_job;

  SELECT array_agg(a.id ORDER BY a.id), array_agg(a.technician_id ORDER BY a.id), array_agg(a.crew_role ORDER BY a.id),
         array_agg(COALESCE(m.net_minutes, 0) ORDER BY a.id),
         array_agg(a.labor_share_bps::numeric ORDER BY a.id)::bigint[],
         array_agg(a.commission_share_bps::numeric ORDER BY a.id)::bigint[]
    INTO ids, techs, roles, mins, lab, com
  FROM job_technician_assignments a
  LEFT JOIN public._crew_job_minutes(p_job) m ON m.team_member_id = a.technician_id
  WHERE a.job_id = p_job AND a.crew_role IS NOT NULL AND a.technician_id IS NOT NULL;

  n := COALESCE(array_length(ids, 1), 0);
  IF n = 0 THEN RETURN; END IF;

  -- Normalise planned shares (a removed technician must not leave the total below 100%).
  lab := public._crew_allocate(lab::numeric[], 10000);
  com := public._crew_allocate(com::numeric[], 10000);

  SELECT COALESCE(SUM(x), 0) INTO tot FROM unnest(mins) AS x;
  IF COALESCE(s.labor_split_mode, 'role_weights') = 'actual_hours' AND tot > 0 THEN
    lab := public._crew_allocate(mins::numeric[], 10000);
  END IF;
  IF COALESCE(s.commission_split_mode, 'role_weights') = 'labor' THEN
    com := lab;
  END IF;

  FOR i IN 1..n LOOP
    assignment_id := ids[i]; technician_id := techs[i]; crew_role := roles[i];
    net_minutes := mins[i]; labor_bps := lab[i]::integer; commission_bps := com[i]::integer;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public._crew_effective(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPC: set_job_crew  (empty p_members dissolves the crew)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_job_crew(
  p_job_id uuid,
  p_members jsonb,
  p_labor_mode text DEFAULT 'role_weights',
  p_commission_mode text DEFAULT 'role_weights',
  p_required_skills text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  j jobs%ROWTYPE;
  n integer;
  ids uuid[]; roles text[]; man_lab numeric[]; man_com numeric[]; w numeric[];
  lab bigint[]; com bigint[];
  v_lead uuid;
  v_skills text[];
  v_gaps text[];
  v_had_records boolean := false;
  i integer;
  m jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_job_crews() THEN RAISE EXCEPTION 'crew_forbidden'; END IF;

  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crew_job_not_found'; END IF;

  IF p_labor_mode NOT IN ('role_weights', 'equal', 'manual', 'actual_hours') THEN RAISE EXCEPTION 'crew_invalid_mode'; END IF;
  IF p_commission_mode NOT IN ('role_weights', 'equal', 'manual', 'labor') THEN RAISE EXCEPTION 'crew_invalid_mode'; END IF;

  IF p_members IS NULL OR jsonb_typeof(p_members) <> 'array' THEN RAISE EXCEPTION 'crew_invalid_members'; END IF;
  n := jsonb_array_length(p_members);
  IF n = 1 OR n > 12 THEN RAISE EXCEPTION 'crew_size_invalid'; END IF;

  -- Release generated, still-pending commissions so they are recomputed (raises if already on a statement).
  IF EXISTS (SELECT 1 FROM commission_records WHERE user_id = v_owner AND job_id = p_job_id AND kind = 'earned' AND calc_source <> 'manual') THEN
    v_had_records := true;
    PERFORM public._commission_release_job(v_owner, p_job_id);
  END IF;

  PERFORM set_config('vireek.crew_rpc', '1', true);

  IF n = 0 THEN
    DELETE FROM job_technician_assignments WHERE job_id = p_job_id AND crew_role IS NOT NULL;
    DELETE FROM job_crew_settings WHERE job_id = p_job_id;
    IF v_had_records THEN PERFORM public._commission_generate_for_job(v_owner, p_job_id); END IF;
    PERFORM public.log_audit_event(v_owner, 'job_crew_dissolved', 'jobs', p_job_id::text);
    RETURN jsonb_build_object('ok', true, 'skill_gaps', '[]'::jsonb);
  END IF;

  ids := '{}'; roles := '{}'; man_lab := '{}'; man_com := '{}';
  FOR i IN 0..n - 1 LOOP
    m := p_members -> i;
    IF jsonb_typeof(m) <> 'object' THEN RAISE EXCEPTION 'crew_invalid_members'; END IF;
    ids := ids || (m ->> 'technician_id')::uuid;
    roles := roles || COALESCE(m ->> 'role', '');
    man_lab := man_lab || COALESCE((m ->> 'labor_bps')::numeric, 0);
    man_com := man_com || COALESCE((m ->> 'commission_bps')::numeric, 0);
  END LOOP;

  IF (SELECT count(DISTINCT x) FROM unnest(ids) AS x) <> n THEN RAISE EXCEPTION 'crew_duplicate_member'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(roles) AS r WHERE r NOT IN ('lead', 'helper', 'apprentice')) THEN RAISE EXCEPTION 'crew_invalid_role'; END IF;
  IF (SELECT count(*) FROM unnest(roles) AS r WHERE r = 'lead') <> 1 THEN RAISE EXCEPTION 'crew_needs_one_lead'; END IF;
  IF (SELECT count(*) FROM team_members tm WHERE tm.id = ANY (ids) AND tm.account_owner_id = v_owner) <> n THEN
    RAISE EXCEPTION 'crew_member_not_on_team';
  END IF;

  FOR i IN 1..n LOOP
    IF roles[i] = 'lead' THEN v_lead := ids[i]; END IF;
  END LOOP;

  -- Shares
  w := '{}';
  FOR i IN 1..n LOOP w := w || public._crew_role_weight(roles[i])::numeric; END LOOP;

  IF p_labor_mode = 'equal' THEN
    lab := public._crew_allocate(array_fill(1::numeric, ARRAY[n]), 10000);
  ELSIF p_labor_mode = 'manual' THEN
    IF (SELECT COALESCE(sum(x), 0) FROM unnest(man_lab) AS x) <> 10000 THEN RAISE EXCEPTION 'crew_labor_shares_must_total_100'; END IF;
    lab := man_lab::bigint[];
  ELSE
    lab := public._crew_allocate(w, 10000);          -- role_weights and the actual_hours fallback
  END IF;

  IF p_commission_mode = 'equal' THEN
    com := public._crew_allocate(array_fill(1::numeric, ARRAY[n]), 10000);
  ELSIF p_commission_mode = 'manual' THEN
    IF (SELECT COALESCE(sum(x), 0) FROM unnest(man_com) AS x) <> 10000 THEN RAISE EXCEPTION 'crew_commission_shares_must_total_100'; END IF;
    com := man_com::bigint[];
  ELSIF p_commission_mode = 'labor' THEN
    com := lab;
  ELSE
    com := public._crew_allocate(w, 10000);
  END IF;

  -- Required skills: trimmed, lower-cased, unique, max 20 x 40 chars.
  SELECT COALESCE(array_agg(DISTINCT s), '{}') INTO v_skills
  FROM (SELECT left(lower(btrim(x)), 40) AS s FROM unnest(COALESCE(p_required_skills, '{}')) AS x) q
  WHERE s <> '';
  IF cardinality(v_skills) > 20 THEN RAISE EXCEPTION 'crew_too_many_skills'; END IF;

  -- Write roster (lead first so the jobs trigger sees a consistent state).
  DELETE FROM job_technician_assignments WHERE job_id = p_job_id AND crew_role IS NOT NULL;
  FOR i IN 1..n LOOP
    INSERT INTO job_technician_assignments (user_id, job_id, technician_id, service_type, crew_role, labor_share_bps, commission_share_bps, crew_updated_at)
    VALUES (v_owner, p_job_id, ids[i], j.service_type, roles[i], lab[i]::integer, com[i]::integer, now());
  END LOOP;

  INSERT INTO job_crew_settings (job_id, user_id, labor_split_mode, commission_split_mode, required_skills, updated_at)
  VALUES (p_job_id, v_owner, p_labor_mode, p_commission_mode, v_skills, now())
  ON CONFLICT (job_id) DO UPDATE
    SET labor_split_mode = EXCLUDED.labor_split_mode,
        commission_split_mode = EXCLUDED.commission_split_mode,
        required_skills = EXCLUDED.required_skills,
        updated_at = now();

  IF j.assigned_technician_id IS DISTINCT FROM v_lead THEN
    UPDATE jobs SET assigned_technician_id = v_lead WHERE id = p_job_id;   -- fires the existing history trigger
  END IF;

  IF v_had_records THEN PERFORM public._commission_generate_for_job(v_owner, p_job_id); END IF;

  SELECT COALESCE(array_agg(rs), '{}') INTO v_gaps
  FROM unnest(v_skills) AS rs
  WHERE NOT EXISTS (
    SELECT 1 FROM team_members tm, unnest(COALESCE(tm.skills, '{}')) AS ts
    WHERE tm.id = ANY (ids) AND lower(btrim(ts)) = rs
  );

  PERFORM public.log_audit_event(v_owner, 'job_crew_updated', 'jobs', p_job_id::text);
  RETURN jsonb_build_object('ok', true, 'skill_gaps', to_jsonb(v_gaps));
END;
$$;
REVOKE ALL ON FUNCTION public.set_job_crew(uuid, jsonb, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_job_crew(uuid, jsonb, text, text, text[]) TO authenticated;

-- =============================================================
-- Keep the roster consistent when the lead is changed elsewhere
-- (dispatch board, bulk reassign, ...). Unassigning a crew job is blocked.
-- =============================================================
CREATE OR REPLACE FUNCTION public._crew_sync_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l_id uuid; l_tech uuid; n_id uuid;
BEGIN
  IF COALESCE(current_setting('vireek.crew_rpc', true), '') = '1' THEN RETURN NEW; END IF;
  SELECT id, technician_id INTO l_id, l_tech FROM job_technician_assignments WHERE job_id = NEW.id AND crew_role = 'lead';
  IF l_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.assigned_technician_id IS NULL THEN
    RAISE EXCEPTION 'crew_unassign_blocked: remove the crew before unassigning this job';
  END IF;

  SELECT id INTO n_id FROM job_technician_assignments
   WHERE job_id = NEW.id AND crew_role IS NOT NULL AND technician_id = NEW.assigned_technician_id;
  IF n_id = l_id THEN RETURN NEW; END IF;

  IF n_id IS NOT NULL THEN     -- new lead was already on the crew: swap seats
    UPDATE job_technician_assignments SET technician_id = NULL WHERE id = l_id;
    UPDATE job_technician_assignments SET technician_id = l_tech WHERE id = n_id;
  END IF;
  UPDATE job_technician_assignments SET technician_id = NEW.assigned_technician_id, crew_updated_at = now() WHERE id = l_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crew_sync_lead ON jobs;
CREATE TRIGGER trg_crew_sync_lead
  AFTER UPDATE OF assigned_technician_id ON jobs
  FOR EACH ROW
  WHEN (OLD.assigned_technician_id IS DISTINCT FROM NEW.assigned_technician_id)
  EXECUTE FUNCTION public._crew_sync_lead();

-- =============================================================
-- RPC: get_job_crew (roster + hours + shares; money-safe)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_job_crew(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  j jobs%ROWTYPE;
  v_me uuid := public.get_my_team_member_id();
  v_manage boolean := public.can_manage_job_crews();
  v_money boolean := public.time_is_manager();
  s job_crew_settings%ROWTYPE;
  v_members jsonb;
  v_gaps jsonb;
  v_total integer;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  IF NOT (v_manage OR v_money OR j.assigned_technician_id IS NOT DISTINCT FROM v_me
          OR EXISTS (SELECT 1 FROM job_technician_assignments a WHERE a.job_id = p_job_id AND a.crew_role IS NOT NULL AND a.technician_id = v_me)) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO s FROM job_crew_settings WHERE job_id = p_job_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'assignment_id', e.assignment_id,
           'technician_id', e.technician_id,
           'name', COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
           'role', e.crew_role,
           'skills', to_jsonb(COALESCE(tm.skills, '{}')),
           'net_minutes', e.net_minutes,
           'labor_bps', CASE WHEN v_money OR v_manage OR e.technician_id = v_me THEN e.labor_bps END,
           'commission_bps', CASE WHEN v_money OR e.technician_id = v_me THEN e.commission_bps END,
           'labor_cost_cents', CASE WHEN v_money THEN round(e.net_minutes / 60.0 * COALESCE(emp.hourly_rate_cents, 0))::bigint END
         ) ORDER BY CASE e.crew_role WHEN 'lead' THEN 0 WHEN 'helper' THEN 1 ELSE 2 END, COALESCE(tm.member_name, tm.member_email)), '[]'::jsonb),
         COALESCE(SUM(e.net_minutes), 0)
    INTO v_members, v_total
  FROM public._crew_effective(p_job_id) e
  JOIN team_members tm ON tm.id = e.technician_id
  LEFT JOIN employees emp ON emp.team_member_id = e.technician_id AND emp.user_id = v_owner AND emp.active;

  SELECT COALESCE(jsonb_agg(rs), '[]'::jsonb) INTO v_gaps
  FROM unnest(COALESCE(s.required_skills, '{}')) AS rs
  WHERE NOT EXISTS (
    SELECT 1
    FROM job_technician_assignments a
    JOIN team_members tm ON tm.id = a.technician_id,
         unnest(COALESCE(tm.skills, '{}')) AS ts
    WHERE a.job_id = p_job_id AND a.crew_role IS NOT NULL AND lower(btrim(ts)) = rs
  );

  RETURN jsonb_build_object(
    'has_crew', jsonb_array_length(v_members) > 0,
    'can_manage', v_manage,
    'can_see_money', v_money,
    'labor_mode', COALESCE(s.labor_split_mode, 'role_weights'),
    'commission_mode', COALESCE(s.commission_split_mode, 'role_weights'),
    'required_skills', to_jsonb(COALESCE(s.required_skills, '{}')),
    'skill_gaps', v_gaps,
    'total_minutes', v_total,
    'members', v_members
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_job_crew(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_crew(uuid) TO authenticated;

-- =============================================================
-- RPC: jobs where I am a helper/apprentice (for the technician day list + time clock)
-- Same columns as get_technician_today_jobs.
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_my_crew_jobs(p_date date DEFAULT current_date)
RETURNS TABLE (
  id uuid, customer_name text, address text, service_type text,
  scheduled_datetime timestamptz, job_status text,
  arrived_at timestamptz, started_at timestamptz, completed_at timestamptz,
  expected_duration_minutes integer, safety_flag boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT j.id, j.customer_name, j.address, j.service_type, j.scheduled_datetime, j.job_status,
         j.arrived_at, j.started_at, j.completed_at, j.expected_duration_minutes, j.safety_flag
  FROM jobs j
  JOIN job_technician_assignments a
    ON a.job_id = j.id AND a.crew_role IN ('helper', 'apprentice') AND a.technician_id = public.get_my_team_member_id()
  WHERE j.scheduled_datetime::date = p_date
  ORDER BY j.scheduled_datetime ASC NULLS LAST;
$$;
REVOKE ALL ON FUNCTION public.get_my_crew_jobs(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_crew_jobs(date) TO authenticated;

-- =============================================================
-- COMMISSIONS: per-member split for crew jobs
-- =============================================================
CREATE OR REPLACE FUNCTION public._commission_generate_crew(p_owner uuid, p_job_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs%ROWTYPE;
  emp employees%ROWTYPE;
  ov commission_job_overrides%ROWTYPE;
  pl commission_plans%ROWTYPE;
  t RECORD;
  v_inv_count integer;
  v_inv_id uuid;
  v_basis bigint;
  v_date date;
  v_ids uuid[]; v_roles text[]; v_bps bigint[]; v_basis_arr bigint[]; v_flat_arr bigint[];
  v_idx integer;
  v_mb bigint;
  v_cum bigint; v_after bigint; v_overlap bigint; v_numer numeric;
  v_commission bigint; v_rate numeric; v_source text; v_plan_id uuid; v_detail jsonb; v_segments jsonb;
  v_p_start date; v_p_end date;
  c_created integer := 0; c_exists integer := 0; c_excluded integer := 0; c_norule integer := 0; c_noemp integer := 0;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = p_owner;
  IF NOT FOUND OR j.job_status <> 'completed' THEN RETURN 'not_eligible'; END IF;

  SELECT count(*), COALESCE(sum(subtotal_cents), 0), (array_agg(id ORDER BY created_at))[1]
    INTO v_inv_count, v_basis, v_inv_id
  FROM ar_invoices WHERE user_id = p_owner AND job_id = j.id AND status = 'paid';
  IF v_inv_count = 0 THEN
    IF j.invoice_status = 'paid' AND j.invoice_amount IS NOT NULL AND j.invoice_amount > 0 THEN
      v_basis := round(j.invoice_amount * 100);
    ELSE
      RETURN 'not_eligible';
    END IF;
  END IF;
  IF v_basis <= 0 THEN RETURN 'not_eligible'; END IF;
  v_date := COALESCE(j.completed_at::date, j.created_at::date);

  SELECT array_agg(x.technician_id ORDER BY x.assignment_id), array_agg(x.crew_role ORDER BY x.assignment_id),
         array_agg(x.commission_bps::bigint ORDER BY x.assignment_id)
    INTO v_ids, v_roles, v_bps
  FROM public._crew_effective(p_job_id) x;
  IF v_ids IS NULL THEN RETURN 'no_employee'; END IF;

  v_basis_arr := public._crew_allocate(v_bps::numeric[], v_basis);

  -- Job-wide flat override is shared by commission share.
  SELECT * INTO ov FROM commission_job_overrides
   WHERE user_id = p_owner AND job_id = j.id AND employee_id IS NULL AND override_type = 'flat_cents' LIMIT 1;
  IF FOUND THEN v_flat_arr := public._crew_allocate(v_bps::numeric[], ov.flat_cents); END IF;

  FOR v_idx IN 1..array_length(v_ids, 1) LOOP
    v_mb := v_basis_arr[v_idx];
    SELECT * INTO emp FROM employees WHERE user_id = p_owner AND team_member_id = v_ids[v_idx] AND active LIMIT 1;
    IF NOT FOUND THEN c_noemp := c_noemp + 1; CONTINUE; END IF;
    IF v_mb <= 0 THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM commission_records WHERE employee_id = emp.id AND job_id = j.id AND kind = 'earned') THEN
      c_exists := c_exists + 1; CONTINUE;
    END IF;

    v_numer := 0; v_segments := '[]'::jsonb; v_plan_id := NULL; pl := NULL;

    SELECT * INTO ov FROM commission_job_overrides
     WHERE user_id = p_owner AND job_id = j.id AND (employee_id = emp.id OR employee_id IS NULL)
     ORDER BY (employee_id IS NULL) LIMIT 1;

    IF FOUND THEN
      IF ov.override_type = 'excluded' THEN c_excluded := c_excluded + 1; CONTINUE; END IF;
      IF ov.override_type = 'rate_percent' THEN
        v_rate := ov.rate_percent;
        v_commission := round(v_mb * v_rate / 100.0);
        v_source := 'override_rate';
      ELSE
        v_commission := CASE WHEN ov.employee_id IS NULL THEN v_flat_arr[v_idx] ELSE ov.flat_cents END;
        v_rate := least(999.99, round(v_commission * 100.0 / v_mb, 2));
        v_source := 'override_flat';
      END IF;
      v_detail := jsonb_build_object('override_id', ov.id, 'type', ov.override_type, 'reason', ov.reason);
    ELSE
      IF emp.commission_plan_id IS NOT NULL THEN
        SELECT * INTO pl FROM commission_plans WHERE id = emp.commission_plan_id AND user_id = p_owner AND active;
      END IF;
      IF pl.id IS NULL THEN
        SELECT * INTO pl FROM commission_plans WHERE user_id = p_owner AND is_default AND active LIMIT 1;
      END IF;

      IF pl.id IS NOT NULL AND EXISTS (SELECT 1 FROM commission_plan_tiers WHERE plan_id = pl.id) THEN
        v_p_start := public._commission_cycle_start(v_date, pl.tier_period);
        v_p_end := (v_p_start + CASE pl.tier_period WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END)::date;
        SELECT COALESCE(sum(basis_amount_cents), 0) INTO v_cum FROM commission_records
         WHERE employee_id = emp.id AND kind = 'earned' AND earned_date >= v_p_start AND earned_date < v_p_end;
        v_after := v_cum + v_mb;

        IF pl.tier_mode = 'tier_reached' THEN
          SELECT min_cents, rate_percent INTO t FROM commission_plan_tiers
           WHERE plan_id = pl.id AND min_cents <= v_after ORDER BY min_cents DESC LIMIT 1;
          v_commission := round(v_mb * t.rate_percent / 100.0);
          v_rate := t.rate_percent;
          v_segments := jsonb_build_array(jsonb_build_object('min_cents', t.min_cents, 'rate_percent', t.rate_percent, 'amount_cents', v_mb, 'commission_cents', v_commission));
        ELSE
          FOR t IN SELECT min_cents, rate_percent, lead(min_cents) OVER (ORDER BY min_cents) AS next_min
                     FROM commission_plan_tiers WHERE plan_id = pl.id ORDER BY min_cents
          LOOP
            v_overlap := greatest(0, least(v_after, COALESCE(t.next_min, 9223372036854775807)) - greatest(v_cum, t.min_cents));
            IF v_overlap > 0 THEN
              v_numer := v_numer + v_overlap * t.rate_percent;
              v_segments := v_segments || jsonb_build_object('min_cents', t.min_cents, 'rate_percent', t.rate_percent, 'amount_cents', v_overlap, 'commission_cents', round(v_overlap * t.rate_percent / 100.0));
            END IF;
          END LOOP;
          v_commission := round(v_numer / 100.0);
          v_rate := least(999.99, round(v_commission * 100.0 / v_mb, 2));
        END IF;
        v_source := 'plan';
        v_plan_id := pl.id;
        v_detail := jsonb_build_object('mode', pl.tier_mode, 'period', pl.tier_period, 'period_start', v_p_start, 'cumulative_before_cents', v_cum, 'segments', v_segments);
      ELSIF COALESCE(emp.commission_rate_percent, 0) > 0 THEN
        v_rate := emp.commission_rate_percent;
        v_commission := round(v_mb * v_rate / 100.0);
        v_source := 'employee_rate';
        v_detail := jsonb_build_object('flat_rate_percent', v_rate);
      ELSE
        c_norule := c_norule + 1; CONTINUE;
      END IF;
    END IF;

    v_detail := COALESCE(v_detail, '{}'::jsonb) || jsonb_build_object(
      'crew', jsonb_build_object('role', v_roles[v_idx], 'commission_share_bps', v_bps[v_idx], 'job_basis_cents', v_basis));

    BEGIN
      INSERT INTO commission_records (
        user_id, employee_id, job_id, ar_invoice_id, basis_amount_cents, commission_rate_percent, commission_cents,
        status, kind, calc_source, plan_id, earned_date, calc_detail
      ) VALUES (
        p_owner, emp.id, j.id, CASE WHEN v_inv_count = 1 THEN v_inv_id END, v_mb, v_rate, v_commission,
        'pending', 'earned', v_source, v_plan_id, v_date, v_detail
      );
      c_created := c_created + 1;
    EXCEPTION WHEN unique_violation THEN
      c_exists := c_exists + 1;
    END;
  END LOOP;

  RETURN CASE
    WHEN c_created > 0 THEN 'created'
    WHEN c_exists > 0 THEN 'exists'
    WHEN c_excluded > 0 THEN 'excluded'
    WHEN c_norule > 0 THEN 'no_rule'
    ELSE 'no_employee'
  END;
END;
$$;
REVOKE ALL ON FUNCTION public._commission_generate_crew(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Dispatcher: keep whatever generator exists today as the single-technician path.
DO $$
BEGIN
  IF to_regprocedure('public._commission_generate_single(uuid,uuid)') IS NULL
     AND to_regprocedure('public._commission_generate_for_job(uuid,uuid)') IS NOT NULL THEN
    ALTER FUNCTION public._commission_generate_for_job(uuid, uuid) RENAME TO _commission_generate_single;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._commission_generate_for_job(p_owner uuid, p_job_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_technician_assignments WHERE job_id = p_job_id AND user_id = p_owner AND crew_role IS NOT NULL) THEN
    RETURN public._commission_generate_crew(p_owner, p_job_id);
  END IF;
  RETURN public._commission_generate_single(p_owner, p_job_id);
END;
$$;
REVOKE ALL ON FUNCTION public._commission_generate_for_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
