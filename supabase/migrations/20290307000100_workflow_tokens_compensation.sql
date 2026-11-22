/*
  Workflow engine — execution tokens, durable compensation state, idempotency constraints.

  STATUS: written WITHOUT access to Postgres. NOT RUN. Apply on staging, run supabase/tests/database/workflow_tokens_compensation.test.sql,
  then the load scripts in load/workflow/. Idempotent: safe to run twice. Service-role only: RLS on, no policies, no grants to anon/authenticated
  (the owner-facing run views read the audit log, not these tables).

  Requires 20270210000000_workflow_compiler.sql and 20270301000100_workflow_runtime_extensions.sql.

  ## What already existed (NOT duplicated here)
  - compiled_workflow_step_keys with PRIMARY KEY (key) + cwf_claim_step()  => at-most-once side effects (kept as is)
  - kill switch WORKFLOW_PARALLEL_ENABLED in workflow-graph-executor        => kept; the two new flags below only ever narrow it

  ## What this adds
  1. compiled_workflow_tokens          — one row per parallel branch / fan-out item. UNIQUE (run_id, scope_key) makes spawning idempotent.
  2. cwf_token_spawn / cwf_token_claim / cwf_token_save / cwf_token_cancel — idempotent spawn, lease-based claim (FOR UPDATE SKIP LOCKED), guarded save.
  3. compiled_workflow_compensations   — durable saga state. UNIQUE (run_id, node_id): every undo is planned and run at most once.
  4. compiled_workflow_runs.status gains 'compensating'; claim_compiled_runs() now also leases compensating runs.
  5. CHECK on step keys: a key must start with its own run id (previously enforced only inside cwf_claim_step).

  ## Runtime flags (secrets on workflow-graph-executor; all default OFF)
  WORKFLOW_PARALLEL_ENABLED=true            existing kill switch for parallel / foreach
  WORKFLOW_TOKENS_ENABLED=true              use the token executor for parallel / foreach (needs PARALLEL_ENABLED too)
  WORKFLOW_DURABLE_COMPENSATION=true        use compensating state + compiled_workflow_compensations instead of in-tick undo

  ## Rollback (before real data): turn the flags off first, then
    UPDATE compiled_workflow_runs SET status = 'failed', stop_reason = COALESCE(stop_reason, 'rolled_back') WHERE status = 'compensating';
    DROP FUNCTION IF EXISTS cwf_token_cancel(uuid, uuid, text), cwf_token_spawn(uuid, uuid, text, text, jsonb), cwf_token_claim(uuid, uuid, text, integer, integer),
      cwf_token_save(uuid, uuid, text, text, integer, text, text, jsonb, text), cwf_comp_plan(uuid, uuid, jsonb), cwf_comp_claim(uuid, uuid, integer);
    DROP TABLE IF EXISTS compiled_workflow_compensations, compiled_workflow_tokens;
    (re-create the old status CHECK and claim_compiled_runs from 20270210000000 if the compensating status must be removed again)
*/

-- =============================================================
-- 1. Tokens
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES compiled_workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  parent_node text NOT NULL CHECK (char_length(parent_node) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('branch', 'item')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 199),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 3 AND 160),
  cursor text,
  hops integer NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  inflight_node text,
  output jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output) = 'object' AND pg_column_size(output) <= 65536),
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- THE idempotency constraint: a (run, scope) pair can only ever have one token, however many ticks try to spawn it.
  CONSTRAINT cwt_unique_scope UNIQUE (run_id, scope_key),
  CONSTRAINT cwt_scope_matches CHECK (scope_key = parent_node || ':' || CASE kind WHEN 'branch' THEN 'b' ELSE 'i' END || ordinal::text),
  CONSTRAINT cwt_branch_has_cursor CHECK (kind <> 'branch' OR cursor IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_cwt_run_parent ON compiled_workflow_tokens (run_id, parent_node, ordinal);
CREATE INDEX IF NOT EXISTS idx_cwt_claimable ON compiled_workflow_tokens (run_id, parent_node) WHERE status IN ('pending', 'running');
ALTER TABLE compiled_workflow_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON compiled_workflow_tokens FROM anon, authenticated;

/** Idempotent spawn. p_starts = [{"ordinal":0,"cursor":"nodeA"}, ...] (cursor may be null for foreach items). Returns the number of NEW rows. */
CREATE OR REPLACE FUNCTION public.cwf_token_spawn(p_run_id uuid, p_user_id uuid, p_parent text, p_kind text, p_starts jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF p_kind NOT IN ('branch', 'item') THEN RAISE EXCEPTION 'invalid kind'; END IF;
  IF jsonb_typeof(p_starts) <> 'array' OR jsonb_array_length(p_starts) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid starts'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compiled_workflow_runs WHERE id = p_run_id AND user_id = p_user_id) THEN RAISE EXCEPTION 'run not found'; END IF;
  INSERT INTO compiled_workflow_tokens (run_id, user_id, parent_node, kind, ordinal, scope_key, cursor)
  SELECT p_run_id, p_user_id, p_parent, p_kind, (e->>'ordinal')::int,
         p_parent || ':' || CASE p_kind WHEN 'branch' THEN 'b' ELSE 'i' END || (e->>'ordinal'), NULLIF(e->>'cursor', '')
    FROM jsonb_array_elements(p_starts) e
  ON CONFLICT (run_id, scope_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

/*
  Lease up to p_limit tokens of one parent. A 'running' token whose lease expired belonged to a process that died mid-node: if it had an
  inflight_node the outcome is UNKNOWN, so it is failed (never re-run) — otherwise it is simply re-leased. p_limit is also the concurrency
  cap for fan-out: tokens already leased (running, lease valid) count against it.
*/
CREATE OR REPLACE FUNCTION public.cwf_token_claim(p_run_id uuid, p_user_id uuid, p_parent text, p_limit integer, p_lease_seconds integer DEFAULT 90)
RETURNS SETOF compiled_workflow_tokens LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_busy integer; v_room integer;
BEGIN
  UPDATE compiled_workflow_tokens SET status = 'failed', error = 'interrupted: outcome unknown, not re-run', inflight_node = NULL, lease_until = NULL, updated_at = now()
   WHERE run_id = p_run_id AND user_id = p_user_id AND parent_node = p_parent AND status = 'running' AND lease_until < now() AND inflight_node IS NOT NULL;
  SELECT count(*) INTO v_busy FROM compiled_workflow_tokens
   WHERE run_id = p_run_id AND user_id = p_user_id AND parent_node = p_parent AND status = 'running' AND lease_until >= now();
  v_room := GREATEST(0, LEAST(p_limit, 50) - v_busy);
  IF v_room = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT id FROM compiled_workflow_tokens
     WHERE run_id = p_run_id AND user_id = p_user_id AND parent_node = p_parent
       AND (status = 'pending' OR (status = 'running' AND lease_until < now()))
     ORDER BY ordinal LIMIT v_room FOR UPDATE SKIP LOCKED)
  UPDATE compiled_workflow_tokens t SET status = 'running', attempts = t.attempts + 1, lease_until = now() + make_interval(secs => GREATEST(10, LEAST(p_lease_seconds, 600))), updated_at = now()
    FROM due WHERE t.id = due.id RETURNING t.*;
END $$;

/* Guarded write. A terminal token never changes (invariant I3); only a token currently leased as 'running' can be saved (false = lease lost: stop, do not execute). */
CREATE OR REPLACE FUNCTION public.cwf_token_save(
  p_run_id uuid, p_user_id uuid, p_scope text, p_status text, p_hops integer, p_cursor text, p_inflight text, p_output jsonb, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF p_status NOT IN ('pending', 'running', 'succeeded', 'failed', 'cancelled') THEN RAISE EXCEPTION 'invalid status'; END IF;  -- 'pending' = release the lease (deadline yield)
  UPDATE compiled_workflow_tokens
     SET status = p_status, hops = p_hops, cursor = COALESCE(p_cursor, cursor), inflight_node = p_inflight,
         output = COALESCE(p_output, output), error = left(p_error, 300),
         lease_until = CASE WHEN p_status = 'running' THEN now() + interval '90 seconds' ELSE NULL END, updated_at = now()
   WHERE run_id = p_run_id AND user_id = p_user_id AND scope_key = p_scope AND status = 'running';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

/* Join released / fail-fast: open siblings that nobody is executing stop here. Leased ones finish their current node (cannot be pre-empted). */
CREATE OR REPLACE FUNCTION public.cwf_token_cancel(p_run_id uuid, p_user_id uuid, p_parent text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE compiled_workflow_tokens SET status = 'cancelled', lease_until = NULL, updated_at = now()
   WHERE run_id = p_run_id AND user_id = p_user_id AND parent_node = p_parent
     AND (status = 'pending' OR (status = 'running' AND lease_until < now() AND inflight_node IS NULL));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- =============================================================
-- 2. Durable compensation (saga) state
-- =============================================================
CREATE TABLE IF NOT EXISTS compiled_workflow_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES compiled_workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 80),         -- the action that is being undone
  compensator text NOT NULL CHECK (char_length(compensator) BETWEEN 1 AND 80), -- the side node that undoes it
  seq integer NOT NULL CHECK (seq >= 0),                                        -- completion order of the original action
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'manual')),
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cwc_unique_step UNIQUE (run_id, node_id)    -- I4: every step is undone at most once
);
CREATE INDEX IF NOT EXISTS idx_cwc_run ON compiled_workflow_compensations (run_id, seq DESC);
ALTER TABLE compiled_workflow_compensations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON compiled_workflow_compensations FROM anon, authenticated;

/* p_steps = [{"node_id","compensator","seq","manual":bool}] ; idempotent (re-planning after a crash inserts nothing new). */
CREATE OR REPLACE FUNCTION public.cwf_comp_plan(p_run_id uuid, p_user_id uuid, p_steps jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  IF jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) > 200 THEN RAISE EXCEPTION 'invalid steps'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compiled_workflow_runs WHERE id = p_run_id AND user_id = p_user_id) THEN RAISE EXCEPTION 'run not found'; END IF;
  INSERT INTO compiled_workflow_compensations (run_id, user_id, node_id, compensator, seq, status)
  SELECT p_run_id, p_user_id, e->>'node_id', e->>'compensator', (e->>'seq')::int, CASE WHEN COALESCE((e->>'manual')::boolean, false) THEN 'manual' ELSE 'pending' END
    FROM jsonb_array_elements(p_steps) e
  ON CONFLICT (run_id, node_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

/* Lease the NEXT undo in reverse completion order (highest seq first, strictly one at a time). A 'running' step whose lease expired had an unknown outcome: failed, never repeated. */
CREATE OR REPLACE FUNCTION public.cwf_comp_claim(p_run_id uuid, p_user_id uuid, p_lease_seconds integer DEFAULT 90)
RETURNS SETOF compiled_workflow_compensations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE compiled_workflow_compensations SET status = 'failed', error = 'interrupted: outcome unknown, not repeated', lease_until = NULL, updated_at = now()
   WHERE run_id = p_run_id AND user_id = p_user_id AND status = 'running' AND lease_until < now();
  IF EXISTS (SELECT 1 FROM compiled_workflow_compensations WHERE run_id = p_run_id AND user_id = p_user_id AND status = 'running') THEN RETURN; END IF;
  RETURN QUERY
  WITH nxt AS (
    SELECT id FROM compiled_workflow_compensations WHERE run_id = p_run_id AND user_id = p_user_id AND status = 'pending'
     ORDER BY seq DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
  UPDATE compiled_workflow_compensations c SET status = 'running', lease_until = now() + make_interval(secs => GREATEST(10, LEAST(p_lease_seconds, 600))), updated_at = now()
    FROM nxt WHERE c.id = nxt.id RETURNING c.*;
END $$;

-- =============================================================
-- 3. Run status 'compensating' + claim function
-- =============================================================
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'public.compiled_workflow_runs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%waiting_approval%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.compiled_workflow_runs DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE public.compiled_workflow_runs ADD CONSTRAINT compiled_workflow_runs_status_check
    CHECK (status IN ('active', 'waiting_approval', 'waiting_timer', 'compensating', 'completed', 'failed', 'cancelled'));
END $$;

DROP INDEX IF EXISTS public.idx_cwr_due;
CREATE INDEX idx_cwr_due ON compiled_workflow_runs(next_wake_at) WHERE status IN ('active', 'waiting_timer', 'compensating');

CREATE OR REPLACE FUNCTION public.claim_compiled_runs(p_limit integer, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF compiled_workflow_runs LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM compiled_workflow_runs
     WHERE status IN ('active', 'waiting_timer', 'compensating') AND next_wake_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY next_wake_at LIMIT GREATEST(1, LEAST(p_limit, 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE compiled_workflow_runs r SET locked_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE r.id = due.id RETURNING r.*;
$$;
REVOKE ALL ON FUNCTION public.claim_compiled_runs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_compiled_runs(integer, integer) TO service_role;

-- A step key must start with its own run id (previously only cwf_claim_step enforced this).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cwsk_key_starts_with_run' AND conrelid = 'public.compiled_workflow_step_keys'::regclass) THEN
    ALTER TABLE public.compiled_workflow_step_keys ADD CONSTRAINT cwsk_key_starts_with_run CHECK (left(key, 37) = run_id::text || ':') NOT VALID;
    ALTER TABLE public.compiled_workflow_step_keys VALIDATE CONSTRAINT cwsk_key_starts_with_run;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.cwf_token_spawn(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cwf_token_claim(uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cwf_token_save(uuid, uuid, text, text, integer, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cwf_token_cancel(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cwf_token_cancel(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.cwf_comp_plan(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cwf_comp_claim(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cwf_token_spawn(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cwf_token_claim(uuid, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cwf_token_save(uuid, uuid, text, text, integer, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cwf_comp_plan(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cwf_comp_claim(uuid, uuid, integer) TO service_role;
