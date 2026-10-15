/*
  # Microsoft 365 / Outlook calendar sync (technicians + office)

  Tables
  - microsoft_calendar_connections : one office connection per account + one per technician (team_members row).
  - microsoft_calendar_secrets     : OAuth tokens. RLS on, NO policies, grants revoked: service role only.
  - calendar_busy_blocks           : inbound busy/free from Outlook (no titles/attendees are stored, only time + show-as).
  - microsoft_calendar_event_map   : job <-> Outlook event mapping used for idempotent two-way sync. Service role only.

  Integrity rules
  - Clients can only READ connections (managers see all, others see their own) and busy blocks. Every write goes through
    the edge functions (service role).
  - Vireek's own events are never stored as busy blocks (they would double-count the job).

  Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, team_members(user_id), jobs.

  Scheduling (run once, after deploying microsoft-calendar-sync; same pattern as your other cron jobs)
    select cron.schedule('microsoft-calendar-sync', '0-59/5 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/microsoft-calendar-sync',
        headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

CREATE TABLE IF NOT EXISTS microsoft_calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  scope text NOT NULL,
  connection_key text NOT NULL,
  ms_email text,
  ms_calendar_id text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  delta_link text,
  delta_window_end timestamptz,
  last_synced_at timestamptz,
  last_error_code text,
  last_error_message text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  sync_locked_until timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcc_scope_check CHECK (scope IN ('office', 'technician')),
  CONSTRAINT mcc_status_check CHECK (status IN ('connected', 'error', 'disconnected')),
  CONSTRAINT mcc_key_check CHECK (
    (scope = 'office' AND team_member_id IS NULL AND connection_key = 'office')
    OR (scope = 'technician' AND team_member_id IS NOT NULL AND connection_key = team_member_id::text)
  ),
  CONSTRAINT mcc_unique_per_account UNIQUE (account_owner_id, connection_key)
);
CREATE INDEX IF NOT EXISTS idx_mcc_sync_queue ON microsoft_calendar_connections (last_synced_at NULLS FIRST) WHERE status = 'connected';
CREATE INDEX IF NOT EXISTS idx_mcc_user ON microsoft_calendar_connections (user_id);

CREATE TABLE IF NOT EXISTS microsoft_calendar_secrets (
  connection_id uuid PRIMARY KEY REFERENCES microsoft_calendar_connections(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_busy_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES microsoft_calendar_connections(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  ms_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  show_as text NOT NULL DEFAULT 'busy',
  is_all_day boolean NOT NULL DEFAULT false,
  blocking boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cbb_range_check CHECK (ends_at > starts_at),
  CONSTRAINT cbb_unique_event UNIQUE (connection_id, ms_event_id)
);
CREATE INDEX IF NOT EXISTS idx_cbb_owner_range ON calendar_busy_blocks (account_owner_id, starts_at, ends_at) WHERE blocking;
CREATE INDEX IF NOT EXISTS idx_cbb_tech_range ON calendar_busy_blocks (team_member_id, starts_at, ends_at) WHERE blocking;

CREATE TABLE IF NOT EXISTS microsoft_calendar_event_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES microsoft_calendar_connections(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ms_event_id text NOT NULL,
  hash text NOT NULL,
  status text NOT NULL DEFAULT 'synced',
  last_pushed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcem_status_check CHECK (status IN ('synced', 'remote_deleted')),
  CONSTRAINT mcem_unique_job UNIQUE (connection_id, job_id),
  CONSTRAINT mcem_unique_event UNIQUE (connection_id, ms_event_id)
);

CREATE OR REPLACE FUNCTION public.ms_calendar_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_mcc_touch ON microsoft_calendar_connections;
CREATE TRIGGER trg_mcc_touch BEFORE UPDATE ON microsoft_calendar_connections
  FOR EACH ROW EXECUTE FUNCTION public.ms_calendar_touch_updated_at();

-- RLS ----------------------------------------------------------------------------------------
ALTER TABLE microsoft_calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE microsoft_calendar_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_busy_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE microsoft_calendar_event_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mcc_select" ON microsoft_calendar_connections;
CREATE POLICY "mcc_select" ON microsoft_calendar_connections FOR SELECT TO authenticated
USING (account_owner_id = public.get_account_owner_id() AND (public.identity_is_manager() OR user_id = auth.uid()));

DROP POLICY IF EXISTS "cbb_select" ON calendar_busy_blocks;
CREATE POLICY "cbb_select" ON calendar_busy_blocks FOR SELECT TO authenticated
USING (account_owner_id = public.get_account_owner_id());

REVOKE ALL ON microsoft_calendar_secrets FROM anon, authenticated;
REVOKE ALL ON microsoft_calendar_event_map FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON microsoft_calendar_connections FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON calendar_busy_blocks FROM anon, authenticated;
REVOKE ALL ON microsoft_calendar_connections FROM anon;
REVOKE ALL ON calendar_busy_blocks FROM anon;

-- Availability helpers -------------------------------------------------------------------------
-- p_technician_id NULL = office calendar. Only blocks from a technician's own calendar make THAT technician busy.
CREATE OR REPLACE FUNCTION public.calendar_is_busy(p_start timestamptz, p_end timestamptz, p_technician_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_busy_blocks b
    WHERE b.account_owner_id = public.get_account_owner_id()
      AND b.blocking AND b.starts_at < p_end AND b.ends_at > p_start
      AND ((p_technician_id IS NULL AND b.team_member_id IS NULL) OR b.team_member_id = p_technician_id)
  );
$$;

-- Same check for server-side callers (edge functions / AI agent) that have no auth.uid().
CREATE OR REPLACE FUNCTION public.calendar_is_busy_for_owner(p_owner uuid, p_start timestamptz, p_end timestamptz, p_technician_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_busy_blocks b
    WHERE b.account_owner_id = p_owner
      AND b.blocking AND b.starts_at < p_end AND b.ends_at > p_start
      AND ((p_technician_id IS NULL AND b.team_member_id IS NULL) OR b.team_member_id = p_technician_id)
  );
$$;

REVOKE ALL ON FUNCTION public.calendar_is_busy(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendar_is_busy(timestamptz, timestamptz, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.calendar_is_busy_for_owner(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_is_busy_for_owner(uuid, timestamptz, timestamptz, uuid) TO service_role;
