/*
  # Vireek Technician Passport 2.0 — Technician Identity Graph

  Additive: does NOT touch get_technician_trust_passport() (Passport 1.0).

  ## New objects
  - technician_insurance_policies : manager-maintained, manager-verified insurance records
  - technician_passport_shares    : immutable, SHA-256-sealed public snapshots (portable passport)
  - identity_is_manager()         : owner/admin/billing-permission helper
  - identity_confidence_rows()    : recency-weighted Wilson lower-bound skill confidence (internal)
  - build_technician_identity_payload() : one canonical payload builder (internal)
  - get_technician_identity_passport()  : authenticated read (manager: all, technician: self)
  - issue_technician_passport_share()   : technician (self) or manager issues a sealed link
  - revoke_technician_passport_share()  : technician (self) or manager revokes
  - verify_technician_passport(token)   : public (anon) verification

  ## Integrity rules
  - Every metric is derived from operational tables; nothing here is typed in by a user
    except insurance, which only counts once a manager verifies it.
  - Issued snapshots cannot be modified (trigger); only revoke/view counters change.
  - Public payload never contains customer data, margin, complaints, or policy/credential numbers.
*/

-- 0) Helper --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.identity_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.identity_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.identity_is_manager() TO authenticated;

-- 1) Insurance -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technician_insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  policy_type text NOT NULL,
  carrier text NOT NULL,
  policy_number text,
  coverage_amount_cents bigint,
  effective_date date,
  expires_at date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tip_type_check CHECK (policy_type IN ('general_liability', 'workers_comp', 'commercial_auto', 'professional_liability', 'umbrella', 'other')),
  CONSTRAINT tip_status_check CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT tip_carrier_check CHECK (length(btrim(carrier)) BETWEEN 1 AND 120),
  CONSTRAINT tip_policy_number_check CHECK (policy_number IS NULL OR length(policy_number) <= 60),
  CONSTRAINT tip_coverage_check CHECK (coverage_amount_cents IS NULL OR coverage_amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tip_technician ON technician_insurance_policies(technician_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_tip_account ON technician_insurance_policies(account_owner_id);

DROP TRIGGER IF EXISTS trg_tip_updated_at ON technician_insurance_policies;
CREATE TRIGGER trg_tip_updated_at
  BEFORE UPDATE ON technician_insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Editing a policy's substance invalidates its verification unless re-verified in the same edit.
CREATE OR REPLACE FUNCTION public.tip_reset_verification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.policy_type, NEW.carrier, NEW.policy_number, NEW.coverage_amount_cents, NEW.expires_at, NEW.effective_date)
       IS DISTINCT FROM
     (OLD.policy_type, OLD.carrier, OLD.policy_number, OLD.coverage_amount_cents, OLD.expires_at, OLD.effective_date)
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
    NEW.verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tip_reset_verification ON technician_insurance_policies;
CREATE TRIGGER trg_tip_reset_verification
  BEFORE UPDATE ON technician_insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.tip_reset_verification();

ALTER TABLE technician_insurance_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tip_select" ON technician_insurance_policies;
CREATE POLICY "tip_select" ON technician_insurance_policies FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );

DROP POLICY IF EXISTS "tip_insert" ON technician_insurance_policies;
CREATE POLICY "tip_insert" ON technician_insurance_policies FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.identity_is_manager()
    AND EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.id = technician_insurance_policies.technician_id
        AND m.account_owner_id = technician_insurance_policies.account_owner_id
    )
  );

DROP POLICY IF EXISTS "tip_update" ON technician_insurance_policies;
CREATE POLICY "tip_update" ON technician_insurance_policies FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.identity_is_manager()
    AND EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.id = technician_insurance_policies.technician_id
        AND m.account_owner_id = technician_insurance_policies.account_owner_id
    )
  );

DROP POLICY IF EXISTS "tip_delete" ON technician_insurance_policies;
CREATE POLICY "tip_delete" ON technician_insurance_policies FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 2) Portable passport shares ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS technician_passport_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  issued_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  issued_by_role text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  CONSTRAINT tps_role_check CHECK (issued_by_role IN ('technician', 'manager')),
  CONSTRAINT tps_label_check CHECK (label IS NULL OR length(label) <= 80)
);

CREATE INDEX IF NOT EXISTS idx_tps_technician ON technician_passport_shares(technician_id, issued_at DESC);

CREATE OR REPLACE FUNCTION public.tps_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.technician_id IS DISTINCT FROM OLD.technician_id
     OR NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Issued passports are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Passport is already revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tps_guard_immutable ON technician_passport_shares;
CREATE TRIGGER trg_tps_guard_immutable
  BEFORE UPDATE ON technician_passport_shares
  FOR EACH ROW EXECUTE FUNCTION public.tps_guard_immutable();

ALTER TABLE technician_passport_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tps_select" ON technician_passport_shares;
CREATE POLICY "tps_select" ON technician_passport_shares FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );
-- Intentionally no INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER RPCs below write.
REVOKE INSERT, UPDATE, DELETE ON technician_passport_shares FROM authenticated, anon;

-- 3) Skill confidence (internal) -------------------------------------------------------
-- confidence = 100 * (0.8 * WilsonLB90(recency-weighted fix success) + 0.2 * rating/5)
-- (rating term dropped when no ratings). Half-life 180 days, 730-day lookback.
CREATE OR REPLACE FUNCTION public.identity_confidence_rows(p_owner uuid, p_tech uuid, p_kind text)
RETURNS TABLE (
  skill_key text,
  job_count integer,
  effective_jobs numeric,
  fix_rate numeric,
  avg_rating numeric,
  confidence integer,
  last_job_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      CASE
        WHEN p_kind = 'service_type' THEN nullif(btrim(j.service_type), '')
        WHEN nullif(btrim(e.make), '') IS NOT NULL
          THEN btrim(e.make) || ' ' || coalesce(nullif(btrim(e.equipment_type), ''), 'equipment')
      END AS k,
      coalesce(j.completed_at, j.scheduled_datetime) AS done_at,
      exp(-ln(2.0) * greatest(0, extract(epoch FROM (now() - coalesce(j.completed_at, j.scheduled_datetime))) / 86400.0) / 180.0) AS w,
      NOT (
        EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = j.user_id AND r.is_rework = true AND r.rework_of_job_id = j.id)
        OR coalesce(o.caused_callback, false)
      ) AS ok,
      (SELECT avg(rv.rating)::numeric FROM review_requests rv WHERE rv.job_id = j.id AND rv.rating IS NOT NULL) AS rating
    FROM jobs j
    LEFT JOIN job_outcomes o ON o.job_id = j.id
    LEFT JOIN job_equipment je ON p_kind = 'equipment' AND je.job_id = j.id
    LEFT JOIN equipment e ON e.id = je.equipment_id
    WHERE j.user_id = p_owner
      AND j.assigned_technician_id = p_tech
      AND j.job_status = 'completed'
      AND p_kind IN ('service_type', 'equipment')
      AND coalesce(j.completed_at, j.scheduled_datetime) >= now() - interval '730 days'
  ),
  agg AS (
    SELECT
      k,
      count(*)::integer AS jobs_n,
      count(*) FILTER (WHERE ok)::integer AS ok_n,
      sum(w) AS n,
      coalesce(sum(w) FILTER (WHERE ok), 0) AS s,
      sum(w * rating) FILTER (WHERE rating IS NOT NULL) / nullif(sum(w) FILTER (WHERE rating IS NOT NULL), 0) AS rating_w,
      max(done_at) AS last_at
    FROM base
    WHERE k IS NOT NULL
    GROUP BY k
  ),
  scored AS (
    SELECT
      a.*,
      -- Wilson lower bound, z = 1.645 (90% one-sided)
      ((a.s / a.n) + 2.706025 / (2 * a.n)
        - 1.645 * sqrt((((a.s / a.n) * (1 - (a.s / a.n))) + 2.706025 / (4 * a.n)) / a.n))
        / (1 + 2.706025 / a.n) AS wl
    FROM agg a
  )
  SELECT
    k,
    jobs_n,
    round(n, 2),
    round(100.0 * ok_n / jobs_n, 1),
    round(rating_w, 2),
    least(100, greatest(0, round(100 * CASE WHEN rating_w IS NULL THEN wl ELSE 0.8 * wl + 0.2 * (rating_w / 5.0) END)))::integer,
    last_at
  FROM scored;
$$;

REVOKE ALL ON FUNCTION public.identity_confidence_rows(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- 4) Canonical payload builder (internal) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.build_technician_identity_payload(p_tech_id uuid, p_window_days integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
  v_owner uuid;
  v_since timestamptz;
  v_metrics jsonb;
  v_skills jsonb;
  v_equipment jsonb;
  v_certs jsonb;
  v_insurance jsonb;
  v_training jsonb;
  v_regions jsonb;
  v_company text;
  v_unresolved integer;
  v_life_jobs integer;
  v_life_verified integer;
  v_skill_avg numeric;
  v_valid_certs integer;
  v_valid_ins integer;
  v_jobs integer;
  v_index numeric;
  v_coverage numeric;
  v_tier text;
BEGIN
  SELECT * INTO v_tm FROM team_members WHERE id = p_tech_id AND role = 'technician';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_owner := v_tm.account_owner_id;
  v_since := now() - make_interval(days => p_window_days);

  -- Window metrics ---------------------------------------------------------------
  WITH done AS (
    SELECT
      j.id,
      j.evidence_verified_at,
      j.arrived_at,
      (nullif(btrim(j.technician_diagnosis), '') IS NOT NULL) AS diagnosed,
      (
        EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = j.user_id AND r.is_rework = true AND r.rework_of_job_id = j.id)
        OR coalesce(o.caused_callback, false)
      ) AS reworked,
      coalesce(qr.require_safety_evidence, false) AS safety_req,
      CASE
        WHEN j.eta_set_at IS NOT NULL AND j.eta_minutes IS NOT NULL
          THEN j.eta_set_at + make_interval(mins => j.eta_minutes)
        ELSE j.scheduled_datetime
      END AS target_at,
      (SELECT avg(rv.rating)::numeric FROM review_requests rv WHERE rv.job_id = j.id AND rv.rating IS NOT NULL) AS rating
    FROM jobs j
    LEFT JOIN job_outcomes o ON o.job_id = j.id
    LEFT JOIN job_quality_requirements qr ON qr.user_id = j.user_id AND qr.service_type = j.service_type
    WHERE j.user_id = v_owner
      AND j.assigned_technician_id = p_tech_id
      AND j.job_status = 'completed'
      AND coalesce(j.completed_at, j.scheduled_datetime) >= v_since
  )
  SELECT jsonb_build_object(
    'jobs_completed', count(*),
    'verified_jobs', count(*) FILTER (WHERE evidence_verified_at IS NOT NULL),
    'first_time_fix_rate', round(100.0 * count(*) FILTER (WHERE NOT reworked) / nullif(count(*), 0), 1),
    'callback_rate', round(100.0 * count(*) FILTER (WHERE reworked) / nullif(count(*), 0), 1),
    'rated_jobs', count(rating),
    'customer_rating_avg', round(avg(rating), 2),
    'safety_required_jobs', count(*) FILTER (WHERE safety_req),
    'safety_compliance_rate', round(
      100.0 * count(*) FILTER (WHERE safety_req AND evidence_verified_at IS NOT NULL)
      / nullif(count(*) FILTER (WHERE safety_req), 0), 1),
    'diagnosed_jobs', count(*) FILTER (WHERE diagnosed),
    'diagnosis_accuracy', round(
      100.0 * count(*) FILTER (WHERE diagnosed AND NOT reworked)
      / nullif(count(*) FILTER (WHERE diagnosed), 0), 1),
    'timed_jobs', count(*) FILTER (WHERE arrived_at IS NOT NULL AND target_at IS NOT NULL),
    'response_reliability', round(
      100.0 * count(*) FILTER (WHERE arrived_at IS NOT NULL AND target_at IS NOT NULL AND arrived_at <= target_at + interval '15 minutes')
      / nullif(count(*) FILTER (WHERE arrived_at IS NOT NULL AND target_at IS NOT NULL), 0), 1)
  )
  INTO v_metrics
  FROM done;

  SELECT count(*), count(*) FILTER (WHERE j.evidence_verified_at IS NOT NULL)
  INTO v_life_jobs, v_life_verified
  FROM jobs j
  WHERE j.user_id = v_owner AND j.assigned_technician_id = p_tech_id AND j.job_status = 'completed';

  v_metrics := v_metrics || jsonb_build_object('lifetime_jobs', v_life_jobs, 'lifetime_verified_jobs', v_life_verified);
  v_jobs := coalesce((v_metrics ->> 'jobs_completed')::integer, 0);

  -- Skill confidence -------------------------------------------------------------
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.confidence DESC, r.job_count DESC), '[]'::jsonb)
  INTO v_skills
  FROM (
    SELECT * FROM public.identity_confidence_rows(v_owner, p_tech_id, 'service_type')
    ORDER BY confidence DESC, job_count DESC
    LIMIT 12
  ) r;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.confidence DESC, r.job_count DESC), '[]'::jsonb)
  INTO v_equipment
  FROM (
    SELECT * FROM public.identity_confidence_rows(v_owner, p_tech_id, 'equipment')
    ORDER BY confidence DESC, job_count DESC
    LIMIT 12
  ) r;

  SELECT avg(t.c) INTO v_skill_avg
  FROM (
    SELECT confidence AS c
    FROM public.identity_confidence_rows(v_owner, p_tech_id, 'service_type')
    WHERE job_count >= 3
    ORDER BY confidence DESC
    LIMIT 5
  ) t;

  -- Certifications (no credential numbers) ---------------------------------------
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', c.credential_type,
    'name', c.credential_name,
    'issuer', c.issuing_authority,
    'issued_at', c.issued_at,
    'expires_at', c.expires_at,
    'valid', (c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at >= current_date))
  ) ORDER BY c.credential_type), '[]'::jsonb)
  INTO v_certs
  FROM technician_credentials c
  WHERE c.technician_id = p_tech_id AND c.status <> 'revoked';

  -- Insurance (no policy numbers) --------------------------------------------------
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'type', i.policy_type,
    'carrier', i.carrier,
    'coverage_amount_cents', i.coverage_amount_cents,
    'expires_at', i.expires_at,
    'verified', (i.verified_at IS NOT NULL),
    'valid', (i.status = 'active' AND i.expires_at >= current_date)
  ) ORDER BY i.expires_at DESC), '[]'::jsonb)
  INTO v_insurance
  FROM technician_insurance_policies i
  WHERE i.technician_id = p_tech_id AND i.status = 'active';

  SELECT count(*) INTO v_valid_certs FROM jsonb_array_elements(v_certs) e WHERE (e ->> 'valid')::boolean;
  SELECT count(*) INTO v_valid_ins
  FROM jsonb_array_elements(v_insurance) e
  WHERE (e ->> 'valid')::boolean AND (e ->> 'verified')::boolean;

  -- Training (kept separate from real-job evidence) --------------------------------
  SELECT jsonb_build_object(
    'lessons_completed', (SELECT count(*) FROM apprenticeship_lesson_completions l WHERE l.team_member_id = p_tech_id),
    'apprenticeship_target_level', (SELECT p.target_level FROM apprenticeship_plans p WHERE p.team_member_id = p_tech_id AND p.status = 'active' LIMIT 1),
    'simulator_attempts', (SELECT count(*) FROM simulator_attempts a WHERE a.team_member_id = p_tech_id AND a.status = 'submitted'),
    'simulator_passed', (SELECT count(*) FROM simulator_attempts a WHERE a.team_member_id = p_tech_id AND a.status = 'submitted' AND a.passed IS TRUE),
    'simulator_avg_score', (SELECT round(avg(a.score), 1) FROM simulator_attempts a WHERE a.team_member_id = p_tech_id AND a.status = 'submitted')
  ) INTO v_training;

  -- Regions ------------------------------------------------------------------------
  SELECT coalesce(jsonb_agg(DISTINCT t.x), '[]'::jsonb)
  INTO v_regions
  FROM (
    SELECT btrim(s.part) AS x FROM regexp_split_to_table(coalesce(v_tm.service_area, ''), '[,;/|]') AS s(part)
    UNION
    SELECT btrim(tr.name) FROM territories tr WHERE tr.id = v_tm.territory_id
  ) t
  WHERE t.x IS NOT NULL AND t.x <> '';

  SELECT p.company_name INTO v_company FROM profiles p WHERE p.id = v_owner;

  SELECT count(*)::integer INTO v_unresolved
  FROM service_recovery_signals s
  JOIN jobs j ON j.id = s.job_id
  WHERE j.assigned_technician_id = p_tech_id AND s.status NOT IN ('resolved', 'ignored');

  -- Passport Index (weighted, renormalized over available evidence) ----------------
  SELECT round(sum(t.w * t.v) / nullif(sum(t.w), 0)), coalesce(sum(t.w), 0)
  INTO v_index, v_coverage
  FROM (VALUES
    (25, (v_metrics ->> 'first_time_fix_rate')::numeric),
    (15, (v_metrics ->> 'customer_rating_avg')::numeric * 20),
    (15, (v_metrics ->> 'safety_compliance_rate')::numeric),
    (15, (v_metrics ->> 'response_reliability')::numeric),
    (10, (v_metrics ->> 'diagnosis_accuracy')::numeric),
    (10, v_skill_avg),
    (5, CASE WHEN v_valid_certs > 0 THEN 100 ELSE 0 END),
    (5, CASE WHEN v_valid_ins > 0 THEN 100 ELSE 0 END)
  ) AS t(w, v)
  WHERE t.v IS NOT NULL;

  IF v_jobs < 3 THEN
    v_index := NULL;
  END IF;

  v_tier := CASE
    WHEN v_index IS NULL THEN 'unrated'
    WHEN v_index >= 90 AND v_jobs >= 25 THEN 'elite'
    WHEN v_index >= 80 AND v_jobs >= 10 THEN 'trusted'
    WHEN v_index >= 65 THEN 'established'
    ELSE 'emerging'
  END;

  RETURN jsonb_build_object(
    'schema', 'vireek.technician_passport.v2',
    'window_days', p_window_days,
    'generated_at', now(),
    'company_name', v_company,
    'index', v_index,
    'index_coverage', v_coverage,
    'tier', v_tier,
    'metrics', v_metrics,
    'skills', v_skills,
    'equipment_expertise', v_equipment,
    'certifications', v_certs,
    'insurance', v_insurance,
    'training', v_training,
    'languages', to_jsonb(coalesce(v_tm.languages, '{}'::text[])),
    'declared_skills', to_jsonb(coalesce(v_tm.skills, '{}'::text[])),
    'regions', v_regions,
    'internal', jsonb_build_object('unresolved_complaints', coalesce(v_unresolved, 0))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_technician_identity_payload(uuid, integer) FROM PUBLIC, anon, authenticated;

-- 5) Authenticated read ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_technician_identity_passport(
  p_technician_id uuid DEFAULT NULL,
  p_window_days integer DEFAULT 365
)
RETURNS TABLE (
  technician_id uuid,
  technician_name text,
  payload jsonb,
  generated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tm.id,
    coalesce(nullif(btrim(tm.member_name), ''), tm.member_email),
    public.build_technician_identity_payload(tm.id, least(1095, greatest(7, coalesce(p_window_days, 365)))),
    now()
  FROM team_members tm
  WHERE tm.account_owner_id = public.get_account_owner_id()
    AND tm.role = 'technician'
    AND (p_technician_id IS NULL OR tm.id = p_technician_id)
    AND (public.identity_is_manager() OR tm.id = public.get_my_team_member_id())
  ORDER BY tm.member_name;
$$;

REVOKE ALL ON FUNCTION public.get_technician_identity_passport(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_identity_passport(uuid, integer) TO authenticated;

-- 6) Issue a sealed, portable snapshot -------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_technician_passport_share(
  p_technician_id uuid,
  p_label text DEFAULT NULL,
  p_valid_days integer DEFAULT 30,
  p_window_days integer DEFAULT 365
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
  v_is_manager boolean;
  v_is_self boolean;
  v_payload jsonb;
  v_snapshot jsonb;
  v_hash text;
  v_token text;
  v_id uuid;
  v_expires timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_tm
  FROM team_members
  WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002';
  END IF;

  v_is_manager := public.identity_is_manager();
  v_is_self := (v_tm.user_id IS NOT NULL AND v_tm.user_id = auth.uid());
  IF NOT (v_is_manager OR v_is_self) THEN
    RAISE EXCEPTION 'Only the technician or a manager can issue a passport' USING ERRCODE = '42501';
  END IF;

  IF p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 365 THEN
    RAISE EXCEPTION 'valid_days must be between 1 and 365' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) FROM technician_passport_shares s
      WHERE s.technician_id = p_technician_id AND s.revoked_at IS NULL AND s.expires_at > now()) >= 20 THEN
    RAISE EXCEPTION 'Too many active passport links — revoke one first' USING ERRCODE = '54000';
  END IF;

  v_payload := public.build_technician_identity_payload(p_technician_id, least(1095, greatest(30, coalesce(p_window_days, 365))));

  v_snapshot := jsonb_build_object(
    'schema', 'vireek.technician_passport.v2',
    'display_name', coalesce(nullif(btrim(v_tm.member_name), ''), 'Technician'),
    'issuer_company', v_payload -> 'company_name',
    'issued_at', now(),
    'window_days', v_payload -> 'window_days',
    'index', v_payload -> 'index',
    'index_coverage', v_payload -> 'index_coverage',
    'tier', v_payload -> 'tier',
    'metrics', v_payload -> 'metrics',
    'skills', v_payload -> 'skills',
    'equipment_expertise', v_payload -> 'equipment_expertise',
    'certifications', coalesce((
      SELECT jsonb_agg(c) FROM jsonb_array_elements(v_payload -> 'certifications') c WHERE (c ->> 'valid')::boolean
    ), '[]'::jsonb),
    'insurance', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'type', i -> 'type', 'carrier', i -> 'carrier',
        'coverage_amount_cents', i -> 'coverage_amount_cents', 'expires_at', i -> 'expires_at'))
      FROM jsonb_array_elements(v_payload -> 'insurance') i
      WHERE (i ->> 'valid')::boolean AND (i ->> 'verified')::boolean
    ), '[]'::jsonb),
    'training', v_payload -> 'training',
    'languages', v_payload -> 'languages',
    'regions', v_payload -> 'regions'
  );

  v_hash := encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(days => p_valid_days);

  INSERT INTO technician_passport_shares (
    account_owner_id, technician_id, token_hash, label, snapshot, snapshot_hash,
    issued_by, issued_by_role, expires_at
  ) VALUES (
    v_tm.account_owner_id, p_technician_id,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    left(nullif(btrim(p_label), ''), 80),
    v_snapshot, v_hash, auth.uid(),
    CASE WHEN v_is_self THEN 'technician' ELSE 'manager' END,
    v_expires
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('share_id', v_id, 'token', v_token, 'expires_at', v_expires, 'snapshot_hash', v_hash);
END;
$$;

REVOKE ALL ON FUNCTION public.issue_technician_passport_share(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_technician_passport_share(uuid, text, integer, integer) TO authenticated;

-- 7) Revoke -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_technician_passport_share(p_share_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_share technician_passport_shares%ROWTYPE;
  v_self boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_share FROM technician_passport_shares
  WHERE id = p_share_id AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Passport link not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM team_members m WHERE m.id = v_share.technician_id AND m.user_id = auth.uid()
  ) INTO v_self;

  IF NOT (public.identity_is_manager() OR v_self) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  IF v_share.revoked_at IS NULL THEN
    UPDATE technician_passport_shares SET revoked_at = now() WHERE id = p_share_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_technician_passport_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_technician_passport_share(uuid) TO authenticated;

-- 8) Public verification (anon) -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_technician_passport(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row technician_passport_shares%ROWTYPE;
  v_status text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_row FROM technician_passport_shares
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF encode(sha256(convert_to(v_row.snapshot::text, 'UTF8')), 'hex') <> v_row.snapshot_hash THEN
    RETURN jsonb_build_object('status', 'tampered');
  END IF;

  v_status := CASE
    WHEN v_row.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v_row.expires_at <= now() THEN 'expired'
    ELSE 'valid'
  END;

  IF v_status = 'valid' THEN
    UPDATE technician_passport_shares
    SET view_count = view_count + 1, last_viewed_at = now()
    WHERE id = v_row.id;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'issued_at', v_row.issued_at,
    'expires_at', v_row.expires_at,
    'issued_by_role', v_row.issued_by_role,
    'snapshot_hash', v_row.snapshot_hash,
    'snapshot', CASE WHEN v_status = 'valid' THEN v_row.snapshot ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_technician_passport(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_technician_passport(text) TO anon, authenticated;
