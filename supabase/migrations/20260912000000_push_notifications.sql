/*
# Real Web Push Notifications

## What this migration does
Wires the existing `notifications` table (see
20260831090000_notifications_and_audit_log.sql) up to real browser push
notifications — delivered even when the dashboard tab is closed, via the
PWA's service worker. No native app required.

## New Tables

### push_subscriptions
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT get_account_owner_id())
- `endpoint` (text, NOT NULL, UNIQUE)
- `p256dh` (text, NOT NULL)
- `auth_key` (text, NOT NULL)
- `user_agent` (text, nullable)
- `created_at` (timestamptz, default now)

## New notification triggers
1. `leads` INSERT -> 'new_lead' notification (gated by profiles.notify_new_lead)
2. `calls` row lands in `status = 'missed'` -> 'missed_call' notification
   (gated by profiles.notify_missed_call)

## Push dispatch
One generic trigger fires on every INSERT into `notifications` and calls
the `send-push-notification` edge function via `pg_net` — covers every
existing notification type, not just the two new ones.

## Required manual setup (do NOT put real secrets in a committed migration)
  ALTER DATABASE postgres SET app.settings.edge_function_base_url =
    'https://<your-project-ref>.supabase.co/functions/v1';
  ALTER DATABASE postgres SET app.settings.push_dispatch_secret =
    '<a long random string you generate, e.g. openssl rand -hex 32>';

Then set the edge function's secrets (see send-push-notification/index.ts)
and deploy it:
  supabase functions deploy send-push-notification --no-verify-jwt

Until both are done, dispatch_push_notification() below simply no-ops.
*/

-- =============================================================
-- EXTENSION: pg_net
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- =============================================================
-- PROFILE NOTIFICATION PREFERENCES
-- =============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_new_lead boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_missed_call boolean NOT NULL DEFAULT true;

-- =============================================================
-- PUSH_SUBSCRIPTIONS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_push_subscriptions" ON push_subscriptions;
CREATE POLICY "select_own_push_subscriptions"
ON push_subscriptions FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_push_subscriptions" ON push_subscriptions;
CREATE POLICY "insert_own_push_subscriptions"
ON push_subscriptions FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_push_subscriptions" ON push_subscriptions;
CREATE POLICY "delete_own_push_subscriptions"
ON push_subscriptions FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- TRIGGER: new lead -> notification
-- =============================================================

CREATE OR REPLACE FUNCTION public.notify_on_new_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
BEGIN
  SELECT notify_new_lead INTO v_notify FROM profiles WHERE id = NEW.user_id;
  IF COALESCE(v_notify, true) THEN
    INSERT INTO public.notifications (user_id, type, title, message, action_url)
    VALUES (
      NEW.user_id,
      'new_lead',
      'New lead: ' || NEW.name,
      COALESCE(NEW.service_interested, 'A new lead') || ' just came in from ' || NEW.name || '.',
      '/dashboard/leads'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_new_lead ON leads;
CREATE TRIGGER trigger_notify_new_lead
  AFTER INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_new_lead();

-- =============================================================
-- TRIGGER: missed call -> notification
-- =============================================================

CREATE OR REPLACE FUNCTION public.notify_on_missed_call()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
  v_should_notify boolean := false;
BEGIN
  IF NEW.status = 'missed' THEN
    IF TG_OP = 'INSERT' THEN
      v_should_notify := true;
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'missed' THEN
      v_should_notify := true;
    END IF;
  END IF;

  IF v_should_notify THEN
    SELECT notify_missed_call INTO v_notify FROM profiles WHERE id = NEW.user_id;
    IF COALESCE(v_notify, true) THEN
      INSERT INTO public.notifications (user_id, type, title, message, action_url)
      VALUES (
        NEW.user_id,
        'missed_call',
        'Missed call',
        COALESCE(NEW.caller_name, 'A caller') ||
          CASE WHEN NEW.caller_phone IS NOT NULL THEN ' (' || NEW.caller_phone || ')' ELSE '' END ||
          ' was not answered.',
        '/dashboard/calls'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_missed_call_insert ON calls;
CREATE TRIGGER trigger_notify_missed_call_insert
  AFTER INSERT ON calls
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_missed_call();

DROP TRIGGER IF EXISTS trigger_notify_missed_call_update ON calls;
CREATE TRIGGER trigger_notify_missed_call_update
  AFTER UPDATE ON calls
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_missed_call();

-- =============================================================
-- TRIGGER: notifications INSERT -> dispatch real push (via pg_net)
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

DROP TRIGGER IF EXISTS trigger_dispatch_push_notification ON notifications;
CREATE TRIGGER trigger_dispatch_push_notification
  AFTER INSERT ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_push_notification();
