/*
  # Quiet hours + timezone-aware sending

  Every outbound SMS / email / call / campaign step is checked against:
    - the business's quiet window + holiday blackouts (business_profile.quiet_hours)
    - the CUSTOMER's local time (customers.timezone, else detected from address / phone)
    - a hard 08:00-21:00 recipient-local floor for SMS + calls (code: quietHoursCore.ts)
  Messages that fall inside a quiet period are queued (deferred_messages) and released by the
  deferred-message-dispatcher edge function. Emergencies may override; every decision that
  matters is written to messaging_gate_events.

  Adds:
    1. business_profile.timezone, business_profile.quiet_hours (jsonb, validated in code)
    2. customers.timezone / timezone_source (optional explicit override)
    3. deferred_messages   queue of held messages
    4. messaging_gate_events   audit of deferrals + overrides
    5. claim_due_deferred_messages(), release_deferred_message(), cancel_deferred_message()
    6. pg_cron schedule (only if pg_cron exists)

  Idempotent. Rename the timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 1. SETTINGS COLUMNS
-- =============================================================

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS quiet_hours jsonb;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS timezone_source text;

CREATE OR REPLACE FUNCTION public.validate_timezone_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_business_profile_timezone ON business_profile;
CREATE TRIGGER trg_business_profile_timezone BEFORE INSERT OR UPDATE OF timezone ON business_profile
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone_columns();

DROP TRIGGER IF EXISTS trg_customers_timezone ON customers;
CREATE TRIGGER trg_customers_timezone BEFORE INSERT OR UPDATE OF timezone ON customers
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone_columns();

-- =============================================================
-- 2. DEFERRED MESSAGE QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS deferred_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'call')),
  -- a2p = sendCompliantSms (Twilio messaging service + A2P/opt-out gates); plain = notify/deliver.ts senders
  transport text NOT NULL DEFAULT 'plain' CHECK (transport IN ('a2p', 'plain')),
  purpose text NOT NULL DEFAULT 'service' CHECK (purpose IN ('marketing', 'service', 'emergency')),
  to_address text NOT NULL,
  subject text,
  body_text text NOT NULL,
  body_html text,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  source text,
  dedupe_key text,
  send_after timestamptz NOT NULL,
  timezone text,
  tz_source text,
  defer_reason text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  provider_ref text,
  override_reason text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_messages_dedupe
  ON deferred_messages(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'sending');
CREATE INDEX IF NOT EXISTS idx_deferred_messages_due ON deferred_messages(send_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_deferred_messages_user ON deferred_messages(user_id, created_at DESC);

ALTER TABLE deferred_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_deferred_messages" ON deferred_messages;
CREATE POLICY "select_own_deferred_messages" ON deferred_messages
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: writes happen only via service role (edge functions) or the RPCs below.

-- =============================================================
-- 3. AUDIT LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS messaging_gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL,
  purpose text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('deferred', 'emergency_override', 'manual_override')),
  reason text,
  timezone text,
  tz_source text,
  send_at timestamptz,
  override_reason text,
  deferred_message_id uuid REFERENCES deferred_messages(id) ON DELETE SET NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messaging_gate_events_user ON messaging_gate_events(user_id, created_at DESC);

ALTER TABLE messaging_gate_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_messaging_gate_events" ON messaging_gate_events;
CREATE POLICY "select_own_messaging_gate_events" ON messaging_gate_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. RPCs
-- =============================================================

-- Atomically claim due rows for the dispatcher (service role only).
CREATE OR REPLACE FUNCTION public.claim_due_deferred_messages(p_limit integer DEFAULT 50)
RETURNS SETOF deferred_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH picked AS (
    SELECT id FROM deferred_messages
    WHERE status = 'queued' AND send_after <= now() AND attempts < 5
    ORDER BY send_after
    LIMIT greatest(1, least(p_limit, 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE deferred_messages d
     SET status = 'sending', attempts = d.attempts + 1, claimed_at = now()
    FROM picked
   WHERE d.id = picked.id
  RETURNING d.*;
$$;
REVOKE ALL ON FUNCTION public.claim_due_deferred_messages(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_deferred_messages(integer) TO service_role;

-- Owner action: send a held (non-marketing) message now. The dispatcher re-validates and
-- records the override; marketing messages can never be released early.
CREATE OR REPLACE FUNCTION public.release_deferred_message(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'An override reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE deferred_messages
     SET send_after = now(), override_reason = left(btrim(p_reason), 300)
   WHERE id = p_id AND user_id = v_owner AND status = 'queued' AND purpose <> 'marketing';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.release_deferred_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_deferred_message(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_deferred_message(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  UPDATE deferred_messages SET status = 'cancelled'
   WHERE id = p_id AND user_id = v_owner AND status = 'queued';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.cancel_deferred_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_deferred_message(uuid) TO authenticated;

-- Recover rows stuck in 'sending' (function crashed mid-send).
CREATE OR REPLACE FUNCTION public.requeue_stuck_deferred_messages()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    UPDATE deferred_messages SET status = 'queued'
     WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes' AND attempts < 5
    RETURNING 1
  ) SELECT count(*)::integer FROM r;
$$;
REVOKE ALL ON FUNCTION public.requeue_stuck_deferred_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_stuck_deferred_messages() TO service_role;

-- =============================================================
-- 5. SCHEDULE (only when pg_cron exists; otherwise call the edge function every 5 min yourself)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-requeue-stuck-deferred', '*/10 * * * *', $cmd$SELECT public.requeue_stuck_deferred_messages();$cmd$);
  END IF;
END $$;
