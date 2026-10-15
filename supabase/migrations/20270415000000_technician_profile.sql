/*
  # Technician self-service profile (/tech/profile)

  technician_credentials is already readable by the technician (account-scoped
  RLS), so credentials need no change. Two things were missing for a
  self-service profile:

  1. team_members UPDATE is owner-only, so a technician could never change their
     own availability. set_my_technician_availability() is a SECURITY DEFINER
     RPC that updates ONLY dispatch_enabled + max_jobs_per_day on the caller's
     own row (resolved server-side via get_my_team_member_id()).
  2. Notification preferences were account-level (profiles.notify_*), so there
     was nowhere for a technician's own settings. technician_preferences stores
     them per technician; writes go through save_my_technician_preferences(),
     which resolves technician + owner server-side (never trusts client ids).

  Additive only: no existing table, policy, trigger or function is changed.
*/

CREATE TABLE IF NOT EXISTS technician_preferences (
  technician_id uuid PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  notify_credential_expiry boolean NOT NULL DEFAULT true,
  credential_alert_days integer NOT NULL DEFAULT 30 CHECK (credential_alert_days IN (14, 30, 60, 90)),
  notify_job_assigned boolean NOT NULL DEFAULT true,
  notify_schedule_change boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_technician_preferences_user ON technician_preferences(user_id);

ALTER TABLE technician_preferences ENABLE ROW LEVEL SECURITY;

-- Read-only via RLS: the technician sees their own row, the account owner sees their team's.
DROP POLICY IF EXISTS "select_technician_preferences" ON technician_preferences;
CREATE POLICY "select_technician_preferences" ON technician_preferences FOR SELECT TO authenticated
  USING (technician_id = public.get_my_team_member_id() OR user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_my_technician_availability(
  p_dispatch_enabled boolean,
  p_max_jobs_per_day integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.get_my_team_member_id();
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_a_team_member' USING ERRCODE = '42501';
  END IF;
  IF p_dispatch_enabled IS NULL OR p_max_jobs_per_day IS NULL OR p_max_jobs_per_day < 1 OR p_max_jobs_per_day > 30 THEN
    RAISE EXCEPTION 'invalid_availability' USING ERRCODE = '22023';
  END IF;

  UPDATE team_members
     SET dispatch_enabled = p_dispatch_enabled,
         max_jobs_per_day = p_max_jobs_per_day
   WHERE id = v_id;

  RETURN jsonb_build_object('dispatch_enabled', p_dispatch_enabled, 'max_jobs_per_day', p_max_jobs_per_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_my_technician_preferences(
  p_notify_credential_expiry boolean,
  p_credential_alert_days integer,
  p_notify_job_assigned boolean,
  p_notify_schedule_change boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.get_my_team_member_id();
  v_owner uuid;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_a_team_member' USING ERRCODE = '42501';
  END IF;
  IF p_credential_alert_days NOT IN (14, 30, 60, 90)
     OR p_notify_credential_expiry IS NULL OR p_notify_job_assigned IS NULL OR p_notify_schedule_change IS NULL THEN
    RAISE EXCEPTION 'invalid_preferences' USING ERRCODE = '22023';
  END IF;

  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = v_id;

  INSERT INTO technician_preferences AS tp (
    technician_id, user_id, notify_credential_expiry, credential_alert_days,
    notify_job_assigned, notify_schedule_change, updated_at
  ) VALUES (
    v_id, v_owner, p_notify_credential_expiry, p_credential_alert_days,
    p_notify_job_assigned, p_notify_schedule_change, now()
  )
  ON CONFLICT (technician_id) DO UPDATE SET
    notify_credential_expiry = EXCLUDED.notify_credential_expiry,
    credential_alert_days = EXCLUDED.credential_alert_days,
    notify_job_assigned = EXCLUDED.notify_job_assigned,
    notify_schedule_change = EXCLUDED.notify_schedule_change,
    updated_at = now();

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_technician_availability(boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_my_technician_preferences(boolean, integer, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_technician_availability(boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_my_technician_preferences(boolean, integer, boolean, boolean) TO authenticated;
