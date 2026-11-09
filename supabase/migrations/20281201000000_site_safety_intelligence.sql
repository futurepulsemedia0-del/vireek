/*
  # Site Safety Intelligence — lone-worker safety for technicians

  ## What this adds (all additive; nothing existing is changed or dropped)
  1.  safety_settings            per-account switches, region profile, escalation chain, retention.
  2.  safety_member_prefs        per-technician: emergency contact, duress word (hash), location opt-in.
  3.  safety_consent_log         append-only monitoring consent evidence (versioned notice).
  4.  safety_hazard_facts        event / behaviour / self-reported facts per EXACT address, each with
                                 source + date + expiry + human review. Customer-facing notes need
                                 legal review, an appeal contact and an expiry (CHECK constraint).
  5.  safety_policy_rules        precautions per risk tier (configurable).
  6.  safety_job_assessments     tier + precautions computed per job (written by the safety-brief function).
  7.  safety_decline_requests    "decline or reschedule unsafe work" — no penalty, office + customer notified.
  8.  safety_sessions / safety_events / safety_locations
                                 lone-worker timer, append-only event log, job-window-only location.
  9.  safety_incidents (+events) structured ledger with case workflow, wellbeing follow-up, attachments.
  10. safety_fairness_audits     output of the disparate-impact screen + human review status.

  ## Fairness by construction
  - No area/neighbourhood/demographic/voice columns exist. Facts attach to an exact address key.
  - fact_text is linted by a trigger (protected-attribute and area-profiling language is rejected).
  - category is a closed list; "weapon" style stereotyping categories are deliberately absent.

  ## Security
  - RLS on every table. Clients can only SELECT; every write goes through SECURITY DEFINER RPCs that
    check the caller (assigned technician / manager) and the tenant (get_account_owner_id()).
  - Technicians cannot read the facts table directly (data minimisation): they receive their own
    jobs' brief through the safety-brief edge function after an access check.
  - Service-role-only RPCs: safety_upsert_call_facts, safety_checkin_by_sms.
  - Location capture re-uses location_tracking_gate() AND requires monitoring consent AND the
    technician's own opt-in AND a live session.
  - Vireek does NOT contact emergency services. Nothing here replaces calling them.

  ## Rollback
  See the commented ROLLBACK block at the bottom (manual, destructive, never run automatically).
*/

-- =============================================================
-- 0) Small helpers (re-use existing ones; no parallel permission system)
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.location_privacy_can_manage();
$$;
REVOKE ALL ON FUNCTION public.safety_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_can_manage() TO authenticated;

-- Max location retention per region profile. The TypeScript mirror lives in src/lib/safety/core.ts
-- (REGION_LIMITS) and a unit test fails if the two drift apart.
CREATE OR REPLACE FUNCTION public.safety_region_max_retention(p_profile text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_profile
    WHEN 'standard' THEN 90
    WHEN 'strict_eu' THEN 14
    WHEN 'custom' THEN 365
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.safety_is_e164(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p IS NULL OR p ~ '^\+[1-9][0-9]{6,14}$';
$$;

-- Is this team member on the job (lead or crew)?
CREATE OR REPLACE FUNCTION public.safety_is_on_job(p_job uuid, p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_member IS NOT NULL AND (
    EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job AND j.assigned_technician_id = p_member)
    OR EXISTS (SELECT 1 FROM job_technician_assignments a
               WHERE a.job_id = p_job AND a.technician_id = p_member AND a.crew_role IS NOT NULL)
  );
$$;
REVOKE ALL ON FUNCTION public.safety_is_on_job(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_is_on_job(uuid, uuid) TO authenticated, service_role;

-- =============================================================
-- 1) Settings
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_settings (
  user_id uuid PRIMARY KEY,                                   -- account owner
  enabled boolean NOT NULL DEFAULT false,
  region_profile text NOT NULL DEFAULT 'standard' CHECK (region_profile IN ('standard', 'strict_eu', 'custom')),
  labor_review_ack boolean NOT NULL DEFAULT false,            -- manager attests works-council / labour review is done
  labor_review_ack_by uuid,
  labor_review_ack_at timestamptz,
  monitoring_consent_required boolean NOT NULL DEFAULT true,
  notice_version integer NOT NULL DEFAULT 1 CHECK (notice_version >= 1),
  notice_bumped_at timestamptz NOT NULL DEFAULT now(),
  location_sharing_enabled boolean NOT NULL DEFAULT false,
  location_visibility text NOT NULL DEFAULT 'on_escalation' CHECK (location_visibility IN ('on_escalation', 'during_job')),
  location_retention_days integer NOT NULL DEFAULT 14 CHECK (location_retention_days BETWEEN 1 AND 365),
  checkin_interval_minutes integer NOT NULL DEFAULT 30 CHECK (checkin_interval_minutes BETWEEN 10 AND 240),
  checkin_grace_minutes integer NOT NULL DEFAULT 5 CHECK (checkin_grace_minutes BETWEEN 1 AND 30),
  overrun_prompt_minutes integer NOT NULL DEFAULT 30 CHECK (overrun_prompt_minutes BETWEEN 5 AND 240),
  unreachable_minutes integer NOT NULL DEFAULT 15 CHECK (unreachable_minutes BETWEEN 5 AND 120),
  escalation_chain jsonb NOT NULL DEFAULT '[{"step":"dispatcher","delay_min":0},{"step":"emergency_contact","delay_min":5},{"step":"company_next","delay_min":10}]'::jsonb,
  dispatcher_phone text CHECK (public.safety_is_e164(dispatcher_phone)),
  company_next_phone text CHECK (public.safety_is_e164(company_next_phone)),
  duress_word_enabled boolean NOT NULL DEFAULT false,
  sms_fallback_enabled boolean NOT NULL DEFAULT true,
  drills_enabled boolean NOT NULL DEFAULT true,
  fact_ttl_days integer NOT NULL DEFAULT 365 CHECK (fact_ttl_days BETWEEN 30 AND 1095),
  show_unreviewed_call_facts boolean NOT NULL DEFAULT true,
  auto_notify_customer_on_decline boolean NOT NULL DEFAULT true,
  decline_customer_message text CHECK (decline_customer_message IS NULL OR char_length(decline_customer_message) <= 500),
  appeal_contact text CHECK (appeal_contact IS NULL OR char_length(appeal_contact) <= 200),
  incident_retention_months integer NOT NULL DEFAULT 60 CHECK (incident_retention_months BETWEEN 12 AND 120),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE safety_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_settings_select" ON safety_settings;
CREATE POLICY "safety_settings_select" ON safety_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.safety_can_manage());

-- =============================================================
-- 2) Per-technician preferences + consent evidence
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_member_prefs (
  team_member_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  location_opt_in boolean NOT NULL DEFAULT false,
  emergency_contact_name text CHECK (emergency_contact_name IS NULL OR char_length(emergency_contact_name) <= 80),
  emergency_contact_phone text CHECK (public.safety_is_e164(emergency_contact_phone)),
  duress_word_hash text CHECK (duress_word_hash IS NULL OR duress_word_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_member_prefs_user ON safety_member_prefs(user_id);

ALTER TABLE safety_member_prefs ENABLE ROW LEVEL SECURITY;
-- A technician sees only their own row. Managers do NOT read prefs (duress hash / contact) directly;
-- the escalation function reads them with the service role at the moment they are needed.
DROP POLICY IF EXISTS "safety_member_prefs_select" ON safety_member_prefs;
CREATE POLICY "safety_member_prefs_select" ON safety_member_prefs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND team_member_id = public.get_my_team_member_id());

CREATE TABLE IF NOT EXISTS safety_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  member_email text NOT NULL,
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  notice_version integer NOT NULL CHECK (notice_version >= 1),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'web')),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_consent_member_time ON safety_consent_log(team_member_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.safety_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A cascade from a removed parent (job / session / incident) runs one trigger level deeper
    -- than a direct statement, so it is allowed; a direct DELETE of history is not.
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'safety_consent_log'
     AND NEW.team_member_id IS NULL
     AND (to_jsonb(NEW) - 'team_member_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'team_member_id') THEN
    RETURN NEW;                                  -- detaching a removed member keeps the evidence
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_safety_consent_log_append_only ON safety_consent_log;
CREATE TRIGGER trg_safety_consent_log_append_only
  BEFORE UPDATE OR DELETE ON safety_consent_log
  FOR EACH ROW EXECUTE FUNCTION public.safety_append_only();

ALTER TABLE safety_consent_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_consent_select" ON safety_consent_log;
CREATE POLICY "safety_consent_select" ON safety_consent_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage() OR team_member_id = public.get_my_team_member_id()));

-- Internal: has this member consented to the CURRENT notice? (not callable by clients)
CREATE OR REPLACE FUNCTION public._safety_consent_ok(p_member uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_s safety_settings%ROWTYPE;
  v_c safety_consent_log%ROWTYPE;
BEGIN
  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = p_member;
  IF v_owner IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_c FROM safety_consent_log WHERE team_member_id = p_member ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT FOUND OR v_c.action <> 'granted' THEN RETURN false; END IF;
  RETURN v_c.notice_version >= v_s.notice_version;
END;
$$;
REVOKE ALL ON FUNCTION public._safety_consent_ok(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._safety_consent_ok(uuid) TO service_role;

-- =============================================================
-- 3) Facts, policy, assessments
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_hazard_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_key text NOT NULL CHECK (char_length(site_key) BETWEEN 3 AND 200),   -- normalised EXACT address
  customer_id uuid,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN (
    'animal', 'lighting', 'structure', 'aggressive_behavior', 'intoxication_reported',
    'access_hazard', 'electrical_hazard', 'biological_hazard', 'other_event')),
  fact_text text NOT NULL CHECK (char_length(fact_text) BETWEEN 3 AND 300),
  quote text CHECK (quote IS NULL OR char_length(quote) <= 200),            -- caller's own sentence; staff-only
  source text NOT NULL CHECK (source IN ('call_volunteered', 'staff_incident', 'equipment_data', 'technician_report', 'customer_self_report')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  occurred_on date NOT NULL,
  expires_on date NOT NULL,
  review_status text NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review', 'confirmed', 'rejected', 'disputed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  customer_visible boolean NOT NULL DEFAULT false,
  legal_review text NOT NULL DEFAULT 'not_required' CHECK (legal_review IN ('not_required', 'needs_review', 'approved', 'blocked')),
  appeal_contact text CHECK (appeal_contact IS NULL OR char_length(appeal_contact) <= 200),
  review_due_on date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_safety_fact_dates CHECK (expires_on > occurred_on),
  -- A customer may only ever be shown a note that a person confirmed, legal approved, that expires
  -- and that has a way to contest it.
  CONSTRAINT chk_safety_fact_customer_visible CHECK (
    customer_visible = false
    OR (review_status = 'confirmed' AND legal_review = 'approved' AND appeal_contact IS NOT NULL AND review_due_on IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_safety_facts_site ON safety_hazard_facts(user_id, site_key) WHERE review_status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_safety_facts_expiry ON safety_hazard_facts(user_id, expires_on);
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_facts_call_category
  ON safety_hazard_facts(user_id, call_id, category) WHERE call_id IS NOT NULL AND source = 'call_volunteered';

ALTER TABLE safety_hazard_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_facts_select" ON safety_hazard_facts;
CREATE POLICY "safety_facts_select" ON safety_hazard_facts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.safety_can_manage());

-- Backstop lint: protected-attribute / area-profiling language is rejected in the database too.
-- (Mirrors PROTECTED_PATTERNS in src/lib/safety/core.ts. Review both when editing either.)
CREATE OR REPLACE FUNCTION public.safety_fact_lint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_text text := normalize(coalesce(NEW.fact_text, '') || ' ' || coalesce(NEW.quote, ''), NFKC);
BEGIN
  IF v_text ~* '\m(black|white|asian|latino|latina|hispanic|arab|african|caucasian|ethnic\w*|race|racial|minorit\w+)\M'
     OR v_text ~* '\m(muslim|islam\w*|jewish|jew|christian|hindu|sikh|buddhist|religio\w+|church|mosque|temple)\M'
     OR v_text ~* '\m(immigra\w+|foreign\w*|illegal alien|undocumented|nationalit\w+|refugee)\M'
     OR v_text ~* '\m(accent\w*|sounded like|sounds like|broken english|spoke poor english)\M'
     OR v_text ~* '\m(gay|lesbian|trans\w*|homosexual|sexual orientation|gender identity)\M'
     OR v_text ~* '\m(disab\w+|crazy|insane|psycho\w*|retard\w*|schizo\w*)\M'
     OR v_text ~* '\m(elderly|senior citizen|too old|teenager)\M'
     OR v_text ~* '\m(bad|rough|sketchy|dangerous|poor|ghetto|crime[- ]ridden)\s+(neighbou?rhood|area|part of town|district|block)\M'
     OR v_text ~* '\mneighbou?rhood\M|\mcrime (rate|score|map)\M|high[- ]crime'
     OR v_text ~* '\m(trailer park|projects|section 8|welfare|low[- ]income)\M'
  THEN
    RAISE EXCEPTION 'Safety facts must describe an event or behaviour at this address, not a person''s characteristics or an area.'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_safety_fact_lint ON safety_hazard_facts;
CREATE TRIGGER trg_safety_fact_lint BEFORE INSERT OR UPDATE ON safety_hazard_facts
  FOR EACH ROW EXECUTE FUNCTION public.safety_fact_lint();

CREATE TABLE IF NOT EXISTS safety_policy_rules (
  user_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('standard', 'elevated', 'high')),
  precautions text[] NOT NULL DEFAULT '{}'
    CHECK (precautions <@ ARRAY['customer_present', 'daytime_only', 'two_person_crew', 'meet_outside_first', 'remote_video_preassessment']::text[]),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tier)
);
ALTER TABLE safety_policy_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_policy_select" ON safety_policy_rules;
CREATE POLICY "safety_policy_select" ON safety_policy_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS safety_job_assessments (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('standard', 'elevated', 'high')),
  precautions text[] NOT NULL DEFAULT '{}',
  fact_ids uuid[] NOT NULL DEFAULT '{}',
  capped_pending_review boolean NOT NULL DEFAULT false,
  override_tier text CHECK (override_tier IS NULL OR override_tier IN ('standard', 'elevated', 'high')),
  override_by uuid,
  override_reason text CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 5 AND 500),
  computed_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_safety_assess_user ON safety_job_assessments(user_id, computed_at DESC);
ALTER TABLE safety_job_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_assess_select" ON safety_job_assessments;
CREATE POLICY "safety_assess_select" ON safety_job_assessments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage() OR public.safety_is_on_job(job_id, public.get_my_team_member_id())));

-- =============================================================
-- 4) Right to decline (no penalty)
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_decline_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('decline', 'reschedule')),
  reason_code text NOT NULL CHECK (reason_code IN ('felt_unsafe', 'precaution_not_met', 'hazard_found', 'other')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'rescheduled', 'reassigned', 'closed')),
  customer_notice_status text NOT NULL DEFAULT 'pending' CHECK (customer_notice_status IN ('pending', 'sent', 'skipped', 'failed')),
  customer_notice_error text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE safety_decline_requests IS
  'Right to decline unsafe work. POLICY: this table must never feed performance scores, retention risk, commissions or discipline. A unit test (safetyNoPenalty) scans the code base for reads of it outside the safety module.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_decline_open ON safety_decline_requests(job_id, team_member_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_safety_decline_notice ON safety_decline_requests(customer_notice_status) WHERE customer_notice_status = 'pending';
ALTER TABLE safety_decline_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_decline_select" ON safety_decline_requests;
CREATE POLICY "safety_decline_select" ON safety_decline_requests FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage() OR team_member_id = public.get_my_team_member_id()));

-- =============================================================
-- 5) Lone-worker sessions, events, locations
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  is_drill boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'escalating', 'duress', 'ended')),
  end_outcome text CHECK (end_outcome IS NULL OR end_outcome IN ('completed', 'cancelled', 'false_alarm', 'auto_job_closed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expected_end_at timestamptz NOT NULL,
  next_checkin_due_at timestamptz NOT NULL,
  last_checkin_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  escalation_anchor_at timestamptz,
  all_clear_pending boolean NOT NULL DEFAULT false,
  sms_code text NOT NULL CHECK (sms_code ~ '^[0-9]{6}$'),
  sms_attempts integer NOT NULL DEFAULT 0,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_safety_session_times CHECK (expected_end_at > started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_session_live ON safety_sessions(job_id, team_member_id) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS idx_safety_session_live ON safety_sessions(user_id, status) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS idx_safety_session_clear ON safety_sessions(all_clear_pending) WHERE all_clear_pending;

ALTER TABLE safety_sessions ENABLE ROW LEVEL SECURITY;
-- sms_code is never exposed to clients: they read sessions through safety_my_session() / safety_active_sessions().
DROP POLICY IF EXISTS "safety_session_select" ON safety_sessions;
CREATE POLICY "safety_session_select" ON safety_sessions FOR SELECT TO authenticated USING (false);

CREATE TABLE IF NOT EXISTS safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'session_start', 'checkin', 'prompt_checkin', 'missed_checkin', 'overrun_prompt', 'unreachable_prompt',
    'escalation_step', 'escalation_resolved', 'duress', 'extended', 'session_end', 'all_clear_sent', 'false_alarm')),
  dedupe_key text,
  step text CHECK (step IS NULL OR step IN ('dispatcher', 'emergency_contact', 'company_next')),
  channel text CHECK (channel IS NULL OR channel IN ('app', 'sms', 'voice', 'push', 'in_app', 'none')),
  delivery text CHECK (delivery IS NULL OR delivery IN ('sent', 'failed', 'simulated', 'skipped_no_contact')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: the same timer action can never be recorded twice for a session.
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_event_dedupe ON safety_events(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_safety_events_session ON safety_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_safety_events_user_time ON safety_events(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_safety_events_append_only ON safety_events;
CREATE TRIGGER trg_safety_events_append_only BEFORE UPDATE OR DELETE ON safety_events
  FOR EACH ROW EXECUTE FUNCTION public.safety_append_only();

ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_events_select" ON safety_events;
CREATE POLICY "safety_events_select" ON safety_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage()
              OR EXISTS (SELECT 1 FROM safety_sessions s WHERE s.id = session_id AND s.team_member_id = public.get_my_team_member_id())));

CREATE TABLE IF NOT EXISTS safety_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m real CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_locations_session ON safety_locations(session_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_locations_expiry ON safety_locations(expires_at);

-- Who may see location rows: the technician always; managers only when the account allows it
-- (always during a job, or only once an escalation / duress is running).
CREATE OR REPLACE FUNCTION public.safety_can_view_location(p_session uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s safety_sessions%ROWTYPE;
  v_set safety_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_s FROM safety_sessions WHERE id = p_session;
  IF NOT FOUND OR v_s.user_id IS DISTINCT FROM public.get_account_owner_id() THEN RETURN false; END IF;
  IF v_s.team_member_id = public.get_my_team_member_id() THEN RETURN true; END IF;
  IF NOT public.safety_can_manage() THEN RETURN false; END IF;
  SELECT * INTO v_set FROM safety_settings WHERE user_id = v_s.user_id;
  IF NOT FOUND OR NOT v_set.location_sharing_enabled THEN RETURN false; END IF;
  IF v_s.status IN ('escalating', 'duress') THEN RETURN true; END IF;
  RETURN v_set.location_visibility = 'during_job' AND v_s.status = 'active';
END;
$$;
REVOKE ALL ON FUNCTION public.safety_can_view_location(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_can_view_location(uuid) TO authenticated;

ALTER TABLE safety_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_locations_select" ON safety_locations;
CREATE POLICY "safety_locations_select" ON safety_locations FOR SELECT TO authenticated
  USING (public.safety_can_view_location(session_id));

-- =============================================================
-- 6) Incident ledger
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL,
  reported_by uuid,
  reporter_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('threat', 'injury', 'near_miss', 'hazard')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'triage', 'investigating', 'actions', 'closed')),
  occurred_at timestamptz NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),
  assigned_to uuid,
  regulatory_reportable boolean NOT NULL DEFAULT false,
  regulator_ref text CHECK (regulator_ref IS NULL OR char_length(regulator_ref) <= 120),
  wellbeing_due_at timestamptz,
  wellbeing_checked_at timestamptz,
  wellbeing_note text CHECK (wellbeing_note IS NULL OR char_length(wellbeing_note) <= 1000),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10),
  closed_at timestamptz,
  retain_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_user ON safety_incidents(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_open ON safety_incidents(user_id, status) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_safety_incidents_wellbeing ON safety_incidents(wellbeing_due_at) WHERE wellbeing_checked_at IS NULL AND wellbeing_due_at IS NOT NULL;

ALTER TABLE safety_incidents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_incidents_select" ON safety_incidents;
CREATE POLICY "safety_incidents_select" ON safety_incidents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage() OR reporter_member_id = public.get_my_team_member_id()));

CREATE TABLE IF NOT EXISTS safety_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  incident_id uuid NOT NULL REFERENCES safety_incidents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reported', 'status_changed', 'note', 'attachment_added', 'wellbeing_checked', 'reportable_changed')),
  from_status text,
  to_status text,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_incident_events ON safety_incident_events(incident_id, created_at);
DROP TRIGGER IF EXISTS trg_safety_incident_events_append_only ON safety_incident_events;
CREATE TRIGGER trg_safety_incident_events_append_only BEFORE UPDATE OR DELETE ON safety_incident_events
  FOR EACH ROW EXECUTE FUNCTION public.safety_append_only();
ALTER TABLE safety_incident_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_incident_events_select" ON safety_incident_events;
CREATE POLICY "safety_incident_events_select" ON safety_incident_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.safety_can_manage()
              OR EXISTS (SELECT 1 FROM safety_incidents i WHERE i.id = incident_id AND i.reporter_member_id = public.get_my_team_member_id())));

-- Private bucket for incident attachments. Path convention: <owner_id>/<incident_id>/<file>.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('safety-attachments', 'safety-attachments', false, 26214400,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "safety_attachments_insert" ON storage.objects;
CREATE POLICY "safety_attachments_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'safety-attachments'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (
      SELECT 1 FROM public.safety_incidents i
      WHERE i.id::text = (storage.foldername(name))[2]
        AND i.user_id = public.get_account_owner_id()
        AND (public.safety_can_manage() OR i.reporter_member_id = public.get_my_team_member_id())
    )
  );

DROP POLICY IF EXISTS "safety_attachments_select" ON storage.objects;
CREATE POLICY "safety_attachments_select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'safety-attachments'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (
      SELECT 1 FROM public.safety_incidents i
      WHERE i.id::text = (storage.foldername(name))[2]
        AND i.user_id = public.get_account_owner_id()
        AND (public.safety_can_manage() OR i.reporter_member_id = public.get_my_team_member_id())
    )
  );
-- No UPDATE / DELETE policy: attachments are evidence and cannot be altered from the client.

-- =============================================================
-- 7) Fairness audits
-- =============================================================

CREATE TABLE IF NOT EXISTS safety_fairness_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  report jsonb NOT NULL,
  finding_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed_no_action', 'action_required', 'actioned')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_start, period_end)
);
ALTER TABLE safety_fairness_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_fairness_select" ON safety_fairness_audits;
CREATE POLICY "safety_fairness_select" ON safety_fairness_audits FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.safety_can_manage());

-- Clients never write these tables directly.
REVOKE INSERT, UPDATE, DELETE ON
  safety_settings, safety_member_prefs, safety_consent_log, safety_hazard_facts, safety_policy_rules,
  safety_job_assessments, safety_decline_requests, safety_sessions, safety_events, safety_locations,
  safety_incidents, safety_incident_events, safety_fairness_audits
FROM anon, authenticated;
REVOKE ALL ON safety_sessions FROM anon, authenticated;          -- contains sms_code; use the RPCs
GRANT SELECT ON
  safety_settings, safety_member_prefs, safety_consent_log, safety_hazard_facts, safety_policy_rules,
  safety_job_assessments, safety_decline_requests, safety_events, safety_locations,
  safety_incidents, safety_incident_events, safety_fairness_audits
TO authenticated;

-- =============================================================
-- 8) Internal helpers (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._safety_normalize(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(lower(regexp_replace(normalize(coalesce(p, ''), NFKC), '[^[:alnum:][:space:]]', ' ', 'g')), '\s+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION public._safety_word_hash(p_word text, p_member uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(public._safety_normalize(p_word) || ':' || p_member::text, 'UTF8')), 'hex');
$$;

-- True when any single word of p_text is the member's own duress word.
CREATE OR REPLACE FUNCTION public._safety_has_duress_word(p_member uuid, p_text text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash text;
BEGIN
  SELECT duress_word_hash INTO v_hash FROM safety_member_prefs WHERE team_member_id = p_member;
  IF v_hash IS NULL OR p_text IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM regexp_split_to_table(public._safety_normalize(p_text), ' ') AS w
    WHERE w <> '' AND public._safety_word_hash(w, p_member) = v_hash
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._safety_raise_duress(p_session uuid, p_via text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s safety_sessions%ROWTYPE;
BEGIN
  UPDATE safety_sessions
     SET status = 'duress', escalation_anchor_at = now(), last_seen_at = now(), all_clear_pending = false
   WHERE id = p_session AND status IN ('active', 'escalating')
   RETURNING * INTO v_s;
  IF NOT FOUND THEN RETURN; END IF;                       -- already in duress or ended: idempotent
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail)
  VALUES (v_s.user_id, v_s.id, 'duress', 'app', jsonb_build_object('via', p_via));
END;
$$;

REVOKE ALL ON FUNCTION public._safety_normalize(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._safety_word_hash(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._safety_has_duress_word(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._safety_raise_duress(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._safety_normalize(text), public._safety_word_hash(text, uuid),
  public._safety_has_duress_word(uuid, text), public._safety_raise_duress(uuid, text) TO service_role;

-- =============================================================
-- 9) Settings + policy RPCs (managers)
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_get_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_s safety_settings%ROWTYPE;
  v_rules jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage safety settings' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;
  SELECT coalesce(jsonb_object_agg(tier, to_jsonb(precautions)), '{}'::jsonb) INTO v_rules FROM safety_policy_rules WHERE user_id = v_owner;
  RETURN jsonb_build_object('configured', v_s.user_id IS NOT NULL, 'settings', CASE WHEN v_s.user_id IS NULL THEN NULL ELSE to_jsonb(v_s) END, 'policy', v_rules);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_get_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_get_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_save_settings(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_old safety_settings%ROWTYPE;
  v_new safety_settings%ROWTYPE;
  v_chain jsonb;
  v_el jsonb;
  v_prev int := -1;
  v_delay int;
  v_max int;
  v_bump boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage safety settings' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_old FROM safety_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN
    INSERT INTO safety_settings (user_id, updated_by) VALUES (v_owner, auth.uid()) RETURNING * INTO v_old;
  END IF;
  v_new := v_old;

  v_new.enabled                     := coalesce((p ->> 'enabled')::boolean, v_old.enabled);
  v_new.region_profile              := coalesce(p ->> 'region_profile', v_old.region_profile);
  v_new.monitoring_consent_required := coalesce((p ->> 'monitoring_consent_required')::boolean, v_old.monitoring_consent_required);
  v_new.location_sharing_enabled    := coalesce((p ->> 'location_sharing_enabled')::boolean, v_old.location_sharing_enabled);
  v_new.location_visibility         := coalesce(p ->> 'location_visibility', v_old.location_visibility);
  v_new.location_retention_days     := coalesce((p ->> 'location_retention_days')::int, v_old.location_retention_days);
  v_new.checkin_interval_minutes    := coalesce((p ->> 'checkin_interval_minutes')::int, v_old.checkin_interval_minutes);
  v_new.checkin_grace_minutes       := coalesce((p ->> 'checkin_grace_minutes')::int, v_old.checkin_grace_minutes);
  v_new.overrun_prompt_minutes      := coalesce((p ->> 'overrun_prompt_minutes')::int, v_old.overrun_prompt_minutes);
  v_new.unreachable_minutes         := coalesce((p ->> 'unreachable_minutes')::int, v_old.unreachable_minutes);
  v_new.dispatcher_phone            := CASE WHEN p ? 'dispatcher_phone' THEN nullif(btrim(p ->> 'dispatcher_phone'), '') ELSE v_old.dispatcher_phone END;
  v_new.company_next_phone          := CASE WHEN p ? 'company_next_phone' THEN nullif(btrim(p ->> 'company_next_phone'), '') ELSE v_old.company_next_phone END;
  v_new.duress_word_enabled         := coalesce((p ->> 'duress_word_enabled')::boolean, v_old.duress_word_enabled);
  v_new.sms_fallback_enabled        := coalesce((p ->> 'sms_fallback_enabled')::boolean, v_old.sms_fallback_enabled);
  v_new.drills_enabled              := coalesce((p ->> 'drills_enabled')::boolean, v_old.drills_enabled);
  v_new.fact_ttl_days               := coalesce((p ->> 'fact_ttl_days')::int, v_old.fact_ttl_days);
  v_new.show_unreviewed_call_facts  := coalesce((p ->> 'show_unreviewed_call_facts')::boolean, v_old.show_unreviewed_call_facts);
  v_new.auto_notify_customer_on_decline := coalesce((p ->> 'auto_notify_customer_on_decline')::boolean, v_old.auto_notify_customer_on_decline);
  v_new.decline_customer_message    := CASE WHEN p ? 'decline_customer_message' THEN nullif(btrim(p ->> 'decline_customer_message'), '') ELSE v_old.decline_customer_message END;
  v_new.appeal_contact              := CASE WHEN p ? 'appeal_contact' THEN nullif(btrim(p ->> 'appeal_contact'), '') ELSE v_old.appeal_contact END;
  v_new.incident_retention_months   := coalesce((p ->> 'incident_retention_months')::int, v_old.incident_retention_months);
  v_new.timezone                    := coalesce(nullif(btrim(p ->> 'timezone'), ''), v_old.timezone);

  IF v_new.region_profile NOT IN ('standard', 'strict_eu', 'custom') THEN RAISE EXCEPTION 'Unknown region profile' USING ERRCODE = '22023'; END IF;
  v_max := public.safety_region_max_retention(v_new.region_profile);

  -- Labour attestation: only the manager saving it can set it; it is cleared if the region changes.
  IF p ? 'labor_review_ack' THEN
    v_new.labor_review_ack := (p ->> 'labor_review_ack')::boolean;
    IF v_new.labor_review_ack AND NOT v_old.labor_review_ack THEN
      v_new.labor_review_ack_by := auth.uid(); v_new.labor_review_ack_at := now();
    END IF;
  END IF;
  IF v_new.region_profile IS DISTINCT FROM v_old.region_profile AND NOT (p ? 'labor_review_ack') THEN
    v_new.labor_review_ack := false; v_new.labor_review_ack_by := NULL; v_new.labor_review_ack_at := NULL;
  END IF;

  IF v_new.location_retention_days > v_max THEN
    RAISE EXCEPTION 'Location retention for this region profile is limited to % days', v_max USING ERRCODE = '22023';
  END IF;
  IF v_new.location_sharing_enabled THEN
    IF v_new.region_profile IN ('strict_eu', 'custom') AND NOT v_new.labor_review_ack THEN
      RAISE EXCEPTION 'Confirm that the labour / works-council review is complete before enabling location sharing' USING ERRCODE = '22023';
    END IF;
    IF v_new.region_profile = 'strict_eu' AND v_new.location_visibility <> 'on_escalation' THEN
      RAISE EXCEPTION 'This region profile only allows location to be visible once an escalation is running' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_new.region_profile = 'strict_eu' AND NOT v_new.monitoring_consent_required THEN
    RAISE EXCEPTION 'This region profile always requires monitoring consent' USING ERRCODE = '22023';
  END IF;

  -- Escalation chain: 1..5 steps, known kinds, non-decreasing delays.
  IF p ? 'escalation_chain' THEN
    v_chain := p -> 'escalation_chain';
    IF jsonb_typeof(v_chain) <> 'array' OR jsonb_array_length(v_chain) NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'The escalation chain needs between 1 and 5 steps' USING ERRCODE = '22023';
    END IF;
    FOR v_el IN SELECT * FROM jsonb_array_elements(v_chain) LOOP
      IF (v_el ->> 'step') NOT IN ('dispatcher', 'emergency_contact', 'company_next') THEN
        RAISE EXCEPTION 'Unknown escalation step' USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_el -> 'delay_min') <> 'number' THEN RAISE EXCEPTION 'Each step needs a delay in minutes' USING ERRCODE = '22023'; END IF;
      v_delay := (v_el ->> 'delay_min')::numeric::int;
      IF v_delay < 0 OR v_delay > 120 OR v_delay < v_prev OR (v_el ->> 'delay_min')::numeric <> v_delay THEN
        RAISE EXCEPTION 'Step delays must be whole minutes between 0 and 120 and in increasing order' USING ERRCODE = '22023';
      END IF;
      v_prev := v_delay;
    END LOOP;
    v_new.escalation_chain := (SELECT jsonb_agg(jsonb_build_object('step', e ->> 'step', 'delay_min', (e ->> 'delay_min')::int)) FROM jsonb_array_elements(v_chain) e);
  END IF;
  IF v_new.enabled AND v_new.dispatcher_phone IS NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_owner AND phone IS NOT NULL) THEN
    RAISE EXCEPTION 'Set a dispatcher phone number so escalations have someone to reach' USING ERRCODE = '22023';
  END IF;

  -- Material changes to what is collected or who can see it need fresh technician consent.
  IF (v_new.location_sharing_enabled AND NOT v_old.location_sharing_enabled)
     OR v_new.location_retention_days > v_old.location_retention_days
     OR (v_new.location_visibility = 'during_job' AND v_old.location_visibility <> 'during_job')
     OR v_new.region_profile IS DISTINCT FROM v_old.region_profile THEN
    v_bump := true;
  END IF;
  IF v_bump THEN v_new.notice_version := v_old.notice_version + 1; v_new.notice_bumped_at := now(); END IF;

  v_new.updated_by := auth.uid();
  v_new.updated_at := now();

  UPDATE safety_settings SET
    enabled = v_new.enabled, region_profile = v_new.region_profile, labor_review_ack = v_new.labor_review_ack,
    labor_review_ack_by = v_new.labor_review_ack_by, labor_review_ack_at = v_new.labor_review_ack_at,
    monitoring_consent_required = v_new.monitoring_consent_required, notice_version = v_new.notice_version,
    notice_bumped_at = v_new.notice_bumped_at, location_sharing_enabled = v_new.location_sharing_enabled,
    location_visibility = v_new.location_visibility, location_retention_days = v_new.location_retention_days,
    checkin_interval_minutes = v_new.checkin_interval_minutes, checkin_grace_minutes = v_new.checkin_grace_minutes,
    overrun_prompt_minutes = v_new.overrun_prompt_minutes, unreachable_minutes = v_new.unreachable_minutes,
    escalation_chain = v_new.escalation_chain, dispatcher_phone = v_new.dispatcher_phone,
    company_next_phone = v_new.company_next_phone, duress_word_enabled = v_new.duress_word_enabled,
    sms_fallback_enabled = v_new.sms_fallback_enabled, drills_enabled = v_new.drills_enabled,
    fact_ttl_days = v_new.fact_ttl_days, show_unreviewed_call_facts = v_new.show_unreviewed_call_facts,
    auto_notify_customer_on_decline = v_new.auto_notify_customer_on_decline,
    decline_customer_message = v_new.decline_customer_message, appeal_contact = v_new.appeal_contact,
    incident_retention_months = v_new.incident_retention_months, timezone = v_new.timezone,
    updated_by = v_new.updated_by, updated_at = v_new.updated_at
  WHERE user_id = v_owner;

  PERFORM public.log_audit_event(v_owner, 'safety.settings_updated', 'safety_settings', v_owner::text,
    jsonb_build_object('enabled', v_new.enabled, 'region_profile', v_new.region_profile,
                       'location_sharing_enabled', v_new.location_sharing_enabled, 'notice_bumped', v_bump));
  RETURN jsonb_build_object('success', true, 'notice_bumped', v_bump, 'notice_version', v_new.notice_version);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_save_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_save_settings(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_save_policy(p_tier text, p_precautions text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage safety policy' USING ERRCODE = '42501'; END IF;
  IF p_tier NOT IN ('standard', 'elevated', 'high') THEN RAISE EXCEPTION 'Unknown risk tier' USING ERRCODE = '22023'; END IF;
  INSERT INTO safety_policy_rules (user_id, tier, precautions, updated_by)
  VALUES (v_owner, p_tier, coalesce(p_precautions, '{}'), auth.uid())
  ON CONFLICT (user_id, tier) DO UPDATE SET precautions = EXCLUDED.precautions, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.log_audit_event(v_owner, 'safety.policy_updated', 'safety_policy_rules', p_tier, jsonb_build_object('precautions', p_precautions));
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_save_policy(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_save_policy(text, text[]) TO authenticated;

-- =============================================================
-- 10) Technician-facing: transparency, prefs, consent
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_my_transparency()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_owner uuid := public.get_account_owner_id();
  v_s safety_settings%ROWTYPE;
  v_p safety_member_prefs%ROWTYPE;
  v_c safety_consent_log%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;
  IF v_me IS NOT NULL THEN
    SELECT * INTO v_p FROM safety_member_prefs WHERE team_member_id = v_me;
    SELECT * INTO v_c FROM safety_consent_log WHERE team_member_id = v_me ORDER BY created_at DESC, id DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'enabled', coalesce(v_s.enabled, false),
    'is_member', v_me IS NOT NULL,
    'region_profile', coalesce(v_s.region_profile, 'standard'),
    'notice_version', coalesce(v_s.notice_version, 1),
    'monitoring_consent_required', coalesce(v_s.monitoring_consent_required, true),
    'location_sharing_enabled', coalesce(v_s.location_sharing_enabled, false),
    'location_visibility', coalesce(v_s.location_visibility, 'on_escalation'),
    'location_retention_days', coalesce(v_s.location_retention_days, 14),
    'checkin_interval_minutes', coalesce(v_s.checkin_interval_minutes, 30),
    'chain_steps', coalesce((SELECT jsonb_agg(e ->> 'step') FROM jsonb_array_elements(coalesce(v_s.escalation_chain, '[]'::jsonb)) e), '[]'::jsonb),
    'duress_word_enabled', coalesce(v_s.duress_word_enabled, false),
    'sms_fallback_enabled', coalesce(v_s.sms_fallback_enabled, true),
    'consent_action', v_c.action,
    'consent_version', v_c.notice_version,
    'consent_current', v_c.action = 'granted' AND v_c.notice_version >= coalesce(v_s.notice_version, 1),
    'location_opt_in', coalesce(v_p.location_opt_in, false),
    'has_emergency_contact', v_p.emergency_contact_phone IS NOT NULL,
    'emergency_contact_name', v_p.emergency_contact_name,
    'has_duress_word', v_p.duress_word_hash IS NOT NULL,
    'sms_number', (SELECT pn.phone_number FROM phone_numbers pn WHERE pn.account_id = v_owner AND pn.sms_enabled AND pn.status = 'active' ORDER BY pn.is_primary DESC LIMIT 1),
    'stored_location_points', CASE WHEN v_me IS NULL THEN 0 ELSE (SELECT count(*) FROM safety_locations WHERE team_member_id = v_me) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.safety_my_transparency() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_my_transparency() TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_set_my_prefs(
  p_location_opt_in boolean DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_clear_contact boolean DEFAULT false,
  p_duress_word text DEFAULT NULL,
  p_clear_duress boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_owner uuid := public.get_account_owner_id();
  v_phone text := nullif(regexp_replace(coalesce(p_contact_phone, ''), '[\s().-]', '', 'g'), '');
  v_word text := public._safety_normalize(p_duress_word);
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can set safety preferences' USING ERRCODE = '42501'; END IF;
  IF v_phone IS NOT NULL AND NOT public.safety_is_e164(v_phone) THEN
    RAISE EXCEPTION 'Use the international format for the phone number, for example +4915112345678' USING ERRCODE = '22023';
  END IF;
  IF p_duress_word IS NOT NULL AND (v_word = '' OR v_word ~ '\s') THEN
    RAISE EXCEPTION 'The duress word must be a single word' USING ERRCODE = '22023';
  END IF;
  INSERT INTO safety_member_prefs (team_member_id, user_id) VALUES (v_me, v_owner) ON CONFLICT (team_member_id) DO NOTHING;
  UPDATE safety_member_prefs SET
    location_opt_in = coalesce(p_location_opt_in, location_opt_in),
    emergency_contact_name = CASE WHEN p_clear_contact THEN NULL WHEN p_contact_name IS NOT NULL THEN left(btrim(p_contact_name), 80) ELSE emergency_contact_name END,
    emergency_contact_phone = CASE WHEN p_clear_contact THEN NULL WHEN v_phone IS NOT NULL THEN v_phone ELSE emergency_contact_phone END,
    duress_word_hash = CASE WHEN p_clear_duress THEN NULL WHEN p_duress_word IS NOT NULL THEN public._safety_word_hash(v_word, v_me) ELSE duress_word_hash END,
    updated_at = now()
  WHERE team_member_id = v_me;
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_set_my_prefs(boolean, text, text, boolean, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_set_my_prefs(boolean, text, text, boolean, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_set_consent(p_action text, p_source text DEFAULT 'app', p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_owner uuid := public.get_account_owner_id();
  v_s safety_settings%ROWTYPE;
  v_email text;
  v_name text;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can record consent' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('granted', 'revoked') THEN RAISE EXCEPTION 'Unknown consent action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Safety monitoring has not been set up yet' USING ERRCODE = '22023'; END IF;
  SELECT member_email, member_name INTO v_email, v_name FROM team_members WHERE id = v_me;
  INSERT INTO safety_consent_log (user_id, team_member_id, member_email, action, notice_version, source, user_agent)
  VALUES (v_owner, v_me, v_email, p_action, v_s.notice_version, CASE WHEN p_source = 'web' THEN 'web' ELSE 'app' END, left(p_user_agent, 300));
  IF p_action = 'revoked' THEN
    -- Withdrawing consent also stops location sharing and removes stored points.
    UPDATE safety_member_prefs SET location_opt_in = false, updated_at = now() WHERE team_member_id = v_me;
    DELETE FROM safety_locations WHERE team_member_id = v_me;
  END IF;
  RETURN jsonb_build_object('success', true, 'notice_version', v_s.notice_version);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_set_consent(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_set_consent(text, text, text) TO authenticated;

-- =============================================================
-- 11) Fact review (managers). Facts are CREATED by the safety-api / vapi-webhook code paths
--     (they compute the exact-address key in TypeScript, the single place that logic lives).
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_review_fact(
  p_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_legal_review text DEFAULT NULL,
  p_customer_visible boolean DEFAULT NULL,
  p_appeal_contact text DEFAULT NULL,
  p_review_due_on date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_f safety_hazard_facts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to review safety facts' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_f FROM safety_hazard_facts WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fact not found' USING ERRCODE = 'P0002'; END IF;

  IF p_action = 'confirm' THEN
    v_f.review_status := 'confirmed';
  ELSIF p_action = 'reject' THEN
    v_f.review_status := 'rejected'; v_f.customer_visible := false;
  ELSIF p_action = 'dispute' THEN
    v_f.review_status := 'disputed'; v_f.customer_visible := false;
  ELSIF p_action = 'reopen' THEN
    v_f.review_status := 'pending_review'; v_f.customer_visible := false;
  ELSIF p_action = 'update_notice' THEN
    NULL;                                                       -- handled below
  ELSE
    RAISE EXCEPTION 'Unknown review action' USING ERRCODE = '22023';
  END IF;

  IF p_legal_review IS NOT NULL THEN
    IF p_legal_review NOT IN ('not_required', 'needs_review', 'approved', 'blocked') THEN RAISE EXCEPTION 'Unknown legal review state' USING ERRCODE = '22023'; END IF;
    v_f.legal_review := p_legal_review;
    IF p_legal_review IN ('needs_review', 'blocked') THEN v_f.customer_visible := false; END IF;
  END IF;
  IF p_appeal_contact IS NOT NULL THEN v_f.appeal_contact := nullif(btrim(p_appeal_contact), ''); END IF;
  IF p_review_due_on IS NOT NULL THEN v_f.review_due_on := p_review_due_on; END IF;
  IF p_customer_visible IS NOT NULL THEN
    IF p_customer_visible AND NOT (v_f.review_status = 'confirmed' AND v_f.legal_review = 'approved' AND v_f.appeal_contact IS NOT NULL AND v_f.review_due_on IS NOT NULL) THEN
      RAISE EXCEPTION 'A customer-facing note must be confirmed, legally approved, have an appeal contact and a review date' USING ERRCODE = '22023';
    END IF;
    v_f.customer_visible := p_customer_visible;
  END IF;

  UPDATE safety_hazard_facts SET
    review_status = v_f.review_status, reviewed_by = auth.uid(), reviewed_at = now(),
    review_note = CASE WHEN p_note IS NOT NULL THEN left(btrim(p_note), 500) ELSE review_note END,
    legal_review = v_f.legal_review, customer_visible = v_f.customer_visible,
    appeal_contact = v_f.appeal_contact, review_due_on = v_f.review_due_on
  WHERE id = p_id;
  PERFORM public.log_audit_event(v_owner, 'safety.fact_reviewed', 'safety_hazard_facts', p_id::text, jsonb_build_object('action', p_action));
  RETURN jsonb_build_object('success', true, 'review_status', v_f.review_status);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_review_fact(uuid, text, text, text, boolean, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_review_fact(uuid, text, text, text, boolean, text, date) TO authenticated;

-- Service role only: facts read from a finished call. One per (call, category); never overwrites a review.
CREATE OR REPLACE FUNCTION public.safety_upsert_call_facts(
  p_user uuid, p_call uuid, p_site_key text, p_customer uuid, p_occurred date, p_facts jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s safety_settings%ROWTYPE;
  v_f jsonb;
  v_n integer := 0;
BEGIN
  SELECT * INTO v_s FROM safety_settings WHERE user_id = p_user;
  IF NOT FOUND OR NOT v_s.enabled THEN RETURN 0; END IF;
  IF p_site_key IS NULL OR jsonb_typeof(p_facts) <> 'array' THEN RETURN 0; END IF;
  FOR v_f IN SELECT * FROM jsonb_array_elements(p_facts) LOOP
    BEGIN
      INSERT INTO safety_hazard_facts (user_id, site_key, customer_id, call_id, category, fact_text, quote, source, source_ref, occurred_on, expires_on)
      VALUES (p_user, p_site_key, p_customer, p_call, v_f ->> 'category', v_f ->> 'fact_text', left(v_f ->> 'quote', 200),
              'call_volunteered', 'call:' || p_call::text, p_occurred, p_occurred + v_s.fact_ttl_days)
      ON CONFLICT DO NOTHING;
      IF FOUND THEN v_n := v_n + 1; END IF;
    EXCEPTION WHEN check_violation THEN
      NULL;                                          -- lint / constraint refused this one: skip, keep the rest
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.safety_upsert_call_facts(uuid, uuid, text, uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safety_upsert_call_facts(uuid, uuid, text, uuid, date, jsonb) TO service_role;

-- =============================================================
-- 12) Lone-worker sessions
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_start_session(p_job_id uuid, p_expected_minutes integer DEFAULT NULL, p_drill boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_owner uuid := public.get_account_owner_id();
  v_s safety_settings%ROWTYPE;
  v_job jobs%ROWTYPE;
  v_exp integer;
  v_existing safety_sessions%ROWTYPE;
  v_new safety_sessions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can start a safety timer' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND OR NOT public.safety_is_on_job(p_job_id, v_me) THEN RAISE EXCEPTION 'You are not assigned to this job' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;
  IF NOT FOUND OR NOT v_s.enabled THEN RETURN jsonb_build_object('success', false, 'error', 'safety_disabled'); END IF;
  IF p_drill AND NOT v_s.drills_enabled THEN RETURN jsonb_build_object('success', false, 'error', 'drills_disabled'); END IF;
  IF v_s.monitoring_consent_required AND NOT public._safety_consent_ok(v_me) THEN
    RETURN jsonb_build_object('success', false, 'error', 'consent_required');
  END IF;

  SELECT * INTO v_existing FROM safety_sessions WHERE job_id = p_job_id AND team_member_id = v_me AND status <> 'ended';
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'existing', true, 'session_id', v_existing.id, 'status', v_existing.status,
      'next_checkin_due_at', v_existing.next_checkin_due_at, 'expected_end_at', v_existing.expected_end_at, 'is_drill', v_existing.is_drill);
  END IF;

  v_exp := least(720, greatest(15, coalesce(p_expected_minutes, v_job.expected_duration_minutes, 90)));
  INSERT INTO safety_sessions (user_id, job_id, team_member_id, is_drill, expected_end_at, next_checkin_due_at, sms_code)
  VALUES (v_owner, p_job_id, v_me, coalesce(p_drill, false),
          now() + make_interval(mins => v_exp),
          now() + make_interval(mins => v_s.checkin_interval_minutes),
          lpad((floor(random() * 1000000))::int::text, 6, '0'))
  RETURNING * INTO v_new;
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail)
  VALUES (v_owner, v_new.id, 'session_start', 'app', jsonb_build_object('expected_minutes', v_exp, 'drill', v_new.is_drill));
  RETURN jsonb_build_object('success', true, 'existing', false, 'session_id', v_new.id, 'status', v_new.status,
    'next_checkin_due_at', v_new.next_checkin_due_at, 'expected_end_at', v_new.expected_end_at, 'is_drill', v_new.is_drill);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_start_session(uuid, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_start_session(uuid, integer, boolean) TO authenticated;

-- Check-in by tap / voice / typed text. A message containing the technician's duress word looks like a
-- normal check-in to anyone watching the screen but silently raises a duress escalation.
CREATE OR REPLACE FUNCTION public.safety_checkin(p_session uuid, p_method text DEFAULT 'tap', p_text text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_s safety_sessions%ROWTYPE;
  v_cfg safety_settings%ROWTYPE;
  v_was_escalating boolean;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can check in' USING ERRCODE = '42501'; END IF;
  IF p_method NOT IN ('tap', 'voice', 'auto') THEN p_method := 'tap'; END IF;
  SELECT * INTO v_s FROM safety_sessions WHERE id = p_session AND team_member_id = v_me FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002'; END IF;
  IF v_s.status = 'ended' THEN RETURN jsonb_build_object('success', false, 'error', 'session_ended'); END IF;
  SELECT * INTO v_cfg FROM safety_settings WHERE user_id = v_s.user_id;

  IF v_cfg.duress_word_enabled AND public._safety_has_duress_word(v_me, p_text) THEN
    PERFORM public._safety_raise_duress(p_session, 'checkin_word');
    RETURN jsonb_build_object('success', true, 'status', 'active', 'next_checkin_due_at', v_s.next_checkin_due_at);   -- looks normal on purpose
  END IF;

  IF v_s.status = 'duress' THEN
    -- A plain check-in never cancels duress. The office ends it once the technician is confirmed safe.
    UPDATE safety_sessions SET last_seen_at = now() WHERE id = p_session;
    RETURN jsonb_build_object('success', true, 'status', 'active', 'next_checkin_due_at', v_s.next_checkin_due_at);
  END IF;

  v_was_escalating := v_s.status = 'escalating';
  UPDATE safety_sessions SET
    status = 'active', escalation_anchor_at = NULL, last_checkin_at = now(), last_seen_at = now(),
    next_checkin_due_at = least(now() + make_interval(mins => v_cfg.checkin_interval_minutes), expected_end_at + make_interval(mins => v_cfg.checkin_interval_minutes)),
    all_clear_pending = v_was_escalating
  WHERE id = p_session
  RETURNING * INTO v_s;
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail)
  VALUES (v_s.user_id, v_s.id, 'checkin', 'app', jsonb_build_object('method', p_method));
  IF v_was_escalating THEN
    INSERT INTO safety_events (user_id, session_id, kind, channel) VALUES (v_s.user_id, v_s.id, 'escalation_resolved', 'app');
  END IF;
  RETURN jsonb_build_object('success', true, 'status', v_s.status, 'next_checkin_due_at', v_s.next_checkin_due_at);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_checkin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_checkin(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_duress(p_session uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can raise an alert' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM safety_sessions WHERE id = p_session AND team_member_id = v_me AND status <> 'ended') THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._safety_raise_duress(p_session, 'button');
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_duress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_duress(uuid) TO authenticated;

-- Heartbeat from the app (foreground / background fetch). Drives the "phone unreachable" prompt.
CREATE OR REPLACE FUNCTION public.safety_heartbeat(p_session uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE safety_sessions SET last_seen_at = now()
   WHERE id = p_session AND team_member_id = public.get_my_team_member_id() AND status <> 'ended';
END;
$$;
REVOKE ALL ON FUNCTION public.safety_heartbeat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_heartbeat(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_extend(p_session uuid, p_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_s safety_sessions%ROWTYPE;
BEGIN
  IF p_minutes IS NULL OR p_minutes < 15 OR p_minutes > 240 THEN RAISE EXCEPTION 'Extend by 15 to 240 minutes' USING ERRCODE = '22023'; END IF;
  UPDATE safety_sessions SET expected_end_at = expected_end_at + make_interval(mins => p_minutes), last_seen_at = now()
   WHERE id = p_session AND team_member_id = v_me AND status IN ('active', 'escalating')
   RETURNING * INTO v_s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail)
  VALUES (v_s.user_id, v_s.id, 'extended', 'app', jsonb_build_object('minutes', p_minutes));
  RETURN jsonb_build_object('success', true, 'expected_end_at', v_s.expected_end_at);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_extend(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_extend(uuid, integer) TO authenticated;

-- The technician ends their own session; a manager may end any session in the account
-- (for example after confirming a technician is safe following a duress).
CREATE OR REPLACE FUNCTION public.safety_end_session(p_session uuid, p_outcome text DEFAULT 'completed')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_s safety_sessions%ROWTYPE;
  v_was boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_outcome NOT IN ('completed', 'cancelled', 'false_alarm') THEN RAISE EXCEPTION 'Unknown outcome' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_s FROM safety_sessions WHERE id = p_session AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = 'P0002'; END IF;
  IF v_s.team_member_id IS DISTINCT FROM v_me AND NOT public.safety_can_manage() THEN
    RAISE EXCEPTION 'Only the technician or a manager can end this session' USING ERRCODE = '42501';
  END IF;
  IF v_s.status = 'ended' THEN RETURN jsonb_build_object('success', true, 'already_ended', true); END IF;
  v_was := v_s.status IN ('escalating', 'duress');
  UPDATE safety_sessions SET status = 'ended', end_outcome = p_outcome, ended_at = now(), all_clear_pending = v_was WHERE id = p_session;
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail)
  VALUES (v_owner, p_session, 'session_end', 'app', jsonb_build_object('outcome', p_outcome, 'by_manager', v_s.team_member_id IS DISTINCT FROM v_me));
  IF p_outcome = 'false_alarm' THEN
    INSERT INTO safety_events (user_id, session_id, kind, channel) VALUES (v_owner, p_session, 'false_alarm', 'app');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_end_session(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_end_session(uuid, text) TO authenticated;

-- The technician's own live session for a job (never returns the SMS code).
CREATE OR REPLACE FUNCTION public.safety_my_session(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s safety_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_s FROM safety_sessions WHERE job_id = p_job_id AND team_member_id = public.get_my_team_member_id() AND status <> 'ended';
  IF NOT FOUND THEN RETURN jsonb_build_object('active', false); END IF;
  RETURN jsonb_build_object('active', true, 'session_id', v_s.id, 'status', CASE WHEN v_s.status = 'duress' THEN 'active' ELSE v_s.status END,
    'is_drill', v_s.is_drill, 'started_at', v_s.started_at, 'expected_end_at', v_s.expected_end_at,
    'next_checkin_due_at', v_s.next_checkin_due_at, 'last_checkin_at', v_s.last_checkin_at);
  -- 'duress' is reported as 'active' to the device on purpose: the screen must not reveal a silent alert.
END;
$$;
REVOKE ALL ON FUNCTION public.safety_my_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_my_session(uuid) TO authenticated;

-- Live board for managers.
CREATE OR REPLACE FUNCTION public.safety_active_sessions()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to view the safety board' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(x) ORDER BY x.sort_rank, x.started_at) FROM (
      SELECT s.id AS session_id, s.status, s.is_drill, s.started_at, s.expected_end_at, s.next_checkin_due_at, s.last_checkin_at, s.last_seen_at,
             CASE s.status WHEN 'duress' THEN 0 WHEN 'escalating' THEN 1 ELSE 2 END AS sort_rank,
             tm.member_name AS technician_name, j.id AS job_id, j.customer_name, j.address,
             (SELECT jsonb_build_object('lat', l.lat, 'lng', l.lng, 'accuracy_m', l.accuracy_m, 'recorded_at', l.recorded_at)
                FROM safety_locations l WHERE l.session_id = s.id AND public.safety_can_view_location(s.id)
                ORDER BY l.recorded_at DESC LIMIT 1) AS last_location
      FROM safety_sessions s
      JOIN team_members tm ON tm.id = s.team_member_id
      JOIN jobs j ON j.id = s.job_id
      WHERE s.user_id = v_owner AND s.status <> 'ended'
    ) x), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_active_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_active_sessions() TO authenticated;

-- Service role: SMS fallback check-in / help. Matches the sender to a technician with a live session.
CREATE OR REPLACE FUNCTION public.safety_checkin_by_sms(p_user uuid, p_phone text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tm team_members%ROWTYPE;
  v_s safety_sessions%ROWTYPE;
  v_cfg safety_settings%ROWTYPE;
  v_norm text := public._safety_normalize(p_body);
  v_has_code boolean;
  v_was boolean;
BEGIN
  SELECT * INTO v_cfg FROM safety_settings WHERE user_id = p_user;
  IF NOT FOUND OR NOT v_cfg.enabled OR NOT v_cfg.sms_fallback_enabled THEN RETURN jsonb_build_object('handled', false); END IF;

  SELECT tm.* INTO v_tm FROM team_members tm
   WHERE tm.account_owner_id = p_user
     AND regexp_replace(coalesce(tm.member_phone, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
     AND coalesce(tm.member_phone, '') <> ''
   LIMIT 2;
  IF NOT FOUND THEN RETURN jsonb_build_object('handled', false); END IF;
  -- Two technicians sharing one number: refuse rather than guess.
  IF (SELECT count(*) FROM team_members tm WHERE tm.account_owner_id = p_user
        AND regexp_replace(coalesce(tm.member_phone, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) > 1 THEN
    RETURN jsonb_build_object('handled', false);
  END IF;

  SELECT * INTO v_s FROM safety_sessions WHERE team_member_id = v_tm.id AND status <> 'ended' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('handled', false); END IF;

  -- HELP always counts: a false alarm is cheap, a missed one is not.
  IF v_norm ~ '(^| )(help|sos|duress|panic)( |$)' THEN
    PERFORM public._safety_raise_duress(v_s.id, 'sms_help');
    RETURN jsonb_build_object('handled', true, 'result', 'help');
  END IF;

  IF v_s.sms_attempts >= 5 THEN RETURN jsonb_build_object('handled', true, 'result', 'locked'); END IF;
  v_has_code := (' ' || v_norm || ' ') LIKE ('% ' || v_s.sms_code || ' %');
  IF NOT v_has_code THEN
    UPDATE safety_sessions SET sms_attempts = sms_attempts + 1 WHERE id = v_s.id;
    RETURN jsonb_build_object('handled', true, 'result', 'unknown');
  END IF;

  IF v_cfg.duress_word_enabled AND public._safety_has_duress_word(v_tm.id, p_body) THEN
    PERFORM public._safety_raise_duress(v_s.id, 'sms_word');
    RETURN jsonb_build_object('handled', true, 'result', 'ok');         -- reads as a normal OK on purpose
  END IF;

  IF v_norm !~ '(^| )(ok|okay|safe|fine|yes|done)( |$)' THEN RETURN jsonb_build_object('handled', true, 'result', 'unknown'); END IF;
  IF v_s.status = 'duress' THEN
    UPDATE safety_sessions SET last_seen_at = now() WHERE id = v_s.id;
    RETURN jsonb_build_object('handled', true, 'result', 'ok');
  END IF;

  v_was := v_s.status = 'escalating';
  UPDATE safety_sessions SET status = 'active', escalation_anchor_at = NULL, last_checkin_at = now(), last_seen_at = now(),
    next_checkin_due_at = least(now() + make_interval(mins => v_cfg.checkin_interval_minutes), expected_end_at + make_interval(mins => v_cfg.checkin_interval_minutes)),
    all_clear_pending = v_was, sms_attempts = 0
  WHERE id = v_s.id;
  INSERT INTO safety_events (user_id, session_id, kind, channel, detail) VALUES (p_user, v_s.id, 'checkin', 'sms', jsonb_build_object('method', 'sms'));
  IF v_was THEN INSERT INTO safety_events (user_id, session_id, kind, channel) VALUES (p_user, v_s.id, 'escalation_resolved', 'sms'); END IF;
  RETURN jsonb_build_object('handled', true, 'result', 'ok');
END;
$$;
REVOKE ALL ON FUNCTION public.safety_checkin_by_sms(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safety_checkin_by_sms(uuid, text, text) TO service_role;

-- Location: only during a live session, only with monitoring consent + the technician's opt-in + the
-- existing tracking gate (shift / location consent). Anything else is refused and NOT stored.
CREATE OR REPLACE FUNCTION public.safety_record_location(p_session uuid, p_lat double precision, p_lng double precision, p_accuracy real DEFAULT NULL, p_recorded_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_s safety_sessions%ROWTYPE;
  v_cfg safety_settings%ROWTYPE;
  v_opt boolean;
  v_at timestamptz := coalesce(p_recorded_at, now());
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can share location' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_s FROM safety_sessions WHERE id = p_session AND team_member_id = v_me;
  IF NOT FOUND OR v_s.status = 'ended' THEN RETURN jsonb_build_object('stored', false, 'reason', 'no_active_session'); END IF;
  SELECT * INTO v_cfg FROM safety_settings WHERE user_id = v_s.user_id;
  IF NOT FOUND OR NOT v_cfg.enabled OR NOT v_cfg.location_sharing_enabled THEN RETURN jsonb_build_object('stored', false, 'reason', 'feature_off'); END IF;
  IF NOT public._safety_consent_ok(v_me) THEN RETURN jsonb_build_object('stored', false, 'reason', 'no_monitoring_consent'); END IF;
  SELECT location_opt_in INTO v_opt FROM safety_member_prefs WHERE team_member_id = v_me;
  IF NOT coalesce(v_opt, false) THEN RETURN jsonb_build_object('stored', false, 'reason', 'no_member_opt_in'); END IF;
  IF public.location_tracking_gate(v_me, v_at) <> 'allowed' THEN RETURN jsonb_build_object('stored', false, 'reason', 'tracking_gate_refused'); END IF;
  IF v_at < v_s.started_at OR v_at > now() + interval '1 minute' THEN RETURN jsonb_build_object('stored', false, 'reason', 'out_of_window'); END IF;
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN RETURN jsonb_build_object('stored', false, 'reason', 'invalid'); END IF;
  -- Throttle: at most one point per 15 seconds per session.
  IF EXISTS (SELECT 1 FROM safety_locations WHERE session_id = p_session AND recorded_at > v_at - interval '15 seconds' AND recorded_at <= v_at + interval '15 seconds') THEN
    RETURN jsonb_build_object('stored', false, 'reason', 'throttled');
  END IF;
  INSERT INTO safety_locations (user_id, session_id, team_member_id, lat, lng, accuracy_m, recorded_at, expires_at)
  VALUES (v_s.user_id, p_session, v_me, p_lat, p_lng, p_accuracy, v_at, v_at + make_interval(days => v_cfg.location_retention_days));
  UPDATE safety_sessions SET last_seen_at = now() WHERE id = p_session;
  RETURN jsonb_build_object('stored', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_record_location(uuid, double precision, double precision, real, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_record_location(uuid, double precision, double precision, real, timestamptz) TO authenticated;

-- End a session automatically when its job is completed or cancelled.
CREATE OR REPLACE FUNCTION public.safety_end_sessions_on_job_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job_status IN ('completed', 'cancelled') AND OLD.job_status IS DISTINCT FROM NEW.job_status THEN
    UPDATE safety_sessions SET status = 'ended', end_outcome = 'auto_job_closed', ended_at = now(),
           all_clear_pending = status IN ('escalating', 'duress')
     WHERE job_id = NEW.id AND status <> 'ended';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_safety_end_sessions_on_job_close ON jobs;
CREATE TRIGGER trg_safety_end_sessions_on_job_close AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.safety_end_sessions_on_job_close();

-- =============================================================
-- 13) Right to decline (no penalty)
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_request_decline(p_job_id uuid, p_action text, p_reason text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := public.get_my_team_member_id();
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_s safety_settings%ROWTYPE;
  v_id uuid;
  v_name text;
BEGIN
  IF auth.uid() IS NULL OR v_me IS NULL THEN RAISE EXCEPTION 'Only team members can decline a job' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('decline', 'reschedule') OR p_reason NOT IN ('felt_unsafe', 'precaution_not_met', 'hazard_found', 'other') THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND OR NOT public.safety_is_on_job(p_job_id, v_me) THEN RAISE EXCEPTION 'You are not assigned to this job' USING ERRCODE = '42501'; END IF;
  IF v_job.job_status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This job is already closed' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_s FROM safety_settings WHERE user_id = v_owner;

  INSERT INTO safety_decline_requests (user_id, job_id, team_member_id, action, reason_code, note, customer_notice_status)
  VALUES (v_owner, p_job_id, v_me, p_action, p_reason, left(btrim(p_note), 500),
          CASE WHEN coalesce(v_s.auto_notify_customer_on_decline, true) THEN 'pending' ELSE 'skipped' END)
  ON CONFLICT (job_id, team_member_id) WHERE status = 'open' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM safety_decline_requests WHERE job_id = p_job_id AND team_member_id = v_me AND status = 'open';
    RETURN jsonb_build_object('success', true, 'existing', true, 'id', v_id);
  END IF;

  -- Existing field flag, so the dispatch board shows it with no new UI. The job itself is left as it is:
  -- the office decides whether to reschedule or reassign.
  UPDATE jobs SET safety_flag = true, safety_flag_note = left('Technician asked to ' || p_action || ' (' || p_reason || ')', 200) WHERE id = p_job_id;

  SELECT coalesce(member_name, member_email) INTO v_name FROM team_members WHERE id = v_me;
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (v_owner, 'safety_decline', 'Safety: job needs rescheduling',
          coalesce(v_name, 'A technician') || ' asked to ' || p_action || ' the job for ' || v_job.customer_name || '. No penalty applies.',
          '/dashboard/site-safety?tab=declines');
  PERFORM public.log_audit_event(v_owner, 'safety.decline_requested', 'jobs', p_job_id::text, jsonb_build_object('action', p_action, 'reason', p_reason));
  RETURN jsonb_build_object('success', true, 'existing', false, 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_request_decline(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_request_decline(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_resolve_decline(p_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('rescheduled', 'reassigned', 'closed') THEN RAISE EXCEPTION 'Unknown status' USING ERRCODE = '22023'; END IF;
  UPDATE safety_decline_requests SET status = p_status, resolved_by = auth.uid(), resolved_at = now() WHERE id = p_id AND user_id = v_owner AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already resolved' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_resolve_decline(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_resolve_decline(uuid, text) TO authenticated;

-- =============================================================
-- 14) Incident ledger RPCs
-- =============================================================

-- Mirror of wellbeingDueHours() in src/lib/safety/core.ts.
CREATE OR REPLACE FUNCTION public._safety_wellbeing_hours(p_category text, p_severity text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_category = 'hazard' THEN NULL
    WHEN p_category = 'near_miss' THEN CASE WHEN p_severity IN ('high', 'critical') THEN 48 ELSE NULL END
    ELSE CASE WHEN p_severity IN ('high', 'critical') THEN 24 ELSE 72 END
  END;
$$;

CREATE OR REPLACE FUNCTION public.safety_report_incident(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.get_my_team_member_id();
  v_cfg safety_settings%ROWTYPE;
  v_job uuid := nullif(p ->> 'job_id', '')::uuid;
  v_cat text := p ->> 'category';
  v_sev text := p ->> 'severity';
  v_at timestamptz := coalesce(nullif(p ->> 'occurred_at', '')::timestamptz, now());
  v_hours integer;
  v_row safety_incidents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF v_cat NOT IN ('threat', 'injury', 'near_miss', 'hazard') OR v_sev NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION 'Invalid category or severity' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'The incident time cannot be in the future' USING ERRCODE = '22023'; END IF;
  IF v_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_me IS NOT NULL AND v_job IS NOT NULL AND NOT public.safety_can_manage() AND NOT public.safety_is_on_job(v_job, v_me) THEN
    RAISE EXCEPTION 'You can only report incidents for your own jobs' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM safety_settings WHERE user_id = v_owner;
  v_hours := public._safety_wellbeing_hours(v_cat, v_sev);

  INSERT INTO safety_incidents (user_id, reported_by, reporter_member_id, job_id, category, severity, occurred_at, description,
                                wellbeing_due_at, retain_until)
  VALUES (v_owner, auth.uid(), v_me, v_job, v_cat, v_sev, v_at, btrim(p ->> 'description'),
          CASE WHEN v_hours IS NULL THEN NULL ELSE now() + make_interval(hours => v_hours) END,
          (current_date + make_interval(months => coalesce(v_cfg.incident_retention_months, 60)))::date)
  RETURNING * INTO v_row;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, to_status, actor_id) VALUES (v_owner, v_row.id, 'reported', 'reported', auth.uid());
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (v_owner, 'safety_incident', 'Safety incident reported', 'A ' || v_cat || ' incident (' || v_sev || ') was reported.', '/dashboard/site-safety?tab=incidents');
  RETURN jsonb_build_object('success', true, 'id', v_row.id, 'case_number', v_row.case_number, 'wellbeing_due_at', v_row.wellbeing_due_at);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_report_incident(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_report_incident(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_incident_transition(p_id uuid, p_to text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_i safety_incidents%ROWTYPE;
  v_ok boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage incidents' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_i FROM safety_incidents WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002'; END IF;
  -- Mirror of canTransition() in core.ts.
  v_ok := (v_i.status = 'reported' AND p_to IN ('triage', 'closed'))
       OR (v_i.status = 'triage' AND p_to IN ('investigating', 'actions', 'closed'))
       OR (v_i.status = 'investigating' AND p_to IN ('actions', 'closed'))
       OR (v_i.status = 'actions' AND p_to IN ('investigating', 'closed'))
       OR (v_i.status = 'closed' AND p_to = 'investigating');
  IF NOT v_ok THEN RAISE EXCEPTION 'That status change is not allowed from %', v_i.status USING ERRCODE = '22023'; END IF;
  IF p_to = 'closed' AND v_i.wellbeing_due_at IS NOT NULL AND v_i.wellbeing_checked_at IS NULL THEN
    RAISE EXCEPTION 'Complete the wellbeing check before closing this case' USING ERRCODE = '22023';
  END IF;
  UPDATE safety_incidents SET status = p_to, assigned_to = coalesce(assigned_to, auth.uid()),
         closed_at = CASE WHEN p_to = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = p_id;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, from_status, to_status, note, actor_id)
  VALUES (v_owner, p_id, 'status_changed', v_i.status, p_to, left(p_note, 2000), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_incident_transition(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_incident_transition(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_incident_note(p_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Write a note of up to 2000 characters' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM safety_incidents i WHERE i.id = p_id AND i.user_id = v_owner
                 AND (public.safety_can_manage() OR i.reporter_member_id = public.get_my_team_member_id())) THEN
    RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, note, actor_id) VALUES (v_owner, p_id, 'note', btrim(p_note), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_incident_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_incident_note(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_incident_add_attachment(p_id uuid, p_path text, p_name text, p_type text, p_size bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_i safety_incidents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_i FROM safety_incidents WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR NOT (public.safety_can_manage() OR v_i.reporter_member_id = public.get_my_team_member_id()) THEN
    RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_path !~ ('^' || v_owner::text || '/' || p_id::text || '/[A-Za-z0-9._-]{1,120}$') THEN RAISE EXCEPTION 'Invalid attachment path' USING ERRCODE = '22023'; END IF;
  IF p_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/mp4') THEN RAISE EXCEPTION 'File type not allowed' USING ERRCODE = '22023'; END IF;
  IF p_size IS NULL OR p_size <= 0 OR p_size > 26214400 THEN RAISE EXCEPTION 'File is too large' USING ERRCODE = '22023'; END IF;
  IF jsonb_array_length(v_i.attachments) >= 10 THEN RAISE EXCEPTION 'An incident can hold up to 10 attachments' USING ERRCODE = '22023'; END IF;
  UPDATE safety_incidents SET attachments = attachments || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(p_name, 120), 'type', p_type, 'size', p_size)),
         updated_at = now() WHERE id = p_id;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, note, actor_id) VALUES (v_owner, p_id, 'attachment_added', left(p_name, 120), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_incident_add_attachment(uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_incident_add_attachment(uuid, text, text, text, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_incident_wellbeing(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission' USING ERRCODE = '42501'; END IF;
  UPDATE safety_incidents SET wellbeing_checked_at = now(), wellbeing_note = left(btrim(p_note), 1000), updated_at = now()
   WHERE id = p_id AND user_id = v_owner AND wellbeing_checked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found or already checked' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, actor_id) VALUES (v_owner, p_id, 'wellbeing_checked', auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_incident_wellbeing(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_incident_wellbeing(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.safety_incident_set_reportable(p_id uuid, p_flag boolean, p_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission' USING ERRCODE = '42501'; END IF;
  UPDATE safety_incidents SET regulatory_reportable = p_flag, regulator_ref = left(btrim(p_ref), 120), updated_at = now() WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO safety_incident_events (user_id, incident_id, kind, note, actor_id) VALUES (v_owner, p_id, 'reportable_changed', CASE WHEN p_flag THEN 'reportable' ELSE 'not reportable' END, auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_incident_set_reportable(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_incident_set_reportable(uuid, boolean, text) TO authenticated;

-- Monthly trend aggregates for the manager dashboard (counts only, no free text).
CREATE OR REPLACE FUNCTION public.safety_trends(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_from timestamptz := date_trunc('month', now()) - make_interval(months => least(36, greatest(1, coalesce(p_months, 12))) - 1);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'incidents', coalesce((SELECT jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'category', category, 'severity', severity, 'count', n) ORDER BY m)
        FROM (SELECT date_trunc('month', occurred_at) AS m, category, severity, count(*) AS n FROM safety_incidents
              WHERE user_id = v_owner AND occurred_at >= v_from GROUP BY 1, 2, 3) t), '[]'::jsonb),
    'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'total', total, 'escalated', escalated, 'duress', duress, 'false_alarms', fa) ORDER BY m)
        FROM (SELECT date_trunc('month', s.started_at) AS m, count(*) AS total,
                     count(*) FILTER (WHERE EXISTS (SELECT 1 FROM safety_events e WHERE e.session_id = s.id AND e.kind = 'missed_checkin')) AS escalated,
                     count(*) FILTER (WHERE EXISTS (SELECT 1 FROM safety_events e WHERE e.session_id = s.id AND e.kind = 'duress')) AS duress,
                     count(*) FILTER (WHERE s.end_outcome = 'false_alarm') AS fa
              FROM safety_sessions s WHERE s.user_id = v_owner AND s.started_at >= v_from AND NOT s.is_drill GROUP BY 1) t), '[]'::jsonb),
    'declines', coalesce((SELECT jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'count', n) ORDER BY m)
        FROM (SELECT date_trunc('month', created_at) AS m, count(*) AS n FROM safety_decline_requests WHERE user_id = v_owner AND created_at >= v_from GROUP BY 1) t), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.safety_trends(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_trends(integer) TO authenticated;

-- =============================================================
-- 15) Fairness audit review, data for the audit job, purge
-- =============================================================

CREATE OR REPLACE FUNCTION public.safety_review_audit(p_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.safety_can_manage() THEN RAISE EXCEPTION 'You do not have permission' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('reviewed_no_action', 'action_required', 'actioned') THEN RAISE EXCEPTION 'Unknown status' USING ERRCODE = '22023'; END IF;
  IF p_status IN ('action_required', 'reviewed_no_action') AND (p_note IS NULL OR char_length(btrim(p_note)) < 5) THEN
    RAISE EXCEPTION 'Write a short note explaining the decision' USING ERRCODE = '22023';
  END IF;
  UPDATE safety_fairness_audits SET status = p_status, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(btrim(p_note), 1000)
   WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Audit not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.log_audit_event(v_owner, 'safety.fairness_audit_reviewed', 'safety_fairness_audits', p_id::text, jsonb_build_object('status', p_status));
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_review_audit(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safety_review_audit(uuid, text, text) TO authenticated;

-- Service role: inputs for the audit job. Area = first 3 characters of a postal code found in the
-- address, used ONLY to screen for geographic concentration of flags; never shown to technicians.
CREATE OR REPLACE FUNCTION public.safety_audit_inputs(p_user uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object(
              'area', substring(j.address FROM '(?:^|[^0-9])([0-9]{5})(?:[^0-9]|$)')::text,
              'tier', coalesce(a.override_tier, a.tier, 'standard')))
            FROM jobs j LEFT JOIN safety_job_assessments a ON a.job_id = j.id
            WHERE j.user_id = p_user AND j.scheduled_datetime::date BETWEEN p_from AND p_to), '[]'::jsonb),
    'facts', coalesce((SELECT jsonb_agg(jsonb_build_object('source', f.source, 'review_status', f.review_status))
            FROM safety_hazard_facts f WHERE f.user_id = p_user AND f.created_at::date BETWEEN p_from AND p_to), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.safety_audit_inputs(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safety_audit_inputs(uuid, date, date) TO service_role;

-- Service role: retention. Locations past their expiry; closed incidents past retain_until.
CREATE OR REPLACE FUNCTION public.safety_purge_expired()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loc integer;
  v_inc integer;
BEGIN
  DELETE FROM safety_locations WHERE expires_at < now();
  GET DIAGNOSTICS v_loc = ROW_COUNT;
  DELETE FROM safety_incidents WHERE status = 'closed' AND retain_until IS NOT NULL AND retain_until < current_date;
  GET DIAGNOSTICS v_inc = ROW_COUNT;
  RETURN jsonb_build_object('locations_deleted', v_loc, 'incidents_deleted', v_inc);
END;
$$;
REVOKE ALL ON FUNCTION public.safety_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safety_purge_expired() TO service_role;

/*
## Cron (run once in the Supabase SQL editor; needs pg_cron + pg_net)

    select cron.schedule('safety-tick-every-minute', '* * * * *', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/safety-tick',
        headers := jsonb_build_object('Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
        body := '{"mode":"tick"}'::jsonb);
    $$);
    select cron.schedule('safety-fairness-weekly', '0 3 * * 1', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/safety-tick',
        headers := jsonb_build_object('Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
        body := '{"mode":"fairness"}'::jsonb);
    $$);

## ROLLBACK (manual, destructive — only before real data exists; incident records may be legal evidence)
    -- drop trigger trg_safety_end_sessions_on_job_close on jobs;
    -- drop table safety_fairness_audits, safety_incident_events, safety_incidents, safety_locations, safety_events,
    --            safety_sessions, safety_decline_requests, safety_job_assessments, safety_policy_rules,
    --            safety_hazard_facts, safety_consent_log, safety_member_prefs, safety_settings cascade;
    -- then drop the public.safety_* / public._safety_* functions and the storage policies / bucket 'safety-attachments'.
*/
