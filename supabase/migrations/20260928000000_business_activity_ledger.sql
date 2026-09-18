/*
  # Event-Sourced Business Activity Ledger

  This project already has two event systems, both outbound:
    - webhook_endpoints / dispatch_event_bus (20260924000000) fires HTTP
      deliveries to a developer's own servers for a curated set of events.
    - webhook_logs / dispatch-webhook is the legacy single-URL version.

  Neither of those is a system of record — if a delivery fails, or a
  developer never configured a webhook, the fact that the event happened
  is gone. This migration adds that system of record: an internal,
  immutable, strictly-ordered ledger of everything that happens on an
  account, independent of whether anyone is listening.

  Design:

  - business_activity_events is INSERT-only. A BEFORE UPDATE OR DELETE
    trigger rejects any attempt to change or remove a row — history is
    never edited, only appended to. A mistake gets a compensating event,
    exactly like you'd never rewrite a ledger entry in accounting.
  - Every row belongs to one aggregate (aggregate_type + aggregate_id —
    e.g. a single job) and carries an aggregate_version: 1, 2, 3... for
    that aggregate specifically. Replaying all events for one aggregate
    in aggregate_version order reconstructs its full history — the
    textbook definition of event sourcing, and the reason this table
    exists rather than just widening webhook_logs.
  - id is a bigserial and is also the global, cross-aggregate ordering —
    "everything that happened on this account, in order" is just
    `ORDER BY id`.
  - All writes go through append_activity_event(), which takes a
    per-aggregate Postgres advisory lock before computing the next
    aggregate_version, so two concurrent writers touching the same job
    can never race into the same version number.
  - Six triggers on existing tables (calls, leads, jobs, quotes,
    payment_requests, review_requests) auto-append ledger rows for the
    same set of business moments the Event Bus already tracks, so this
    ledger fills itself in without the app needing to remember to call
    the RPC for the common cases. The RPC stays open for anything a
    developer wants to log by hand (notes, manual status changes, etc.)
    that has no dedicated trigger.

  No edge function, no pg_net, no network call: this is a synchronous,
  transactional write in the same transaction as the business change it
  describes, so — unlike the webhook path — it can never silently drop
  an event because an HTTP call failed.
*/

-- =============================================================
-- BUSINESS_ACTIVITY_EVENTS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS business_activity_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  event_type text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'system', 'customer', 'ai')),
  correlation_id uuid,
  causation_id bigint REFERENCES business_activity_events(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_activity_events_unique_version UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);

CREATE INDEX IF NOT EXISTS idx_activity_events_feed ON business_activity_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_aggregate
  ON business_activity_events(user_id, aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX IF NOT EXISTS idx_activity_events_type ON business_activity_events(user_id, event_type, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_correlation ON business_activity_events(correlation_id) WHERE correlation_id IS NOT NULL;

-- =============================================================
-- IMMUTABILITY: no UPDATE, no DELETE, ever — corrections are new events
-- =============================================================

CREATE OR REPLACE FUNCTION public.reject_activity_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'business_activity_events is append-only — % is not allowed. Append a compensating event instead.', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trigger_reject_activity_event_update ON business_activity_events;
CREATE TRIGGER trigger_reject_activity_event_update
  BEFORE UPDATE ON business_activity_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_activity_event_mutation();

DROP TRIGGER IF EXISTS trigger_reject_activity_event_delete ON business_activity_events;
CREATE TRIGGER trigger_reject_activity_event_delete
  BEFORE DELETE ON business_activity_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_activity_event_mutation();

-- =============================================================
-- RLS — read-only for clients; every write goes through the RPC below
-- (SECURITY DEFINER), so there is deliberately no INSERT/UPDATE/DELETE
-- policy for `authenticated`.
-- =============================================================

ALTER TABLE business_activity_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_activity_events" ON business_activity_events;
CREATE POLICY "select_own_activity_events" ON business_activity_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- APPEND: the only way rows are created. Advisory-locks the aggregate
-- so concurrent appenders can't compute the same aggregate_version.
-- =============================================================

CREATE OR REPLACE FUNCTION public.append_activity_event(
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_event_data jsonb DEFAULT '{}'::jsonb,
  p_actor_type text DEFAULT 'user',
  p_correlation_id uuid DEFAULT NULL,
  p_causation_id bigint DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_user_id uuid DEFAULT NULL
)
RETURNS business_activity_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_next_version integer;
  v_row business_activity_events;
BEGIN
  -- p_user_id lets trusted server-side callers (SECURITY DEFINER triggers,
  -- service-role edge functions) target a tenant directly; anything called
  -- from an authenticated client falls back to their own account.
  v_user_id := COALESCE(p_user_id, public.get_account_owner_id());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'append_activity_event: could not resolve a user_id';
  END IF;

  -- Serialize concurrent appends to the SAME aggregate only — this lock is
  -- released automatically at transaction end and never blocks appends to
  -- a different aggregate.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_aggregate_type || ':' || p_aggregate_id::text, 0));

  SELECT COALESCE(MAX(aggregate_version), 0) + 1 INTO v_next_version
  FROM business_activity_events
  WHERE aggregate_type = p_aggregate_type AND aggregate_id = p_aggregate_id;

  INSERT INTO business_activity_events (
    user_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, event_data, actor_id, actor_type,
    correlation_id, causation_id, metadata
  ) VALUES (
    v_user_id, p_aggregate_type, p_aggregate_id, v_next_version,
    p_event_type, COALESCE(p_event_data, '{}'::jsonb), auth.uid(), p_actor_type,
    p_correlation_id, p_causation_id, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.append_activity_event(text, uuid, text, jsonb, text, uuid, bigint, jsonb, uuid) TO authenticated;

-- =============================================================
-- READ HELPER: full replay history for one aggregate, oldest first.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_aggregate_history(p_aggregate_type text, p_aggregate_id uuid)
RETURNS SETOF business_activity_events
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM business_activity_events
  WHERE aggregate_type = p_aggregate_type
    AND aggregate_id = p_aggregate_id
    AND user_id = public.get_account_owner_id()
  ORDER BY aggregate_version ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_aggregate_history(text, uuid) TO authenticated;

-- =============================================================
-- AUTO-APPEND TRIGGERS on existing business tables. Generic function,
-- one lightweight trigger per (table, moment) — same shape as
-- dispatch_event_bus in 20260924000000, but writing to the ledger
-- in-transaction instead of calling out over HTTP.
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_activity_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_aggregate_type text := TG_ARGV[0];
  v_event_type text := TG_ARGV[1];
BEGIN
  PERFORM public.append_activity_event(
    p_aggregate_type := v_aggregate_type,
    p_aggregate_id := NEW.id,
    p_event_type := v_event_type,
    p_event_data := to_jsonb(NEW),
    p_actor_type := 'system',
    p_user_id := NEW.user_id
  );
  RETURN NEW;
END;
$$;

-- calls
DROP TRIGGER IF EXISTS trigger_log_call_created ON calls;
CREATE TRIGGER trigger_log_call_created
  AFTER INSERT ON calls
  FOR EACH ROW EXECUTE FUNCTION public.log_activity_event('call', 'call.created');

-- leads
DROP TRIGGER IF EXISTS trigger_log_lead_created ON leads;
CREATE TRIGGER trigger_log_lead_created
  AFTER INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION public.log_activity_event('lead', 'lead.created');

-- jobs
DROP TRIGGER IF EXISTS trigger_log_job_created ON jobs;
CREATE TRIGGER trigger_log_job_created
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.log_activity_event('job', 'job.created');

DROP TRIGGER IF EXISTS trigger_log_job_completed ON jobs;
CREATE TRIGGER trigger_log_job_completed
  AFTER UPDATE ON jobs
  FOR EACH ROW WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.log_activity_event('job', 'job.completed');

-- quotes
DROP TRIGGER IF EXISTS trigger_log_quote_sent ON quotes;
CREATE TRIGGER trigger_log_quote_sent
  AFTER UPDATE ON quotes
  FOR EACH ROW WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION public.log_activity_event('quote', 'quote.sent');

DROP TRIGGER IF EXISTS trigger_log_quote_accepted ON quotes;
CREATE TRIGGER trigger_log_quote_accepted
  AFTER UPDATE ON quotes
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION public.log_activity_event('quote', 'quote.accepted');

-- payment_requests
DROP TRIGGER IF EXISTS trigger_log_payment_paid ON payment_requests;
CREATE TRIGGER trigger_log_payment_paid
  AFTER UPDATE ON payment_requests
  FOR EACH ROW WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.log_activity_event('payment', 'payment.received');

-- review_requests
DROP TRIGGER IF EXISTS trigger_log_review_completed ON review_requests;
CREATE TRIGGER trigger_log_review_completed
  AFTER UPDATE ON review_requests
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.log_activity_event('review', 'review.completed');
