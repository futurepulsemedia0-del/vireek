/*
  # Vireek AI Agent Marketplace — Platform layer

  Turns Vireek from an application into a platform: companies install
  third-party (or first-party) agents under permissions + sandbox + audit
  + billing. It is built ON TOP of the existing governance system
  (20261121000000_ai_agent_governance.sql) — it does not replace it:

  - Capability scopes (read:* / act:*) are granted per install, per
    account. An agent can never exceed what the owner granted.
  - Every action an agent proposes still passes evaluate_agent_action()
    (approval queue, spend limits, audit) via 3 new catalog slugs, so the
    existing Agent Governance page controls marketplace agents too.
  - Agents never receive credentials or DB access. Third-party agents are
    external HTTPS endpoints called by the agent-runtime edge function
    with HMAC-signed, scope-minimized context; they only RETURN proposed
    actions, which the broker validates and executes.
  - Tamper-evident audit: hash-chained, append-only.
  - Billing: append-only ledger (usage / subscription / adjustment) with
    platform fee + publisher payout split and per-install spend caps.

  RLS mirrors the governance migration: whole-account SELECT via
  get_account_owner_id(); NO client INSERT/UPDATE/DELETE policies — every
  write goes through a SECURITY DEFINER RPC or the service role.
*/

-- =============================================================
-- 1. Governance catalog slugs (so existing Agent Governance UI applies)
-- =============================================================
INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('mkt_record_insight', 'agent-runtime', 'Marketplace agent: record insight', 'other', false, false, false),
  ('mkt_create_task', 'agent-runtime', 'Marketplace agent: hand off a task', 'other', false, false, false),
  ('mkt_send_sms', 'agent-runtime', 'Marketplace agent: send SMS to a customer', 'messaging', false, false, true)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- 2. Scope catalog (reference data)
-- =============================================================
CREATE TABLE IF NOT EXISTS marketplace_scopes (
  slug text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read', 'act')),
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  governance_slug text REFERENCES agent_action_catalog(slug)
);

ALTER TABLE marketplace_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_select_marketplace_scopes" ON marketplace_scopes;
CREATE POLICY "authenticated_select_marketplace_scopes" ON marketplace_scopes FOR SELECT TO authenticated USING (true);

INSERT INTO marketplace_scopes (slug, label, description, kind, risk, governance_slug) VALUES
  ('read:jobs', 'Read job details', 'Service type, schedule, status, timing and safety flags of jobs. No customer name, address or financials.', 'read', 'low', NULL),
  ('read:job_financials', 'Read job invoice data', 'Invoice amount and invoice status on jobs.', 'read', 'medium', NULL),
  ('read:customers', 'Read customer profile', 'Customer name, type, lifecycle stage, tags. No phone, email, address or notes.', 'read', 'medium', NULL),
  ('read:customer_contact', 'Read customer contact details', 'Customer phone, email and address (personal data).', 'read', 'high', NULL),
  ('act:record_insight', 'Post insights', 'Write recommendations and alerts into your Agent Marketplace feed.', 'act', 'low', 'mkt_record_insight'),
  ('act:create_task', 'Hand off tasks', 'Create tasks on the shared agent task board for your team to review.', 'act', 'medium', 'mkt_create_task'),
  ('act:send_sms', 'Send SMS to customers', 'Propose SMS messages to your customers (A2P + opt-out rules always apply; approval required by default).', 'act', 'high', 'mkt_send_sms')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- 3. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.marketplace_can_manage()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    auth.uid() = public.get_account_owner_id()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_manage_security')::boolean, false)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.marketplace_valid_triggers()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['manual', 'schedule.daily', 'job.scheduled', 'job.completed', 'invoice.overdue', 'quote.declined']::text[];
$$;

CREATE OR REPLACE FUNCTION public.validate_marketplace_manifest(p_manifest jsonb)
RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE
  v_item text;
  v_n integer;
BEGIN
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
    RAISE EXCEPTION 'Manifest must be a JSON object.';
  END IF;

  IF jsonb_typeof(p_manifest -> 'scopes') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_manifest -> 'scopes') NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'manifest.scopes must be an array of 1-12 scopes.';
  END IF;
  FOR v_item IN SELECT jsonb_array_elements_text(p_manifest -> 'scopes') LOOP
    IF NOT EXISTS (SELECT 1 FROM marketplace_scopes WHERE slug = v_item) THEN
      RAISE EXCEPTION 'Unknown scope: %', v_item;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_manifest -> 'triggers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_manifest -> 'triggers') NOT BETWEEN 1 AND 6 THEN
    RAISE EXCEPTION 'manifest.triggers must be an array of 1-6 triggers.';
  END IF;
  FOR v_item IN SELECT jsonb_array_elements_text(p_manifest -> 'triggers') LOOP
    IF NOT (v_item = ANY (public.marketplace_valid_triggers())) THEN
      RAISE EXCEPTION 'Unknown trigger: %', v_item;
    END IF;
  END LOOP;

  IF jsonb_exists(p_manifest, 'limits') THEN
    IF jsonb_typeof(p_manifest -> 'limits') <> 'object' THEN
      RAISE EXCEPTION 'manifest.limits must be an object.';
    END IF;
    IF jsonb_exists(p_manifest -> 'limits', 'timeout_ms') THEN
      IF jsonb_typeof(p_manifest -> 'limits' -> 'timeout_ms') <> 'number' THEN RAISE EXCEPTION 'limits.timeout_ms must be a number.'; END IF;
      v_n := (p_manifest -> 'limits' ->> 'timeout_ms')::numeric::integer;
      IF v_n NOT BETWEEN 1000 AND 15000 THEN RAISE EXCEPTION 'limits.timeout_ms must be 1000-15000.'; END IF;
    END IF;
    IF jsonb_exists(p_manifest -> 'limits', 'max_actions') THEN
      IF jsonb_typeof(p_manifest -> 'limits' -> 'max_actions') <> 'number' THEN RAISE EXCEPTION 'limits.max_actions must be a number.'; END IF;
      v_n := (p_manifest -> 'limits' ->> 'max_actions')::numeric::integer;
      IF v_n NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'limits.max_actions must be 1-10.'; END IF;
    END IF;
  END IF;

  IF jsonb_exists(p_manifest, 'system_prompt') THEN
    IF jsonb_typeof(p_manifest -> 'system_prompt') <> 'string' OR length(p_manifest ->> 'system_prompt') > 4000 THEN
      RAISE EXCEPTION 'manifest.system_prompt must be a string up to 4000 characters.';
    END IF;
  END IF;
END;
$$;

-- =============================================================
-- 4. Agents / versions / secrets
-- =============================================================
CREATE TABLE IF NOT EXISTS marketplace_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,47}$'),
  publisher_id uuid,                       -- NULL = first-party (Vireek)
  publisher_name text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  tagline text NOT NULL CHECK (length(tagline) <= 160),
  description text NOT NULL CHECK (length(description) <= 2000),
  category text NOT NULL CHECK (category IN ('hvac','plumbing','electrical','collections','revenue','dispatch','warranty','compliance','general')),
  runtime text NOT NULL CHECK (runtime IN ('builtin', 'webhook')),
  endpoint_url text CHECK (endpoint_url IS NULL OR (endpoint_url ~ '^https://' AND length(endpoint_url) <= 2048)),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'suspended')),
  pricing_model text NOT NULL DEFAULT 'free' CHECK (pricing_model IN ('free', 'per_run', 'monthly')),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0 AND price_cents <= 1000000),
  platform_fee_bps integer NOT NULL DEFAULT 2000 CHECK (platform_fee_bps BETWEEN 0 AND 5000),
  current_version_id uuid,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_agents_webhook_needs_endpoint CHECK (runtime <> 'webhook' OR endpoint_url IS NOT NULL),
  CONSTRAINT marketplace_agents_price_matches_model CHECK ((pricing_model = 'free') = (price_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_agents_status ON marketplace_agents(status, category);
CREATE INDEX IF NOT EXISTS idx_marketplace_agents_publisher ON marketplace_agents(publisher_id) WHERE publisher_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES marketplace_agents(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'deprecated')),
  review_notes text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

-- Signing secrets: RLS on, NO policies => unreachable from the client.
CREATE TABLE IF NOT EXISTS marketplace_agent_secrets (
  agent_id uuid PRIMARY KEY REFERENCES marketplace_agents(id) ON DELETE CASCADE,
  signing_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketplace_agent_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON marketplace_agent_secrets FROM anon, authenticated;

ALTER TABLE marketplace_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_published_or_own_marketplace_agents" ON marketplace_agents;
CREATE POLICY "select_published_or_own_marketplace_agents" ON marketplace_agents FOR SELECT TO authenticated
  USING (status = 'published' OR publisher_id = auth.uid());

ALTER TABLE marketplace_agent_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_visible_marketplace_versions" ON marketplace_agent_versions;
CREATE POLICY "select_visible_marketplace_versions" ON marketplace_agent_versions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM marketplace_agents a
    WHERE a.id = marketplace_agent_versions.agent_id
      AND (a.publisher_id = auth.uid()
           OR (a.status = 'published' AND marketplace_agent_versions.status IN ('approved', 'deprecated')))
  ));

-- =============================================================
-- 5. Installs
-- =============================================================
CREATE TABLE IF NOT EXISTS marketplace_agent_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES marketplace_agents(id),
  version_id uuid NOT NULL REFERENCES marketplace_agent_versions(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  max_runs_per_day integer NOT NULL DEFAULT 100 CHECK (max_runs_per_day BETWEEN 1 AND 10000),
  max_monthly_spend_cents integer NOT NULL DEFAULT 0 CHECK (max_monthly_spend_cents >= 0),
  installed_by uuid NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_installs_active_agent
  ON marketplace_agent_installs(user_id, agent_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user_active
  ON marketplace_agent_installs(user_id) WHERE status = 'active';

ALTER TABLE marketplace_agent_installs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_marketplace_installs" ON marketplace_agent_installs;
CREATE POLICY "select_own_marketplace_installs" ON marketplace_agent_installs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 6. Runs, outputs
-- =============================================================
CREATE TABLE IF NOT EXISTS marketplace_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id uuid NOT NULL REFERENCES marketplace_agent_installs(id),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version_id uuid NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'blocked')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,  -- scrubbed after processing (data minimization)
  summary text,
  actions_proposed integer NOT NULL DEFAULT 0,
  actions_executed integer NOT NULL DEFAULT 0,
  actions_pending integer NOT NULL DEFAULT 0,
  actions_rejected integer NOT NULL DEFAULT 0,
  duration_ms integer,
  cost_cents integer NOT NULL DEFAULT 0,
  error text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_marketplace_runs_user_created ON marketplace_agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_runs_install_created ON marketplace_agent_runs(install_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_runs_queue ON marketplace_agent_runs(created_at) WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_runs_correlation
  ON marketplace_agent_runs(install_id, correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_agent_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES marketplace_agent_runs(id) ON DELETE CASCADE,
  install_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'insight' CHECK (kind IN ('insight', 'recommendation')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  body text NOT NULL,
  entity_type text CHECK (entity_type IS NULL OR entity_type IN ('job', 'customer')),
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_outputs_user_created ON marketplace_agent_outputs(user_id, created_at DESC);

ALTER TABLE marketplace_agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_marketplace_runs" ON marketplace_agent_runs;
CREATE POLICY "select_own_marketplace_runs" ON marketplace_agent_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

ALTER TABLE marketplace_agent_outputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_marketplace_outputs" ON marketplace_agent_outputs;
CREATE POLICY "select_own_marketplace_outputs" ON marketplace_agent_outputs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 7. Append-only ledger + hash-chained audit
-- =============================================================
CREATE OR REPLACE FUNCTION public.marketplace_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME;
END;
$$;

CREATE TABLE IF NOT EXISTS marketplace_agent_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  install_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  run_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('usage', 'subscription', 'adjustment')),
  amount_cents integer NOT NULL,
  platform_fee_cents integer NOT NULL,
  publisher_payout_cents integer NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_ledger_usage_run ON marketplace_agent_ledger(run_id) WHERE entry_type = 'usage';
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_ledger_subscription ON marketplace_agent_ledger(install_id, period) WHERE entry_type = 'subscription';
CREATE INDEX IF NOT EXISTS idx_marketplace_ledger_user_period ON marketplace_agent_ledger(user_id, period);
CREATE INDEX IF NOT EXISTS idx_marketplace_ledger_install_period ON marketplace_agent_ledger(install_id, period);

DROP TRIGGER IF EXISTS trg_marketplace_ledger_immutable ON marketplace_agent_ledger;
CREATE TRIGGER trg_marketplace_ledger_immutable BEFORE UPDATE OR DELETE ON marketplace_agent_ledger
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_block_mutation();

ALTER TABLE marketplace_agent_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_marketplace_ledger" ON marketplace_agent_ledger;
CREATE POLICY "select_own_marketplace_ledger" ON marketplace_agent_ledger FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS marketplace_agent_audit (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  agent_id uuid,
  install_id uuid,
  actor uuid,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text,
  hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_audit_user ON marketplace_agent_audit(user_id, id DESC);

CREATE OR REPLACE FUNCTION public.marketplace_audit_hash(p_prev text, p_user uuid, p_event text, p_detail jsonb, p_ts timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    COALESCE(p_prev, '') || '|' || p_user::text || '|' || p_event || '|' || p_detail::text || '|' ||
    to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.marketplace_audit_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT hash INTO NEW.prev_hash FROM marketplace_agent_audit WHERE user_id = NEW.user_id ORDER BY id DESC LIMIT 1;
  NEW.hash := public.marketplace_audit_hash(NEW.prev_hash, NEW.user_id, NEW.event, NEW.detail, NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketplace_audit_chain ON marketplace_agent_audit;
CREATE TRIGGER trg_marketplace_audit_chain BEFORE INSERT ON marketplace_agent_audit
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_audit_chain();
DROP TRIGGER IF EXISTS trg_marketplace_audit_immutable ON marketplace_agent_audit;
CREATE TRIGGER trg_marketplace_audit_immutable BEFORE UPDATE OR DELETE ON marketplace_agent_audit
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_block_mutation();

ALTER TABLE marketplace_agent_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_marketplace_audit" ON marketplace_agent_audit;
CREATE POLICY "select_own_marketplace_audit" ON marketplace_agent_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.marketplace_audit_log(
  p_user_id uuid, p_agent_id uuid, p_install_id uuid, p_actor uuid, p_event text, p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO marketplace_agent_audit (user_id, agent_id, install_id, actor, event, detail)
  VALUES (p_user_id, p_agent_id, p_install_id, p_actor, p_event, COALESCE(p_detail, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.marketplace_audit_log(uuid, uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_audit_log(uuid, uuid, uuid, uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_marketplace_audit_chain()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r record;
  v_prev text := NULL;
  v_count integer := 0;
BEGIN
  FOR r IN SELECT * FROM marketplace_agent_audit WHERE user_id = v_owner ORDER BY id LOOP
    v_count := v_count + 1;
    IF r.prev_hash IS DISTINCT FROM v_prev
       OR r.hash <> public.marketplace_audit_hash(v_prev, r.user_id, r.event, r.detail, r.created_at) THEN
      RETURN jsonb_build_object('valid', false, 'checked', v_count, 'broken_at', r.id);
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN jsonb_build_object('valid', true, 'checked', v_count);
END;
$$;

-- =============================================================
-- 8. Publisher RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.register_marketplace_agent(
  p_slug text, p_publisher_name text, p_name text, p_tagline text, p_description text,
  p_category text, p_endpoint_url text, p_pricing_model text DEFAULT 'free', p_price_cents integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_secret text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF (SELECT count(*) FROM marketplace_agents WHERE publisher_id = auth.uid()) >= 10 THEN
    RAISE EXCEPTION 'Publisher limit reached (10 agents).';
  END IF;
  IF length(trim(COALESCE(p_publisher_name, ''))) < 2 THEN RAISE EXCEPTION 'Publisher name is required.'; END IF;

  INSERT INTO marketplace_agents (slug, publisher_id, publisher_name, name, tagline, description, category, runtime, endpoint_url, status, pricing_model, price_cents)
  VALUES (lower(trim(p_slug)), auth.uid(), trim(p_publisher_name), trim(p_name), trim(p_tagline), trim(p_description), p_category, 'webhook', trim(p_endpoint_url), 'draft', p_pricing_model, p_price_cents)
  RETURNING id INTO v_id;

  v_secret := 'whsec_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  INSERT INTO marketplace_agent_secrets (agent_id, signing_secret) VALUES (v_id, v_secret);

  RETURN jsonb_build_object('agent_id', v_id, 'signing_secret', v_secret);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'That agent slug is already taken.';
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_marketplace_agent_version(p_agent_id uuid, p_version text, p_manifest jsonb)
RETURNS marketplace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent marketplace_agents;
  v_row marketplace_agent_versions;
BEGIN
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = p_agent_id AND publisher_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found.'; END IF;
  IF v_agent.status = 'suspended' THEN RAISE EXCEPTION 'This agent is suspended.'; END IF;
  PERFORM public.validate_marketplace_manifest(p_manifest);
  IF v_agent.runtime = 'webhook' AND jsonb_exists(p_manifest, 'system_prompt') THEN
    RAISE EXCEPTION 'system_prompt is only valid for built-in agents.';
  END IF;

  INSERT INTO marketplace_agent_versions (agent_id, version, manifest, manifest_hash)
  VALUES (p_agent_id, p_version, p_manifest, encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex'))
  RETURNING * INTO v_row;

  IF v_agent.status = 'draft' THEN
    UPDATE marketplace_agents SET status = 'in_review', updated_at = now() WHERE id = p_agent_id;
  END IF;
  RETURN v_row;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Version % already exists for this agent.', p_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_marketplace_agent_version(p_version_id uuid, p_approve boolean, p_notes text DEFAULT NULL)
RETURNS marketplace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row marketplace_agent_versions;
  v_agent marketplace_agents;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  SELECT * INTO v_row FROM marketplace_agent_versions WHERE id = p_version_id AND status = 'submitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found or already reviewed.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_row.agent_id;
  IF v_agent.status = 'suspended' THEN RAISE EXCEPTION 'Agent is suspended.'; END IF;

  UPDATE marketplace_agent_versions
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      review_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_version_id RETURNING * INTO v_row;

  IF p_approve THEN
    UPDATE marketplace_agent_versions SET status = 'deprecated'
      WHERE agent_id = v_row.agent_id AND status = 'approved' AND id <> p_version_id;
    UPDATE marketplace_agents SET current_version_id = p_version_id, status = 'published', updated_at = now()
      WHERE id = v_row.agent_id;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.suspend_marketplace_agent(p_agent_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  UPDATE marketplace_agents SET status = 'suspended', suspended_reason = p_reason, updated_at = now() WHERE id = p_agent_id;
  FOR r IN SELECT id, user_id FROM marketplace_agent_installs WHERE agent_id = p_agent_id AND status = 'active' LOOP
    UPDATE marketplace_agent_installs SET status = 'paused', updated_at = now() WHERE id = r.id;
    PERFORM public.marketplace_audit_log(r.user_id, p_agent_id, r.id, auth.uid(), 'agent_suspended', jsonb_build_object('reason', p_reason));
  END LOOP;
END;
$$;

-- =============================================================
-- 9. Customer (account) RPCs: install / settings / status
-- =============================================================
CREATE OR REPLACE FUNCTION public.install_marketplace_agent(
  p_agent_id uuid, p_granted_scopes text[], p_max_runs_per_day integer DEFAULT 100, p_max_monthly_spend_cents integer DEFAULT 0
)
RETURNS marketplace_agent_installs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_agent marketplace_agents;
  v_version marketplace_agent_versions;
  v_requested text[];
  v_row marketplace_agent_installs;
BEGIN
  IF NOT public.marketplace_can_manage() THEN RAISE EXCEPTION 'Only the account owner or a member with security permission can install agents.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = p_agent_id AND status = 'published';
  IF NOT FOUND THEN RAISE EXCEPTION 'This agent is not available.'; END IF;
  SELECT * INTO v_version FROM marketplace_agent_versions WHERE id = v_agent.current_version_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'This agent has no approved version.'; END IF;

  SELECT ARRAY(SELECT jsonb_array_elements_text(v_version.manifest -> 'scopes')) INTO v_requested;
  IF p_granted_scopes IS NULL OR NOT (p_granted_scopes <@ v_requested) THEN
    RAISE EXCEPTION 'Granted scopes must be a subset of the scopes the agent requests.';
  END IF;
  IF p_max_runs_per_day IS NULL OR p_max_runs_per_day NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Runs per day must be 1-10000.'; END IF;
  IF p_max_monthly_spend_cents IS NULL OR p_max_monthly_spend_cents < 0 THEN RAISE EXCEPTION 'Monthly spend cap cannot be negative.'; END IF;
  IF v_agent.pricing_model = 'monthly' AND v_agent.price_cents > p_max_monthly_spend_cents THEN
    RAISE EXCEPTION 'Monthly spend cap is lower than this agent subscription price.';
  END IF;

  INSERT INTO marketplace_agent_installs (user_id, agent_id, version_id, granted_scopes, max_runs_per_day, max_monthly_spend_cents, installed_by)
  VALUES (v_owner, p_agent_id, v_version.id, ARRAY(SELECT DISTINCT unnest(p_granted_scopes) ORDER BY 1), p_max_runs_per_day, p_max_monthly_spend_cents, auth.uid())
  RETURNING * INTO v_row;

  PERFORM public.marketplace_audit_log(v_owner, p_agent_id, v_row.id, auth.uid(), 'installed',
    jsonb_build_object('version', v_version.version, 'manifest_hash', v_version.manifest_hash, 'granted_scopes', v_row.granted_scopes));
  RETURN v_row;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'This agent is already installed.';
END;
$$;

CREATE OR REPLACE FUNCTION public.update_marketplace_install(
  p_install_id uuid, p_granted_scopes text[], p_max_runs_per_day integer, p_max_monthly_spend_cents integer, p_upgrade boolean DEFAULT false
)
RETURNS marketplace_agent_installs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inst marketplace_agent_installs;
  v_agent marketplace_agents;
  v_version marketplace_agent_versions;
  v_requested text[];
  v_row marketplace_agent_installs;
BEGIN
  IF NOT public.marketplace_can_manage() THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO v_inst FROM marketplace_agent_installs WHERE id = p_install_id AND user_id = v_owner AND status <> 'revoked';
  IF NOT FOUND THEN RAISE EXCEPTION 'Install not found.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_inst.agent_id;

  IF p_upgrade THEN
    IF v_agent.status <> 'published' THEN RAISE EXCEPTION 'Agent is not available.'; END IF;
    SELECT * INTO v_version FROM marketplace_agent_versions WHERE id = v_agent.current_version_id AND status = 'approved';
  ELSE
    SELECT * INTO v_version FROM marketplace_agent_versions WHERE id = v_inst.version_id;
  END IF;
  IF v_version.id IS NULL THEN RAISE EXCEPTION 'No approved version available.'; END IF;

  SELECT ARRAY(SELECT jsonb_array_elements_text(v_version.manifest -> 'scopes')) INTO v_requested;
  IF p_granted_scopes IS NULL OR NOT (p_granted_scopes <@ v_requested) THEN
    RAISE EXCEPTION 'Granted scopes must be a subset of the scopes the agent requests.';
  END IF;
  IF p_max_runs_per_day NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Runs per day must be 1-10000.'; END IF;
  IF p_max_monthly_spend_cents < 0 THEN RAISE EXCEPTION 'Monthly spend cap cannot be negative.'; END IF;
  IF v_agent.pricing_model = 'monthly' AND v_agent.price_cents > p_max_monthly_spend_cents THEN
    RAISE EXCEPTION 'Monthly spend cap is lower than this agent subscription price.';
  END IF;

  UPDATE marketplace_agent_installs
  SET version_id = v_version.id,
      granted_scopes = ARRAY(SELECT DISTINCT unnest(p_granted_scopes) ORDER BY 1),
      max_runs_per_day = p_max_runs_per_day,
      max_monthly_spend_cents = p_max_monthly_spend_cents,
      updated_at = now()
  WHERE id = p_install_id RETURNING * INTO v_row;

  PERFORM public.marketplace_audit_log(v_owner, v_inst.agent_id, p_install_id, auth.uid(),
    CASE WHEN v_version.id <> v_inst.version_id THEN 'version_upgraded' ELSE 'settings_updated' END,
    jsonb_build_object('version', v_version.version, 'granted_scopes', v_row.granted_scopes,
      'max_runs_per_day', p_max_runs_per_day, 'max_monthly_spend_cents', p_max_monthly_spend_cents));
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_marketplace_install_status(p_install_id uuid, p_status text)
RETURNS marketplace_agent_installs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inst marketplace_agent_installs;
  v_row marketplace_agent_installs;
BEGIN
  IF NOT public.marketplace_can_manage() THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF p_status NOT IN ('active', 'paused', 'revoked') THEN RAISE EXCEPTION 'Invalid status.'; END IF;
  SELECT * INTO v_inst FROM marketplace_agent_installs WHERE id = p_install_id AND user_id = v_owner AND status <> 'revoked';
  IF NOT FOUND THEN RAISE EXCEPTION 'Install not found.'; END IF;
  IF p_status = 'active' AND NOT EXISTS (SELECT 1 FROM marketplace_agents WHERE id = v_inst.agent_id AND status = 'published') THEN
    RAISE EXCEPTION 'Agent is not available.';
  END IF;

  UPDATE marketplace_agent_installs
  SET status = p_status, updated_at = now(), revoked_at = CASE WHEN p_status = 'revoked' THEN now() ELSE NULL END
  WHERE id = p_install_id RETURNING * INTO v_row;

  IF p_status <> 'active' THEN
    UPDATE marketplace_agent_runs SET status = 'blocked', error = 'Install ' || p_status, finished_at = now(), input = '{}'::jsonb
      WHERE install_id = p_install_id AND status = 'queued';
  END IF;
  PERFORM public.marketplace_audit_log(v_owner, v_inst.agent_id, p_install_id, auth.uid(), 'status_' || p_status, '{}'::jsonb);
  RETURN v_row;
END;
$$;

-- =============================================================
-- 10. Runtime RPCs (service role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.marketplace_install_budget(p_install_id uuid, p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_inst marketplace_agent_installs;
  v_agent marketplace_agents;
  v_runs integer;
  v_spend integer;
  v_next integer;
BEGIN
  SELECT * INTO v_inst FROM marketplace_agent_installs WHERE id = p_install_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'install_missing'); END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_inst.agent_id;

  SELECT count(*) INTO v_runs FROM marketplace_agent_runs
    WHERE install_id = p_install_id AND id <> p_run_id AND status NOT IN ('queued', 'blocked') AND created_at >= date_trunc('day', now());
  SELECT COALESCE(sum(amount_cents), 0) INTO v_spend FROM marketplace_agent_ledger
    WHERE install_id = p_install_id AND period = to_char(now(), 'YYYY-MM');
  v_next := CASE WHEN v_agent.pricing_model = 'per_run' THEN v_agent.price_cents ELSE 0 END;

  IF v_runs >= v_inst.max_runs_per_day THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'daily_run_limit', 'runs_today', v_runs);
  END IF;
  IF v_spend + v_next > v_inst.max_monthly_spend_cents THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'monthly_spend_cap', 'spend_cents', v_spend);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'runs_today', v_runs, 'spend_cents', v_spend);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_marketplace_usage(p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run marketplace_agent_runs;
  v_agent marketplace_agents;
  v_fee integer;
BEGIN
  SELECT * INTO v_run FROM marketplace_agent_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_run.agent_id;
  IF v_agent.pricing_model <> 'per_run' OR v_agent.price_cents <= 0 THEN RETURN 0; END IF;

  v_fee := CASE WHEN v_agent.publisher_id IS NULL THEN v_agent.price_cents
                ELSE (v_agent.price_cents::bigint * v_agent.platform_fee_bps / 10000)::integer END;
  INSERT INTO marketplace_agent_ledger (user_id, install_id, agent_id, run_id, entry_type, amount_cents, platform_fee_cents, publisher_payout_cents, period, description)
  VALUES (v_run.user_id, v_run.install_id, v_run.agent_id, p_run_id, 'usage', v_agent.price_cents, v_fee, v_agent.price_cents - v_fee, to_char(now(), 'YYYY-MM'), 'Per-run usage')
  ON CONFLICT DO NOTHING;
  RETURN v_agent.price_cents;
END;
$$;

CREATE OR REPLACE FUNCTION public.accrue_marketplace_subscriptions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO marketplace_agent_ledger (user_id, install_id, agent_id, entry_type, amount_cents, platform_fee_cents, publisher_payout_cents, period, description)
  SELECT i.user_id, i.id, a.id, 'subscription', a.price_cents,
         CASE WHEN a.publisher_id IS NULL THEN a.price_cents ELSE (a.price_cents::bigint * a.platform_fee_bps / 10000)::integer END,
         a.price_cents - CASE WHEN a.publisher_id IS NULL THEN a.price_cents ELSE (a.price_cents::bigint * a.platform_fee_bps / 10000)::integer END,
         to_char(now(), 'YYYY-MM'), 'Monthly subscription'
  FROM marketplace_agent_installs i
  JOIN marketplace_agents a ON a.id = i.agent_id
  WHERE i.status = 'active' AND a.status = 'published' AND a.pricing_model = 'monthly' AND a.price_cents > 0
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_marketplace_event(p_user_id uuid, p_trigger text, p_input jsonb DEFAULT '{}'::jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT (p_trigger = ANY (public.marketplace_valid_triggers())) THEN RAISE EXCEPTION 'Unknown trigger: %', p_trigger; END IF;
  INSERT INTO marketplace_agent_runs (install_id, user_id, agent_id, version_id, trigger, status, input, correlation_id)
  SELECT i.id, i.user_id, i.agent_id, i.version_id, p_trigger, 'queued', COALESCE(p_input, '{}'::jsonb),
         p_trigger || ':' || COALESCE(p_input ->> 'job_id', p_input ->> 'quote_id', p_input ->> 'invoice_id', md5(COALESCE(p_input, '{}'::jsonb)::text))
  FROM marketplace_agent_installs i
  JOIN marketplace_agent_versions v ON v.id = i.version_id
  WHERE i.user_id = p_user_id AND i.status = 'active' AND jsonb_exists(v.manifest -> 'triggers', p_trigger)
  ON CONFLICT (install_id, correlation_id) WHERE correlation_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_marketplace_daily()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO marketplace_agent_runs (install_id, user_id, agent_id, version_id, trigger, status, input, correlation_id)
  SELECT i.id, i.user_id, i.agent_id, i.version_id, 'schedule.daily', 'queued', '{}'::jsonb, 'daily:' || to_char(now(), 'YYYY-MM-DD')
  FROM marketplace_agent_installs i
  JOIN marketplace_agent_versions v ON v.id = i.version_id
  WHERE i.status = 'active' AND jsonb_exists(v.manifest -> 'triggers', 'schedule.daily')
  ON CONFLICT (install_id, correlation_id) WHERE correlation_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_marketplace_runs(p_limit integer DEFAULT 10)
RETURNS SETOF marketplace_agent_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE marketplace_agent_runs
  SET status = 'failed', error = 'Timed out while running', finished_at = now(), input = '{}'::jsonb
  WHERE status = 'running' AND started_at < now() - interval '15 minutes';

  RETURN QUERY
  UPDATE marketplace_agent_runs r
  SET status = 'running', started_at = now()
  WHERE r.id IN (
    SELECT id FROM marketplace_agent_runs WHERE status = 'queued'
    ORDER BY created_at LIMIT GREATEST(1, LEAST(p_limit, 50)) FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_marketplace_approved_actions(p_limit integer DEFAULT 20)
RETURNS SETOF agent_action_log
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE agent_action_log l
  SET payload = l.payload || jsonb_build_object('mkt_claimed_at', now())
  WHERE l.id IN (
    SELECT id FROM agent_action_log
    WHERE status = 'approved' AND agent_source LIKE 'marketplace:%' AND NOT jsonb_exists(payload, 'mkt_claimed_at')
    ORDER BY created_at LIMIT GREATEST(1, LEAST(p_limit, 100)) FOR UPDATE SKIP LOCKED
  )
  RETURNING l.*;
END;
$$;

-- Service-role-only lockdown for runtime RPCs
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.marketplace_install_budget(uuid, uuid)',
    'public.record_marketplace_usage(uuid)',
    'public.accrue_marketplace_subscriptions()',
    'public.enqueue_marketplace_event(uuid, text, jsonb)',
    'public.enqueue_marketplace_daily()',
    'public.claim_marketplace_runs(integer)',
    'public.claim_marketplace_approved_actions(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- User-facing / staff RPC grants (staff checks happen inside the functions)
REVOKE ALL ON FUNCTION public.register_marketplace_agent(text, text, text, text, text, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_marketplace_agent_version(uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_marketplace_agent_version(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.suspend_marketplace_agent(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.install_marketplace_agent(uuid, text[], integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_marketplace_install(uuid, text[], integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_marketplace_install_status(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_marketplace_audit_chain() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_marketplace_agent(text, text, text, text, text, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_marketplace_agent_version(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_marketplace_agent_version(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_marketplace_agent(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.install_marketplace_agent(uuid, text[], integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_marketplace_install(uuid, text[], integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_marketplace_install_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_marketplace_audit_chain() TO authenticated;

-- =============================================================
-- 11. Event wiring: jobs -> agent runs (never blocks the job write)
-- =============================================================
CREATE OR REPLACE FUNCTION public.marketplace_job_event_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.scheduled_datetime IS NOT NULL THEN
        PERFORM public.enqueue_marketplace_event(NEW.user_id, 'job.scheduled', jsonb_build_object('job_id', NEW.id));
      END IF;
    ELSIF lower(COALESCE(NEW.job_status, '')) IN ('completed', 'complete')
          AND lower(COALESCE(OLD.job_status, '')) NOT IN ('completed', 'complete') THEN
      PERFORM public.enqueue_marketplace_event(NEW.user_id, 'job.completed', jsonb_build_object('job_id', NEW.id));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketplace_job_insert ON jobs;
CREATE TRIGGER trg_marketplace_job_insert AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_job_event_trigger();
DROP TRIGGER IF EXISTS trg_marketplace_job_status ON jobs;
CREATE TRIGGER trg_marketplace_job_status AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_job_event_trigger();

-- =============================================================
-- 12. First-party agents (builtin runtime: Vireek AI brain + the same
--     scope/governance/audit/billing rules as third-party agents)
-- =============================================================
DO $seed$
DECLARE
  r record;
  v_agent uuid;
  v_version uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('hvac-diagnostic', 'HVAC Diagnostic Agent', 'Pre-arrival diagnostic angles and safety flags for HVAC jobs.',
     'Reviews each scheduled HVAC job and tells the technician the most likely fault patterns, safety concerns (refrigerant, combustion, electrical) and which parts and tools to bring. Posts recommendations to your feed; never contacts customers.',
     'hvac',
     '{"scopes":["read:jobs","act:record_insight","act:create_task"],"triggers":["job.scheduled","manual"],"limits":{"timeout_ms":12000,"max_actions":4},"system_prompt":"You are an HVAC diagnostic assistant for a field-service company. Using only the job data provided, flag likely diagnostic angles, safety concerns (refrigerant, gas, combustion, electrical) and parts or tools the technician should bring. Never invent measurements or customer facts. If data is insufficient, say exactly what is missing."}'),
    ('plumbing-agent', 'Plumbing Agent', 'Scope, parts and risk checks for plumbing jobs.',
     'Reviews scheduled plumbing jobs and flags likely scope, parts, water-damage and permit risks before the technician arrives.',
     'plumbing',
     '{"scopes":["read:jobs","act:record_insight","act:create_task"],"triggers":["job.scheduled","manual"],"limits":{"timeout_ms":12000,"max_actions":4},"system_prompt":"You are a plumbing job-preparation assistant. Using only the job data provided, flag likely scope, parts to bring, water-damage and permit risks. Never invent facts. If data is insufficient, say exactly what is missing."}'),
    ('electrical-agent', 'Electrical Agent', 'Safety and code-risk review for electrical jobs.',
     'Reviews scheduled electrical jobs and flags safety hazards, likely code or permit requirements and materials to bring. Escalates anything safety-critical as a task.',
     'electrical',
     '{"scopes":["read:jobs","act:record_insight","act:create_task"],"triggers":["job.scheduled","manual"],"limits":{"timeout_ms":12000,"max_actions":4},"system_prompt":"You are an electrical job-safety assistant. Using only the job data provided, flag safety hazards, likely code or permit requirements and materials to bring. If a hazard could injure someone, record a critical insight AND create a task. Never invent facts. If data is insufficient, say exactly what is missing."}'),
    ('collections-agent', 'Collections Agent', 'Finds unpaid invoices and drafts polite, compliant follow-ups.',
     'Scans jobs with outstanding invoices, prioritizes by amount and age, and proposes polite payment-reminder SMS messages. Every SMS goes through your approval queue by default and respects A2P and opt-out rules.',
     'collections',
     '{"scopes":["read:jobs","read:job_financials","read:customers","read:customer_contact","act:record_insight","act:create_task","act:send_sms"],"triggers":["schedule.daily","invoice.overdue","manual"],"limits":{"timeout_ms":15000,"max_actions":6},"system_prompt":"You are an accounts-receivable assistant for a field-service company. From the jobs provided, identify unpaid invoices, rank them by amount and age, and for the top few propose a short, polite, non-threatening payment reminder SMS using send_sms with the customer id. Never invent amounts, dates or customer ids; use only what is provided. Never threaten legal action. Keep every SMS under 300 characters."}'),
    ('revenue-agent', 'Revenue Agent', 'Surfaces lost and recoverable revenue.',
     'Looks for stalled jobs and unbilled work, and recommends the highest-value recovery actions as insights and tasks for your team.',
     'revenue',
     '{"scopes":["read:jobs","read:job_financials","read:customers","act:record_insight","act:create_task"],"triggers":["schedule.daily","quote.declined","manual"],"limits":{"timeout_ms":15000,"max_actions":5},"system_prompt":"You are a revenue-recovery analyst for a field-service company. From the data provided, find completed-but-unbilled jobs, stalled jobs and other recoverable revenue, rank them by dollar value, and recommend concrete next steps. Never invent amounts or customers. If data is insufficient, say exactly what is missing."}'),
    ('dispatch-agent', 'Dispatch Agent', 'Flags scheduling conflicts, overruns and risky assignments.',
     'Reviews the schedule for overlapping jobs, unusually long jobs and safety-flagged work, and tasks your dispatcher with fixes.',
     'dispatch',
     '{"scopes":["read:jobs","act:record_insight","act:create_task"],"triggers":["job.scheduled","manual"],"limits":{"timeout_ms":12000,"max_actions":5},"system_prompt":"You are a dispatch assistant. From the jobs provided, identify overlapping schedules, jobs likely to overrun their expected duration, and safety-flagged jobs that need a senior technician. Create a task for each real issue. Never invent jobs or times."}'),
    ('warranty-agent', 'Warranty Agent', 'Spots warranty exposure and follow-up opportunities.',
     'After each completed job, checks for warranty-relevant follow-ups and recommends a warranty check-in task.',
     'warranty',
     '{"scopes":["read:jobs","read:customers","act:record_insight","act:create_task"],"triggers":["job.completed","manual"],"limits":{"timeout_ms":12000,"max_actions":3},"system_prompt":"You are a warranty-management assistant. For the completed job provided, note any warranty-relevant considerations and recommend a follow-up task only if the service type typically carries a warranty. Never invent warranty terms. If data is insufficient, say exactly what is missing."}'),
    ('compliance-agent', 'Compliance Agent', 'Checks jobs for permit, licensing and documentation gaps.',
     'Reviews scheduled and completed jobs for likely permit, licensing and documentation gaps and creates tasks so nothing ships non-compliant.',
     'compliance',
     '{"scopes":["read:jobs","act:record_insight","act:create_task"],"triggers":["job.scheduled","job.completed","manual"],"limits":{"timeout_ms":12000,"max_actions":4},"system_prompt":"You are a field-service compliance assistant. From the job provided, flag likely permit, licensing, safety-documentation and records gaps for that service type. State uncertainty plainly; never claim a legal requirement is certain for a specific jurisdiction. Create a task for each real gap."}')
  ) AS t(slug, name, tagline, description, category, manifest)
  LOOP
    INSERT INTO marketplace_agents (slug, publisher_id, publisher_name, name, tagline, description, category, runtime, status, pricing_model, price_cents)
    VALUES (r.slug, NULL, 'Vireek', r.name, r.tagline, r.description, r.category, 'builtin', 'published', 'free', 0)
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_agent FROM marketplace_agents WHERE slug = r.slug;

    INSERT INTO marketplace_agent_versions (agent_id, version, manifest, manifest_hash, status, reviewed_at)
    VALUES (v_agent, '1.0.0', r.manifest::jsonb, encode(sha256(convert_to(r.manifest::jsonb::text, 'UTF8')), 'hex'), 'approved', now())
    ON CONFLICT (agent_id, version) DO NOTHING;

    SELECT id INTO v_version FROM marketplace_agent_versions WHERE agent_id = v_agent AND version = '1.0.0';
    UPDATE marketplace_agents SET current_version_id = v_version WHERE id = v_agent AND current_version_id IS NULL;
  END LOOP;
END
$seed$;
