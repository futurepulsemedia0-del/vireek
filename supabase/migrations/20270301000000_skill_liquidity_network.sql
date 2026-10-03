/*
  # Vireek Skill Liquidity Network (Technician Skill Market)

  Turns Technician Identity / Passport / Skill Graph into a cross-company market:
  a job states what it needs (equipment family + level, diagnostic skill, location,
  urgency, price ceiling) and Vireek ranks every opted-in, verified technician in the
  WHOLE network — not just the best one inside one company.

  Additive & idempotent. Touches no existing table's columns or policies.

  ## New objects
  - skill_market_profiles     : per-technician opt-in listing (company consent AND technician consent)
  - skill_market_skills       : cached, outcome-derived skill levels (rebuilt from identity_confidence_rows)
  - skill_market_offers       : engagement requests + in-network outcome feedback (the flywheel)
  - skill_market_level()      : confidence/volume -> level 1..5 (pure)
  - skill_market_refresh_technician() / skill_market_refresh_stale()
  - skill_market_my_team()    : manager view of own technicians + listing state
  - skill_market_set_listing(): manager sets company consent + commercial terms
  - skill_market_set_consent(): technician sets own consent
  - skill_market_set_availability()
  - search_skill_market()     : the ranking engine (explainable, hard gates + weighted score)
  - skill_market_send_offer() / respond / withdraw / complete / list / expire

  ## Integrity & privacy
  - Levels are derived from real job outcomes (identity_confidence_rows); never typed in.
  - A technician is searchable only when: company in network (business_profile.network_enabled),
    manager consent, technician consent (or no login yet => manager consent only is NOT enough:
    technician_consent_at is required), listing not paused.
  - Search never returns coordinates, names, e-mails or phones of other companies' staff.
    Cross-company results show an alias, company name, tier, rounded distance. Identity and
    company contact are revealed to both sides only after the technician's company accepts.
  - No client INSERT/UPDATE/DELETE on any new table; all writes go through SECURITY DEFINER RPCs.
  - Ratings only by the requesting company, once, only after acceptance, never on own team.

  ## Depends on (all exist in your repo)
  profiles, business_profile(network_enabled, service_area), team_members, jobs, notifications,
  technician_credentials, get_account_owner_id(), get_my_team_member_id(), identity_is_manager(),
  identity_confidence_rows(), build_technician_identity_payload(), haversine_miles(), set_updated_at().
*/

-- 1) Pure helpers --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skill_market_level(p_confidence integer, p_jobs integer)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_jobs >= 30 AND p_confidence >= 88 THEN 5
    WHEN p_jobs >= 15 AND p_confidence >= 75 THEN 4
    WHEN p_jobs >= 8  AND p_confidence >= 60 THEN 3
    WHEN p_jobs >= 3  AND p_confidence >= 40 THEN 2
    ELSE 1
  END::smallint;
$$;

-- tokens: lowercase a-z0-9 and dash, 2..24 chars, 1..4 per requirement
CREATE OR REPLACE FUNCTION public.skill_market_valid_tokens(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p IS NOT NULL
    AND coalesce(array_length(p, 1), 0) BETWEEN 1 AND 4
    AND NOT EXISTS (SELECT 1 FROM unnest(p) t WHERE t IS NULL OR t !~ '^[a-z0-9-]{2,24}$');
$$;

-- 2) Tables --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_market_profiles (
  technician_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_consent_at timestamptz,
  technician_consent_at timestamptz,
  paused boolean NOT NULL DEFAULT false,
  availability text NOT NULL DEFAULT 'open',
  service_radius_miles smallint NOT NULL DEFAULT 40,
  hourly_rate_cents integer,
  callout_fee_cents integer,
  remote_assist_enabled boolean NOT NULL DEFAULT false,
  trade text,
  -- cached overall evidence (from build_technician_identity_payload)
  passport_index smallint,
  tier text,
  jobs_completed integer NOT NULL DEFAULT 0,
  verified_jobs integer NOT NULL DEFAULT 0,
  first_time_fix_rate numeric(5,1),
  rating_avg numeric(3,2),
  response_reliability numeric(5,1),
  valid_insurance boolean NOT NULL DEFAULT false,
  valid_credentials integer NOT NULL DEFAULT 0,
  evidence_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smp_availability_check CHECK (availability IN ('open', 'busy', 'offline')),
  CONSTRAINT smp_radius_check CHECK (service_radius_miles BETWEEN 1 AND 500),
  CONSTRAINT smp_rate_check CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents BETWEEN 0 AND 1000000),
  CONSTRAINT smp_callout_check CHECK (callout_fee_cents IS NULL OR callout_fee_cents BETWEEN 0 AND 1000000),
  CONSTRAINT smp_trade_check CHECK (trade IS NULL OR trade IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general'))
);

CREATE INDEX IF NOT EXISTS idx_smp_account ON skill_market_profiles(account_owner_id);
CREATE INDEX IF NOT EXISTS idx_smp_listed ON skill_market_profiles(trade)
  WHERE company_consent_at IS NOT NULL AND technician_consent_at IS NOT NULL AND paused = false;

DROP TRIGGER IF EXISTS trg_smp_updated_at ON skill_market_profiles;
CREATE TRIGGER trg_smp_updated_at BEFORE UPDATE ON skill_market_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS skill_market_skills (
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  kind text NOT NULL,
  skill_key text NOT NULL,
  job_count integer NOT NULL,
  fix_rate numeric(5,1),
  confidence smallint NOT NULL,
  level smallint NOT NULL,
  last_job_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (technician_id, kind, skill_key),
  CONSTRAINT sms_kind_check CHECK (kind IN ('service', 'equipment')),
  CONSTRAINT sms_level_check CHECK (level BETWEEN 1 AND 5),
  CONSTRAINT sms_conf_check CHECK (confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_sms_kind_key ON skill_market_skills(kind, lower(skill_key));

CREATE TABLE IF NOT EXISTS skill_market_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  technician_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text,
  urgency text NOT NULL DEFAULT 'standard',
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_score numeric(5,1),
  match_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  offered_rate_cents integer,
  remote boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'offered',
  responds_by timestamptz NOT NULL,
  responded_at timestamptz,
  completed_at timestamptz,
  outcome text,
  rating smallint,
  outcome_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smo_status_check CHECK (status IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn', 'completed')),
  CONSTRAINT smo_urgency_check CHECK (urgency IN ('emergency', 'urgent', 'standard')),
  CONSTRAINT smo_outcome_check CHECK (outcome IS NULL OR outcome IN ('resolved', 'partial', 'unresolved')),
  CONSTRAINT smo_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT smo_title_check CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  CONSTRAINT smo_summary_check CHECK (summary IS NULL OR length(summary) <= 600),
  CONSTRAINT smo_note_check CHECK (outcome_note IS NULL OR length(outcome_note) <= 400),
  CONSTRAINT smo_cross_company CHECK (requester_owner_id <> technician_owner_id)
);

CREATE INDEX IF NOT EXISTS idx_smo_requester ON skill_market_offers(requester_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smo_target ON skill_market_offers(technician_owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smo_tech_done ON skill_market_offers(technician_id, completed_at DESC) WHERE status = 'completed';
-- one live offer per (requester, technician) at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_smo_live_pair ON skill_market_offers(requester_owner_id, technician_id)
  WHERE status IN ('offered', 'accepted');

-- 3) RLS: read-only for the two involved companies; no client writes ------------------
ALTER TABLE skill_market_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_market_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_market_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smp_select" ON skill_market_profiles;
CREATE POLICY "smp_select" ON skill_market_profiles FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );

DROP POLICY IF EXISTS "sms_select" ON skill_market_skills;
CREATE POLICY "sms_select" ON skill_market_skills FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM skill_market_profiles p
      WHERE p.technician_id = skill_market_skills.technician_id
        AND p.account_owner_id = public.get_account_owner_id()
        AND (public.identity_is_manager() OR p.technician_id = public.get_my_team_member_id())
    )
  );

DROP POLICY IF EXISTS "smo_select" ON skill_market_offers;
CREATE POLICY "smo_select" ON skill_market_offers FOR SELECT TO authenticated
  USING (
    public.identity_is_manager()
    AND (requester_owner_id = public.get_account_owner_id() OR technician_owner_id = public.get_account_owner_id())
  );

REVOKE INSERT, UPDATE, DELETE ON skill_market_profiles, skill_market_skills, skill_market_offers FROM authenticated, anon;

-- 4) Evidence refresh ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skill_market_refresh_technician(p_tech uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_payload jsonb;
  v_metrics jsonb;
BEGIN
  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = p_tech AND role = 'technician';
  IF NOT FOUND THEN RETURN; END IF;

  v_payload := public.build_technician_identity_payload(p_tech, 365);
  IF v_payload IS NULL THEN RETURN; END IF;
  v_metrics := v_payload -> 'metrics';

  DELETE FROM skill_market_skills WHERE technician_id = p_tech;

  INSERT INTO skill_market_skills (technician_id, kind, skill_key, job_count, fix_rate, confidence, level, last_job_at)
  SELECT p_tech, 'service', r.skill_key, r.job_count, r.fix_rate, r.confidence,
         public.skill_market_level(r.confidence, r.job_count), r.last_job_at
  FROM public.identity_confidence_rows(v_owner, p_tech, 'service_type') r
  ON CONFLICT DO NOTHING;

  INSERT INTO skill_market_skills (technician_id, kind, skill_key, job_count, fix_rate, confidence, level, last_job_at)
  SELECT p_tech, 'equipment', r.skill_key, r.job_count, r.fix_rate, r.confidence,
         public.skill_market_level(r.confidence, r.job_count), r.last_job_at
  FROM public.identity_confidence_rows(v_owner, p_tech, 'equipment') r
  ON CONFLICT DO NOTHING;

  UPDATE skill_market_profiles SET
    passport_index = nullif(v_payload ->> 'index', '')::smallint,
    tier = coalesce(v_payload ->> 'tier', 'unrated'),
    jobs_completed = coalesce((v_metrics ->> 'jobs_completed')::integer, 0),
    verified_jobs = coalesce((v_metrics ->> 'verified_jobs')::integer, 0),
    first_time_fix_rate = (v_metrics ->> 'first_time_fix_rate')::numeric,
    rating_avg = (v_metrics ->> 'customer_rating_avg')::numeric,
    response_reliability = (v_metrics ->> 'response_reliability')::numeric,
    valid_insurance = EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_payload -> 'insurance') i
      WHERE (i ->> 'valid')::boolean AND (i ->> 'verified')::boolean),
    valid_credentials = (
      SELECT count(*)::integer FROM jsonb_array_elements(v_payload -> 'certifications') c
      WHERE (c ->> 'valid')::boolean),
    evidence_refreshed_at = now()
  WHERE technician_id = p_tech;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_refresh_technician(uuid) FROM PUBLIC, anon, authenticated;

-- Cron / service-role entry point (also safe to call from an edge function).
CREATE OR REPLACE FUNCTION public.skill_market_refresh_stale(p_limit integer DEFAULT 25)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT technician_id FROM skill_market_profiles
    WHERE evidence_refreshed_at IS NULL OR evidence_refreshed_at < now() - interval '24 hours'
    ORDER BY evidence_refreshed_at NULLS FIRST
    LIMIT least(100, greatest(1, p_limit))
  LOOP
    PERFORM public.skill_market_refresh_technician(r.technician_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_refresh_stale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skill_market_refresh_stale(integer) TO service_role;

-- Optional daily refresh when pg_cron exists (silently skipped otherwise).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('skill-market-refresh', '17 * * * *', 'select public.skill_market_refresh_stale(50)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 5) Manager / technician surface -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.skill_market_my_team()
RETURNS TABLE (
  technician_id uuid,
  technician_name text,
  has_login boolean,
  listed boolean,
  company_consent boolean,
  technician_consent boolean,
  paused boolean,
  availability text,
  service_radius_miles smallint,
  hourly_rate_cents integer,
  callout_fee_cents integer,
  remote_assist_enabled boolean,
  trade text,
  tier text,
  passport_index smallint,
  jobs_completed integer,
  evidence_refreshed_at timestamptz,
  top_skills jsonb,
  network_jobs integer,
  network_resolved_rate numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tm.id,
    coalesce(nullif(btrim(tm.member_name), ''), tm.member_email),
    (tm.user_id IS NOT NULL),
    (p.company_consent_at IS NOT NULL AND p.technician_consent_at IS NOT NULL AND NOT coalesce(p.paused, false)),
    (p.company_consent_at IS NOT NULL),
    (p.technician_consent_at IS NOT NULL),
    coalesce(p.paused, false),
    coalesce(p.availability, 'open'),
    coalesce(p.service_radius_miles, 40::smallint),
    p.hourly_rate_cents,
    p.callout_fee_cents,
    coalesce(p.remote_assist_enabled, false),
    p.trade,
    p.tier,
    p.passport_index,
    coalesce(p.jobs_completed, 0),
    p.evidence_refreshed_at,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', s.kind, 'skill', s.skill_key, 'level', s.level, 'confidence', s.confidence, 'jobs', s.job_count)
             ORDER BY s.level DESC, s.confidence DESC)
      FROM (SELECT * FROM skill_market_skills x WHERE x.technician_id = tm.id ORDER BY x.level DESC, x.confidence DESC LIMIT 6) s
    ), '[]'::jsonb),
    (SELECT count(*)::integer FROM skill_market_offers o WHERE o.technician_id = tm.id AND o.status = 'completed'),
    (SELECT round(100.0 * count(*) FILTER (WHERE o.outcome = 'resolved') / nullif(count(*), 0), 1)
       FROM skill_market_offers o WHERE o.technician_id = tm.id AND o.status = 'completed')
  FROM team_members tm
  LEFT JOIN skill_market_profiles p ON p.technician_id = tm.id
  WHERE tm.account_owner_id = public.get_account_owner_id()
    AND tm.role = 'technician'
    AND (public.identity_is_manager() OR tm.id = public.get_my_team_member_id())
  ORDER BY tm.member_name;
$$;

REVOKE ALL ON FUNCTION public.skill_market_my_team() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_my_team() TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_set_listing(
  p_technician_id uuid,
  p_enabled boolean,
  p_trade text DEFAULT NULL,
  p_radius_miles integer DEFAULT 40,
  p_hourly_rate_cents integer DEFAULT NULL,
  p_callout_fee_cents integer DEFAULT NULL,
  p_remote_assist boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM business_profile bp WHERE bp.user_id = v_owner AND bp.network_enabled) THEN
    RAISE EXCEPTION 'NETWORK_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'TECHNICIAN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_radius_miles IS NULL OR p_radius_miles < 1 OR p_radius_miles > 500 THEN
    RAISE EXCEPTION 'INVALID_RADIUS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO skill_market_profiles (
    technician_id, account_owner_id, company_consent_at, trade, service_radius_miles,
    hourly_rate_cents, callout_fee_cents, remote_assist_enabled
  ) VALUES (
    p_technician_id, v_owner, CASE WHEN p_enabled THEN now() END, p_trade, p_radius_miles::smallint,
    p_hourly_rate_cents, p_callout_fee_cents, coalesce(p_remote_assist, false)
  )
  ON CONFLICT (technician_id) DO UPDATE SET
    company_consent_at = CASE WHEN p_enabled THEN coalesce(skill_market_profiles.company_consent_at, now()) END,
    trade = p_trade,
    service_radius_miles = p_radius_miles::smallint,
    hourly_rate_cents = p_hourly_rate_cents,
    callout_fee_cents = p_callout_fee_cents,
    remote_assist_enabled = coalesce(p_remote_assist, false);

  IF p_enabled THEN
    PERFORM public.skill_market_refresh_technician(p_technician_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_set_listing(uuid, boolean, text, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_set_listing(uuid, boolean, text, integer, integer, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_set_consent(p_technician_id uuid, p_consent boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_tm FROM team_members
  WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'TECHNICIAN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Only the technician themself can consent (their data, their choice).
  IF v_tm.user_id IS NULL OR v_tm.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'SELF_ONLY' USING ERRCODE = '42501';
  END IF;

  INSERT INTO skill_market_profiles (technician_id, account_owner_id, technician_consent_at)
  VALUES (p_technician_id, v_tm.account_owner_id, CASE WHEN p_consent THEN now() END)
  ON CONFLICT (technician_id) DO UPDATE SET
    technician_consent_at = CASE WHEN p_consent THEN coalesce(skill_market_profiles.technician_consent_at, now()) END;

  IF p_consent THEN
    PERFORM public.skill_market_refresh_technician(p_technician_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_set_consent(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_set_consent(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_set_availability(p_technician_id uuid, p_availability text, p_paused boolean DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_availability NOT IN ('open', 'busy', 'offline') THEN RAISE EXCEPTION 'INVALID_AVAILABILITY' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_tm FROM team_members
  WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'TECHNICIAN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.identity_is_manager() OR v_tm.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  UPDATE skill_market_profiles
  SET availability = p_availability, paused = coalesce(p_paused, paused)
  WHERE technician_id = p_technician_id;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_set_availability(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_set_availability(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_refresh_mine(p_technician_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
  v_last timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_tm FROM team_members
  WHERE id = p_technician_id AND role = 'technician' AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'TECHNICIAN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.identity_is_manager() OR v_tm.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  SELECT evidence_refreshed_at INTO v_last FROM skill_market_profiles WHERE technician_id = p_technician_id;
  IF v_last IS NOT NULL AND v_last > now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'REFRESH_TOO_SOON' USING ERRCODE = '54000';
  END IF;
  PERFORM public.skill_market_refresh_technician(p_technician_id);
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_refresh_mine(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_refresh_mine(uuid) TO authenticated;

-- 6) The ranking engine -----------------------------------------------------------------
/*
  p_requirements: jsonb array, each item
    { "kind": "equipment" | "service", "tokens": ["daikin","vrv"], "min_level": 3, "label": "Daikin VRV" }
  Hard gates (candidate never returned): listed+consented, network member, available (not offline),
  every requirement met by VERIFIED evidence at >= min_level, distance <= min(radius, request radius)
  unless remote, hourly rate <= ceiling, trade match, insurance if required.
  Score (0..100), weights renormalised over components that apply:
    skill_fit, equipment_experience, outcome, proximity, availability, price, trust
*/
CREATE OR REPLACE FUNCTION public.search_skill_market(
  p_requirements jsonb,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_urgency text DEFAULT 'standard',
  p_trade text DEFAULT NULL,
  p_max_radius_miles integer DEFAULT 60,
  p_max_hourly_rate_cents integer DEFAULT NULL,
  p_requires_insurance boolean DEFAULT false,
  p_remote boolean DEFAULT false,
  p_include_own_team boolean DEFAULT true,
  p_limit integer DEFAULT 10
)
RETURNS TABLE (
  candidate_ref uuid,
  alias text,
  is_own_team boolean,
  display_name text,
  company_name text,
  tier text,
  passport_index smallint,
  score numeric,
  distance_miles numeric,
  availability text,
  capacity_left integer,
  hourly_rate_cents integer,
  callout_fee_cents integer,
  remote_ok boolean,
  verified_jobs integer,
  first_time_fix_rate numeric,
  rating_avg numeric,
  network_jobs integer,
  network_resolved_rate numeric,
  valid_insurance boolean,
  evidence_refreshed_at timestamptz,
  breakdown jsonb,
  matched_skills jsonb,
  reasons text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_req jsonb;
  v_n integer;
  v_urg text := coalesce(p_urgency, 'standard');
  w_skill numeric; w_equip numeric; w_out numeric; w_prox numeric; w_avail numeric; w_price numeric; w_trust numeric;
  v_radius integer := least(500, greatest(1, coalesce(p_max_radius_miles, 60)));
  v_limit integer := least(25, greatest(1, coalesce(p_limit, 10)));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM business_profile bp WHERE bp.user_id = v_owner AND bp.network_enabled) THEN
    RAISE EXCEPTION 'NETWORK_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF v_urg NOT IN ('emergency', 'urgent', 'standard') THEN RAISE EXCEPTION 'INVALID_URGENCY' USING ERRCODE = '22023'; END IF;
  IF p_requirements IS NULL OR jsonb_typeof(p_requirements) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUIREMENTS' USING ERRCODE = '22023'; END IF;

  v_n := jsonb_array_length(p_requirements);
  IF v_n < 1 OR v_n > 6 THEN RAISE EXCEPTION 'INVALID_REQUIREMENTS' USING ERRCODE = '22023'; END IF;

  -- validate + normalise requirements once
  SELECT jsonb_agg(jsonb_build_object(
           'kind', e ->> 'kind',
           'tokens', e -> 'tokens',
           'min_level', least(5, greatest(1, coalesce((e ->> 'min_level')::integer, 1))),
           'label', left(coalesce(nullif(btrim(e ->> 'label'), ''), 'Requirement'), 60)))
  INTO v_req
  FROM jsonb_array_elements(p_requirements) e
  WHERE (e ->> 'kind') IN ('equipment', 'service')
    AND CASE WHEN jsonb_typeof(e -> 'tokens') = 'array'
             THEN public.skill_market_valid_tokens(ARRAY(SELECT jsonb_array_elements_text(e -> 'tokens')))
             ELSE false END;
  IF v_req IS NULL OR jsonb_array_length(v_req) <> v_n THEN RAISE EXCEPTION 'INVALID_REQUIREMENTS' USING ERRCODE = '22023'; END IF;

  IF NOT p_remote AND (p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180) THEN
    RAISE EXCEPTION 'LOCATION_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- urgency-dependent weights
  IF v_urg = 'emergency' THEN
    w_skill := 22; w_equip := 10; w_out := 10; w_prox := 25; w_avail := 20; w_price := 0; w_trust := 13;
  ELSIF v_urg = 'urgent' THEN
    w_skill := 26; w_equip := 12; w_out := 14; w_prox := 18; w_avail := 14; w_price := 5; w_trust := 11;
  ELSE
    w_skill := 28; w_equip := 14; w_out := 18; w_prox := 12; w_avail := 8; w_price := 10; w_trust := 10;
  END IF;

  RETURN QUERY
  WITH cand AS (
    SELECT
      p.technician_id, p.account_owner_id, p.availability, p.service_radius_miles, p.hourly_rate_cents,
      p.callout_fee_cents, p.remote_assist_enabled, p.trade, p.tier, p.passport_index, p.jobs_completed,
      p.verified_jobs, p.first_time_fix_rate, p.rating_avg, p.response_reliability, p.valid_insurance,
      p.valid_credentials, p.evidence_refreshed_at,
      tm.member_name, tm.max_jobs_per_day,
      (p.account_owner_id = v_owner) AS own,
      CASE
        WHEN tm.current_latitude IS NOT NULL AND tm.location_updated_at > now() - interval '3 hours'
          THEN tm.current_latitude ELSE tm.home_latitude END AS lat,
      CASE
        WHEN tm.current_latitude IS NOT NULL AND tm.location_updated_at > now() - interval '3 hours'
          THEN tm.current_longitude ELSE tm.home_longitude END AS lng,
      coalesce(pr.company_name, 'Vireek member') AS company
    FROM skill_market_profiles p
    JOIN team_members tm ON tm.id = p.technician_id AND tm.role = 'technician'
    JOIN profiles pr ON pr.id = p.account_owner_id
    JOIN business_profile bp ON bp.user_id = p.account_owner_id AND bp.network_enabled
    WHERE p.company_consent_at IS NOT NULL
      AND p.technician_consent_at IS NOT NULL
      AND p.paused = false
      AND p.availability <> 'offline'
      AND (p_include_own_team OR p.account_owner_id <> v_owner)
      AND (p_trade IS NULL OR p.trade IS NULL OR p.trade = p_trade)
      AND (p_max_hourly_rate_cents IS NULL OR p.hourly_rate_cents IS NULL OR p.hourly_rate_cents <= p_max_hourly_rate_cents)
      AND (NOT p_requires_insurance OR p.valid_insurance)
      AND (NOT p_remote OR p.remote_assist_enabled)
      -- skip anyone with a live offer from this company already? no: unique index prevents duplicates at send time
  ),
  geo AS (
    SELECT c.*,
      CASE WHEN p_remote THEN NULL
           WHEN c.lat IS NULL OR c.lng IS NULL THEN NULL
           ELSE public.haversine_miles(p_lat, p_lng, c.lat, c.lng) END AS dist
    FROM cand c
  ),
  gated AS (
    SELECT g.* FROM geo g
    WHERE p_remote
       OR (g.dist IS NOT NULL AND g.dist <= least(v_radius, g.service_radius_miles))
  ),
  -- per-requirement best verified match
  reqs AS (
    SELECT g.technician_id, r.ord, r.e ->> 'kind' AS kind,
           (r.e ->> 'min_level')::integer AS min_level, r.e ->> 'label' AS label,
           m.skill_key, m.level, m.confidence, m.job_count, m.fix_rate
    FROM gated g
    CROSS JOIN LATERAL jsonb_array_elements(v_req) WITH ORDINALITY AS r(e, ord)
    LEFT JOIN LATERAL (
      SELECT s.skill_key, s.level, s.confidence, s.job_count, s.fix_rate
      FROM skill_market_skills s
      WHERE s.technician_id = g.technician_id
        AND s.kind = (r.e ->> 'kind')
        AND s.level >= (r.e ->> 'min_level')::integer
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(r.e -> 'tokens') t
          WHERE position(t in lower(s.skill_key)) = 0)
      ORDER BY s.level DESC, s.confidence DESC, s.job_count DESC
      LIMIT 1
    ) m ON true
  ),
  eligible AS (
    SELECT g.*
    FROM gated g
    WHERE (SELECT count(*) FROM reqs q WHERE q.technician_id = g.technician_id AND q.skill_key IS NOT NULL) = v_n
  ),
  agg AS (
    SELECT
      q.technician_id,
      avg((0.7 * q.confidence / 100.0 + 0.3 * q.level / 5.0)) FILTER (WHERE q.kind = 'service') AS skill_fit,
      avg((0.7 * q.confidence / 100.0 + 0.3 * q.level / 5.0)) FILTER (WHERE q.kind = 'equipment') AS equip_fit,
      jsonb_agg(jsonb_build_object('label', q.label, 'skill', q.skill_key, 'level', q.level,
                'confidence', q.confidence, 'jobs', q.job_count, 'min_level', q.min_level) ORDER BY q.ord) AS matched
    FROM reqs q
    WHERE q.technician_id IN (SELECT technician_id FROM eligible)
    GROUP BY q.technician_id
  ),
  net AS (
    SELECT o.technician_id,
           count(*)::integer AS n,
           100.0 * count(*) FILTER (WHERE o.outcome = 'resolved') / nullif(count(*), 0) AS resolved_rate,
           avg(o.rating)::numeric AS rating
    FROM skill_market_offers o
    WHERE o.status = 'completed' AND o.completed_at > now() - interval '365 days'
      AND o.technician_id IN (SELECT technician_id FROM eligible)
    GROUP BY o.technician_id
  ),
  workload AS (
    SELECT e.technician_id,
           greatest(0, coalesce(e.max_jobs_per_day, 6) - (
             SELECT count(*) FROM jobs j
             WHERE j.assigned_technician_id = e.technician_id
               AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
               AND j.scheduled_datetime >= date_trunc('day', now())
               AND j.scheduled_datetime < date_trunc('day', now()) + interval '1 day'
           ))::integer AS left_today
    FROM eligible e
  ),
  scored AS (
    SELECT
      e.*, a.skill_fit, a.equip_fit, a.matched,
      coalesce(n.n, 0) AS net_n, n.resolved_rate AS net_resolved, n.rating AS net_rating, l.left_today,
      -- outcome: blend internal first-time-fix with in-network resolution (network evidence grows in weight)
      CASE
        WHEN e.first_time_fix_rate IS NULL AND n.resolved_rate IS NULL THEN NULL
        ELSE (
          coalesce(e.first_time_fix_rate, 0) * least(coalesce(e.jobs_completed, 0), 30)
          + coalesce(n.resolved_rate, 0) * least(coalesce(n.n, 0), 10) * 2
        ) / nullif(least(coalesce(e.jobs_completed, 0), 30) + least(coalesce(n.n, 0), 10) * 2, 0) / 100.0
      END AS outcome_fit,
      CASE WHEN p_remote THEN NULL ELSE greatest(0, 1 - (e.dist / greatest(1, least(v_radius, e.service_radius_miles)))) END AS prox_fit,
      CASE
        WHEN e.availability = 'busy' THEN 0.25
        WHEN l.left_today <= 0 THEN 0.2
        ELSE least(1, 0.6 + 0.1 * l.left_today)
      END AS avail_fit,
      CASE
        WHEN p_max_hourly_rate_cents IS NULL OR p_max_hourly_rate_cents = 0 OR e.hourly_rate_cents IS NULL THEN NULL
        ELSE greatest(0, 1 - e.hourly_rate_cents::numeric / p_max_hourly_rate_cents)
      END AS price_fit,
      (
        0.5 * coalesce(e.passport_index, 0) / 100.0
        + 0.25 * (CASE WHEN e.valid_insurance THEN 1 ELSE 0 END)
        + 0.15 * least(1, e.valid_credentials / 2.0)
        + 0.10 * least(1, coalesce(e.verified_jobs, 0) / 20.0)
      ) AS trust_fit
    FROM eligible e
    JOIN agg a ON a.technician_id = e.technician_id
    JOIN workload l ON l.technician_id = e.technician_id
    LEFT JOIN net n ON n.technician_id = e.technician_id
  ),
  final AS (
    SELECT s.*,
      -- renormalise over the components that apply
      (( coalesce(w_skill * s.skill_fit, 0) + coalesce(w_equip * s.equip_fit, 0) + coalesce(w_out * s.outcome_fit, 0)
        + coalesce(w_prox * s.prox_fit, 0) + w_avail * s.avail_fit + coalesce(w_price * s.price_fit, 0) + w_trust * s.trust_fit )
      /
      nullif( (CASE WHEN s.skill_fit IS NULL THEN 0 ELSE w_skill END)
            + (CASE WHEN s.equip_fit IS NULL THEN 0 ELSE w_equip END)
            + (CASE WHEN s.outcome_fit IS NULL THEN 0 ELSE w_out END)
            + (CASE WHEN s.prox_fit IS NULL THEN 0 ELSE w_prox END)
            + w_avail
            + (CASE WHEN s.price_fit IS NULL THEN 0 ELSE w_price END)
            + w_trust, 0) * 100.0)::numeric AS total
    FROM scored s
  )
  SELECT
    f.technician_id,
    'Technician ' || upper(substr(md5(f.technician_id::text), 1, 4)),
    f.own,
    CASE WHEN f.own THEN coalesce(nullif(btrim(f.member_name), ''), 'Technician') END,
    f.company,
    f.tier,
    f.passport_index,
    round(f.total, 1),
    CASE WHEN f.dist IS NULL THEN NULL ELSE round(f.dist::numeric, 0) END,
    f.availability,
    f.left_today,
    f.hourly_rate_cents,
    f.callout_fee_cents,
    f.remote_assist_enabled,
    f.verified_jobs,
    f.first_time_fix_rate,
    f.rating_avg,
    f.net_n,
    round(f.net_resolved, 1),
    f.valid_insurance,
    f.evidence_refreshed_at,
    jsonb_build_object(
      'skill_fit', CASE WHEN f.skill_fit IS NULL THEN NULL ELSE round(f.skill_fit * 100) END,
      'equipment_experience', CASE WHEN f.equip_fit IS NULL THEN NULL ELSE round(f.equip_fit * 100) END,
      'historical_outcome', CASE WHEN f.outcome_fit IS NULL THEN NULL ELSE round(f.outcome_fit * 100) END,
      'proximity', CASE WHEN f.prox_fit IS NULL THEN NULL ELSE round(f.prox_fit * 100) END,
      'availability', round(f.avail_fit * 100),
      'price', CASE WHEN f.price_fit IS NULL THEN NULL ELSE round(f.price_fit * 100) END,
      'trust', round(f.trust_fit * 100),
      'weights', jsonb_build_object('skill', w_skill, 'equipment', w_equip, 'outcome', w_out,
                   'proximity', w_prox, 'availability', w_avail, 'price', w_price, 'trust', w_trust)
    ),
    f.matched,
    ARRAY_REMOVE(ARRAY[
      (SELECT string_agg((m ->> 'label') || ' L' || (m ->> 'level') || ' (' || (m ->> 'confidence') || '% over ' || (m ->> 'jobs') || ' jobs)', ' · ')
         FROM jsonb_array_elements(f.matched) m),
      CASE WHEN f.dist IS NOT NULL THEN round(f.dist::numeric, 0)::text || ' mi away' END,
      CASE WHEN f.availability = 'open' AND f.left_today > 0 THEN 'Open today (' || f.left_today || ' slots)' END,
      CASE WHEN f.net_n >= 3 THEN f.net_n || ' in-network jobs, ' || round(coalesce(f.net_resolved, 0)) || '% resolved' END,
      CASE WHEN f.valid_insurance THEN 'Verified insurance' END
    ], NULL)
  FROM final f
  ORDER BY f.total DESC, f.dist NULLS LAST
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_skill_market(jsonb, double precision, double precision, text, text, integer, integer, boolean, boolean, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_skill_market(jsonb, double precision, double precision, text, text, integer, integer, boolean, boolean, boolean, integer) TO authenticated;

-- 7) Offers ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skill_market_expire_offers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE skill_market_offers SET status = 'expired', responded_at = now()
  WHERE status = 'offered' AND responds_by < now()
    AND (requester_owner_id = public.get_account_owner_id() OR technician_owner_id = public.get_account_owner_id());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_expire_offers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_expire_offers() TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_send_offer(
  p_technician_id uuid,
  p_title text,
  p_summary text,
  p_urgency text,
  p_requirements jsonb,
  p_match_score numeric DEFAULT NULL,
  p_match_breakdown jsonb DEFAULT '{}'::jsonb,
  p_offered_rate_cents integer DEFAULT NULL,
  p_remote boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_p skill_market_profiles%ROWTYPE;
  v_id uuid;
  v_hours integer;
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM business_profile bp WHERE bp.user_id = v_owner AND bp.network_enabled) THEN
    RAISE EXCEPTION 'NETWORK_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF p_urgency NOT IN ('emergency', 'urgent', 'standard') THEN RAISE EXCEPTION 'INVALID_URGENCY' USING ERRCODE = '22023'; END IF;
  IF length(v_title) < 3 OR length(v_title) > 120 THEN RAISE EXCEPTION 'INVALID_TITLE' USING ERRCODE = '22023'; END IF;
  IF v_summary IS NOT NULL AND length(v_summary) > 600 THEN RAISE EXCEPTION 'INVALID_SUMMARY' USING ERRCODE = '22023'; END IF;
  -- no contact details in pre-acceptance text (same rule as the network hub)
  IF public.network_text_has_contact_info(v_title) OR public.network_text_has_contact_info(coalesce(v_summary, '')) THEN
    RAISE EXCEPTION 'PII_IN_PUBLIC_FIELDS' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_p FROM skill_market_profiles
  WHERE technician_id = p_technician_id
    AND company_consent_at IS NOT NULL AND technician_consent_at IS NOT NULL AND paused = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANDIDATE_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF v_p.account_owner_id = v_owner THEN RAISE EXCEPTION 'OWN_TEAM_USE_DISPATCH' USING ERRCODE = '22023'; END IF;

  IF (SELECT count(*) FROM skill_market_offers WHERE requester_owner_id = v_owner AND status IN ('offered', 'accepted')) >= 20 THEN
    RAISE EXCEPTION 'TOO_MANY_OPEN' USING ERRCODE = '54000';
  END IF;
  IF (SELECT count(*) FROM skill_market_offers WHERE requester_owner_id = v_owner AND created_at > now() - interval '1 hour') >= 15 THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = '54000';
  END IF;

  v_hours := CASE p_urgency WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 4 ELSE 24 END;

  BEGIN
    INSERT INTO skill_market_offers (
      requester_owner_id, technician_id, technician_owner_id, title, summary, urgency, requirements,
      match_score, match_breakdown, offered_rate_cents, remote, responds_by
    ) VALUES (
      v_owner, p_technician_id, v_p.account_owner_id, v_title, v_summary, p_urgency,
      coalesce(p_requirements, '[]'::jsonb), p_match_score, coalesce(p_match_breakdown, '{}'::jsonb),
      p_offered_rate_cents, coalesce(p_remote, false), now() + make_interval(hours => v_hours)
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ALREADY_OFFERED' USING ERRCODE = '23505';
  END;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    v_p.account_owner_id, 'system',
    CASE p_urgency WHEN 'emergency' THEN 'Emergency skill-market request' ELSE 'New skill-market request' END,
    'A Vireek member requests one of your technicians: "' || v_title || '". Respond within ' || v_hours || 'h.',
    '/dashboard/network/skill-market'
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_send_offer(uuid, text, text, text, jsonb, numeric, jsonb, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_send_offer(uuid, text, text, text, jsonb, numeric, jsonb, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_respond_offer(p_offer_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o skill_market_offers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_o FROM skill_market_offers
  WHERE id = p_offer_id AND technician_owner_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_o.status <> 'offered' THEN RAISE EXCEPTION 'OFFER_NOT_OPEN' USING ERRCODE = '22023'; END IF;
  IF v_o.responds_by < now() THEN
    UPDATE skill_market_offers SET status = 'expired', responded_at = now() WHERE id = p_offer_id;
    RAISE EXCEPTION 'OFFER_EXPIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE skill_market_offers
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now()
  WHERE id = p_offer_id;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    v_o.requester_owner_id, 'system',
    CASE WHEN p_accept THEN 'Skill-market request accepted' ELSE 'Skill-market request declined' END,
    CASE WHEN p_accept
      THEN 'Your request "' || v_o.title || '" was accepted. Contact details are now visible.'
      ELSE 'Your request "' || v_o.title || '" was declined. Try the next best match.' END,
    '/dashboard/network/skill-market'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_respond_offer(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_respond_offer(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.skill_market_withdraw_offer(p_offer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  UPDATE skill_market_offers SET status = 'withdrawn', responded_at = now()
  WHERE id = p_offer_id AND requester_owner_id = public.get_account_owner_id() AND status IN ('offered', 'accepted');
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_withdraw_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_withdraw_offer(uuid) TO authenticated;

-- Outcome feedback: the network-effect flywheel. Requester only, once, after acceptance.
CREATE OR REPLACE FUNCTION public.skill_market_complete_offer(
  p_offer_id uuid, p_outcome text, p_rating integer, p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF p_outcome NOT IN ('resolved', 'partial', 'unresolved') THEN RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE = '22023'; END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'INVALID_RATING' USING ERRCODE = '22023'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 400 THEN RAISE EXCEPTION 'INVALID_NOTE' USING ERRCODE = '22023'; END IF;

  UPDATE skill_market_offers
  SET status = 'completed', outcome = p_outcome, rating = p_rating::smallint, outcome_note = v_note, completed_at = now()
  WHERE id = p_offer_id AND requester_owner_id = public.get_account_owner_id() AND status = 'accepted';
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.skill_market_complete_offer(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_complete_offer(uuid, text, integer, text) TO authenticated;

-- List offers (both directions). Counterparty identity/contact only after acceptance.
CREATE OR REPLACE FUNCTION public.skill_market_list_offers()
RETURNS TABLE (
  id uuid,
  direction text,
  title text,
  summary text,
  urgency text,
  status text,
  match_score numeric,
  offered_rate_cents integer,
  remote boolean,
  responds_by timestamptz,
  created_at timestamptz,
  outcome text,
  rating smallint,
  requirements jsonb,
  technician_alias text,
  technician_name text,
  counterparty_company text,
  counterparty_phone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    CASE WHEN o.requester_owner_id = public.get_account_owner_id() THEN 'sent' ELSE 'received' END,
    o.title, o.summary, o.urgency, o.status, o.match_score, o.offered_rate_cents, o.remote,
    o.responds_by, o.created_at, o.outcome, o.rating, o.requirements,
    'Technician ' || upper(substr(md5(o.technician_id::text), 1, 4)),
    CASE WHEN o.status IN ('accepted', 'completed') AND o.requester_owner_id = public.get_account_owner_id()
         THEN coalesce(nullif(btrim(tm.member_name), ''), 'Technician')
         WHEN o.technician_owner_id = public.get_account_owner_id()
         THEN coalesce(nullif(btrim(tm.member_name), ''), 'Technician') END,
    CASE WHEN o.requester_owner_id = public.get_account_owner_id()
         THEN (SELECT coalesce(company_name, 'Vireek member') FROM profiles WHERE id = o.technician_owner_id)
         ELSE (SELECT coalesce(company_name, 'Vireek member') FROM profiles WHERE id = o.requester_owner_id) END,
    CASE WHEN o.status IN ('accepted', 'completed') THEN
      (SELECT pr.phone FROM profiles pr
        WHERE pr.id = CASE WHEN o.requester_owner_id = public.get_account_owner_id() THEN o.technician_owner_id ELSE o.requester_owner_id END)
    END
  FROM skill_market_offers o
  JOIN team_members tm ON tm.id = o.technician_id
  WHERE public.identity_is_manager()
    AND (o.requester_owner_id = public.get_account_owner_id() OR o.technician_owner_id = public.get_account_owner_id())
  ORDER BY o.created_at DESC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.skill_market_list_offers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skill_market_list_offers() TO authenticated;
