/*
  Vireek Agent Network — MCP server + A2A endpoint (data layer)

  Lets EXTERNAL agents (other AI assistants, CRM / insurance / property /
  accounting agents) use Vireek through one governed door:
    - MCP  (Model Context Protocol, Streamable HTTP)  -> edge function mcp-server
    - A2A  (Agent2Agent, JSON-RPC)                    -> same function, /a2a

  Adds:
    agent_network_clients  per-agent credentials (hashed key, per-tool scopes,
                           expiry, daily quota). Separate from api_keys on
                           purpose: those keys are read-only REST keys and
                           must never gain write power by accident.
    agent_network_calls    audit log + idempotency + approval state for every call
    4 governance actions   every WRITE tool goes through evaluate_agent_action,
                           and defaults to "needs human approval"
    RPCs                   auth/quota gate, technician assignment (row-locked),
                           client create / revoke / list, call list

  Purely additive. Admin-only management (owner / admin / can_manage_security).
  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 0) Admin helper --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_network_is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_manage_security')::boolean, false)
    )
  );
$$;
REVOKE ALL ON FUNCTION public.agent_network_is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_network_is_admin() TO authenticated;

-- 1) Clients (one row per external agent credential) ---------------------------
CREATE TABLE IF NOT EXISTS agent_network_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 8 AND 24),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT '{}',
  daily_call_limit integer NOT NULL DEFAULT 1000 CHECK (daily_call_limit BETWEEN 1 AND 100000),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT agent_network_valid_scopes CHECK (
    scopes <@ ARRAY[
      'customers:read', 'equipment:read', 'jobs:read', 'schedule:read', 'inventory:read',
      'quotes:create', 'dispatch:assign', 'messages:send', 'payments:collect'
    ]::text[]
  )
);
CREATE INDEX IF NOT EXISTS idx_agent_network_clients_user ON agent_network_clients (user_id, created_at DESC);

ALTER TABLE agent_network_clients ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: the key hash is never readable by browsers.
-- Management goes through the RPCs below; the edge function uses service role.

CREATE OR REPLACE FUNCTION public.prevent_agent_client_tampering()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.daily_call_limit IS DISTINCT FROM OLD.daily_call_limit
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Agent clients are immutable except for revocation and usage stamps';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Agent client is already revoked';
  END IF;
  IF NEW.revoked_at IS NULL AND OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoked_at can only be set, never cleared';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_agent_network_clients_immutable ON agent_network_clients;
CREATE TRIGGER trg_agent_network_clients_immutable
  BEFORE UPDATE ON agent_network_clients
  FOR EACH ROW EXECUTE FUNCTION public.prevent_agent_client_tampering();

-- 2) Calls (audit + idempotency + approval state) -----------------------------
CREATE TABLE IF NOT EXISTS agent_network_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES agent_network_clients(id) ON DELETE CASCADE,
  protocol text NOT NULL CHECK (protocol IN ('mcp', 'a2a')),
  tool text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 64),
  is_write boolean NOT NULL DEFAULT false,
  idempotency_key text CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  args_hash text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received' CHECK (status IN (
    'received', 'ok', 'pending_approval', 'executing', 'executed', 'rejected', 'canceled', 'failed', 'error'
  )),
  governance_log_id uuid,
  result jsonb,
  error_code text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_network_calls_idem
  ON agent_network_calls (client_id, tool, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_network_calls_client_time ON agent_network_calls (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_network_calls_owner_time ON agent_network_calls (user_id, created_at DESC);

ALTER TABLE agent_network_calls ENABLE ROW LEVEL SECURITY;
-- No policies: reads via list_agent_network_calls(); writes via service role only.

-- 3) Governance actions: every external WRITE needs a human by default ---------
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('agent_net_create_quote',        'mcp-server', 'External agent: create draft quote',        'financial', false, false, true),
  ('agent_net_dispatch_technician', 'mcp-server', 'External agent: assign technician to job',  'other',     false, false, true),
  ('agent_net_send_message',        'mcp-server', 'External agent: send customer SMS',         'messaging', false, false, true),
  ('agent_net_collect_payment',     'mcp-server', 'External agent: create payment link',       'financial', false, false, true)
ON CONFLICT (slug) DO NOTHING;

-- 4) Edge-function gate: authenticate + expiry + burst + daily quota -----------
CREATE OR REPLACE FUNCTION public.agent_network_begin(p_key_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c agent_network_clients;
  v_burst integer;
  v_day integer;
BEGIN
  SELECT * INTO c FROM agent_network_clients WHERE key_hash = p_key_hash;
  IF NOT FOUND OR c.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key');
  END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT count(*) INTO v_burst FROM agent_network_calls
    WHERE client_id = c.id AND created_at > now() - interval '1 minute';
  IF v_burst >= 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', 30);
  END IF;
  SELECT count(*) INTO v_day FROM agent_network_calls
    WHERE client_id = c.id AND created_at > now() - interval '24 hours';
  IF v_day >= c.daily_call_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'retry_after', 3600);
  END IF;

  IF c.last_used_at IS NULL OR c.last_used_at < now() - interval '1 minute' THEN
    UPDATE agent_network_clients SET last_used_at = now() WHERE id = c.id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'client_id', c.id, 'user_id', c.user_id,
                            'name', c.name, 'scopes', to_jsonb(c.scopes));
END;
$$;

-- 5) Row-locked technician assignment (service role only) ----------------------
-- Same capacity rule as the dashboard's assignment RPC, but takes the owner
-- explicitly because an agent has no auth.uid().
CREATE OR REPLACE FUNCTION public.agent_network_assign_technician(
  p_owner uuid, p_job_id uuid, p_technician_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job record;
  v_tech record;
  v_load integer;
  v_capacity integer;
  v_day date;
BEGIN
  SELECT id, user_id, scheduled_datetime, job_status, assigned_technician_id INTO v_job
    FROM jobs WHERE id = p_job_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.'); END IF;
  IF v_job.job_status NOT IN ('scheduled', 'en_route') THEN
    RETURN jsonb_build_object('status', 'not_assignable', 'reason', format('Job is %s.', v_job.job_status));
  END IF;

  SELECT id, member_name, max_jobs_per_day, dispatch_enabled INTO v_tech
    FROM team_members
    WHERE id = p_technician_id AND account_owner_id = p_owner AND role = 'technician' AND invite_status = 'active'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'technician_not_found', 'reason', 'Active technician not found.'); END IF;
  IF NOT v_tech.dispatch_enabled THEN
    RETURN jsonb_build_object('status', 'dispatch_disabled', 'reason', 'This technician is not dispatchable.');
  END IF;

  v_day := coalesce(v_job.scheduled_datetime, now())::date;
  v_capacity := coalesce(v_tech.max_jobs_per_day, 6);
  SELECT count(*) INTO v_load FROM jobs
    WHERE assigned_technician_id = p_technician_id
      AND job_status IN ('scheduled', 'en_route', 'in_progress')
      AND scheduled_datetime::date = v_day AND id <> p_job_id;
  IF v_load >= v_capacity THEN
    RETURN jsonb_build_object('status', 'at_capacity', 'day_load', v_load, 'capacity', v_capacity,
                              'reason', format('%s already has %s of %s jobs that day.', v_tech.member_name, v_load, v_capacity));
  END IF;

  UPDATE jobs SET assigned_technician_id = p_technician_id WHERE id = p_job_id;
  RETURN jsonb_build_object('status', 'assigned', 'technician_id', p_technician_id,
                            'technician_name', v_tech.member_name, 'day_load', v_load + 1, 'capacity', v_capacity,
                            'previous_technician_id', v_job.assigned_technician_id);
END;
$$;

-- 6) Management RPCs (admins only) ---------------------------------------------
CREATE OR REPLACE FUNCTION public.create_agent_network_client(
  p_name text, p_scopes text[], p_key_prefix text, p_key_hash text,
  p_daily_call_limit integer DEFAULT 1000, p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN RAISE EXCEPTION 'Pick at least one scope'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN RAISE EXCEPTION 'Expiry must be in the future'; END IF;
  IF (SELECT count(*) FROM agent_network_clients WHERE user_id = v_owner AND revoked_at IS NULL) >= 25 THEN
    RAISE EXCEPTION 'Too many active agent clients (max 25). Revoke one first.';
  END IF;

  INSERT INTO agent_network_clients (user_id, name, key_prefix, key_hash, scopes, daily_call_limit, expires_at)
  VALUES (v_owner, btrim(p_name), p_key_prefix, p_key_hash, p_scopes, p_daily_call_limit, p_expires_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_agent_network_client(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE agent_network_clients SET revoked_at = now()
    WHERE id = p_id AND user_id = v_owner AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Client not found or already revoked'; END IF;
  -- Anything still waiting on a human for this client can no longer run.
  UPDATE agent_network_calls SET status = 'canceled', updated_at = now()
    WHERE client_id = p_id AND status IN ('received', 'pending_approval');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_agent_network_clients()
RETURNS TABLE (
  id uuid, name text, key_prefix text, scopes text[], daily_call_limit integer,
  expires_at timestamptz, last_used_at timestamptz, created_at timestamptz, revoked_at timestamptz,
  calls_24h bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name, c.key_prefix, c.scopes, c.daily_call_limit, c.expires_at, c.last_used_at, c.created_at, c.revoked_at,
         (SELECT count(*) FROM agent_network_calls k WHERE k.client_id = c.id AND k.created_at > now() - interval '24 hours')
  FROM agent_network_clients c
  WHERE c.user_id = v_owner
  ORDER BY c.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_agent_network_calls(p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (
  id uuid, client_name text, protocol text, tool text, is_write boolean, status text,
  governance_log_id uuid, error_code text, latency_ms integer, args jsonb, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
  SELECT k.id, c.name, k.protocol, k.tool, k.is_write, k.status, k.governance_log_id, k.error_code, k.latency_ms,
         CASE WHEN k.is_write THEN k.args ELSE '{}'::jsonb END, k.created_at
  FROM agent_network_calls k
  JOIN agent_network_clients c ON c.id = k.client_id
  WHERE k.user_id = v_owner AND (p_before IS NULL OR k.created_at < p_before)
  ORDER BY k.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_network_begin(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_network_assign_technician(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_agent_network_client(text, text[], text, text, integer, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_agent_network_client(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_agent_network_clients() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_agent_network_calls(integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_agent_network_client(text, text[], text, text, integer, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_network_client(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_agent_network_clients() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_agent_network_calls(integer, timestamptz) TO authenticated;
