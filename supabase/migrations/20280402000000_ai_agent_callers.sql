/*
  # AI agent callers (a caller that is itself an AI assistant calling on a customer's behalf)

  Context: consumer AI assistants (e.g. Google's "call local businesses for you", announced at I/O May 2026) place
  price-and-availability calls to home-service businesses. This migration adds the state the voice webhook needs to
  serve them safely. Everything is OFF by default and purely additive; human callers are untouched.

  - agent_caller_settings   per-business controls (enable, approval mode, price-range rule, blocked ZIPs, never-discuss,
                            hold limits, abuse limits, retention). Owner-only writes through an RPC.
  - price_book_items.agent_quotable   which services may be quoted to an AI caller by phone.
  - calls.caller_kind / caller_kind_confidence / agent_platform_claimed   attribution. The platform is only what the
                            caller SAID — it is not verified and is labelled "claimed" everywhere.
  - agent_caller_sessions   one row per call: classification + protocol state (service-role writes only).
  - agent_caller_events     append-only funnel + audit events. Caller identity is a HASH (caller_key), never a number.
  - agent_holds             a reserved capacity slot awaiting human approval (or auto-booked), with an expiry.
  - agent_holds_sweep()     service-role: alerts before expiry, then releases expired holds back to capacity.
  - agent_callers_purge()   service-role: deletes agent events/sessions older than each business's retention_days.

  Holds reserve REAL capacity: they are created through the existing book_capacity_slot() RPC (a 'scheduled' job
  protected by jobs_no_double_booking), so a held window cannot be double-sold. Releasing a hold cancels that job.
*/

-- =============================================================
-- settings
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_caller_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  approval_mode text NOT NULL DEFAULT 'hold_for_approval' CHECK (approval_mode IN ('quote_only', 'hold_for_approval', 'auto_book')),
  max_holds_per_day integer NOT NULL DEFAULT 5 CHECK (max_holds_per_day BETWEEN 0 AND 50),
  hold_minutes integer NOT NULL DEFAULT 60 CHECK (hold_minutes BETWEEN 15 AND 1440),
  flat_price_mode text NOT NULL DEFAULT 'exact' CHECK (flat_price_mode IN ('exact', 'starting_at', 'range')),
  flat_range_percent integer NOT NULL DEFAULT 15 CHECK (flat_range_percent BETWEEN 1 AND 50),
  blocked_zips text[] NOT NULL DEFAULT '{}' CHECK (cardinality(blocked_zips) <= 50),
  never_discuss text[] NOT NULL DEFAULT '{}' CHECK (cardinality(never_discuss) <= 50),
  allow_sms_summary boolean NOT NULL DEFAULT true,
  allow_email_summary boolean NOT NULL DEFAULT true,
  max_quotes_per_caller_per_day integer NOT NULL DEFAULT 6 CHECK (max_quotes_per_caller_per_day BETWEEN 1 AND 50),
  max_distinct_services_per_caller_per_day integer NOT NULL DEFAULT 5 CHECK (max_distinct_services_per_caller_per_day BETWEEN 1 AND 30),
  max_quotes_per_hour_tenant integer NOT NULL DEFAULT 60 CHECK (max_quotes_per_hour_tenant BETWEEN 5 AND 500),
  max_summaries_per_day integer NOT NULL DEFAULT 30 CHECK (max_summaries_per_day BETWEEN 0 AND 200),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_caller_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_caller_settings" ON agent_caller_settings;
CREATE POLICY "select_own_agent_caller_settings" ON agent_caller_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE policy: owner-only writes through update_agent_caller_settings().

CREATE OR REPLACE FUNCTION public.update_agent_caller_settings(p jsonb)
RETURNS agent_caller_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row agent_caller_settings;
  v_cur agent_caller_settings;
  v_zips text[];
  v_topics text[];
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF auth.uid() IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'owner_only'; END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_settings'; END IF;

  INSERT INTO agent_caller_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_cur FROM agent_caller_settings WHERE user_id = v_owner;

  v_zips := CASE WHEN p ? 'blocked_zips' THEN ARRAY(SELECT DISTINCT left(btrim(z), 5) FROM jsonb_array_elements_text(p->'blocked_zips') z WHERE btrim(z) ~ '^[0-9]{5}$') ELSE v_cur.blocked_zips END;
  v_topics := CASE WHEN p ? 'never_discuss' THEN ARRAY(SELECT DISTINCT lower(left(btrim(t), 60)) FROM jsonb_array_elements_text(p->'never_discuss') t WHERE length(btrim(t)) >= 2) ELSE v_cur.never_discuss END;

  UPDATE agent_caller_settings SET
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    approval_mode = coalesce(p->>'approval_mode', approval_mode),
    max_holds_per_day = coalesce((p->>'max_holds_per_day')::integer, max_holds_per_day),
    hold_minutes = coalesce((p->>'hold_minutes')::integer, hold_minutes),
    flat_price_mode = coalesce(p->>'flat_price_mode', flat_price_mode),
    flat_range_percent = coalesce((p->>'flat_range_percent')::integer, flat_range_percent),
    blocked_zips = v_zips,
    never_discuss = v_topics,
    allow_sms_summary = coalesce((p->>'allow_sms_summary')::boolean, allow_sms_summary),
    allow_email_summary = coalesce((p->>'allow_email_summary')::boolean, allow_email_summary),
    max_quotes_per_caller_per_day = coalesce((p->>'max_quotes_per_caller_per_day')::integer, max_quotes_per_caller_per_day),
    max_distinct_services_per_caller_per_day = coalesce((p->>'max_distinct_services_per_caller_per_day')::integer, max_distinct_services_per_caller_per_day),
    max_quotes_per_hour_tenant = coalesce((p->>'max_quotes_per_hour_tenant')::integer, max_quotes_per_hour_tenant),
    max_summaries_per_day = coalesce((p->>'max_summaries_per_day')::integer, max_summaries_per_day),
    retention_days = coalesce((p->>'retention_days')::integer, retention_days),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_agent_caller_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_agent_caller_settings(jsonb) TO authenticated;

-- =============================================================
-- which services may be quoted to an AI caller
-- =============================================================

ALTER TABLE price_book_items ADD COLUMN IF NOT EXISTS agent_quotable boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN price_book_items.agent_quotable IS
  'false => never quoted to a caller identified as an AI agent (human callers are unaffected). Only used when agent_caller_settings.enabled.';

-- =============================================================
-- call attribution
-- =============================================================

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS caller_kind text CHECK (caller_kind IN ('human', 'ai_agent', 'unknown')),
  ADD COLUMN IF NOT EXISTS caller_kind_confidence numeric(4, 3) CHECK (caller_kind_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS agent_platform_claimed text;
CREATE INDEX IF NOT EXISTS idx_calls_agent_kind ON calls (user_id, call_datetime DESC) WHERE caller_kind = 'ai_agent';
COMMENT ON COLUMN calls.agent_platform_claimed IS 'What the caller SAID it was (e.g. google). Unverified: never used to relax a check.';

-- =============================================================
-- sessions / events / holds
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_caller_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  caller_key text NOT NULL,
  kind text CHECK (kind IN ('human', 'ai_agent', 'unknown')),
  confidence numeric(4, 3),
  platform_claimed text,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, vapi_call_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_created ON agent_caller_sessions (user_id, created_at DESC);
ALTER TABLE agent_caller_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_sessions" ON agent_caller_sessions;
CREATE POLICY "select_own_agent_sessions" ON agent_caller_sessions FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS agent_caller_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_caller_sessions(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL,
  caller_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'detected', 'quote_given', 'hold_created', 'hold_confirmed', 'hold_declined', 'hold_expired',
    'summary_sent', 'summary_failed', 'injection_flagged', 'rate_limited', 'emergency_routed', 'refused_topic', 'out_of_area')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_events_user_created ON agent_caller_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_caller ON agent_caller_events (user_id, caller_key, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_call ON agent_caller_events (user_id, vapi_call_id);
ALTER TABLE agent_caller_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_events" ON agent_caller_events;
CREATE POLICY "select_own_agent_events" ON agent_caller_events FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS agent_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'declined', 'expired')),
  mode text NOT NULL CHECK (mode IN ('hold', 'book')),
  service text,
  zip text,
  window_start timestamptz NOT NULL,
  expires_at timestamptz,
  platform_claimed text,
  summary_channel text CHECK (summary_channel IN ('sms', 'email')),
  alerted_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code),
  UNIQUE (user_id, vapi_call_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_holds_status ON agent_holds (user_id, status, expires_at);
ALTER TABLE agent_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_holds" ON agent_holds;
CREATE POLICY "select_own_agent_holds" ON agent_holds FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: only the voice webhook (service role) and the SECURITY DEFINER functions write here.

-- Owner alert the moment a hold needs a decision.
CREATE OR REPLACE FUNCTION public.notify_agent_hold_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'held' THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (NEW.user_id, 'agent_hold', 'AI agent lead: hold needs approval',
            format('A caller AI assistant is holding %s. Ref %s. Approve or release it before %s.',
                   coalesce(NEW.service, 'a time slot'), NEW.code, to_char(NEW.expires_at AT TIME ZONE 'UTC', 'HH24:MI "UTC"')),
            '/dashboard/ai-agent-callers');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trigger_notify_agent_hold_created ON agent_holds;
CREATE TRIGGER trigger_notify_agent_hold_created AFTER INSERT ON agent_holds FOR EACH ROW EXECUTE FUNCTION public.notify_agent_hold_created();

-- =============================================================
-- one round-trip for every counter the voice path needs
-- =============================================================

CREATE OR REPLACE FUNCTION public.agent_caller_counts(p_user uuid, p_caller_key text, p_dest_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'caller_quotes_24h',  count(*) FILTER (WHERE e.event_type = 'quote_given' AND e.caller_key = p_caller_key AND e.created_at > now() - interval '24 hours'),
    'caller_services_24h', count(DISTINCT e.detail->>'service') FILTER (WHERE e.event_type = 'quote_given' AND e.caller_key = p_caller_key AND e.created_at > now() - interval '24 hours'),
    'caller_zips_24h',     count(DISTINCT e.detail->>'zip') FILTER (WHERE e.event_type = 'quote_given' AND e.caller_key = p_caller_key AND e.created_at > now() - interval '24 hours'),
    'tenant_quotes_1h',    count(*) FILTER (WHERE e.event_type = 'quote_given' AND e.created_at > now() - interval '1 hour'),
    'tenant_summaries_24h', count(*) FILTER (WHERE e.event_type IN ('summary_sent', 'summary_failed') AND e.created_at > now() - interval '24 hours'),
    'dest_summaries_24h',  count(*) FILTER (WHERE e.event_type IN ('summary_sent', 'summary_failed') AND p_dest_key IS NOT NULL AND e.detail->>'dest_key' = p_dest_key AND e.created_at > now() - interval '24 hours'),
    'holds_24h', (SELECT count(*) FROM agent_holds h WHERE h.user_id = p_user AND h.created_at > now() - interval '24 hours')
  )
  FROM agent_caller_events e
  WHERE e.user_id = p_user AND e.created_at > now() - interval '24 hours';
$$;
REVOKE ALL ON FUNCTION public.agent_caller_counts(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_caller_counts(uuid, text, text) TO service_role;

-- =============================================================
-- owner decision on a hold
-- =============================================================

CREATE OR REPLACE FUNCTION public.agent_hold_decide(p_hold_id uuid, p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_hold agent_holds;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_hold FROM agent_holds WHERE id = p_hold_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_hold.status <> 'held' THEN RETURN jsonb_build_object('status', 'already_' || v_hold.status); END IF;
  IF v_hold.expires_at IS NOT NULL AND v_hold.expires_at <= now() THEN RETURN jsonb_build_object('status', 'expired'); END IF;

  IF p_approve THEN
    UPDATE agent_holds SET status = 'confirmed', decided_by = auth.uid(), decided_at = now() WHERE id = v_hold.id;
    UPDATE jobs SET dispatch_note = left('AI agent lead ' || v_hold.code || ' — approved. ' || coalesce(dispatch_note, ''), 900) WHERE id = v_hold.job_id;
  ELSE
    UPDATE agent_holds SET status = 'declined', decided_by = auth.uid(), decided_at = now() WHERE id = v_hold.id;
    UPDATE jobs SET job_status = 'cancelled' WHERE id = v_hold.job_id AND job_status = 'scheduled';
  END IF;
  INSERT INTO agent_caller_events (user_id, vapi_call_id, caller_key, event_type, detail)
  VALUES (v_owner, v_hold.vapi_call_id, 'owner', CASE WHEN p_approve THEN 'hold_confirmed' ELSE 'hold_declined' END, jsonb_build_object('code', v_hold.code));
  RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'confirmed' ELSE 'declined' END);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_hold_decide(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_hold_decide(uuid, boolean) TO authenticated;

-- =============================================================
-- sweep: alert before expiry, then release expired holds back to capacity
-- =============================================================

CREATE OR REPLACE FUNCTION public.agent_holds_sweep(p_alert_minutes integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alerted integer := 0;
  v_expired integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT * FROM agent_holds
    WHERE status = 'held' AND alerted_at IS NULL AND expires_at > now() AND expires_at <= now() + make_interval(mins => p_alert_minutes)
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (r.user_id, 'agent_hold_expiring', 'AI agent hold expires soon',
            format('Hold %s for %s expires in under %s minutes. Approve it or it is released.', r.code, coalesce(r.service, 'a time slot'), p_alert_minutes),
            '/dashboard/ai-agent-callers');
    UPDATE agent_holds SET alerted_at = now() WHERE id = r.id;
    v_alerted := v_alerted + 1;
  END LOOP;

  FOR r IN
    SELECT * FROM agent_holds WHERE status = 'held' AND expires_at <= now() FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE agent_holds SET status = 'expired', decided_at = now() WHERE id = r.id;
    UPDATE jobs SET job_status = 'cancelled' WHERE id = r.job_id AND job_status = 'scheduled';
    INSERT INTO agent_caller_events (user_id, vapi_call_id, caller_key, event_type, detail)
    VALUES (r.user_id, r.vapi_call_id, 'system', 'hold_expired', jsonb_build_object('code', r.code));
    v_expired := v_expired + 1;
  END LOOP;
  RETURN jsonb_build_object('alerted', v_alerted, 'expired', v_expired);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_holds_sweep(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_holds_sweep(integer) TO service_role;

-- =============================================================
-- retention
-- =============================================================

CREATE OR REPLACE FUNCTION public.agent_callers_purge()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_events integer;
  v_sessions integer;
BEGIN
  DELETE FROM agent_caller_events e
  USING (SELECT user_id, retention_days FROM agent_caller_settings) s
  WHERE e.user_id = s.user_id AND e.created_at < now() - make_interval(days => s.retention_days);
  GET DIAGNOSTICS v_events = ROW_COUNT;
  DELETE FROM agent_caller_sessions x
  USING (SELECT user_id, retention_days FROM agent_caller_settings) s
  WHERE x.user_id = s.user_id AND x.created_at < now() - make_interval(days => s.retention_days);
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  RETURN jsonb_build_object('events', v_events, 'sessions', v_sessions);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_callers_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_callers_purge() TO service_role;

-- Scheduler (Supabase SQL editor; pg_cron + pg_net enabled). Replace placeholders:
--   select cron.schedule('agent-hold-sweep-every-minute', '* * * * *', $cron$
--     select net.http_post(url := 'https://<project>.supabase.co/functions/v1/agent-caller-sweep',
--                          headers := jsonb_build_object('X-Cron-Secret', '<CRON_SECRET>', 'Content-Type', 'application/json'),
--                          body := '{}'::jsonb) $cron$);
