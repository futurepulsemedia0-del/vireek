/*
  # Release safety core (expand-only, additive)

  1. feature_flags gets lifecycle + targeting columns (owner, kind, risk, expires_at, targeting).
     Plan targeting: targeting = {"plans": ["professional"]}; an 'on' override bypasses it.
  2. flag_evaluate(key, tenant): server-side evaluation for edge functions (service_role only).
  3. Kill switches: global + per-org, audit, resume of high/critical switches needs a second staff approver.
  4. kill_switch_snapshot(): one cheap read for edge functions (service_role only).

  Deploy order: apply this migration first; the edge helper and callers ship afterwards.
  Old code keeps working: no column is dropped or renamed, get_my_feature_flags keeps its signature.
*/
-- rollback: DROP the new functions/tables listed below and the five new feature_flags columns, then restore
-- get_my_feature_flags() and feature_flags_audit() from 20270411000100_feature_flags.sql. No data outside these objects is touched.

-- =============================================================
-- 1. FLAG LIFECYCLE + TARGETING (additive)
-- =============================================================
ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS owner text CHECK (owner IS NULL OR char_length(btrim(owner)) BETWEEN 2 AND 120),
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'release' CHECK (kind IN ('release', 'ops', 'experiment', 'permission')),
  ADD COLUMN IF NOT EXISTS risk text NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS targeting jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(targeting) = 'object');

CREATE OR REPLACE FUNCTION public.feature_flags_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := jsonb_build_object('name', OLD.name, 'description', OLD.description, 'enabled', OLD.enabled, 'rollout_pct', OLD.rollout_pct,
      'owner', OLD.owner, 'kind', OLD.kind, 'risk', OLD.risk, 'expires_at', OLD.expires_at, 'targeting', OLD.targeting);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := jsonb_build_object('name', NEW.name, 'description', NEW.description, 'enabled', NEW.enabled, 'rollout_pct', NEW.rollout_pct,
      'owner', NEW.owner, 'kind', NEW.kind, 'risk', NEW.risk, 'expires_at', NEW.expires_at, 'targeting', NEW.targeting);
  END IF;

  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  INSERT INTO feature_flag_audit (flag_id, flag_key, action, before, after)
  VALUES (
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.key, OLD.key),
    CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
    v_old, v_new
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.feature_flag_plan_match(p_targeting jsonb, p_plan text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_targeting IS NULL OR jsonb_typeof(p_targeting -> 'plans') IS DISTINCT FROM 'array' THEN true
    WHEN jsonb_array_length(p_targeting -> 'plans') = 0 THEN true
    ELSE COALESCE(p_plan, '') IN (SELECT jsonb_array_elements_text(p_targeting -> 'plans'))
  END;
$$;

-- Same signature/return type as before; adds plan targeting.
CREATE OR REPLACE FUNCTION public.get_my_feature_flags()
RETURNS TABLE (flag_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.key
    FROM feature_flags f
   CROSS JOIN LATERAL (SELECT public.get_account_owner_id() AS tenant) t
    LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = t.tenant
    LEFT JOIN profiles p ON p.id = t.tenant
   WHERE t.tenant IS NOT NULL
     AND public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, t.tenant, f.key)
     AND (o.state = 'on' OR public.feature_flag_plan_match(f.targeting, p.plan))
   ORDER BY f.key;
$$;

-- Server-side evaluation for edge functions. Unknown flag -> false (safe default).
CREATE OR REPLACE FUNCTION public.flag_evaluate(p_key text, p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_tenant, f.key)
           AND (o.state = 'on' OR public.feature_flag_plan_match(f.targeting, p.plan))
      FROM feature_flags f
      LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
      LEFT JOIN profiles p ON p.id = p_tenant
     WHERE f.key = p_key
  ), false);
$$;

REVOKE ALL ON FUNCTION public.feature_flag_plan_match(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_flag_plan_match(jsonb, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.flag_evaluate(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_evaluate(text, uuid) TO service_role;

-- =============================================================
-- 2. KILL SWITCHES
-- =============================================================
CREATE TABLE IF NOT EXISTS kill_switches (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  risk text NOT NULL DEFAULT 'high' CHECK (risk IN ('medium', 'high', 'critical')),
  stopped boolean NOT NULL DEFAULT false,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  stopped_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_drill_at timestamptz
);

CREATE TABLE IF NOT EXISTS kill_switch_org_stops (
  key text NOT NULL REFERENCES kill_switches(key) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  stopped_at timestamptz NOT NULL DEFAULT now(),
  stopped_by uuid,
  PRIMARY KEY (key, tenant_id)
);

CREATE TABLE IF NOT EXISTS kill_switch_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'org', 'drill')),
  action text NOT NULL CHECK (action IN ('stop', 'resume', 'drill')),
  tenant_id uuid,
  reason text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kill_switch_audit_key ON kill_switch_audit(key, created_at DESC);

CREATE TABLE IF NOT EXISTS release_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('kill_switch_resume', 'flag_change', 'app_policy')),
  target_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  CONSTRAINT release_change_two_person CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_release_change_pending ON release_change_requests(kind, target_key) WHERE status = 'pending';

ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switch_org_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switch_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_change_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON kill_switches, kill_switch_org_stops, kill_switch_audit, release_change_requests FROM anon;
REVOKE INSERT, UPDATE, DELETE ON kill_switches, kill_switch_org_stops, kill_switch_audit, release_change_requests FROM authenticated;

DROP POLICY IF EXISTS "staff_read_kill_switches" ON kill_switches;
CREATE POLICY "staff_read_kill_switches" ON kill_switches FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_kill_switch_org_stops" ON kill_switch_org_stops;
CREATE POLICY "staff_read_kill_switch_org_stops" ON kill_switch_org_stops FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_kill_switch_audit" ON kill_switch_audit;
CREATE POLICY "staff_read_kill_switch_audit" ON kill_switch_audit FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_release_change_requests" ON release_change_requests;
CREATE POLICY "staff_read_release_change_requests" ON release_change_requests FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));

INSERT INTO kill_switches (key, label, description, risk) VALUES
  ('outbound_dialer', 'Outbound dialer', 'Scheduled outbound AI calls (quote follow-up, reminders, review requests).', 'critical'),
  ('voice_cloning', 'Voice cloning', 'Creating and using cloned voices.', 'high'),
  ('agent_auto_actions', 'Agent auto-actions', 'Actions AI agents take without a human click.', 'critical'),
  ('price_auto_apply', 'Price auto-apply', 'Automatic price changes applied to price books and quotes.', 'critical'),
  ('auto_replies', 'Auto-replies', 'Automatic replies to customers (reviews, messages, email).', 'high'),
  ('ai_model_prompt_versions', 'AI model / prompt versions', 'Promoted model routes and prompt versions; stopping falls back to the pinned baseline.', 'high'),
  ('marketplace_ingestion', 'Marketplace ingestion', 'Lead-marketplace and feed ingestion.', 'high'),
  ('sms_campaigns', 'SMS campaigns', 'Bulk and campaign SMS sends.', 'critical')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 3. STAFF RPCs (each re-checks is_vireek_staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_list_kill_switches()
RETURNS TABLE (
  key text, label text, description text, risk text, stopped boolean, reason text,
  stopped_at timestamptz, updated_at timestamptz, last_drill_at timestamptz,
  org_stops integer, pending_resume uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT k.key, k.label, k.description, k.risk, k.stopped, k.reason, k.stopped_at, k.updated_at, k.last_drill_at,
         (SELECT count(*)::integer FROM kill_switch_org_stops s WHERE s.key = k.key),
         (SELECT r.id FROM release_change_requests r
           WHERE r.kind = 'kill_switch_resume' AND r.target_key = k.key AND r.status = 'pending'
           ORDER BY r.requested_at DESC LIMIT 1)
    FROM kill_switches k
   ORDER BY k.key;
END;
$$;

-- Stop is always one click (global or per org). Resume of a high/critical GLOBAL switch needs a second approver.
CREATE OR REPLACE FUNCTION public.staff_set_kill_switch(p_key text, p_tenant_id uuid, p_stopped boolean, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_risk text;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_stopped AND (v_reason IS NULL OR char_length(v_reason) < 3) THEN
    RAISE EXCEPTION 'A reason is required to stop a capability' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Reason must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT k.risk INTO v_risk FROM kill_switches k WHERE k.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kill switch not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_tenant_id IS NULL THEN
    IF NOT p_stopped AND v_risk IN ('high', 'critical') THEN
      RAISE EXCEPTION 'Resuming a % switch needs a second approver (use the resume request flow)', v_risk USING ERRCODE = '42501';
    END IF;
    UPDATE kill_switches
       SET stopped = p_stopped,
           reason = CASE WHEN p_stopped THEN v_reason ELSE NULL END,
           stopped_at = CASE WHEN p_stopped THEN now() ELSE NULL END,
           updated_at = now(),
           updated_by = auth.uid()
     WHERE kill_switches.key = p_key;
    INSERT INTO kill_switch_audit (key, scope, action, reason, actor)
    VALUES (p_key, 'global', CASE WHEN p_stopped THEN 'stop' ELSE 'resume' END, v_reason, auth.uid());
  ELSE
    IF NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = p_tenant_id AND pr.role = 'owner') THEN
      RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_stopped THEN
      INSERT INTO kill_switch_org_stops (key, tenant_id, reason, stopped_by)
      VALUES (p_key, p_tenant_id, v_reason, auth.uid())
      ON CONFLICT (key, tenant_id)
      DO UPDATE SET reason = EXCLUDED.reason, stopped_at = now(), stopped_by = EXCLUDED.stopped_by;
    ELSE
      DELETE FROM kill_switch_org_stops s WHERE s.key = p_key AND s.tenant_id = p_tenant_id;
    END IF;
    INSERT INTO kill_switch_audit (key, scope, action, tenant_id, reason, actor)
    VALUES (p_key, 'org', CASE WHEN p_stopped THEN 'stop' ELSE 'resume' END, p_tenant_id, v_reason, auth.uid());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_request_kill_switch_resume(p_key text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Reason must be 3-500 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kill_switches k WHERE k.key = p_key AND k.stopped) THEN
    RAISE EXCEPTION 'Kill switch not found or not stopped' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO release_change_requests (kind, target_key, reason, requested_by)
  VALUES ('kill_switch_resume', p_key, v_reason, auth.uid())
  ON CONFLICT (kind, target_key) WHERE status = 'pending' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT r.id INTO v_id FROM release_change_requests r
     WHERE r.kind = 'kill_switch_resume' AND r.target_key = p_key AND r.status = 'pending';
  END IF;
  RETURN v_id;
END;
$$;

-- Returns 'approved' | 'rejected' | 'expired'. The approver must differ from the requester; requests expire after 24h.
CREATE OR REPLACE FUNCTION public.staff_decide_kill_switch_resume(p_request_id uuid, p_approve boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r release_change_requests%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM release_change_requests q WHERE q.id = p_request_id AND q.kind = 'kill_switch_resume' FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'Request not found or already decided' USING ERRCODE = 'P0002';
  END IF;
  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'A second person must decide this request' USING ERRCODE = '42501';
  END IF;

  IF r.requested_at < now() - interval '24 hours' THEN
    UPDATE release_change_requests SET status = 'expired', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'expired';
  END IF;

  IF NOT p_approve THEN
    UPDATE release_change_requests SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    RETURN 'rejected';
  END IF;

  UPDATE kill_switches
     SET stopped = false, reason = NULL, stopped_at = NULL, updated_at = now(), updated_by = auth.uid()
   WHERE kill_switches.key = r.target_key;
  INSERT INTO kill_switch_audit (key, scope, action, reason, actor)
  VALUES (r.target_key, 'global', 'resume', 'two-person approval: ' || r.reason, auth.uid());
  UPDATE release_change_requests SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
  RETURN 'approved';
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_record_kill_switch_drill(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  UPDATE kill_switches SET last_drill_at = now() WHERE kill_switches.key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kill switch not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO kill_switch_audit (key, scope, action, reason, actor)
  VALUES (p_key, 'drill', 'drill', 'monthly drill completed', auth.uid());
END;
$$;

-- =============================================================
-- 4. EDGE-FUNCTION READS (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.kill_switch_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'global', COALESCE((SELECT jsonb_agg(k.key ORDER BY k.key) FROM kill_switches k WHERE k.stopped), '[]'::jsonb),
    'orgs', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', s.key, 'tenant_id', s.tenant_id)) FROM kill_switch_org_stops s), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.kill_switch_drills_overdue()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k.key FROM kill_switches k
   WHERE k.last_drill_at IS NULL OR k.last_drill_at < now() - interval '35 days'
   ORDER BY k.key;
$$;

REVOKE ALL ON FUNCTION public.kill_switch_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kill_switch_drills_overdue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kill_switch_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION public.kill_switch_drills_overdue() TO service_role;

REVOKE ALL ON FUNCTION public.staff_list_kill_switches() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_kill_switch(text, uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_request_kill_switch_resume(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_decide_kill_switch_resume(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_record_kill_switch_drill(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_list_kill_switches() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_kill_switch(text, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_request_kill_switch_resume(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_decide_kill_switch_resume(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_record_kill_switch_drill(text) TO authenticated;
