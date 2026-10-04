/*
  # Vireek Workflow Compiler

  The owner describes WHAT should happen in plain language; the
  workflow-compiler edge function turns it into a validated, immutable
  execution graph (trigger -> lookups -> AI reasoning -> decisions -> agent
  actions -> human approval -> fallback -> verification -> audit).

  Additive only: new tables, new functions, one new AFTER INSERT trigger on
  business_activity_events. Nothing existing is altered or dropped, and the
  existing workflow_* tables / executor are untouched.

  Tables
    compiled_workflows        immutable graph + status (draft/test/live/paused/archived)
    compiled_workflow_runs    one execution per matching business event
    compiled_workflow_approvals  human gates (with the price the human confirmed)
    compiled_workflow_audit   append-only, hash-chained event log (tamper-evident)

  Safety properties enforced in the database, not just in code:
    - graph / ir / instruction can never be edited after creation (new compile = new row)
    - audit rows can never be updated or deleted; each row hashes the previous one
    - one run per (workflow, business event): enrollment is idempotent
    - draft cannot go straight to live; it must pass through test mode
    - the owner (never the client) is the only party that can move a status

  Deploy order: run this migration -> deploy workflow-compiler (JWT on) ->
  deploy workflow-graph-executor (--no-verify-jwt) and call it from the same
  cron that calls workflow-engine-executor, every minute, with X-Cron-Secret.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =============================================================
-- compiled_workflows
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES compiled_workflows(id) ON DELETE SET NULL,
  name text NOT NULL,
  instruction text NOT NULL,
  summary text NOT NULL,
  trigger_event text NOT NULL,
  sla_minutes integer CHECK (sla_minutes IS NULL OR sla_minutes BETWEEN 1 AND 10080),
  ir jsonb NOT NULL,
  graph jsonb NOT NULL,
  report jsonb NOT NULL,
  compiler_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'test', 'live', 'paused', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cwf_user ON compiled_workflows(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cwf_trigger ON compiled_workflows(trigger_event) WHERE status IN ('test', 'live');

ALTER TABLE compiled_workflows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_compiled_workflows" ON compiled_workflows;
CREATE POLICY "select_own_compiled_workflows" ON compiled_workflows FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: writes go through the edge function (service role) or the RPCs below.

CREATE OR REPLACE FUNCTION public.cwf_freeze_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ir IS DISTINCT FROM OLD.ir OR NEW.graph IS DISTINCT FROM OLD.graph
     OR NEW.instruction IS DISTINCT FROM OLD.instruction OR NEW.trigger_event IS DISTINCT FROM OLD.trigger_event
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'COMPILED_WORKFLOW_IMMUTABLE';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cwf_freeze_graph ON compiled_workflows;
CREATE TRIGGER trg_cwf_freeze_graph BEFORE UPDATE ON compiled_workflows
  FOR EACH ROW EXECUTE FUNCTION public.cwf_freeze_graph();

-- =============================================================
-- compiled_workflow_runs
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES compiled_workflows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trigger_event_id bigint REFERENCES business_activity_events(id) ON DELETE SET NULL,
  entity_type text,
  entity_id uuid,
  customer_name text,
  customer_phone text,
  customer_email text,
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'waiting_approval', 'waiting_timer', 'completed', 'failed', 'cancelled')),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_node text NOT NULL,
  pending_edge text,
  inflight_node text,
  hop_count integer NOT NULL DEFAULT 0,
  next_wake_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  deadline_at timestamptz,
  sla_breached_at timestamptz,
  stop_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT cwr_idempotent_enrollment UNIQUE (workflow_id, trigger_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cwr_user ON compiled_workflow_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cwr_due ON compiled_workflow_runs(next_wake_at) WHERE status IN ('active', 'waiting_timer');
CREATE INDEX IF NOT EXISTS idx_cwr_sla ON compiled_workflow_runs(deadline_at) WHERE sla_breached_at IS NULL AND status IN ('active', 'waiting_approval', 'waiting_timer');

ALTER TABLE compiled_workflow_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_compiled_runs" ON compiled_workflow_runs;
CREATE POLICY "select_own_compiled_runs" ON compiled_workflow_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- compiled_workflow_approvals
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES compiled_workflow_runs(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES compiled_workflows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  price_cents integer CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 100000000),
  note text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  CONSTRAINT cwa_unique_node UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_cwa_pending ON compiled_workflow_approvals(user_id, requested_at) WHERE status = 'pending';
ALTER TABLE compiled_workflow_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_compiled_approvals" ON compiled_workflow_approvals;
CREATE POLICY "select_own_compiled_approvals" ON compiled_workflow_approvals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- compiled_workflow_audit — append-only, hash chained per run
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES compiled_workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  seq integer NOT NULL,
  event_type text NOT NULL,
  node_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cwau_unique_seq UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_cwau_run ON compiled_workflow_audit(run_id, seq);
ALTER TABLE compiled_workflow_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_compiled_audit" ON compiled_workflow_audit;
CREATE POLICY "select_own_compiled_audit" ON compiled_workflow_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.cwau_chain()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_prev text; v_seq integer;
BEGIN
  SELECT hash, seq INTO v_prev, v_seq FROM compiled_workflow_audit
    WHERE run_id = NEW.run_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_prev, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.hash := encode(extensions.digest(
    NEW.prev_hash || '|' || NEW.seq || '|' || NEW.event_type || '|' || COALESCE(NEW.node_id, '') || '|' ||
    NEW.detail::text || '|' || to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cwau_chain ON compiled_workflow_audit;
CREATE TRIGGER trg_cwau_chain BEFORE INSERT ON compiled_workflow_audit
  FOR EACH ROW EXECUTE FUNCTION public.cwau_chain();

CREATE OR REPLACE FUNCTION public.cwau_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF; -- allow ON DELETE CASCADE from run/profile removal
  RAISE EXCEPTION 'AUDIT_LOG_IS_APPEND_ONLY';
END;
$$;
DROP TRIGGER IF EXISTS trg_cwau_no_update ON compiled_workflow_audit;
CREATE TRIGGER trg_cwau_no_update BEFORE UPDATE ON compiled_workflow_audit
  FOR EACH ROW EXECUTE FUNCTION public.cwau_block_mutation();
DROP TRIGGER IF EXISTS trg_cwau_no_delete ON compiled_workflow_audit;
CREATE TRIGGER trg_cwau_no_delete BEFORE DELETE ON compiled_workflow_audit
  FOR EACH ROW EXECUTE FUNCTION public.cwau_block_mutation();

/** Recomputes every hash for a run. Returns {ok, checked, first_bad_seq}. */
CREATE OR REPLACE FUNCTION public.verify_compiled_audit_chain(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  r record; v_prev text := repeat('0', 64); v_expected text; v_n integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM compiled_workflow_runs WHERE id = p_run_id AND user_id = public.get_account_owner_id()) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  FOR r IN SELECT * FROM compiled_workflow_audit WHERE run_id = p_run_id ORDER BY seq LOOP
    v_n := v_n + 1;
    v_expected := encode(extensions.digest(
      v_prev || '|' || r.seq || '|' || r.event_type || '|' || COALESCE(r.node_id, '') || '|' ||
      r.detail::text || '|' || to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'sha256'), 'hex');
    IF r.prev_hash <> v_prev OR r.hash <> v_expected THEN
      RETURN jsonb_build_object('ok', false, 'checked', v_n, 'first_bad_seq', r.seq);
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'checked', v_n, 'first_bad_seq', NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.verify_compiled_audit_chain(uuid) TO authenticated;

-- =============================================================
-- Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.cwf_audit(p_run_id uuid, p_user_id uuid, p_event text, p_node text, p_detail jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO compiled_workflow_audit (run_id, user_id, event_type, node_id, detail, seq, prev_hash, hash)
  VALUES (p_run_id, p_user_id, p_event, p_node, COALESCE(p_detail, '{}'::jsonb), 0, '', '');
$$;
REVOKE ALL ON FUNCTION public.cwf_audit(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cwf_audit(uuid, uuid, text, text, jsonb) TO service_role;

-- =============================================================
-- Enrollment: one run per (workflow, ledger event)
-- =============================================================
CREATE OR REPLACE FUNCTION public.match_compiled_workflows()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_def record; v_run_id uuid; v_name text; v_phone text; v_email text; v_ctx jsonb; v_graph jsonb;
BEGIN
  v_ctx := (NEW.event_data - 'id') - 'user_id';
  v_name := COALESCE(NEW.event_data->>'customer_name', NEW.event_data->>'caller_name', NEW.event_data->>'name');
  v_phone := COALESCE(NEW.event_data->>'customer_phone', NEW.event_data->>'caller_phone', NEW.event_data->>'phone');
  v_email := COALESCE(NEW.event_data->>'customer_email', NEW.event_data->>'email');

  FOR v_def IN
    SELECT id, graph, status, sla_minutes FROM compiled_workflows
    WHERE user_id = NEW.user_id AND status IN ('test', 'live') AND trigger_event = NEW.event_type
  LOOP
    INSERT INTO compiled_workflow_runs (
      workflow_id, user_id, trigger_event_id, entity_type, entity_id,
      customer_name, customer_phone, customer_email, mode, current_node, state, deadline_at
    ) VALUES (
      v_def.id, NEW.user_id, NEW.id, NEW.aggregate_type, NEW.aggregate_id,
      v_name, v_phone, v_email,
      CASE WHEN v_def.status = 'live' THEN 'live' ELSE 'test' END,
      v_def.graph->>'entry',
      jsonb_build_object('trigger', v_ctx, 'customer', jsonb_build_object('name', v_name, 'phone', v_phone, 'email', v_email)),
      CASE WHEN v_def.sla_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => v_def.sla_minutes) END
    )
    ON CONFLICT (workflow_id, trigger_event_id) DO NOTHING
    RETURNING id INTO v_run_id;

    IF v_run_id IS NOT NULL THEN
      PERFORM public.cwf_audit(v_run_id, NEW.user_id, 'run_started', v_def.graph->>'entry',
        jsonb_build_object('event_type', NEW.event_type, 'event_id', NEW.id, 'mode', CASE WHEN v_def.status = 'live' THEN 'live' ELSE 'test' END));
    END IF;
    v_run_id := NULL;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let an automation problem roll back the business event that caused it (a call, a job...).
  RAISE WARNING 'match_compiled_workflows failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trigger_match_compiled_workflows ON business_activity_events;
CREATE TRIGGER trigger_match_compiled_workflows
  AFTER INSERT ON business_activity_events
  FOR EACH ROW EXECUTE FUNCTION public.match_compiled_workflows();

-- =============================================================
-- Owner-facing RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_compiled_workflow_status(p_id uuid, p_status text)
RETURNS compiled_workflows LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_wf compiled_workflows;
BEGIN
  SELECT * INTO v_wf FROM compiled_workflows WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_status NOT IN ('test', 'live', 'paused', 'archived') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
  IF v_wf.status = 'archived' THEN RAISE EXCEPTION 'ARCHIVED_IS_FINAL'; END IF;
  IF v_wf.status = 'draft' AND p_status NOT IN ('test', 'archived') THEN RAISE EXCEPTION 'DRAFT_MUST_PASS_TEST_FIRST'; END IF;
  UPDATE compiled_workflows
     SET status = p_status, activated_at = CASE WHEN p_status IN ('test', 'live') AND activated_at IS NULL THEN now() ELSE activated_at END
   WHERE id = p_id RETURNING * INTO v_wf;
  RETURN v_wf;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_compiled_workflow_status(uuid, text) TO authenticated;

/** Starts a TEST-mode run from a synthetic event so the owner can watch the whole pipeline immediately. */
CREATE OR REPLACE FUNCTION public.start_compiled_test_run(p_workflow_id uuid, p_context jsonb, p_customer_name text, p_customer_phone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_wf compiled_workflows; v_id uuid;
BEGIN
  SELECT * INTO v_wf FROM compiled_workflows WHERE id = p_workflow_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_wf.status = 'archived' THEN RAISE EXCEPTION 'ARCHIVED_IS_FINAL'; END IF;
  IF pg_column_size(COALESCE(p_context, '{}'::jsonb)) > 8000 THEN RAISE EXCEPTION 'CONTEXT_TOO_LARGE'; END IF;
  INSERT INTO compiled_workflow_runs (workflow_id, user_id, customer_name, customer_phone, mode, current_node, state, deadline_at)
  VALUES (v_wf.id, v_owner, NULLIF(btrim(p_customer_name), ''), NULLIF(btrim(p_customer_phone), ''), 'test', v_wf.graph->>'entry',
    jsonb_build_object('trigger', COALESCE(p_context, '{}'::jsonb),
      'customer', jsonb_build_object('name', NULLIF(btrim(p_customer_name), ''), 'phone', NULLIF(btrim(p_customer_phone), ''))),
    CASE WHEN v_wf.sla_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => v_wf.sla_minutes) END)
  RETURNING id INTO v_id;
  PERFORM public.cwf_audit(v_id, v_owner, 'run_started', v_wf.graph->>'entry', jsonb_build_object('synthetic', true, 'mode', 'test'));
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.start_compiled_test_run(uuid, jsonb, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_compiled_run(p_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_n integer;
BEGIN
  UPDATE compiled_workflow_runs SET status = 'cancelled', stop_reason = 'cancelled_by_owner', completed_at = now(), locked_until = NULL
   WHERE id = p_run_id AND user_id = v_owner AND status IN ('active', 'waiting_approval', 'waiting_timer');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN false; END IF;
  UPDATE compiled_workflow_approvals SET status = 'expired', decided_at = now() WHERE run_id = p_run_id AND status = 'pending';
  PERFORM public.cwf_audit(p_run_id, v_owner, 'run_cancelled', NULL, jsonb_build_object('by', auth.uid()));
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_compiled_run(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_compiled_approval(p_approval_id uuid, p_approve boolean, p_price_cents integer, p_note text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_ap compiled_workflow_approvals; v_edge text;
BEGIN
  SELECT * INTO v_ap FROM compiled_workflow_approvals WHERE id = p_approval_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_ap.status <> 'pending' THEN RETURN false; END IF;
  IF v_ap.expires_at < now() THEN RETURN false; END IF; -- the executor will expire it and take the timeout edge
  v_edge := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;

  UPDATE compiled_workflow_approvals
     SET status = v_edge, price_cents = p_price_cents, note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
         decided_at = now(), decided_by = auth.uid()
   WHERE id = p_approval_id;

  UPDATE compiled_workflow_runs
     SET status = 'active', pending_edge = v_edge, next_wake_at = now(),
         state = jsonb_set(state, ARRAY[v_ap.node_id], jsonb_build_object(
           'approved', p_approve, 'price_cents', p_price_cents, 'note', NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')), true)
   WHERE id = v_ap.run_id AND status = 'waiting_approval';

  PERFORM public.cwf_audit(v_ap.run_id, v_owner, 'approval_decided', v_ap.node_id,
    jsonb_build_object('decision', v_edge, 'price_cents', p_price_cents, 'decided_by', auth.uid()));
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_compiled_approval(uuid, boolean, integer, text) TO authenticated;

-- =============================================================
-- Executor-only RPCs (service_role)
-- =============================================================
/** Atomically leases due runs so two overlapping cron ticks can never process the same run. */
CREATE OR REPLACE FUNCTION public.claim_compiled_runs(p_limit integer, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF compiled_workflow_runs LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM compiled_workflow_runs
     WHERE status IN ('active', 'waiting_timer') AND next_wake_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY next_wake_at LIMIT GREATEST(1, LEAST(p_limit, 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE compiled_workflow_runs r SET locked_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE r.id = due.id RETURNING r.*;
$$;

/** Calls the EXISTING post_network_handoff() RPC on behalf of the account owner (it requires auth.uid()). */
CREATE OR REPLACE FUNCTION public.cwf_post_handoff(
  p_owner uuid, p_trade text, p_title text, p_summary text, p_customer_name text, p_customer_phone text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_owner::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
  RETURN public.post_network_handoff('emergency', p_trade, p_title, p_summary, NULL, NULL, NULL, 10,
    p_customer_name, p_customer_phone, NULL, 'Posted automatically by Vireek Workflow Compiler', false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_compiled_runs(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cwf_post_handoff(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_compiled_runs(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cwf_post_handoff(uuid, text, text, text, text, text) TO service_role;

-- =============================================================
-- Governance catalog (so each commitment shows up in Agent Governance)
-- =============================================================
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('compiled_workflow_sms', 'workflow-graph-executor', 'Compiled workflow text message', 'messaging', false, false, false),
  ('compiled_workflow_dispatch', 'workflow-graph-executor', 'Compiled workflow technician dispatch', 'other', false, false, false),
  ('compiled_workflow_handoff', 'workflow-graph-executor', 'Compiled workflow contractor handoff', 'other', false, false, false)
ON CONFLICT (slug) DO NOTHING;
