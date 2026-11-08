/*
  Workflow runtime extensions.
  STATUS: written without access to Postgres. NOT RUN. Run on a staging project first.

  1. compiled_workflow_step_keys  — at-most-once side effects across branches / fan-out items / compensation
  2. domain_event_*               — registry, consumer positions and dead letters for the INTERNAL event backbone
                                    (business_activity_events stays the single, immutable source of truth)
  All new tables are service-role only: RLS on, no policies, no grants to anon/authenticated.
*/

-- =============================================================
-- 1. Step keys (idempotency)
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_step_keys (
  key text PRIMARY KEY CHECK (length(key) <= 200),
  run_id uuid NOT NULL REFERENCES compiled_workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('exec', 'compensate')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cwsk_run ON compiled_workflow_step_keys(run_id);
ALTER TABLE compiled_workflow_step_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON compiled_workflow_step_keys FROM anon, authenticated;

/** true = this caller owns the step and may run it; false = it was already claimed (never run it twice). */
CREATE OR REPLACE FUNCTION public.cwf_claim_step(p_run_id uuid, p_user_id uuid, p_key text, p_node text, p_purpose text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF p_purpose NOT IN ('exec', 'compensate') THEN RAISE EXCEPTION 'invalid purpose'; END IF;
  IF length(p_key) > 200 OR left(p_key, 37) <> p_run_id::text || ':' THEN RAISE EXCEPTION 'key must start with the run id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compiled_workflow_runs WHERE id = p_run_id AND user_id = p_user_id) THEN RAISE EXCEPTION 'run not found'; END IF;
  INSERT INTO compiled_workflow_step_keys (key, run_id, user_id, node_id, purpose)
  VALUES (p_key, p_run_id, p_user_id, p_node, p_purpose)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION public.cwf_claim_step(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cwf_claim_step(uuid, uuid, text, text, text) TO service_role;

-- =============================================================
-- 2. Internal domain-event backbone (additions only)
-- =============================================================
CREATE TABLE IF NOT EXISTS domain_event_schemas (
  event_type text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  schema jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_type, version)
);

CREATE TABLE IF NOT EXISTS domain_event_consumers (
  consumer_group text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  committed_version integer NOT NULL DEFAULT 0 CHECK (committed_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, aggregate_type, aggregate_id)
);

CREATE TABLE IF NOT EXISTS domain_event_dead_letters (
  id bigserial PRIMARY KEY,
  consumer_group text NOT NULL,
  event_id bigint NOT NULL REFERENCES business_activity_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  UNIQUE (consumer_group, event_id)
);
CREATE INDEX IF NOT EXISTS idx_dedl_open ON domain_event_dead_letters(consumer_group, failed_at) WHERE replayed_at IS NULL;

ALTER TABLE domain_event_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event_consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event_dead_letters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON domain_event_schemas, domain_event_consumers, domain_event_dead_letters FROM anon, authenticated;

/** Compare-and-set: only the next version (committed + 1) advances a group's position. Returns false for duplicates/gaps. */
CREATE OR REPLACE FUNCTION public.domain_event_commit(p_group text, p_type text, p_aggregate uuid, p_version integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF p_version < 1 THEN RAISE EXCEPTION 'version starts at 1'; END IF;
  IF p_version = 1 THEN
    INSERT INTO domain_event_consumers (consumer_group, aggregate_type, aggregate_id, committed_version)
    VALUES (p_group, p_type, p_aggregate, 1) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  ELSE
    UPDATE domain_event_consumers SET committed_version = p_version, updated_at = now()
     WHERE consumer_group = p_group AND aggregate_type = p_type AND aggregate_id = p_aggregate
       AND committed_version = p_version - 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;
  RETURN v_rows = 1;
END $$;

/** Queue depth and age of the oldest undelivered event for a group (last 30 days; older backlog is not counted). */
CREATE OR REPLACE FUNCTION public.domain_event_queue_depth(p_group text)
RETURNS TABLE (depth bigint, oldest_age_ms bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::bigint,
         COALESCE(EXTRACT(EPOCH FROM (now() - min(e.occurred_at))) * 1000, 0)::bigint
    FROM business_activity_events e
    LEFT JOIN domain_event_consumers c
      ON c.consumer_group = p_group AND c.aggregate_type = e.aggregate_type AND c.aggregate_id = e.aggregate_id
   WHERE e.occurred_at > now() - interval '30 days'
     AND e.aggregate_version > COALESCE(c.committed_version, 0);
$$;

CREATE OR REPLACE FUNCTION public.domain_event_dead_letter_put(p_group text, p_event_id bigint, p_attempts integer, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO domain_event_dead_letters (consumer_group, event_id, user_id, attempts, last_error)
  SELECT p_group, e.id, e.user_id, p_attempts, left(p_error, 500)
    FROM business_activity_events e WHERE e.id = p_event_id
  ON CONFLICT (consumer_group, event_id)
  DO UPDATE SET attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, failed_at = now(), replayed_at = NULL;
$$;

/** Marks dead letters as replayed (the consumer then retries them). Returns how many were requeued. */
CREATE OR REPLACE FUNCTION public.domain_event_dlq_requeue(p_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) > 500 THEN RAISE EXCEPTION 'requeue 1..500 ids at a time'; END IF;
  UPDATE domain_event_dead_letters SET replayed_at = now() WHERE id = ANY (p_ids) AND replayed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

/** Retention: only replayed dead letters are ever deleted. The event ledger itself is immutable and never pruned. */
CREATE OR REPLACE FUNCTION public.domain_event_dlq_prune(p_days integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF p_days < 7 THEN RAISE EXCEPTION 'retention must be at least 7 days'; END IF;
  DELETE FROM domain_event_dead_letters WHERE replayed_at IS NOT NULL AND replayed_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

REVOKE ALL ON FUNCTION public.domain_event_commit(text, text, uuid, integer),
                      public.domain_event_queue_depth(text),
                      public.domain_event_dead_letter_put(text, bigint, integer, text),
                      public.domain_event_dlq_requeue(bigint[]),
                      public.domain_event_dlq_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.domain_event_commit(text, text, uuid, integer),
                          public.domain_event_queue_depth(text),
                          public.domain_event_dead_letter_put(text, bigint, integer, text),
                          public.domain_event_dlq_requeue(bigint[]),
                          public.domain_event_dlq_prune(integer) TO service_role;

/*
  ROLLBACK (manual): DROP FUNCTION public.cwf_claim_step, public.domain_event_*; DROP TABLE compiled_workflow_step_keys,
  domain_event_schemas, domain_event_consumers, domain_event_dead_letters;
  Safe only while no workflow uses parallel/foreach/compensator (the runtime flag is off).
*/
