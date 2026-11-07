/*
  # Interop hardening (Agent Network gate v2 + durable outbound webhooks)

  Additive and reversible. Nothing existing is dropped or weakened.

  1. agent_network_usage / agent_network_denials / agent_network_alerts
  2. agent_network_begin_v2(): race-free (per-client advisory lock), batch-aware cost,
     STRICTER windows than v1 (70 s burst, 25 h daily), auto-throttle after scope probing.
     v1 agent_network_begin() is untouched, so the edge function can fall back instantly.
  3. webhook_endpoints: previous-secret rotation columns, https CHECK (NOT VALID: old rows untouched)
  4. webhook_outbox: durable queue (stable delivery_id, attempts, backoff, dead-letter = status 'dead', replay)
  5. dispatch_event_bus(): when `app.settings.webhook_outbox` = 'on' events are queued instead of
     fire-and-forget pg_net; any other value keeps the legacy behaviour byte for byte.

  Rollback:
    ALTER DATABASE postgres RESET app.settings.webhook_outbox;   -- back to legacy dispatch
    unset AGENT_NET_GATE_V2 in the mcp-server env               -- back to v1 gate
*/

-- 1) Gate bookkeeping ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_network_usage (
  client_id uuid NOT NULL REFERENCES agent_network_clients(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('s10', 'h1')),
  bucket timestamptz NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, granularity, bucket)
);
ALTER TABLE agent_network_usage ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS agent_network_denials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id uuid REFERENCES agent_network_clients(id) ON DELETE CASCADE,
  key_hash_prefix text CHECK (key_hash_prefix IS NULL OR key_hash_prefix ~ '^[0-9a-f]{12}$'),
  protocol text CHECK (protocol IN ('mcp', 'a2a')),
  tool text CHECK (tool IS NULL OR char_length(tool) <= 64),
  reason text NOT NULL CHECK (reason IN (
    'invalid_key', 'expired', 'rate_limited', 'quota_exceeded', 'throttled', 'scope_denied', 'unknown_tool', 'origin_denied', 'bad_protocol_version'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_network_denials_client ON agent_network_denials (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_network_denials_anon ON agent_network_denials (created_at DESC) WHERE client_id IS NULL;
ALTER TABLE agent_network_denials ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS agent_network_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id uuid REFERENCES agent_network_clients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('scope_probing', 'auth_anomaly', 'dlq_growth')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_network_alerts_owner ON agent_network_alerts (user_id, created_at DESC);
ALTER TABLE agent_network_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_network_alerts" ON agent_network_alerts;
CREATE POLICY "select_own_agent_network_alerts" ON agent_network_alerts FOR SELECT TO authenticated
  USING (user_id = (select public.get_account_owner_id()) AND (select public.agent_network_is_admin()));

-- 2) Gate v2 --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_network_begin_v2(p_key_hash text, p_cost integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c agent_network_clients;
  v_cost integer := least(greatest(coalesce(p_cost, 1), 1), 20);
  v_s10 timestamptz := to_timestamp(floor(extract(epoch FROM now()) / 10) * 10);
  v_h1 timestamptz := date_trunc('hour', now());
  v_burst integer;
  v_day integer;
  v_denials integer;
  v_found boolean;
BEGIN
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key');
  END IF;

  SELECT * INTO c FROM agent_network_clients WHERE key_hash = p_key_hash;
  v_found := FOUND;
  IF NOT v_found OR c.revoked_at IS NOT NULL THEN
    -- Unknown/revoked key: audit with a capped insert rate so this cannot become a write-amplification vector.
    IF (SELECT count(*) FROM agent_network_denials WHERE client_id IS NULL AND created_at > now() - interval '1 minute') < 200 THEN
      INSERT INTO agent_network_denials (user_id, client_id, key_hash_prefix, reason)
      VALUES (CASE WHEN v_found THEN c.user_id END, CASE WHEN v_found THEN c.id END, left(p_key_hash, 12), 'invalid_key');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key');
  END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at <= now() THEN
    INSERT INTO agent_network_denials (user_id, client_id, reason) VALUES (c.user_id, c.id, 'expired');
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  -- Serialise concurrent requests of ONE client: parallel bursts can no longer all read the same count.
  PERFORM pg_advisory_xact_lock(hashtextextended(c.id::text, 0));

  SELECT count(*) INTO v_denials FROM agent_network_denials
    WHERE client_id = c.id AND reason IN ('scope_denied', 'unknown_tool') AND created_at > now() - interval '10 minutes';
  IF v_denials >= 25 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'throttled', 'retry_after', 300);
  END IF;

  SELECT coalesce(sum(calls), 0) INTO v_burst FROM agent_network_usage
    WHERE client_id = c.id AND granularity = 's10' AND bucket > now() - interval '70 seconds';
  IF v_burst + v_cost > 60 THEN
    INSERT INTO agent_network_denials (user_id, client_id, reason) VALUES (c.user_id, c.id, 'rate_limited');
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', 30);
  END IF;

  SELECT coalesce(sum(calls), 0) INTO v_day FROM agent_network_usage
    WHERE client_id = c.id AND granularity = 'h1' AND bucket > now() - interval '25 hours';
  IF v_day + v_cost > c.daily_call_limit THEN
    INSERT INTO agent_network_denials (user_id, client_id, reason) VALUES (c.user_id, c.id, 'quota_exceeded');
    RETURN jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'retry_after', 3600);
  END IF;

  INSERT INTO agent_network_usage (client_id, granularity, bucket, calls) VALUES (c.id, 's10', v_s10, v_cost)
    ON CONFLICT (client_id, granularity, bucket) DO UPDATE SET calls = agent_network_usage.calls + EXCLUDED.calls;
  INSERT INTO agent_network_usage (client_id, granularity, bucket, calls) VALUES (c.id, 'h1', v_h1, v_cost)
    ON CONFLICT (client_id, granularity, bucket) DO UPDATE SET calls = agent_network_usage.calls + EXCLUDED.calls;

  IF random() < 0.01 THEN
    DELETE FROM agent_network_usage WHERE (granularity = 's10' AND bucket < now() - interval '10 minutes')
                                       OR (granularity = 'h1' AND bucket < now() - interval '3 days');
    DELETE FROM agent_network_denials WHERE created_at < now() - interval '30 days';
  END IF;

  IF c.last_used_at IS NULL OR c.last_used_at < now() - interval '1 minute' THEN
    UPDATE agent_network_clients SET last_used_at = now() WHERE id = c.id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'client_id', c.id, 'user_id', c.user_id, 'name', c.name, 'scopes', to_jsonb(c.scopes));
END;
$$;

-- Edge-detected denials (scope / unknown tool / origin / protocol header). Raises ONE alert per client per hour.
CREATE OR REPLACE FUNCTION public.agent_network_record_denial(p_client_id uuid, p_reason text, p_tool text, p_protocol text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_recent integer;
BEGIN
  SELECT user_id INTO v_user FROM agent_network_clients WHERE id = p_client_id;
  IF v_user IS NULL THEN RETURN; END IF;
  INSERT INTO agent_network_denials (user_id, client_id, protocol, tool, reason)
  VALUES (v_user, p_client_id, CASE WHEN p_protocol IN ('mcp', 'a2a') THEN p_protocol END, left(p_tool, 64), p_reason);

  SELECT count(*) INTO v_recent FROM agent_network_denials
    WHERE client_id = p_client_id AND reason IN ('scope_denied', 'unknown_tool') AND created_at > now() - interval '10 minutes';
  IF v_recent >= 25 AND NOT EXISTS (
    SELECT 1 FROM agent_network_alerts WHERE client_id = p_client_id AND kind = 'scope_probing' AND created_at > now() - interval '1 hour'
  ) THEN
    INSERT INTO agent_network_alerts (user_id, client_id, kind, detail)
    VALUES (v_user, p_client_id, 'scope_probing', jsonb_build_object('denials_10m', v_recent, 'action', 'key throttled for 5 minutes'));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_network_begin_v2(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_network_record_denial(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_network_begin_v2(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_network_record_denial(uuid, text, text, text) TO service_role;

-- 3) Endpoint rotation columns + https guard ------------------------------------------
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS previous_secret text;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS previous_secret_expires_at timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS consecutive_dead integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_https_only CHECK (url ~* '^https://[^/@\s]+') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.rotate_webhook_secret(p_endpoint_id uuid, p_grace_hours integer DEFAULT 24)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new text := 'whsec_' || encode(gen_random_bytes(24), 'hex');
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE webhook_endpoints
     SET previous_secret = signing_secret,
         previous_secret_expires_at = now() + make_interval(hours => least(greatest(coalesce(p_grace_hours, 24), 1), 168)),
         signing_secret = v_new
   WHERE id = p_endpoint_id AND user_id = public.get_account_owner_id();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Endpoint not found'; END IF;
  RETURN v_new;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_webhook_secret(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_webhook_secret(uuid, integer) TO authenticated;

-- 4) Durable outbox --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_status_code integer,
  last_error text,
  replay_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (endpoint_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_due ON webhook_outbox (next_attempt_at) WHERE status IN ('pending', 'delivering');
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_owner ON webhook_outbox (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_dead ON webhook_outbox (user_id) WHERE status = 'dead';

ALTER TABLE webhook_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_webhook_outbox" ON webhook_outbox;
CREATE POLICY "select_own_webhook_outbox" ON webhook_outbox FOR SELECT TO authenticated
  USING (user_id = (select public.get_account_owner_id()));
-- No insert/update/delete policies: writes only via triggers, RPCs and the service role.

CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (
  id uuid, user_id uuid, endpoint_id uuid, delivery_id uuid, event_type text, payload jsonb,
  attempts integer, created_at timestamptz, url text, signing_secret text, previous_secret text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT o.id FROM webhook_outbox o
     WHERE (o.status = 'pending' AND o.next_attempt_at <= now())
        OR (o.status = 'delivering' AND o.locked_until < now())   -- crashed worker: lease expired
     ORDER BY o.next_attempt_at
     LIMIT least(greatest(p_limit, 1), 100)
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE webhook_outbox o
       SET status = 'delivering', attempts = o.attempts + 1,
           locked_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 15), 300))
      FROM due WHERE o.id = due.id
    RETURNING o.*
  )
  SELECT c.id, c.user_id, c.endpoint_id, c.delivery_id, c.event_type, c.payload, c.attempts, c.created_at,
         e.url, e.signing_secret,
         CASE WHEN e.previous_secret_expires_at > now() THEN e.previous_secret END
    FROM claimed c JOIN webhook_endpoints e ON e.id = c.endpoint_id;
$$;

CREATE OR REPLACE FUNCTION public.complete_webhook_delivery(
  p_id uuid, p_class text, p_status integer, p_error text, p_delay_seconds integer, p_max_attempts integer DEFAULT 8
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o webhook_outbox;
  v_final text;
BEGIN
  SELECT * INTO o FROM webhook_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'delivering' THEN RETURN 'ignored'; END IF;

  v_final := CASE
    WHEN p_class = 'delivered' THEN 'delivered'
    WHEN p_class = 'retry' AND o.attempts < p_max_attempts THEN 'pending'
    ELSE 'dead'
  END;

  UPDATE webhook_outbox
     SET status = v_final, locked_until = NULL, last_status_code = p_status, last_error = left(p_error, 500),
         next_attempt_at = CASE WHEN v_final = 'pending' THEN now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds, 30), 5), 21600)) ELSE next_attempt_at END,
         delivered_at = CASE WHEN v_final = 'delivered' THEN now() END
   WHERE id = p_id;

  UPDATE webhook_endpoints
     SET last_delivery_at = now(),
         last_delivery_status = CASE WHEN v_final = 'delivered' THEN 'success' ELSE 'error' END,
         consecutive_dead = CASE WHEN v_final = 'delivered' THEN 0 WHEN v_final = 'dead' THEN consecutive_dead + 1 ELSE consecutive_dead END
   WHERE id = o.endpoint_id;

  INSERT INTO webhook_logs (user_id, direction, event_type, status, status_code, target_url, error_message, endpoint_id, attempt)
  SELECT o.user_id, 'outgoing', o.event_type, CASE WHEN v_final = 'delivered' THEN 'success' ELSE 'error' END,
         p_status, e.url, CASE WHEN v_final = 'delivered' THEN NULL ELSE left(coalesce(p_error, 'delivery_failed'), 500) END, o.endpoint_id, o.attempts
    FROM webhook_endpoints e WHERE e.id = o.endpoint_id;

  IF v_final = 'dead' THEN
    -- A permanently failing endpoint disables itself after 20 dead letters in a row (owner can re-enable).
    UPDATE webhook_endpoints SET status = 'disabled' WHERE id = o.endpoint_id AND consecutive_dead >= 20;
    IF (SELECT count(*) FROM webhook_outbox WHERE user_id = o.user_id AND status = 'dead') >= 10
       AND NOT EXISTS (SELECT 1 FROM agent_network_alerts WHERE user_id = o.user_id AND kind = 'dlq_growth' AND created_at > now() - interval '1 day') THEN
      INSERT INTO agent_network_alerts (user_id, kind, detail)
      VALUES (o.user_id, 'dlq_growth', jsonb_build_object('endpoint_id', o.endpoint_id, 'dead_letters', (SELECT count(*) FROM webhook_outbox WHERE user_id = o.user_id AND status = 'dead')));
    END IF;
  END IF;
  RETURN v_final;
END;
$$;

CREATE OR REPLACE FUNCTION public.replay_webhook_delivery(p_outbox_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  -- Same delivery_id on purpose: receivers de-duplicate on it.
  UPDATE webhook_outbox
     SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL,
         replay_count = replay_count + 1, last_error = NULL
   WHERE id = p_outbox_id AND user_id = public.get_account_owner_id() AND status IN ('dead', 'delivered');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Delivery not found or still in flight'; END IF;
  UPDATE webhook_endpoints SET consecutive_dead = 0 WHERE id = (SELECT endpoint_id FROM webhook_outbox WHERE id = p_outbox_id);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_webhook_delivery(uuid, text, integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replay_webhook_delivery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_webhook_delivery(uuid, text, integer, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.replay_webhook_delivery(uuid) TO authenticated;

-- 5) Trigger: queue when the flag is on, otherwise legacy behaviour unchanged ----------------
CREATE OR REPLACE FUNCTION public.dispatch_event_bus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
  v_event_type text;
  v_endpoint record;
BEGIN
  v_event_type := TG_ARGV[0];

  IF coalesce(current_setting('app.settings.webhook_outbox', true), '') = 'on' THEN
    INSERT INTO webhook_outbox (user_id, endpoint_id, event_type, payload)
    SELECT e.user_id, e.id, v_event_type, to_jsonb(NEW)
      FROM webhook_endpoints e
     WHERE e.user_id = NEW.user_id AND e.status = 'active' AND v_event_type = ANY(e.events);
    RETURN NEW;
  END IF;

  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);

  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  FOR v_endpoint IN
    SELECT id FROM webhook_endpoints
    WHERE user_id = NEW.user_id
      AND status = 'active'
      AND v_event_type = ANY(events)
  LOOP
    PERFORM net.http_post(
      url := v_base_url || '/event-bus-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-push-dispatch-secret', v_secret
      ),
      body := jsonb_build_object(
        'endpoint_id', v_endpoint.id,
        'event_type', v_event_type,
        'record', to_jsonb(NEW)
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;
