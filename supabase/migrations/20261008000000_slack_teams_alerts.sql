/*
  # Slack & Microsoft Teams alerts

  Per-account chat connections (OAuth), event -> channel mapping, and a short
  delivery log. Everything is scoped to the ACCOUNT OWNER's id (user_id), the
  same way integrations / notifications are, so team members see and act on
  their owner's setup.

  ## Tables
  - chat_connections         one row per (account, provider). No secrets here.
  - chat_connection_secrets  OAuth tokens. RLS on, NO policies, privileges
                             revoked: only edge functions (service role) can
                             ever read or write it. Tokens never reach a browser.
  - chat_alert_rules         one row per (account, provider, event_type).
  - chat_alert_deliveries    recent sent/failed alerts, shown in the UI.

  ## Writes
  Clients can only SELECT. All writes go through the chat-integrations edge
  function, which checks owner / can_manage_team before using the service role.

  ## Dispatch
  AFTER triggers call dispatch_chat_alerts(), which POSTs to the
  chat-alerts-dispatch edge function through pg_net — the same mechanism and
  the same two app.settings the developer event bus already uses. It only
  fires when an enabled rule exists, and it can never block or fail the
  original INSERT/UPDATE.
*/

CREATE TABLE IF NOT EXISTS chat_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  external_workspace_id text NOT NULL,
  workspace_name text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_by_name text,
  last_error text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS chat_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES chat_connections(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('emergency', 'new_job', 'missed_call', 'low_csat')),
  enabled boolean NOT NULL DEFAULT false,
  channel_id text,
  channel_name text,
  container_id text,
  container_name text,
  threshold smallint CHECK (threshold BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, event_type),
  CHECK (NOT enabled OR channel_id IS NOT NULL),
  FOREIGN KEY (user_id, provider) REFERENCES chat_connections(user_id, provider) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  channel_name text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_alert_rules_lookup ON chat_alert_rules(user_id, event_type) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_chat_alert_deliveries_user ON chat_alert_deliveries(user_id, created_at DESC);

ALTER TABLE chat_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_alert_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON chat_connection_secrets FROM anon, authenticated;

DROP POLICY IF EXISTS "select_own_chat_connections" ON chat_connections;
CREATE POLICY "select_own_chat_connections"
  ON chat_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_chat_alert_rules" ON chat_alert_rules;
CREATE POLICY "select_own_chat_alert_rules"
  ON chat_alert_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_chat_alert_deliveries" ON chat_alert_deliveries;
CREATE POLICY "select_own_chat_alert_deliveries"
  ON chat_alert_deliveries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- ---------------------------------------------------------------------
-- Dispatch trigger function
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_chat_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
  v_event text;
  v_owner uuid;
BEGIN
  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF COALESCE(v_base_url, '') = '' OR COALESCE(v_secret, '') = '' THEN
    RETURN NEW;
  END IF;

  v_event := TG_ARGV[0];

  IF TG_TABLE_NAME = 'call_feedback' THEN
    -- call_feedback.user_id is whoever submitted it; the CALL's owner is the account.
    SELECT user_id INTO v_owner FROM calls WHERE id = NEW.call_id;
  ELSE
    v_owner := NEW.user_id;
  END IF;
  IF v_owner IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM chat_alert_rules r
    WHERE r.user_id = v_owner AND r.event_type = v_event AND r.enabled
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/chat-alerts-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object(
      'owner_id', v_owner,
      'event_type', v_event,
      'record', to_jsonb(NEW)
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- An alerting problem must never block a call, job or feedback write.
  RETURN NEW;
END;
$$;

-- emergency: on insert, or when a call is later flagged
DROP TRIGGER IF EXISTS trigger_chat_alert_emergency_insert ON calls;
CREATE TRIGGER trigger_chat_alert_emergency_insert
  AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.is_emergency)
  EXECUTE FUNCTION public.dispatch_chat_alerts('emergency');

DROP TRIGGER IF EXISTS trigger_chat_alert_emergency_update ON calls;
CREATE TRIGGER trigger_chat_alert_emergency_update
  AFTER UPDATE ON calls
  FOR EACH ROW WHEN (NEW.is_emergency AND NOT OLD.is_emergency)
  EXECUTE FUNCTION public.dispatch_chat_alerts('emergency');

-- missed call: on insert, or when a call transitions to 'missed'
DROP TRIGGER IF EXISTS trigger_chat_alert_missed_insert ON calls;
CREATE TRIGGER trigger_chat_alert_missed_insert
  AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.status = 'missed')
  EXECUTE FUNCTION public.dispatch_chat_alerts('missed_call');

DROP TRIGGER IF EXISTS trigger_chat_alert_missed_update ON calls;
CREATE TRIGGER trigger_chat_alert_missed_update
  AFTER UPDATE ON calls
  FOR EACH ROW WHEN (NEW.status = 'missed' AND OLD.status IS DISTINCT FROM 'missed')
  EXECUTE FUNCTION public.dispatch_chat_alerts('missed_call');

-- new job
DROP TRIGGER IF EXISTS trigger_chat_alert_new_job ON jobs;
CREATE TRIGGER trigger_chat_alert_new_job
  AFTER INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_chat_alerts('new_job');

-- low CSAT: every rating is forwarded; the per-rule threshold is applied in the function
DROP TRIGGER IF EXISTS trigger_chat_alert_csat_insert ON call_feedback;
CREATE TRIGGER trigger_chat_alert_csat_insert
  AFTER INSERT ON call_feedback
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_chat_alerts('low_csat');

DROP TRIGGER IF EXISTS trigger_chat_alert_csat_update ON call_feedback;
CREATE TRIGGER trigger_chat_alert_csat_update
  AFTER UPDATE OF rating ON call_feedback
  FOR EACH ROW WHEN (NEW.rating IS DISTINCT FROM OLD.rating)
  EXECUTE FUNCTION public.dispatch_chat_alerts('low_csat');
