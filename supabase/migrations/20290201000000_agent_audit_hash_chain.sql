-- Tamper-evident audit chain over agent_action_log (per tenant).
-- agent_action_log rows legitimately change status (pending -> approved -> executed),
-- so the log itself can't be immutable. Instead EVERY insert/update is appended to an
-- immutable per-tenant hash chain. Editing/deleting a log row or a chain row later is detectable.
-- Additive only. Safe on fresh DB and current schema.

CREATE TABLE IF NOT EXISTS public.agent_audit_chain (
  user_id     uuid        NOT NULL,
  seq         bigint      NOT NULL,
  log_id      uuid        NOT NULL,
  event       text        NOT NULL CHECK (event IN ('INSERT','UPDATE')),
  snapshot    jsonb       NOT NULL,
  prev_hash   text        NOT NULL,
  row_hash    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_chain_log ON public.agent_audit_chain (log_id, seq DESC);

ALTER TABLE public.agent_audit_chain ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_audit_chain" ON public.agent_audit_chain;
CREATE POLICY "select_own_agent_audit_chain" ON public.agent_audit_chain FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.agent_audit_chain FROM anon, authenticated;
GRANT SELECT ON public.agent_audit_chain TO authenticated;

-- Chain rows can never be updated or deleted (also blocks service_role / table owner via trigger).
CREATE OR REPLACE FUNCTION public.agent_audit_chain_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_audit_chain is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_agent_audit_chain_immutable ON public.agent_audit_chain;
CREATE TRIGGER trg_agent_audit_chain_immutable
  BEFORE UPDATE OR DELETE ON public.agent_audit_chain
  FOR EACH ROW EXECUTE FUNCTION public.agent_audit_chain_immutable();

-- Hash helper (sha256 is built into PG >= 11; no extension needed).
CREATE OR REPLACE FUNCTION public.agent_audit_hash(p_prev text, p_seq bigint, p_log uuid, p_event text, p_snap jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_prev || '|' || p_seq::text || '|' || p_log::text || '|' || p_event || '|' || p_snap::text, 'UTF8')), 'hex')
$$;

-- Append on every insert/update of agent_action_log (serialized per tenant).
CREATE OR REPLACE FUNCTION public.agent_audit_chain_append() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prev text; v_seq bigint; v_snap jsonb; v_event text := TG_OP;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_audit_chain:' || NEW.user_id::text, 0));
  SELECT row_hash, seq INTO v_prev, v_seq FROM agent_audit_chain
    WHERE user_id = NEW.user_id ORDER BY seq DESC LIMIT 1;
  v_prev := COALESCE(v_prev, repeat('0', 64));
  v_seq  := COALESCE(v_seq, 0) + 1;
  v_snap := to_jsonb(NEW);
  INSERT INTO agent_audit_chain (user_id, seq, log_id, event, snapshot, prev_hash, row_hash)
  VALUES (NEW.user_id, v_seq, NEW.id, v_event, v_snap, v_prev,
          public.agent_audit_hash(v_prev, v_seq, NEW.id, v_event, v_snap));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_agent_audit_chain_append ON public.agent_action_log;
CREATE TRIGGER trg_agent_audit_chain_append
  AFTER INSERT OR UPDATE ON public.agent_action_log
  FOR EACH ROW EXECUTE FUNCTION public.agent_audit_chain_append();

-- Block hard deletes of audit rows.
CREATE OR REPLACE FUNCTION public.agent_action_log_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_action_log rows cannot be deleted' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_agent_action_log_no_delete ON public.agent_action_log;
CREATE TRIGGER trg_agent_action_log_no_delete
  BEFORE DELETE ON public.agent_action_log
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_log_no_delete();

-- Verification: recompute the whole chain + compare each live row with its latest snapshot.
CREATE OR REPLACE FUNCTION public.verify_agent_audit_chain(p_user_id uuid)
RETURNS TABLE (ok boolean, checked bigint, broken_seq bigint, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_prev text := repeat('0', 64); v_expect bigint := 1; v_n bigint := 0; live record;
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not allowed to verify another account.' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT * FROM agent_audit_chain WHERE user_id = p_user_id ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_expect THEN RETURN QUERY SELECT false, v_n, r.seq, 'sequence gap (row removed)'; RETURN; END IF;
    IF r.prev_hash <> v_prev THEN RETURN QUERY SELECT false, v_n, r.seq, 'prev_hash mismatch'; RETURN; END IF;
    IF r.row_hash <> public.agent_audit_hash(r.prev_hash, r.seq, r.log_id, r.event, r.snapshot) THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'row_hash mismatch (chain row altered)'; RETURN;
    END IF;
    v_prev := r.row_hash; v_expect := r.seq + 1;
  END LOOP;
  -- live rows must equal the latest snapshot (detects edits made while triggers were bypassed)
  FOR live IN
    SELECT l.id, to_jsonb(l) AS j,
           (SELECT c.snapshot FROM agent_audit_chain c WHERE c.log_id = l.id ORDER BY c.seq DESC LIMIT 1) AS snap,
           (SELECT c.seq FROM agent_audit_chain c WHERE c.log_id = l.id ORDER BY c.seq DESC LIMIT 1) AS seq
    FROM agent_action_log l WHERE l.user_id = p_user_id
  LOOP
    IF live.snap IS NULL THEN
      RETURN QUERY SELECT false, v_n, NULL::bigint, 'log row has no chain entry: ' || live.id::text; RETURN;
    ELSIF live.j IS DISTINCT FROM live.snap THEN
      RETURN QUERY SELECT false, v_n, live.seq, 'log row differs from audited snapshot: ' || live.id::text; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::text;
END $$;
REVOKE ALL ON FUNCTION public.verify_agent_audit_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_agent_audit_chain(uuid) TO authenticated, service_role;

-- Backfill: seed chain for pre-existing log rows (once, in created_at order).
DO $$
DECLARE r record; v_prev text; v_seq bigint;
BEGIN
  FOR r IN SELECT * FROM agent_action_log l
           WHERE NOT EXISTS (SELECT 1 FROM agent_audit_chain c WHERE c.log_id = l.id)
           ORDER BY l.user_id, l.created_at, l.id LOOP
    SELECT row_hash, seq INTO v_prev, v_seq FROM agent_audit_chain WHERE user_id = r.user_id ORDER BY seq DESC LIMIT 1;
    v_prev := COALESCE(v_prev, repeat('0', 64)); v_seq := COALESCE(v_seq, 0) + 1;
    INSERT INTO agent_audit_chain (user_id, seq, log_id, event, snapshot, prev_hash, row_hash)
    VALUES (r.user_id, v_seq, r.id, 'INSERT', to_jsonb(r), v_prev,
            public.agent_audit_hash(v_prev, v_seq, r.id, 'INSERT', to_jsonb(r)));
  END LOOP;
END $$;

-- Rollback (manual, only if needed):
--   DROP TRIGGER trg_agent_audit_chain_append ON public.agent_action_log;
--   DROP TRIGGER trg_agent_action_log_no_delete ON public.agent_action_log;
--   (chain table is kept on purpose; dropping it destroys audit evidence)
