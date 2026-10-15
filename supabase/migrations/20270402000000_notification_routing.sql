/*
# Notification Routing Rules

Owner decides WHO gets WHICH alert via WHICH channel (push, SMS, email, Slack),
by role / on-call / person, by schedule window and by severity — with
escalation if nobody acknowledges.

## Reuses (no duplicated concepts)
- notifications                — still the single source of alerts (+ severity, acknowledged_*)
- on_call_schedules / escalation_tiers / escalation_events
                               — an unacknowledged alert opens an escalation_events row
                                 (new nullable notification_id) and the EXISTING
                                 escalation-tick walks the tiers; the EXISTING
                                 /ack/:token page + acknowledge_escalation() acknowledge it.
- push_subscriptions           — + subscriber_user_id so a push can target one person.
- send-push-notification       — still the only Web Push sender.

## New
- notification_routing_rules      owner-configured rules
- notification_deliveries         per-recipient/channel audit log + idempotency guard
- notification_routing_settings   Slack webhook (secret, never readable by the client)
                                  + "fall back to push" switch
- RPCs: get/set_notification_routing_settings, acknowledge_notification

## Behaviour
- Account with NO active rule  -> exactly today's behaviour (push to all devices).
- Account with active rules    -> notification-router decides. If no rule matches,
                                  fallback_to_push (default true) keeps today's behaviour.

## Manual setup
None beyond what push_notifications already needs
(app.settings.edge_function_base_url + app.settings.push_dispatch_secret).
Deploy: supabase functions deploy notification-router --no-verify-jwt
Optional secrets already used elsewhere: TWILIO_*, RESEND_API_KEY, SITE_URL.
*/

-- =============================================================
-- Column additions on reused tables
-- =============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS severity text CHECK (severity IN ('info','warning','high','critical')),
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid;

ALTER TABLE escalation_events
  ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ee_notification ON escalation_events(notification_id) WHERE notification_id IS NOT NULL;

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS subscriber_user_id uuid DEFAULT auth.uid();
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_subscriber ON push_subscriptions(user_id, subscriber_user_id);

-- =============================================================
-- notification_routing_rules
-- =============================================================

CREATE TABLE IF NOT EXISTS notification_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  is_active boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),

  -- Which alerts: empty array = every type
  notification_types text[] NOT NULL DEFAULT '{}',
  min_severity text NOT NULL DEFAULT 'high' CHECK (min_severity IN ('info','warning','high','critical')),

  -- Who
  target_type text NOT NULL CHECK (target_type IN ('owner','role','on_call','member')),
  target_role text CHECK (target_role IN ('admin','technician','member')),
  target_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES on_call_schedules(id) ON DELETE SET NULL, -- on-call target + escalation tiers

  -- How
  channels text[] NOT NULL DEFAULT '{push}'
    CHECK (cardinality(channels) BETWEEN 1 AND 4 AND channels <@ ARRAY['push','sms','email','slack']),

  -- When (rule only applies inside this window; NULL window = always)
  active_days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'
    CHECK (cardinality(active_days) BETWEEN 1 AND 7 AND active_days <@ ARRAY[0,1,2,3,4,5,6]),
  window_start time,
  window_end time,
  timezone text NOT NULL DEFAULT 'America/New_York',

  -- Escalation + flood control
  escalate_if_unacked boolean NOT NULL DEFAULT false,
  cooldown_minutes int NOT NULL DEFAULT 0 CHECK (cooldown_minutes BETWEEN 0 AND 1440),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT nrr_window_pair CHECK ((window_start IS NULL) = (window_end IS NULL)),
  CONSTRAINT nrr_target_role CHECK (target_type <> 'role' OR target_role IS NOT NULL),
  CONSTRAINT nrr_target_member CHECK (target_type <> 'member' OR target_member_id IS NOT NULL),
  CONSTRAINT nrr_target_on_call CHECK (target_type <> 'on_call' OR schedule_id IS NOT NULL),
  CONSTRAINT nrr_escalation_schedule CHECK (NOT escalate_if_unacked OR schedule_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_nrr_user_active ON notification_routing_rules(user_id, priority) WHERE is_active;

-- Integrity + tenant isolation the CHECKs cannot express:
-- timezone must be real; schedule / member must belong to the SAME owner.
CREATE OR REPLACE FUNCTION public.validate_notification_routing_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM now() AT TIME ZONE NEW.timezone;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid timezone: %', NEW.timezone USING ERRCODE = '22023';
  END;

  IF NEW.schedule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM on_call_schedules s WHERE s.id = NEW.schedule_id AND s.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Schedule does not belong to this account' USING ERRCODE = '42501';
  END IF;

  IF NEW.target_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_members t WHERE t.id = NEW.target_member_id AND t.account_owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Team member does not belong to this account' USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_validate_notification_routing_rule ON notification_routing_rules;
CREATE TRIGGER trigger_validate_notification_routing_rule
  BEFORE INSERT OR UPDATE ON notification_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.validate_notification_routing_rule();

ALTER TABLE notification_routing_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_notification_routing_rules" ON notification_routing_rules;
CREATE POLICY "select_own_notification_routing_rules" ON notification_routing_rules
  FOR SELECT TO authenticated USING (get_account_owner_id() = user_id);

-- Only the account owner configures routing (same restriction as on_call_schedules).
DROP POLICY IF EXISTS "mutate_own_notification_routing_rules" ON notification_routing_rules;
CREATE POLICY "mutate_own_notification_routing_rules" ON notification_routing_rules
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =============================================================
-- notification_deliveries (audit log + idempotency)
-- =============================================================

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES notification_routing_rules(id) ON DELETE SET NULL,
  notification_type text NOT NULL,
  severity text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push','sms','email','slack')),
  recipient_key text NOT NULL,            -- 'owner' | 'member:<uuid>' | 'channel'
  recipient_label text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error text,
  escalation_event_id uuid REFERENCES escalation_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A retried trigger / double invoke can never double-send.
  UNIQUE (notification_id, channel, recipient_key)
);

CREATE INDEX IF NOT EXISTS idx_nd_user_created ON notification_deliveries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nd_cooldown ON notification_deliveries(rule_id, notification_type, created_at DESC);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_notification_deliveries" ON notification_deliveries;
CREATE POLICY "select_own_notification_deliveries" ON notification_deliveries
  FOR SELECT TO authenticated USING (get_account_owner_id() = user_id);
-- No client INSERT/UPDATE/DELETE: written only by the service-role edge function.

-- =============================================================
-- notification_routing_settings (secret lives here; no client policies)
-- =============================================================

CREATE TABLE IF NOT EXISTS notification_routing_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  slack_webhook_url text,
  fallback_to_push boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_routing_settings ENABLE ROW LEVEL SECURITY; -- intentionally NO policies

CREATE OR REPLACE FUNCTION public.get_notification_routing_settings()
RETURNS TABLE (slack_configured boolean, slack_hint text, fallback_to_push boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(s.slack_webhook_url IS NOT NULL, false),
    CASE WHEN s.slack_webhook_url IS NULL THEN NULL ELSE '…' || right(s.slack_webhook_url, 6) END,
    COALESCE(s.fallback_to_push, true)
  FROM (SELECT public.get_account_owner_id() AS uid) me
  LEFT JOIN notification_routing_settings s ON s.user_id = me.uid;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_routing_settings(
  p_slack_webhook_url text DEFAULT NULL,
  p_clear_slack boolean DEFAULT false,
  p_fallback_to_push boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := auth.uid();
BEGIN
  IF v_owner IS NULL OR v_owner <> public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Only the account owner can change notification routing' USING ERRCODE = '42501';
  END IF;

  IF p_slack_webhook_url IS NOT NULL
     AND p_slack_webhook_url !~ '^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,200}$' THEN
    RAISE EXCEPTION 'Not a valid Slack incoming-webhook URL' USING ERRCODE = '22023';
  END IF;

  INSERT INTO notification_routing_settings (user_id, slack_webhook_url, fallback_to_push)
  VALUES (v_owner, p_slack_webhook_url, COALESCE(p_fallback_to_push, true))
  ON CONFLICT (user_id) DO UPDATE SET
    slack_webhook_url = CASE
      WHEN p_clear_slack THEN NULL
      WHEN p_slack_webhook_url IS NOT NULL THEN p_slack_webhook_url
      ELSE notification_routing_settings.slack_webhook_url END,
    fallback_to_push = COALESCE(p_fallback_to_push, notification_routing_settings.fallback_to_push),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_notification_routing_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_notification_routing_settings(text, boolean, boolean) TO authenticated;

-- Service-role only: map a team member's email -> auth user id (for targeted push).
CREATE OR REPLACE FUNCTION public.get_auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_auth_user_id_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_auth_user_id_by_email(text) TO service_role;

-- =============================================================
-- Acknowledgement (in-app) + extend the existing tap-to-ack link
-- =============================================================

CREATE OR REPLACE FUNCTION public.acknowledge_notification(p_notification_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_member uuid;
  v_found boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;

  SELECT id INTO v_member FROM team_members
  WHERE account_owner_id = v_owner AND lower(member_email) = lower(auth.jwt() ->> 'email')
  LIMIT 1;

  UPDATE notifications
  SET acknowledged_at = COALESCE(acknowledged_at, now()),
      acknowledged_by = COALESCE(acknowledged_by, auth.uid()),
      is_read = true
  WHERE id = p_notification_id AND user_id = v_owner
  RETURNING true INTO v_found;

  IF v_found IS NOT TRUE THEN RETURN false; END IF;

  UPDATE escalation_events
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_member
  WHERE notification_id = p_notification_id AND status = 'active';

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_notification(uuid) TO authenticated;

-- Same contract as before (anon tap-to-ack link), now also stamps the notification.
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
  v_notification uuid;
  v_member uuid;
BEGIN
  SELECT id, current_tier, schedule_id, notification_id
  INTO v_id, v_tier, v_schedule, v_notification
  FROM escalation_events WHERE ack_token = p_token AND status = 'active';

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT COALESCE(team_member_id, public.get_current_on_call(v_schedule)) INTO v_member
  FROM escalation_tiers WHERE schedule_id = v_schedule AND tier_order = v_tier;

  UPDATE escalation_events
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_member
  WHERE id = v_id;

  IF v_notification IS NOT NULL THEN
    UPDATE notifications
    SET acknowledged_at = COALESCE(acknowledged_at, now()), is_read = true
    WHERE id = v_notification;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_escalation(text) TO anon, authenticated;

-- =============================================================
-- Dispatch: route via notification-router when rules exist,
-- otherwise keep today's push-to-everyone behaviour untouched.
-- =============================================================

CREATE OR REPLACE FUNCTION public.dispatch_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
BEGIN
  -- Account has routing rules -> notification-router owns delivery (incl. push fallback).
  IF EXISTS (SELECT 1 FROM notification_routing_rules r WHERE r.user_id = NEW.user_id AND r.is_active) THEN
    RETURN NEW;
  END IF;

  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);

  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/send-push-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object('notification_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_notification_routing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM notification_routing_rules r WHERE r.user_id = NEW.user_id AND r.is_active) THEN
    RETURN NEW;
  END IF;

  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/notification-router',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object('notification_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dispatch_notification_routing ON notifications;
CREATE TRIGGER trigger_dispatch_notification_routing
  AFTER INSERT ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_notification_routing();
