/*
# On-Call Rotation & Escalation

## New Tables
- on_call_schedules        — rotation config (daily/weekly, handoff hour, timezone)
- on_call_schedule_members — ordered members in the rotation (position 0..n-1)
- escalation_tiers         — who to notify next if unacknowledged, and after how long
- escalation_events        — one row per live escalation tied to a `calls` row

## Functions
- get_current_on_call(schedule_id)  — resolves who is on call right now, purely
  from rotation_start_date + handoff_hour + rotation_type + member count/position.
  No cron needed to "advance" the rotation — it's always computed live.
- acknowledge_escalation(token)     — SECURITY DEFINER, same pattern as
  reschedule_job_by_token: lets an anonymous tap-to-acknowledge link work.

## Security
RLS on all 4 tables. Config tables (schedules/members/tiers): any account
member can SELECT (get_account_owner_id()), only the owner can mutate
(auth.uid() = user_id) — same restriction membership_plans already has.
escalation_events: SELECT only for the account; all writes go through
service-role edge functions, so no authenticated INSERT/UPDATE policy exists.
*/

CREATE TABLE IF NOT EXISTS on_call_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Emergency Dispatch',
  rotation_type text NOT NULL DEFAULT 'weekly' CHECK (rotation_type IN ('daily','weekly')),
  timezone text NOT NULL DEFAULT 'America/New_York',
  rotation_start_date date NOT NULL DEFAULT CURRENT_DATE,
  handoff_hour int NOT NULL DEFAULT 8 CHECK (handoff_hour BETWEEN 0 AND 23),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_schedule_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES on_call_schedules(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  position int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, team_member_id),
  UNIQUE (schedule_id, position)
);

CREATE TABLE IF NOT EXISTS escalation_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES on_call_schedules(id) ON DELETE CASCADE,
  tier_order int NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL, -- NULL = "whoever is currently on call"
  delay_minutes int NOT NULL DEFAULT 5 CHECK (delay_minutes >= 1),
  notify_via text NOT NULL DEFAULT 'sms' CHECK (notify_via IN ('sms','call','both')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, tier_order)
);

CREATE TABLE IF NOT EXISTS escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  schedule_id uuid NOT NULL REFERENCES on_call_schedules(id) ON DELETE CASCADE,
  current_tier int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','exhausted','cancelled')),
  acknowledged_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  last_notified_at timestamptz,
  ack_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocsm_schedule ON on_call_schedule_members(schedule_id, position);
CREATE INDEX IF NOT EXISTS idx_et_schedule ON escalation_tiers(schedule_id, tier_order);
CREATE INDEX IF NOT EXISTS idx_ee_active ON escalation_events(status, last_notified_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ee_user ON escalation_events(user_id);

ALTER TABLE on_call_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_call_schedule_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_schedules" ON on_call_schedules FOR SELECT TO authenticated USING (get_account_owner_id() = user_id);
CREATE POLICY "mutate_own_schedules" ON on_call_schedules FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "select_own_schedule_members" ON on_call_schedule_members FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND get_account_owner_id() = s.user_id));
CREATE POLICY "mutate_own_schedule_members" ON on_call_schedule_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND auth.uid() = s.user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND auth.uid() = s.user_id));

CREATE POLICY "select_own_escalation_tiers" ON escalation_tiers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND get_account_owner_id() = s.user_id));
CREATE POLICY "mutate_own_escalation_tiers" ON escalation_tiers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND auth.uid() = s.user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM on_call_schedules s WHERE s.id = schedule_id AND auth.uid() = s.user_id));

CREATE POLICY "select_own_escalation_events" ON escalation_events FOR SELECT TO authenticated USING (get_account_owner_id() = user_id);

-- =============================================================
-- get_current_on_call: who is on call right now for a schedule
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_current_on_call(p_schedule_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schedule on_call_schedules%ROWTYPE;
  v_member_count int;
  v_period_start timestamptz;
  v_periods_elapsed bigint;
  v_index int;
  v_member_id uuid;
BEGIN
  SELECT * INTO v_schedule FROM on_call_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_member_count FROM on_call_schedule_members WHERE schedule_id = p_schedule_id;
  IF v_member_count = 0 THEN RETURN NULL; END IF;

  v_period_start := (v_schedule.rotation_start_date::timestamp + make_interval(hours => v_schedule.handoff_hour))
                     AT TIME ZONE v_schedule.timezone;

  IF v_schedule.rotation_type = 'daily' THEN
    v_periods_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_period_start)) / 86400))::bigint;
  ELSE
    v_periods_elapsed := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_period_start)) / (86400 * 7)))::bigint;
  END IF;

  v_index := (v_periods_elapsed % v_member_count)::int;

  SELECT team_member_id INTO v_member_id
  FROM on_call_schedule_members
  WHERE schedule_id = p_schedule_id AND position = v_index;

  RETURN v_member_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_current_on_call(uuid) TO authenticated, service_role;

-- =============================================================
-- acknowledge_escalation: tap-to-acknowledge link target (public)
-- =============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_escalation(p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_tier int;
  v_schedule uuid;
  v_member uuid;
BEGIN
  SELECT id, current_tier, schedule_id INTO v_id, v_tier, v_schedule
  FROM escalation_events WHERE ack_token = p_token AND status = 'active';

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT COALESCE(team_member_id, public.get_current_on_call(v_schedule)) INTO v_member
  FROM escalation_tiers WHERE schedule_id = v_schedule AND tier_order = v_tier;

  UPDATE escalation_events
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_member
  WHERE id = v_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_escalation(text) TO anon, authenticated;

/*
## Cron (run once in the Supabase SQL editor, after enabling the
## pg_cron and pg_net extensions in Database > Extensions):

    select cron.schedule(
      'escalation-tick-every-2-min',
      '*/2 * * * *',
      $$
      select net.http_post(
        url := '<your-project-ref>.supabase.co/functions/v1/escalation-tick',
        headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'X-Cron-Secret', '<same value as CRON_SECRET secret>')
      );
      $$
    );

Until pg_cron is enabled, trigger it via any external scheduler (GitHub
Actions cron workflow, Supabase Scheduled Functions UI, etc.) hitting the
function URL every 1-2 minutes — same pattern already used for
check-warranty-alerts and outbound-dialer in this codebase.
*/
