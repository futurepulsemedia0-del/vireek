/*
  # Slack + Microsoft Teams notifications

  Tables
  - chat_connections         one row per (account owner, provider); NO secrets here (safe to SELECT from the browser)
  - chat_connection_secrets  AES-GCM encrypted Slack bot token; RLS on + zero policies => service role only
  - chat_channels            Teams channel cache filled by the bot when the app is installed
  - chat_routes              event type -> channel mapping (+ buttons / contact-detail / CSAT-threshold options)
  - chat_events              outbox + action state (acknowledged / assigned)
  - chat_deliveries          per-channel delivery log (status, attempts, error, message ids)

  Events are enqueued by triggers on calls / jobs / call_feedback / payment_requests / profiles ONLY when the
  owner has an enabled route for that event type, and every trigger swallows its own errors so a notification
  problem can never block a call, job or payment write.

  Reuses the existing pg_net settings (same as dispatch-webhook):
    app.settings.edge_function_base_url, app.settings.push_dispatch_secret
  Deploy after migrating: supabase functions deploy chat-notify-dispatch --no-verify-jwt
*/

-- ======================= TABLES =======================
CREATE TABLE IF NOT EXISTS chat_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  external_id text NOT NULL,
  external_name text,
  bot_user_id text,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS chat_connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES chat_connections(id) ON DELETE CASCADE,
  token_ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES chat_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  team_id text NOT NULL,
  team_name text,
  service_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, channel_id)
);

CREATE TABLE IF NOT EXISTS chat_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES chat_connections(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('emergency_call', 'missed_call', 'new_job', 'job_completed', 'low_csat', 'payment_failed')),
  channel_id text NOT NULL,
  channel_name text,
  enabled boolean NOT NULL DEFAULT true,
  actions_enabled boolean NOT NULL DEFAULT true,
  include_contact_details boolean NOT NULL DEFAULT true,
  csat_threshold smallint NOT NULL DEFAULT 2 CHECK (csat_threshold BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_chat_routes_user_event ON chat_routes(user_id, event_type) WHERE enabled;

CREATE TABLE IF NOT EXISTS chat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('emergency_call', 'missed_call', 'new_job', 'job_completed', 'low_csat', 'payment_failed')),
  entity_type text NOT NULL,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by text,
  acknowledged_via text,
  assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL,
  assigned_by text,
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_chat_events_user_created ON chat_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES chat_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES chat_connections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
  channel_id text NOT NULL,
  channel_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  external_message_id text,
  external_conversation_id text,
  service_url text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_user_created ON chat_deliveries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_deliveries_failed ON chat_deliveries(updated_at) WHERE status = 'failed';

-- ======================= RLS =======================
ALTER TABLE chat_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_deliveries ENABLE ROW LEVEL SECURITY;

-- Secrets: no policy at all + explicit revoke => only the service role (Edge Functions) can touch them.
REVOKE ALL ON chat_connection_secrets FROM anon, authenticated;

DROP POLICY IF EXISTS "select_chat_connections" ON chat_connections;
CREATE POLICY "select_chat_connections" ON chat_connections FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_chat_channels" ON chat_channels;
CREATE POLICY "select_chat_channels" ON chat_channels FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_chat_events" ON chat_events;
CREATE POLICY "select_chat_events" ON chat_events FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_chat_deliveries" ON chat_deliveries;
CREATE POLICY "select_chat_deliveries" ON chat_deliveries FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Routes: everyone on the team can read; only the account owner can change them.
DROP POLICY IF EXISTS "select_chat_routes" ON chat_routes;
CREATE POLICY "select_chat_routes" ON chat_routes FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_chat_routes" ON chat_routes;
CREATE POLICY "insert_chat_routes" ON chat_routes FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM chat_connections c WHERE c.id = connection_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS "update_chat_routes" ON chat_routes;
CREATE POLICY "update_chat_routes" ON chat_routes FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM chat_connections c WHERE c.id = connection_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS "delete_chat_routes" ON chat_routes;
CREATE POLICY "delete_chat_routes" ON chat_routes FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ======================= ENQUEUE + DISPATCH =======================
CREATE OR REPLACE FUNCTION public.chat_enqueue_event(
  p_user_id uuid, p_event_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb, p_dedupe_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  -- Zero cost for accounts that haven't mapped this event to a channel.
  IF NOT EXISTS (SELECT 1 FROM chat_routes r WHERE r.user_id = p_user_id AND r.event_type = p_event_type AND r.enabled) THEN
    RETURN;
  END IF;
  INSERT INTO chat_events (user_id, event_type, entity_type, entity_id, payload, dedupe_key)
  VALUES (p_user_id, p_event_type, p_entity_type, p_entity_id, COALESCE(p_payload, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_enqueue_event(uuid, text, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_dispatch_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.push_dispatch_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW; -- same silent no-op as dispatch_customer_webhook; the retry sweep will pick it up
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_base_url || '/chat-notify-dispatch',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
      body := jsonb_build_object('event_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_dispatch_event failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_dispatch_event ON chat_events;
CREATE TRIGGER trg_chat_dispatch_event AFTER INSERT ON chat_events FOR EACH ROW EXECUTE FUNCTION public.chat_dispatch_event();

-- ======================= SOURCE TRIGGERS =======================
-- calls: emergency + missed
CREATE OR REPLACE FUNCTION public.chat_trg_calls() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.is_emergency AND (CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.is_emergency IS DISTINCT FROM true END) THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'emergency_call', 'call', NEW.id,
        jsonb_build_object('caller_name', NEW.caller_name, 'caller_phone', NEW.caller_phone, 'summary', left(COALESCE(NEW.summary, ''), 500)),
        'emergency_call:' || NEW.id);
    END IF;
    IF NEW.status = 'missed' AND (CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.status IS DISTINCT FROM 'missed' END) THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'missed_call', 'call', NEW.id,
        jsonb_build_object('caller_name', NEW.caller_name, 'caller_phone', NEW.caller_phone),
        'missed_call:' || NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_trg_calls failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_calls_ins ON calls;
CREATE TRIGGER trg_chat_calls_ins AFTER INSERT ON calls FOR EACH ROW EXECUTE FUNCTION public.chat_trg_calls();
DROP TRIGGER IF EXISTS trg_chat_calls_upd ON calls;
CREATE TRIGGER trg_chat_calls_upd AFTER UPDATE OF is_emergency, status ON calls FOR EACH ROW EXECUTE FUNCTION public.chat_trg_calls();

-- jobs: new + completed (invoice amounts are deliberately never included)
CREATE OR REPLACE FUNCTION public.chat_trg_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'new_job', 'job', NEW.id,
        jsonb_build_object('customer_name', NEW.customer_name, 'service_type', NEW.service_type, 'address', NEW.address, 'scheduled_datetime', NEW.scheduled_datetime),
        'new_job:' || NEW.id);
    END IF;
    IF NEW.job_status = 'completed' AND (CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.job_status IS DISTINCT FROM 'completed' END) THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'job_completed', 'job', NEW.id,
        jsonb_build_object('customer_name', NEW.customer_name, 'service_type', NEW.service_type),
        'job_completed:' || NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_trg_jobs failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_jobs_ins ON jobs;
CREATE TRIGGER trg_chat_jobs_ins AFTER INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION public.chat_trg_jobs();
DROP TRIGGER IF EXISTS trg_chat_jobs_upd ON jobs;
CREATE TRIGGER trg_chat_jobs_upd AFTER UPDATE OF job_status ON jobs FOR EACH ROW EXECUTE FUNCTION public.chat_trg_jobs();

-- call_feedback: low CSAT (queued for ratings <= 3; each route's own threshold decides at delivery time)
CREATE OR REPLACE FUNCTION public.chat_trg_feedback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.rating <= 3 AND (CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.rating IS DISTINCT FROM NEW.rating END) THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'low_csat', 'call', NEW.call_id,
        jsonb_build_object('rating', NEW.rating, 'comment', left(COALESCE(NEW.comment, ''), 300)),
        'low_csat:' || NEW.id || ':' || NEW.rating);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_trg_feedback failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_feedback_ins ON call_feedback;
CREATE TRIGGER trg_chat_feedback_ins AFTER INSERT ON call_feedback FOR EACH ROW EXECUTE FUNCTION public.chat_trg_feedback();
DROP TRIGGER IF EXISTS trg_chat_feedback_upd ON call_feedback;
CREATE TRIGGER trg_chat_feedback_upd AFTER UPDATE OF rating ON call_feedback FOR EACH ROW EXECUTE FUNCTION public.chat_trg_feedback();

-- payment_requests: a customer's payment failed
CREATE OR REPLACE FUNCTION public.chat_trg_payment_requests() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.status = 'failed' AND (CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD.status IS DISTINCT FROM 'failed' END) THEN
      PERFORM public.chat_enqueue_event(NEW.user_id, 'payment_failed', 'payment_request', NEW.id,
        jsonb_build_object('source', 'customer_payment', 'customer_name', NEW.customer_name, 'amount', NEW.amount, 'currency', NEW.currency),
        'payment_failed:' || NEW.id || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_trg_payment_requests failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_payreq_ins ON payment_requests;
CREATE TRIGGER trg_chat_payreq_ins AFTER INSERT ON payment_requests FOR EACH ROW EXECUTE FUNCTION public.chat_trg_payment_requests();
DROP TRIGGER IF EXISTS trg_chat_payreq_upd ON payment_requests;
CREATE TRIGGER trg_chat_payreq_upd AFTER UPDATE OF status ON payment_requests FOR EACH ROW EXECUTE FUNCTION public.chat_trg_payment_requests();

-- profiles: the owner's own Vireek subscription payment failed (set by stripe-webhook dunning)
CREATE OR REPLACE FUNCTION public.chat_trg_profile_billing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF OLD.payment_failed_at IS NULL AND NEW.payment_failed_at IS NOT NULL THEN
      PERFORM public.chat_enqueue_event(NEW.id, 'payment_failed', 'subscription', NEW.id,
        jsonb_build_object('source', 'subscription'),
        'subscription_payment_failed:' || NEW.id || ':' || NEW.payment_failed_at);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_trg_profile_billing failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_profile_billing ON profiles;
CREATE TRIGGER trg_chat_profile_billing AFTER UPDATE OF payment_failed_at ON profiles FOR EACH ROW EXECUTE FUNCTION public.chat_trg_profile_billing();
