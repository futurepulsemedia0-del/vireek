/*
  # Real API / Developer Platform — Event Bus

  This project already ships:
    - Self-serve API keys (api_keys, see 20260915000000_api_keys.sql)
    - A single legacy webhook URL per account, stored on the `integrations`
      row (integration_type = 'webhook') and dispatched by
      supabase/functions/dispatch-webhook for 3 event types
      (call.created, lead.created, job.created) — see
      20260912010000_webhook_logs.sql.

  This migration adds a real, multi-endpoint Event Bus on top of that,
  without touching the legacy single-URL path (it keeps working exactly
  as-is for anyone already using it):

  - webhook_endpoints: a business can register several endpoint URLs,
    each subscribed to a chosen subset of event types, each with its own
    HMAC signing secret (so a customer can verify a delivery really came
    from Vireek — same idea as Stripe's webhook signing secrets). Unlike
    api_keys' hashed secret, this one is stored recoverable in plaintext:
    it isn't a credential that grants access, it's a shared secret the
    receiving endpoint needs to keep re-verifying every delivery, exactly
    like Stripe lets you view a webhook signing secret again anytime.
  - webhook_logs gets two additive columns (endpoint_id, attempt) so
    deliveries from the new system show up per-endpoint. The legacy
    dispatch-webhook function is untouched and keeps writing rows with
    endpoint_id = NULL.
  - A generic `dispatch_event_bus()` trigger function + one trigger per
    event type, calling the new `event-bus-dispatch` Edge Function
    (pg_net, same pattern as the existing dispatch/push-notification
    triggers) once per matching, active, subscribed endpoint.
  - `send_test_webhook_event(p_endpoint_id)` lets the dashboard fire a
    synthetic `test.ping` delivery at one endpoint on demand, so a
    developer can confirm their receiver works before going live.

  Requires the same settings as the existing webhook/push triggers
  (no new ones to configure if you've already deployed those):
    app.settings.edge_function_base_url
    app.settings.push_dispatch_secret

  After this migration, deploy the new Edge Function:
    supabase functions deploy event-bus-dispatch --no-verify-jwt
*/

-- =============================================================
-- WEBHOOK_ENDPOINTS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url text NOT NULL,
  description text,
  events text[] NOT NULL DEFAULT '{}',
  signing_secret text NOT NULL DEFAULT ('whsec_' || encode(gen_random_bytes(24), 'hex')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_delivery_at timestamptz,
  last_delivery_status text CHECK (last_delivery_status IS NULL OR last_delivery_status IN ('success', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoints_valid_events CHECK (
    events <@ ARRAY[
      'call.created', 'call.emergency', 'lead.created',
      'job.created', 'job.completed',
      'quote.sent', 'quote.accepted',
      'review.completed', 'automation.installed'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active ON webhook_endpoints(user_id) WHERE status = 'active';

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_webhook_endpoints" ON webhook_endpoints;
CREATE POLICY "select_own_webhook_endpoints" ON webhook_endpoints FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_webhook_endpoints" ON webhook_endpoints;
CREATE POLICY "insert_own_webhook_endpoints" ON webhook_endpoints FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_webhook_endpoints" ON webhook_endpoints;
CREATE POLICY "update_own_webhook_endpoints" ON webhook_endpoints FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_webhook_endpoints" ON webhook_endpoints;
CREATE POLICY "delete_own_webhook_endpoints" ON webhook_endpoints FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- WEBHOOK_LOGS: additive columns for the new per-endpoint system
-- =============================================================

ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS endpoint_id uuid REFERENCES webhook_endpoints(id) ON DELETE SET NULL;
ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_endpoint ON webhook_logs(endpoint_id, created_at DESC);

-- =============================================================
-- DISPATCH: generic trigger, one per event type, fires per matching
-- active endpoint subscribed to that event.
-- =============================================================

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
  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);

  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  v_event_type := TG_ARGV[0];

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

-- call.created / call.emergency
DROP TRIGGER IF EXISTS trigger_event_bus_call_created ON calls;
CREATE TRIGGER trigger_event_bus_call_created
  AFTER INSERT ON calls
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_event_bus('call.created');

DROP TRIGGER IF EXISTS trigger_event_bus_call_emergency ON calls;
CREATE TRIGGER trigger_event_bus_call_emergency
  AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.is_emergency)
  EXECUTE FUNCTION public.dispatch_event_bus('call.emergency');

-- lead.created
DROP TRIGGER IF EXISTS trigger_event_bus_lead_created ON leads;
CREATE TRIGGER trigger_event_bus_lead_created
  AFTER INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_event_bus('lead.created');

-- job.created / job.completed
DROP TRIGGER IF EXISTS trigger_event_bus_job_created ON jobs;
CREATE TRIGGER trigger_event_bus_job_created
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_event_bus('job.created');

DROP TRIGGER IF EXISTS trigger_event_bus_job_completed ON jobs;
CREATE TRIGGER trigger_event_bus_job_completed
  AFTER UPDATE ON jobs
  FOR EACH ROW WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.dispatch_event_bus('job.completed');

-- quote.sent / quote.accepted
DROP TRIGGER IF EXISTS trigger_event_bus_quote_sent ON quotes;
CREATE TRIGGER trigger_event_bus_quote_sent
  AFTER UPDATE ON quotes
  FOR EACH ROW WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION public.dispatch_event_bus('quote.sent');

DROP TRIGGER IF EXISTS trigger_event_bus_quote_accepted ON quotes;
CREATE TRIGGER trigger_event_bus_quote_accepted
  AFTER UPDATE ON quotes
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION public.dispatch_event_bus('quote.accepted');

-- review.completed
DROP TRIGGER IF EXISTS trigger_event_bus_review_completed ON review_requests;
CREATE TRIGGER trigger_event_bus_review_completed
  AFTER UPDATE ON review_requests
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.dispatch_event_bus('review.completed');

-- automation.installed (ties into the Automation Marketplace)
DROP TRIGGER IF EXISTS trigger_event_bus_automation_installed ON automation_installs;
CREATE TRIGGER trigger_event_bus_automation_installed
  AFTER INSERT ON automation_installs
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_event_bus('automation.installed');

-- =============================================================
-- RPC: send_test_webhook_event
-- Lets the dashboard fire one synthetic delivery at an endpoint the
-- caller owns, without waiting for a real event to happen.
-- =============================================================

CREATE OR REPLACE FUNCTION public.send_test_webhook_event(p_endpoint_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM webhook_endpoints
    WHERE id = p_endpoint_id AND user_id = public.get_account_owner_id()
  ) THEN
    RAISE EXCEPTION 'Not authorized for this endpoint';
  END IF;

  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE EXCEPTION 'Event Bus is not configured on this environment yet';
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/event-bus-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object(
      'endpoint_id', p_endpoint_id,
      'event_type', 'test.ping',
      'record', jsonb_build_object('message', 'This is a test delivery from Vireek.', 'sent_at', now())
    )
  );
END;
$$;
