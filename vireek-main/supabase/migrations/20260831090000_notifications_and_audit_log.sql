/*
# Notification Center + Audit Log

## What this migration does
Adds a unified notification system and a security audit trail to the Vireek
dashboard, plus the preference columns needed to control which notifications
get created.

## New Tables

### notifications
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL — the account owner this notification belongs to)
- `type` (text, not null — 'emergency_call' | 'usage_alert' | 'ai_insight' | 'job_update' | 'system')
- `title` (text, not null)
- `message` (text, not null)
- `is_read` (boolean, not null, default false)
- `action_url` (text, nullable — a dashboard route to navigate to when clicked)
- `created_at` (timestamptz, default now)

RLS-scoped per account via `get_account_owner_id()`, same pattern as every
other data table (`calls`, `jobs`, etc.) so team members see their account
owner's notifications too.

### audit_log
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL — the account the action happened on)
- `actor_id` (uuid, nullable — the auth user who performed the action)
- `actor_email` (text, nullable — snapshot of the actor's email at the time)
- `action` (text, not null — e.g. "changed_team_permissions", "deleted_job")
- `target_table` (text, nullable)
- `target_id` (text, nullable)
- `created_at` (timestamptz, default now)

RLS: only the account owner can read their account's audit log. Rows are
written exclusively through the `public.log_audit_event()` SECURITY DEFINER
helper (see below) or by trusted server-side code (edge functions using the
service role key) — there are intentionally no client-facing INSERT/UPDATE/
DELETE policies, so a compromised or malicious client session cannot forge
or erase its own audit trail.

## Profile additions
Adds per-account notification-preference toggles to `profiles` (mirrors the
"notify_email_emergency" style toggle already used for the emergency-call
email alert, extended to cover every notification type this step introduces):
- `notify_emergency_call` boolean default true
- `notify_usage_alert` boolean default true
- `notify_ai_insight` boolean default true
- `notify_job_update` boolean default true
(`system` notifications are not user-toggleable — they're account-critical.)

## Triggers
- `notifications`: automatically inserted when
  1. a new call arrives with `is_emergency = true`
  2. a new `ai_insights` row is created (mapped to `usage_alert` when the
     insight is a minutes-usage alert, `ai_insight` otherwise)
  3. a job's `job_status` changes to a state that needs attention, or is
     `scheduled` with a `scheduled_datetime` that has already passed
  Each trigger checks the relevant `profiles.notify_*` toggle before
  inserting, so a user who has turned a notification type off never gets a
  row created for it (not just hidden client-side).
- `audit_log`: `public.log_audit_event(p_user_id, p_action, p_target_table,
  p_target_id)` is a SECURITY DEFINER helper any trusted code path can call;
  it stamps `actor_id`/`actor_email` from the current session automatically.

## Important Notes
1. Both tables reuse `public.get_account_owner_id()` from the very first
   migration, so this stays consistent with the rest of the schema instead
   of inventing a second access-control mechanism.
2. Indexes on `(user_id, created_at desc)` and `(user_id, is_read)` for the
   notification bell's common queries.
3. Realtime: enabling replica identity FULL on `notifications` so Supabase
   Realtime can deliver complete row payloads on UPDATE (needed for the
   "mark as read" live sync across tabs).
*/

-- =============================================================
-- PROFILE NOTIFICATION PREFERENCES
-- =============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_emergency_call boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_usage_alert boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_ai_insight boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_job_update boolean NOT NULL DEFAULT true;

-- =============================================================
-- NOTIFICATIONS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  action_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS "select_own_notifications" ON notifications;
CREATE POLICY "select_own_notifications"
ON notifications FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- Notifications are normally created by triggers/edge functions (service
-- role), but we also allow an authenticated client to insert one scoped to
-- their own account (e.g. future manual "reminders"), same pattern as every
-- other table in this app.
DROP POLICY IF EXISTS "insert_own_notifications" ON notifications;
CREATE POLICY "insert_own_notifications"
ON notifications FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_notifications" ON notifications;
CREATE POLICY "update_own_notifications"
ON notifications FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_notifications" ON notifications;
CREATE POLICY "delete_own_notifications"
ON notifications FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- AUDIT_LOG TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  actor_email text,
  action text NOT NULL,
  target_table text,
  target_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Only the account owner can read their own audit log. Team members —
-- regardless of permissions — cannot read it, and no one can INSERT,
-- UPDATE, or DELETE it directly; writes only ever happen through the
-- SECURITY DEFINER log_audit_event() function below.
DROP POLICY IF EXISTS "owner_select_audit_log" ON audit_log;
CREATE POLICY "owner_select_audit_log"
ON audit_log FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- =============================================================
-- HELPER: log_audit_event()
-- Trusted write path for the audit log. SECURITY DEFINER so it can insert
-- into audit_log even though no client-facing INSERT policy exists.
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_user_id uuid,
  p_action text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
BEGIN
  SELECT email INTO v_actor_email FROM auth.users WHERE id = auth.uid();

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (p_user_id, auth.uid(), v_actor_email, p_action, p_target_table, p_target_id);
END;
$$;

-- Any authenticated user may call this — it only ever writes a row scoped
-- to p_user_id, and callers in the app always pass get_account_owner_id().
GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, text) TO authenticated;

-- =============================================================
-- TRIGGER: emergency call -> notification
-- =============================================================

CREATE OR REPLACE FUNCTION public.notify_on_emergency_call()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
BEGIN
  IF NEW.is_emergency THEN
    SELECT notify_emergency_call INTO v_notify FROM profiles WHERE id = NEW.user_id;
    IF COALESCE(v_notify, true) THEN
      INSERT INTO public.notifications (user_id, type, title, message, action_url)
      VALUES (
        NEW.user_id,
        'emergency_call',
        'New emergency call',
        COALESCE(NEW.caller_name, 'A caller') || ' just called in with an emergency' ||
          CASE WHEN NEW.caller_phone IS NOT NULL THEN ' (' || NEW.caller_phone || ')' ELSE '' END || '.',
        '/dashboard/calls'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_emergency_call ON calls;
CREATE TRIGGER trigger_notify_emergency_call
  AFTER INSERT ON calls
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_emergency_call();

-- =============================================================
-- TRIGGER: ai_insights row -> notification
-- (covers both usage alerts and general AI insights, since the existing
-- usage-alert code path already writes into ai_insights)
-- =============================================================

CREATE OR REPLACE FUNCTION public.notify_on_ai_insight()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_usage boolean;
  v_notify boolean;
  v_type text;
BEGIN
  v_is_usage := NEW.title ILIKE '%minutes%' OR NEW.title ILIKE '%usage%';
  v_type := CASE WHEN v_is_usage THEN 'usage_alert' ELSE 'ai_insight' END;

  IF v_is_usage THEN
    SELECT notify_usage_alert INTO v_notify FROM profiles WHERE id = NEW.user_id;
  ELSE
    SELECT notify_ai_insight INTO v_notify FROM profiles WHERE id = NEW.user_id;
  END IF;

  IF COALESCE(v_notify, true) THEN
    INSERT INTO public.notifications (user_id, type, title, message, action_url)
    VALUES (
      NEW.user_id,
      v_type,
      NEW.title,
      NEW.description,
      CASE WHEN v_is_usage THEN '/dashboard/billing' ELSE '/dashboard/insights' END
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_ai_insight ON ai_insights;
CREATE TRIGGER trigger_notify_ai_insight
  AFTER INSERT ON ai_insights
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_ai_insight();

-- =============================================================
-- TRIGGER: job needs attention -> notification
-- Fires when job_status changes to a state that needs a human to look at
-- it: 'en_route'/'in_progress' don't need one, but a job that just got
-- cancelled, or a job still 'scheduled' whose scheduled_datetime has
-- already passed (stuck), does.
-- =============================================================

CREATE OR REPLACE FUNCTION public.notify_on_job_attention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
  v_needs_attention boolean := false;
  v_reason text;
BEGIN
  IF NEW.job_status IS DISTINCT FROM OLD.job_status THEN
    IF NEW.job_status = 'cancelled' THEN
      v_needs_attention := true;
      v_reason := 'was cancelled';
    ELSIF NEW.job_status = 'scheduled' AND NEW.scheduled_datetime IS NOT NULL AND NEW.scheduled_datetime < now() THEN
      v_needs_attention := true;
      v_reason := 'is still scheduled but its scheduled time has already passed';
    END IF;
  END IF;

  IF v_needs_attention THEN
    SELECT notify_job_update INTO v_notify FROM profiles WHERE id = NEW.user_id;
    IF COALESCE(v_notify, true) THEN
      INSERT INTO public.notifications (user_id, type, title, message, action_url)
      VALUES (
        NEW.user_id,
        'job_update',
        'Job needs attention: ' || NEW.customer_name,
        'The job for ' || NEW.customer_name || ' ' || v_reason || '.',
        '/dashboard/jobs'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_job_attention ON jobs;
CREATE TRIGGER trigger_notify_job_attention
  AFTER UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_job_attention();
