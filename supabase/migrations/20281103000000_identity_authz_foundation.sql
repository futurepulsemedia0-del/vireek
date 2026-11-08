-- =====================================================================
-- Identity & authorization foundation (additive; replaces nothing)
--
--   1. Audit events (append-only)
--   2. Approval chains engine (policies, requests, steps, decisions, delegations)
--   3. Just-in-time access grants (incl. customer-approved staff support access)
--   4. ABAC: principal attributes, policies, record ACL, field masks
--   5. Guest / external collaborators
--   6. Ownership transfer (to `ready`) + org deletion hold
--
-- Mirrors src/lib/authz/*.ts. All new tables are RLS-enabled; tables that carry
-- decisions have NO insert/update/delete policies, so they change only through the
-- SECURITY DEFINER functions below.
--
-- NOT in this migration (see docs/security/identity-authz-audit.md):
--   * re-pointing tenant ownership (needs the 325 owner-only policies migrated)
--   * applying ABAC to existing tables (recipe at the end of this file)
--   * DB-level break-glass (needs a co-owner model that does not exist yet)
--   * enforcing deactivation inside the existing get_account_owner_id()/has_account_permission()
--
-- STATUS: written against the zip's schema, NOT executed (no Postgres available when
-- authored). Run `supabase db reset` + `supabase test db` before relying on it.
-- =====================================================================

DO $$
DECLARE missing text[] := '{}';
BEGIN
  IF to_regprocedure('public.get_account_owner_id()') IS NULL THEN missing := missing || 'function get_account_owner_id()'; END IF;
  IF to_regprocedure('public.has_account_permission(text)') IS NULL THEN missing := missing || 'function has_account_permission(text)'; END IF;
  IF to_regclass('public.team_members') IS NULL THEN missing := missing || 'table team_members'; END IF;
  IF to_regclass('public.profiles') IS NULL THEN missing := missing || 'table profiles'; END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'identity_authz_foundation: missing prerequisites: %', array_to_string(missing, ', ');
  END IF;
END $$;

-- ---------------------------------------------------------------- helpers

-- Owner = has a profile and is not a team member (same rule has_account_permission uses).
CREATE OR REPLACE FUNCTION public.authz_is_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
     AND NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.authz_can_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.has_account_permission('can_manage_security');
$$;

-- Fresh re-authentication: newest `amr` timestamp in the JWT must be within p_max_seconds.
-- ASSUMPTION (unverified): the client signs in again (signInWithPassword) right before the call,
-- which yields a new session whose amr timestamp is fresh.
CREATE OR REPLACE FUNCTION public.authz_recent_reauth(p_max_seconds integer DEFAULT 300)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT max((e ->> 'timestamp')::bigint)
    FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) AS e
    WHERE (e ->> 'timestamp') ~ '^[0-9]{1,12}$'
  ), 0) >= extract(epoch FROM now())::bigint - p_max_seconds;
$$;

CREATE OR REPLACE FUNCTION public.authz_risk_rank(p text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 WHEN 'critical' THEN 3 ELSE NULL END;
$$;

-- ================================================================
-- 1. AUDIT EVENTS (append-only)
-- ================================================================
CREATE TABLE IF NOT EXISTS public.authz_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  actor_id     uuid,
  event        text NOT NULL CHECK (length(event) BETWEEN 1 AND 80),
  subject_type text NOT NULL,
  subject_id   text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authz_events_tenant_time_idx ON public.authz_events (tenant_id, created_at DESC);
ALTER TABLE public.authz_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authz_events_select ON public.authz_events;
CREATE POLICY authz_events_select ON public.authz_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.has_account_permission('can_view_audit_log'));

CREATE OR REPLACE FUNCTION public.authz_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authz_events is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS authz_events_no_change ON public.authz_events;
CREATE TRIGGER authz_events_no_change BEFORE UPDATE OR DELETE ON public.authz_events
  FOR EACH ROW EXECUTE FUNCTION public.authz_events_immutable();

CREATE OR REPLACE FUNCTION public.authz_log(p_tenant uuid, p_event text, p_subject_type text, p_subject_id text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.authz_events (tenant_id, actor_id, event, subject_type, subject_id, detail)
  VALUES (p_tenant, auth.uid(), p_event, p_subject_type, p_subject_id, COALESCE(p_detail, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.authz_log(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ================================================================
-- 2. APPROVAL CHAINS ENGINE
-- ================================================================
CREATE OR REPLACE FUNCTION public.authz_valid_steps(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p) NOT BETWEEN 1 AND 10 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) AS e(s)
      WHERE CASE
        WHEN jsonb_typeof(e.s) IS DISTINCT FROM 'object' THEN true
        WHEN COALESCE(e.s ->> 'id', '') = '' THEN true
        WHEN COALESCE(e.s ->> 'mode', '') NOT IN ('any', 'all', 'quorum') THEN true
        WHEN jsonb_typeof(e.s -> 'approvers') IS DISTINCT FROM 'array' THEN true
        WHEN jsonb_array_length(e.s -> 'approvers') = 0 THEN true
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.s -> 'approvers') a
                     WHERE a !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN true
        WHEN e.s ? 'escalateTo' AND jsonb_typeof(e.s -> 'escalateTo') IS DISTINCT FROM 'array' THEN true
        WHEN e.s ? 'escalateTo' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.s -> 'escalateTo') a
                     WHERE a !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN true
        WHEN e.s ->> 'mode' = 'quorum' AND COALESCE(e.s ->> 'quorum', '') !~ '^[0-9]{1,4}$' THEN true
        WHEN e.s ->> 'mode' = 'quorum' AND (e.s ->> 'quorum')::integer < 1 THEN true
        ELSE false
      END
    )
  END;
$$;

CREATE TABLE IF NOT EXISTS public.authz_approval_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  subject_type         text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_.]{1,62}$'),
  min_amount_cents     bigint NOT NULL DEFAULT 0 CHECK (min_amount_cents >= 0),
  max_amount_cents     bigint CHECK (max_amount_cents IS NULL OR max_amount_cents >= min_amount_cents),
  min_risk             text NOT NULL DEFAULT 'low' CHECK (min_risk IN ('low', 'medium', 'high', 'critical')),
  steps                jsonb NOT NULL CHECK (public.authz_valid_steps(steps)),
  require_reason       boolean NOT NULL DEFAULT false,
  require_signature    boolean NOT NULL DEFAULT false,
  expire_after_minutes integer CHECK (expire_after_minutes IS NULL OR expire_after_minutes > 0),
  priority             integer NOT NULL DEFAULT 0,
  enabled              boolean NOT NULL DEFAULT true,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authz_approval_policies_lookup_idx
  ON public.authz_approval_policies (tenant_id, subject_type) WHERE enabled;
ALTER TABLE public.authz_approval_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authz_approval_policies_select ON public.authz_approval_policies;
CREATE POLICY authz_approval_policies_select ON public.authz_approval_policies FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id());
DROP POLICY IF EXISTS authz_approval_policies_write ON public.authz_approval_policies;
CREATE POLICY authz_approval_policies_write ON public.authz_approval_policies FOR ALL TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin())
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());

CREATE TABLE IF NOT EXISTS public.authz_approval_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  policy_id         uuid REFERENCES public.authz_approval_policies (id) ON DELETE SET NULL,
  subject_type      text NOT NULL,
  subject_id        text NOT NULL,
  amount_cents      bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  risk              text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  requester_id      uuid NOT NULL,
  require_reason    boolean NOT NULL,
  require_signature boolean NOT NULL,
  expires_at        timestamptz,
  steps             jsonb NOT NULL CHECK (public.authz_valid_steps(steps)),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS authz_approval_requests_tenant_status_idx ON public.authz_approval_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS authz_approval_requests_subject_idx ON public.authz_approval_requests (tenant_id, subject_type, subject_id);
ALTER TABLE public.authz_approval_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.authz_approval_step_states (
  request_id   uuid NOT NULL REFERENCES public.authz_approval_requests (id) ON DELETE CASCADE,
  step_id      text NOT NULL,
  position     integer NOT NULL CHECK (position >= 0),
  status       text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'approved', 'rejected')),
  activated_at timestamptz,
  escalated_at timestamptz,
  PRIMARY KEY (request_id, step_id),
  UNIQUE (request_id, position)
);
ALTER TABLE public.authz_approval_step_states ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.authz_approval_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES public.authz_approval_requests (id) ON DELETE CASCADE,
  step_id        text NOT NULL,
  user_id        uuid NOT NULL,
  on_behalf_of   text NOT NULL,
  via_escalation boolean NOT NULL DEFAULT false,
  kind           text NOT NULL CHECK (kind IN ('approve', 'reject')),
  reason         text,
  signature_ref  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, step_id, user_id)
);
ALTER TABLE public.authz_approval_decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.authz_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  delegator_id  uuid NOT NULL,
  delegate_id   uuid NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  subject_types text[],
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (delegate_id <> delegator_id),
  CHECK (ends_at > starts_at),
  CHECK (ends_at <= starts_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS authz_delegations_delegate_idx ON public.authz_delegations (tenant_id, delegate_id) WHERE revoked_at IS NULL;
ALTER TABLE public.authz_delegations ENABLE ROW LEVEL SECURITY;

-- Who may see a request: requester, admin, or a listed approver/escalation target/active delegate.
CREATE OR REPLACE FUNCTION public.authz_can_see_approval(p_request uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM authz_approval_requests r
    WHERE r.id = p_request
      AND r.tenant_id = public.get_account_owner_id()
      AND (
        r.requester_id = auth.uid()
        OR public.authz_can_admin()
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.steps) st(s)
          WHERE (st.s -> 'approvers') ? auth.uid()::text OR COALESCE(st.s -> 'escalateTo', '[]'::jsonb) ? auth.uid()::text
        )
        OR EXISTS (
          SELECT 1 FROM authz_delegations d
          WHERE d.tenant_id = r.tenant_id AND d.delegate_id = auth.uid()
            AND (d.revoked_at IS NULL OR d.revoked_at > now()) AND d.starts_at <= now() AND d.ends_at > now()
        )
      )
  );
$$;
GRANT EXECUTE ON FUNCTION public.authz_can_see_approval(uuid) TO authenticated;

DROP POLICY IF EXISTS authz_approval_requests_select ON public.authz_approval_requests;
CREATE POLICY authz_approval_requests_select ON public.authz_approval_requests FOR SELECT TO authenticated
  USING (public.authz_can_see_approval(id));
DROP POLICY IF EXISTS authz_approval_step_states_select ON public.authz_approval_step_states;
CREATE POLICY authz_approval_step_states_select ON public.authz_approval_step_states FOR SELECT TO authenticated
  USING (public.authz_can_see_approval(request_id));
DROP POLICY IF EXISTS authz_approval_decisions_select ON public.authz_approval_decisions;
CREATE POLICY authz_approval_decisions_select ON public.authz_approval_decisions FOR SELECT TO authenticated
  USING (public.authz_can_see_approval(request_id));
DROP POLICY IF EXISTS authz_delegations_select ON public.authz_delegations;
CREATE POLICY authz_delegations_select ON public.authz_delegations FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND (delegator_id = auth.uid() OR delegate_id = auth.uid() OR public.authz_can_admin()));

-- Delegations are created/revoked only through these functions.
CREATE OR REPLACE FUNCTION public.authz_create_delegation(p_delegate uuid, p_starts timestamptz, p_ends timestamptz, p_subject_types text[] DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN RAISE EXCEPTION 'authz: not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_delegate = auth.uid() THEN RAISE EXCEPTION 'authz: cannot delegate to yourself' USING ERRCODE = '22023'; END IF;
  IF p_ends <= now() THEN RAISE EXCEPTION 'authz: delegation must end in the future' USING ERRCODE = '22023'; END IF;
  IF NOT (p_delegate = v_tenant OR EXISTS (SELECT 1 FROM team_members WHERE account_owner_id = v_tenant AND user_id = p_delegate)) THEN
    RAISE EXCEPTION 'authz: delegate is not a member of this account' USING ERRCODE = '42501';
  END IF;
  INSERT INTO authz_delegations (tenant_id, delegator_id, delegate_id, starts_at, ends_at, subject_types)
  VALUES (v_tenant, auth.uid(), p_delegate, p_starts, p_ends, p_subject_types) RETURNING id INTO v_id;
  PERFORM public.authz_log(v_tenant, 'delegation.created', 'delegation', v_id::text, jsonb_build_object('delegate', p_delegate, 'ends_at', p_ends));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.authz_revoke_delegation(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id();
BEGIN
  UPDATE authz_delegations SET revoked_at = now()
   WHERE id = p_id AND tenant_id = v_tenant AND revoked_at IS NULL AND (delegator_id = auth.uid() OR public.authz_can_admin());
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.authz_log(v_tenant, 'delegation.revoked', 'delegation', p_id::text);
END $$;

-- Create a request: picks the policy exactly like selectPolicy() in approvalEngine.ts.
CREATE OR REPLACE FUNCTION public.authz_create_approval(
  p_subject_type text, p_subject_id text, p_amount_cents bigint, p_risk text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid := public.get_account_owner_id();
  pol authz_approval_policies%ROWTYPE;
  v_id uuid;
  st record;
  v_eligible integer;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN RAISE EXCEPTION 'authz: not authenticated' USING ERRCODE = '28000'; END IF;
  IF public.authz_risk_rank(p_risk) IS NULL OR COALESCE(p_amount_cents, -1) < 0 THEN
    RAISE EXCEPTION 'authz: invalid risk or amount' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO pol FROM authz_approval_policies p
   WHERE p.tenant_id = v_tenant AND p.enabled AND p.subject_type = p_subject_type
     AND p_amount_cents >= p.min_amount_cents
     AND (p.max_amount_cents IS NULL OR p_amount_cents <= p.max_amount_cents)
     AND public.authz_risk_rank(p_risk) >= public.authz_risk_rank(p.min_risk)
   ORDER BY p.priority DESC, p.min_amount_cents DESC, p.id ASC
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: no_policy' USING ERRCODE = 'P0002'; END IF;

  -- Chain must be satisfiable without the requester (separation of duties).
  FOR st IN SELECT e.s AS s FROM jsonb_array_elements(pol.steps) AS e(s) LOOP
    SELECT count(DISTINCT a) INTO v_eligible FROM jsonb_array_elements_text(st.s -> 'approvers') a WHERE a <> v_uid::text;
    IF v_eligible = 0 THEN RAISE EXCEPTION 'authz: unsatisfiable_chain' USING ERRCODE = '55000'; END IF;
    IF st.s ->> 'mode' = 'quorum' AND (st.s ->> 'quorum')::integer > v_eligible THEN
      RAISE EXCEPTION 'authz: unsatisfiable_chain' USING ERRCODE = '55000';
    END IF;
  END LOOP;

  INSERT INTO authz_approval_requests (tenant_id, policy_id, subject_type, subject_id, amount_cents, risk, requester_id,
                                       require_reason, require_signature, expires_at, steps, payload)
  VALUES (v_tenant, pol.id, p_subject_type, p_subject_id, p_amount_cents, p_risk, v_uid, pol.require_reason, pol.require_signature,
          CASE WHEN pol.expire_after_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => pol.expire_after_minutes) END,
          pol.steps, COALESCE(p_payload, '{}'::jsonb))
  RETURNING id INTO v_id;

  INSERT INTO authz_approval_step_states (request_id, step_id, position, status, activated_at)
  SELECT v_id, e.s ->> 'id', (e.ord - 1)::integer, CASE WHEN e.ord = 1 THEN 'active' ELSE 'waiting' END,
         CASE WHEN e.ord = 1 THEN now() ELSE NULL END
    FROM jsonb_array_elements(pol.steps) WITH ORDINALITY AS e(s, ord);

  PERFORM public.authz_log(v_tenant, 'approval.created', 'approval', v_id::text,
          jsonb_build_object('subject_type', p_subject_type, 'subject_id', p_subject_id, 'amount_cents', p_amount_cents, 'risk', p_risk));
  RETURN v_id;
END $$;

-- Decide the active step. Mirrors decide() in approvalEngine.ts. Returns the new request status.
CREATE OR REPLACE FUNCTION public.authz_decide_approval(p_request_id uuid, p_kind text, p_reason text DEFAULT NULL, p_signature_ref text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  r authz_approval_requests%ROWTYPE;
  v_state authz_approval_step_states%ROWTYPE;
  v_step jsonb;
  v_on_behalf text;
  v_via boolean := false;
  v_reason text := nullif(btrim(COALESCE(p_reason, '')), '');
  v_slots text[];
  v_covered text[];
  v_count integer;
  v_satisfied boolean := false;
  v_next_pos integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authz: not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_kind NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'authz: invalid kind' USING ERRCODE = '22023'; END IF;

  SELECT * INTO r FROM authz_approval_requests WHERE id = p_request_id FOR UPDATE;
  -- Same error for "missing" and "other tenant": no existence oracle.
  IF NOT FOUND OR r.tenant_id <> public.get_account_owner_id() THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'authz: not_pending' USING ERRCODE = '55000'; END IF;
  IF r.expires_at IS NOT NULL AND now() >= r.expires_at THEN RAISE EXCEPTION 'authz: expired' USING ERRCODE = '55000'; END IF;
  IF v_uid = r.requester_id THEN RAISE EXCEPTION 'authz: self_approval_forbidden' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_state FROM authz_approval_step_states WHERE request_id = r.id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: no_active_step' USING ERRCODE = '55000'; END IF;
  SELECT e.s INTO v_step FROM jsonb_array_elements(r.steps) AS e(s) WHERE e.s ->> 'id' = v_state.step_id;

  -- Eligibility: direct approver, else active single-level delegate, else escalation target (if escalated).
  IF (v_step -> 'approvers') ? v_uid::text THEN
    v_on_behalf := v_uid::text;
  ELSE
    SELECT d.delegator_id::text INTO v_on_behalf
      FROM authz_delegations d
     WHERE d.tenant_id = r.tenant_id AND d.delegate_id = v_uid
       AND (d.revoked_at IS NULL OR d.revoked_at > now()) AND d.starts_at <= now() AND d.ends_at > now()
       AND (d.subject_types IS NULL OR r.subject_type = ANY (d.subject_types))
       AND d.delegator_id <> r.requester_id
       AND (v_step -> 'approvers') ? d.delegator_id::text
     ORDER BY d.starts_at, d.id
     LIMIT 1;
    IF v_on_behalf IS NULL AND v_state.escalated_at IS NOT NULL AND COALESCE(v_step -> 'escalateTo', '[]'::jsonb) ? v_uid::text THEN
      v_on_behalf := 'escalation';
      v_via := true;
    END IF;
  END IF;
  IF v_on_behalf IS NULL THEN RAISE EXCEPTION 'authz: not_an_approver' USING ERRCODE = '42501'; END IF;

  IF EXISTS (SELECT 1 FROM authz_approval_decisions WHERE request_id = r.id AND step_id = v_state.step_id AND user_id = v_uid) THEN
    RAISE EXCEPTION 'authz: already_decided' USING ERRCODE = '55000';
  END IF;
  IF p_kind = 'reject' AND (v_reason IS NULL OR length(v_reason) < 3) THEN RAISE EXCEPTION 'authz: reason_required' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'approve' THEN
    IF r.require_reason AND (v_reason IS NULL OR length(v_reason) < 3) THEN RAISE EXCEPTION 'authz: reason_required' USING ERRCODE = '22023'; END IF;
    IF r.require_signature AND nullif(btrim(COALESCE(p_signature_ref, '')), '') IS NULL THEN RAISE EXCEPTION 'authz: signature_required' USING ERRCODE = '22023'; END IF;
    IF NOT v_via AND EXISTS (SELECT 1 FROM authz_approval_decisions WHERE request_id = r.id AND step_id = v_state.step_id AND kind = 'approve' AND on_behalf_of = v_on_behalf) THEN
      RAISE EXCEPTION 'authz: slot_already_covered' USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO authz_approval_decisions (request_id, step_id, user_id, on_behalf_of, via_escalation, kind, reason, signature_ref)
  VALUES (r.id, v_state.step_id, v_uid, v_on_behalf, v_via, p_kind, v_reason, CASE WHEN p_kind = 'approve' THEN nullif(btrim(COALESCE(p_signature_ref, '')), '') ELSE NULL END);
  PERFORM public.authz_log(r.tenant_id, 'approval.' || p_kind, 'approval', r.id::text, jsonb_build_object('step', v_state.step_id, 'on_behalf_of', v_on_behalf));

  IF p_kind = 'reject' THEN
    UPDATE authz_approval_step_states SET status = 'rejected' WHERE request_id = r.id AND step_id = v_state.step_id;
    UPDATE authz_approval_requests SET status = 'rejected', completed_at = now() WHERE id = r.id;
    RETURN 'rejected';
  END IF;

  -- Is the step satisfied?
  IF EXISTS (SELECT 1 FROM authz_approval_decisions WHERE request_id = r.id AND step_id = v_state.step_id AND kind = 'approve' AND via_escalation) THEN
    v_satisfied := true;
  ELSE
    SELECT count(*), COALESCE(array_agg(DISTINCT on_behalf_of), '{}'::text[]) INTO v_count, v_covered
      FROM authz_approval_decisions WHERE request_id = r.id AND step_id = v_state.step_id AND kind = 'approve';
    IF v_step ->> 'mode' = 'any' THEN
      v_satisfied := v_count >= 1;
    ELSIF v_step ->> 'mode' = 'quorum' THEN
      SELECT count(DISTINCT user_id) INTO v_count FROM authz_approval_decisions WHERE request_id = r.id AND step_id = v_state.step_id AND kind = 'approve';
      v_satisfied := v_count >= (v_step ->> 'quorum')::integer;
    ELSE
      SELECT COALESCE(array_agg(DISTINCT a), '{}'::text[]) INTO v_slots FROM jsonb_array_elements_text(v_step -> 'approvers') a WHERE a <> r.requester_id::text;
      v_satisfied := v_slots <@ v_covered;
    END IF;
  END IF;
  IF NOT v_satisfied THEN RETURN 'pending'; END IF;

  UPDATE authz_approval_step_states SET status = 'approved' WHERE request_id = r.id AND step_id = v_state.step_id;
  SELECT min(position) INTO v_next_pos FROM authz_approval_step_states WHERE request_id = r.id AND position > v_state.position;
  IF v_next_pos IS NOT NULL THEN
    UPDATE authz_approval_step_states SET status = 'active', activated_at = now() WHERE request_id = r.id AND position = v_next_pos;
    RETURN 'pending';
  END IF;
  UPDATE authz_approval_requests SET status = 'approved', completed_at = now() WHERE id = r.id;
  PERFORM public.authz_log(r.tenant_id, 'approval.completed', 'approval', r.id::text, jsonb_build_object('status', 'approved'));
  RETURN 'approved';
END $$;

CREATE OR REPLACE FUNCTION public.authz_cancel_approval(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r authz_approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM authz_approval_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.tenant_id <> public.get_account_owner_id() THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.requester_id <> auth.uid() THEN RAISE EXCEPTION 'authz: not_requester' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'authz: not_pending' USING ERRCODE = '55000'; END IF;
  UPDATE authz_approval_requests SET status = 'cancelled', completed_at = now() WHERE id = r.id;
  PERFORM public.authz_log(r.tenant_id, 'approval.cancelled', 'approval', r.id::text, jsonb_build_object('reason', nullif(btrim(COALESCE(p_reason, '')), '')));
END $$;

-- Timer-driven maintenance. Service role only; NOT scheduled by this migration
-- (wire to pg_cron or an edge-function cron after verifying it in your project).
CREATE OR REPLACE FUNCTION public.authz_run_approval_timers()
RETURNS TABLE (escalated integer, expired integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_esc integer := 0; v_exp integer := 0; v_n integer;
BEGIN
  UPDATE authz_approval_requests SET status = 'expired', completed_at = now()
   WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now();
  GET DIAGNOSTICS v_exp = ROW_COUNT;

  UPDATE authz_approval_step_states ss SET escalated_at = now()
    FROM authz_approval_requests r, jsonb_array_elements(r.steps) AS e(s)
   WHERE ss.request_id = r.id AND r.status = 'pending' AND ss.status = 'active' AND ss.escalated_at IS NULL
     AND e.s ->> 'id' = ss.step_id
     AND e.s ? 'escalateAfterMinutes' AND (e.s ->> 'escalateAfterMinutes') ~ '^[0-9]{1,6}$'
     AND jsonb_typeof(e.s -> 'escalateTo') = 'array' AND jsonb_array_length(e.s -> 'escalateTo') > 0
     AND ss.activated_at + make_interval(mins => (e.s ->> 'escalateAfterMinutes')::integer) <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT; v_esc := v_n;
  RETURN QUERY SELECT v_esc, v_exp;
END $$;
REVOKE ALL ON FUNCTION public.authz_run_approval_timers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authz_run_approval_timers() TO service_role;

-- ================================================================
-- 3. JUST-IN-TIME ACCESS GRANTS
-- ================================================================
CREATE TABLE IF NOT EXISTS public.authz_access_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,                       -- the tenant whose data/permissions are in scope
  kind              text NOT NULL CHECK (kind IN ('permission', 'staff_support')),
  requester_id      uuid NOT NULL,
  permissions       text[] NOT NULL DEFAULT '{}',
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 15),
  requested_minutes integer NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid,
  decided_at        timestamptz,
  starts_at         timestamptz,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  denied            boolean NOT NULL DEFAULT false,
  cancelled_at      timestamptz,
  CHECK (
    (kind = 'permission'    AND requested_minutes BETWEEN 5 AND 480 AND cardinality(permissions) >= 1
       AND permissions <@ ARRAY['can_view_billing','can_manage_numbers','can_manage_team','can_edit_business_profile',
                                'can_view_all_jobs','can_view_audit_log','can_manage_security','can_issue_refunds','can_export_data']::text[])
    OR
    (kind = 'staff_support' AND requested_minutes BETWEEN 15 AND 240 AND cardinality(permissions) = 0)
  )
);
CREATE INDEX IF NOT EXISTS authz_access_grants_active_idx ON public.authz_access_grants (tenant_id, requester_id, expires_at) WHERE decided_at IS NOT NULL AND NOT denied;
ALTER TABLE public.authz_access_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authz_access_grants_select ON public.authz_access_grants;
CREATE POLICY authz_access_grants_select ON public.authz_access_grants FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR (tenant_id = public.get_account_owner_id() AND public.authz_can_admin()));

CREATE OR REPLACE FUNCTION public.authz_request_access(p_permissions text[], p_reason text, p_minutes integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN RAISE EXCEPTION 'authz: not authenticated' USING ERRCODE = '28000'; END IF;
  INSERT INTO authz_access_grants (tenant_id, kind, requester_id, permissions, reason, requested_minutes)
  VALUES (v_tenant, 'permission', auth.uid(), (SELECT array_agg(DISTINCT p) FROM unnest(p_permissions) p), p_reason, p_minutes)
  RETURNING id INTO v_id;                       -- table CHECKs enforce reason length, duration and key whitelist
  PERFORM public.authz_log(v_tenant, 'access.requested', 'access_grant', v_id::text, jsonb_build_object('permissions', p_permissions, 'minutes', p_minutes));
  RETURN v_id;
END $$;

-- Staff ask a customer for support access. Staff are not tenant members, so this takes the tenant explicitly.
CREATE OR REPLACE FUNCTION public.authz_request_staff_access(p_tenant uuid, p_reason text, p_minutes integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_staff) THEN
    RAISE EXCEPTION 'authz: staff only' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant) THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO authz_access_grants (tenant_id, kind, requester_id, reason, requested_minutes)
  VALUES (p_tenant, 'staff_support', auth.uid(), p_reason, p_minutes) RETURNING id INTO v_id;
  PERFORM public.authz_log(p_tenant, 'staff_access.requested', 'access_grant', v_id::text, jsonb_build_object('minutes', p_minutes));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.authz_decide_access_grant(p_id uuid, p_approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g authz_access_grants%ROWTYPE; p text;
BEGIN
  SELECT * INTO g FROM authz_access_grants WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR g.tenant_id <> public.get_account_owner_id() THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  IF g.decided_at IS NOT NULL OR g.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'authz: not_pending' USING ERRCODE = '55000'; END IF;
  IF g.requester_id = auth.uid() THEN RAISE EXCEPTION 'authz: self_approval_forbidden' USING ERRCODE = '42501'; END IF;
  IF g.kind = 'staff_support' THEN
    IF NOT public.authz_is_owner() THEN RAISE EXCEPTION 'authz: approver_not_owner' USING ERRCODE = '42501'; END IF;
  ELSE
    FOREACH p IN ARRAY g.permissions LOOP
      IF NOT public.has_account_permission(p) THEN RAISE EXCEPTION 'authz: approver_lacks_permission' USING ERRCODE = '42501'; END IF;
    END LOOP;
  END IF;
  IF p_approve THEN
    UPDATE authz_access_grants SET decided_by = auth.uid(), decided_at = now(), starts_at = now(),
           expires_at = now() + make_interval(mins => g.requested_minutes) WHERE id = g.id;
  ELSE
    UPDATE authz_access_grants SET decided_by = auth.uid(), decided_at = now(), denied = true WHERE id = g.id;
  END IF;
  PERFORM public.authz_log(g.tenant_id, CASE WHEN p_approve THEN 'access.approved' ELSE 'access.denied' END, 'access_grant', g.id::text, jsonb_build_object('kind', g.kind));
END $$;

CREATE OR REPLACE FUNCTION public.authz_revoke_access_grant(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g authz_access_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM authz_access_grants WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (g.tenant_id = public.get_account_owner_id() OR g.requester_id = auth.uid()) THEN
    RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Staff-support grants: revocable by the tenant's owner/admin or by the staff member ending their own access.
  IF NOT (g.requester_id = auth.uid() OR (g.tenant_id = public.get_account_owner_id() AND public.authz_can_admin())) THEN
    RAISE EXCEPTION 'authz: not allowed' USING ERRCODE = '42501';
  END IF;
  IF g.decided_at IS NULL OR g.denied OR g.revoked_at IS NOT NULL OR g.expires_at <= now() THEN RAISE EXCEPTION 'authz: not_active' USING ERRCODE = '55000'; END IF;
  UPDATE authz_access_grants SET revoked_at = now() WHERE id = g.id;
  PERFORM public.authz_log(g.tenant_id, 'access.revoked', 'access_grant', g.id::text);
END $$;

CREATE OR REPLACE FUNCTION public.authz_cancel_access_grant(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE authz_access_grants SET cancelled_at = now()
   WHERE id = p_id AND requester_id = auth.uid() AND decided_at IS NULL AND cancelled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Active elevated permission for the caller in the caller's own tenant.
CREATE OR REPLACE FUNCTION public.authz_has_active_grant(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM authz_access_grants g
    WHERE g.kind = 'permission' AND g.requester_id = auth.uid() AND g.tenant_id = public.get_account_owner_id()
      AND g.decided_at IS NOT NULL AND NOT g.denied AND g.cancelled_at IS NULL
      AND g.revoked_at IS NULL AND g.starts_at <= now() AND g.expires_at > now()
      AND p_key = ANY (g.permissions)
  );
$$;

-- Canonical permission check going forward: base permission OR an active JIT grant.
-- Existing can_* helpers are untouched; migrate them to this one module by module.
CREATE OR REPLACE FUNCTION public.authz_has_permission(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.has_account_permission(p_key) OR public.authz_has_active_grant(p_key);
$$;

-- Used by staff-impersonate (service role): is there an approved, unexpired, unrevoked grant?
CREATE OR REPLACE FUNCTION public.authz_staff_grant_active(p_staff uuid, p_tenant uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id FROM authz_access_grants g
   WHERE g.kind = 'staff_support' AND g.requester_id = p_staff AND g.tenant_id = p_tenant
     AND g.decided_at IS NOT NULL AND NOT g.denied AND g.cancelled_at IS NULL
     AND g.revoked_at IS NULL AND g.starts_at <= now() AND g.expires_at > now()
   ORDER BY g.expires_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.authz_staff_grant_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authz_staff_grant_active(uuid, uuid) TO service_role;

-- ================================================================
-- 4. ABAC / FIELD / RECORD LEVEL
-- ================================================================
CREATE TABLE IF NOT EXISTS public.authz_principal_attrs (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  location_ids uuid[] NOT NULL DEFAULT '{}',
  team_ids     uuid[] NOT NULL DEFAULT '{}',
  clearances   text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS public.authz_abac_policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  resource                text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_]{1,62}$'),
  actions                 text[] NOT NULL CHECK (cardinality(actions) >= 1 AND actions <@ ARRAY['select','insert','update','delete']::text[]),
  enabled                 boolean NOT NULL DEFAULT true,
  applies_min_value_cents bigint,
  applies_tags            text[] NOT NULL DEFAULT '{}',
  require_location_match  boolean NOT NULL DEFAULT false,
  require_team_match      boolean NOT NULL DEFAULT false,
  require_clearance       text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authz_abac_policies_lookup_idx ON public.authz_abac_policies (tenant_id, resource) WHERE enabled;
CREATE TABLE IF NOT EXISTS public.authz_record_acl (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  resource          text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_]{1,62}$'),
  record_id         uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  effect            text NOT NULL CHECK (effect IN ('allow', 'deny')),
  actions           text[] NOT NULL CHECK (cardinality(actions) >= 1 AND actions <@ ARRAY['select','insert','update','delete']::text[]),
  expires_at        timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authz_record_acl_lookup_idx ON public.authz_record_acl (tenant_id, resource, record_id, principal_user_id);
CREATE TABLE IF NOT EXISTS public.authz_field_masks (
  tenant_id        uuid NOT NULL,
  resource         text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_]{1,62}$'),
  field            text NOT NULL CHECK (field ~ '^[a-z][a-z0-9_]{0,62}$'),
  strategy         text NOT NULL CHECK (strategy IN ('redact', 'null', 'partial')),
  exempt_clearance text,
  PRIMARY KEY (tenant_id, resource, field)
);
ALTER TABLE public.authz_principal_attrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authz_abac_policies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authz_record_acl      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authz_field_masks     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authz_principal_attrs_select ON public.authz_principal_attrs;
CREATE POLICY authz_principal_attrs_select ON public.authz_principal_attrs FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND (user_id = auth.uid() OR public.authz_can_admin()));
DROP POLICY IF EXISTS authz_principal_attrs_write ON public.authz_principal_attrs;
CREATE POLICY authz_principal_attrs_write ON public.authz_principal_attrs FOR ALL TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin())
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());
DROP POLICY IF EXISTS authz_abac_policies_all ON public.authz_abac_policies;
CREATE POLICY authz_abac_policies_all ON public.authz_abac_policies FOR ALL TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin())
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());
DROP POLICY IF EXISTS authz_record_acl_all ON public.authz_record_acl;
CREATE POLICY authz_record_acl_all ON public.authz_record_acl FOR ALL TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin())
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());
DROP POLICY IF EXISTS authz_field_masks_all ON public.authz_field_masks;
CREATE POLICY authz_field_masks_all ON public.authz_field_masks FOR ALL TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin())
  WITH CHECK (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());

-- Decision for the caller, same order and reason codes as decide() in abac.ts:
--   owner | acl_deny | acl_allow | policy_location | policy_team | policy_clearance | pass
-- 'pass' means "ABAC has no objection" (the caller's base RLS condition still applies).
CREATE OR REPLACE FUNCTION public.authz_record_decision(
  p_resource text, p_record_id uuid, p_action text,
  p_location uuid DEFAULT NULL, p_team uuid DEFAULT NULL, p_value bigint DEFAULT NULL, p_tags text[] DEFAULT '{}')
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid := public.get_account_owner_id();
  v_deny boolean; v_allow boolean;
  pa authz_principal_attrs%ROWTYPE;
  pol record;
  v_locs uuid[] := '{}'; v_teams uuid[] := '{}'; v_clr text[] := '{}';
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN RETURN 'acl_deny'; END IF;   -- fail closed
  IF public.authz_is_owner() THEN RETURN 'owner'; END IF;

  SELECT COALESCE(bool_or(effect = 'deny'), false), COALESCE(bool_or(effect = 'allow'), false) INTO v_deny, v_allow
    FROM authz_record_acl
   WHERE tenant_id = v_tenant AND resource = p_resource AND record_id = p_record_id AND principal_user_id = v_uid
     AND p_action = ANY (actions) AND (expires_at IS NULL OR expires_at > now());
  IF v_deny THEN RETURN 'acl_deny'; END IF;
  IF v_allow THEN RETURN 'acl_allow'; END IF;

  SELECT * INTO pa FROM authz_principal_attrs WHERE tenant_id = v_tenant AND user_id = v_uid;
  IF FOUND THEN v_locs := pa.location_ids; v_teams := pa.team_ids; v_clr := pa.clearances; END IF;

  FOR pol IN
    SELECT * FROM authz_abac_policies
     WHERE tenant_id = v_tenant AND enabled AND resource = p_resource AND p_action = ANY (actions)
     ORDER BY id
  LOOP
    IF pol.applies_min_value_cents IS NOT NULL AND (p_value IS NULL OR p_value < pol.applies_min_value_cents) THEN CONTINUE; END IF;
    IF cardinality(pol.applies_tags) > 0 AND NOT (COALESCE(p_tags, '{}') && pol.applies_tags) THEN CONTINUE; END IF;
    IF pol.require_location_match AND cardinality(v_locs) > 0 AND (p_location IS NULL OR NOT (p_location = ANY (v_locs))) THEN RETURN 'policy_location'; END IF;
    IF pol.require_team_match AND cardinality(v_teams) > 0 AND (p_team IS NULL OR NOT (p_team = ANY (v_teams))) THEN RETURN 'policy_team'; END IF;
    IF pol.require_clearance IS NOT NULL AND NOT (pol.require_clearance = ANY (v_clr)) THEN RETURN 'policy_clearance'; END IF;
  END LOOP;
  RETURN 'pass';
END $$;
GRANT EXECUTE ON FUNCTION public.authz_record_decision(text, uuid, text, uuid, uuid, bigint, text[]) TO authenticated;

-- Convenience for policies that AND with an existing base condition (owner/pass allowed, ACL allow handled separately).
CREATE OR REPLACE FUNCTION public.authz_allows(
  p_resource text, p_record_id uuid, p_action text,
  p_location uuid DEFAULT NULL, p_team uuid DEFAULT NULL, p_value bigint DEFAULT NULL, p_tags text[] DEFAULT '{}')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.authz_record_decision(p_resource, p_record_id, p_action, p_location, p_team, p_value, p_tags) IN ('owner', 'acl_allow', 'pass');
$$;
GRANT EXECUTE ON FUNCTION public.authz_allows(text, uuid, text, uuid, uuid, bigint, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.authz_mask_rule(p_resource text, p_field text)
RETURNS authz_field_masks LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.* FROM authz_field_masks m
   WHERE m.tenant_id = public.get_account_owner_id() AND m.resource = p_resource AND m.field = p_field
     AND NOT public.authz_is_owner()
     AND NOT (m.exempt_clearance IS NOT NULL AND EXISTS (
           SELECT 1 FROM authz_principal_attrs a WHERE a.tenant_id = m.tenant_id AND a.user_id = auth.uid() AND m.exempt_clearance = ANY (a.clearances)));
$$;

CREATE OR REPLACE FUNCTION public.authz_mask_text(p_resource text, p_field text, p_value text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m authz_field_masks;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  m := public.authz_mask_rule(p_resource, p_field);
  IF m.field IS NULL THEN RETURN p_value; END IF;
  IF m.strategy = 'null' THEN RETURN NULL; END IF;
  IF m.strategy = 'redact' THEN RETURN '••••'; END IF;
  IF length(p_value) <= 4 THEN RETURN repeat('•', length(p_value)); END IF;
  RETURN repeat('•', length(p_value) - 4) || right(p_value, 4);
END $$;

CREATE OR REPLACE FUNCTION public.authz_mask_numeric(p_resource text, p_field text, p_value numeric)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m authz_field_masks;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  m := public.authz_mask_rule(p_resource, p_field);
  IF m.field IS NULL THEN RETURN p_value; END IF;
  IF m.strategy = 'redact' THEN RETURN 0; END IF;
  RETURN NULL;                                   -- 'null' and 'partial' (partial is text-only), same as maskRecord()
END $$;
GRANT EXECUTE ON FUNCTION public.authz_mask_text(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.authz_mask_numeric(text, text, numeric) TO authenticated;

-- "Who can see this record?" / "What can this person see?" for admins (read-only simulation).
CREATE OR REPLACE FUNCTION public.authz_simulate_record(
  p_resource text, p_record_id uuid, p_location uuid, p_team uuid, p_value bigint, p_tags text[])
RETURNS TABLE (user_id uuid, decision text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); m record;
BEGIN
  IF NOT public.authz_can_admin() THEN RAISE EXCEPTION 'authz: admin only' USING ERRCODE = '42501'; END IF;
  FOR m IN SELECT tm.user_id AS uid FROM team_members tm WHERE tm.account_owner_id = v_tenant AND tm.user_id IS NOT NULL LOOP
    user_id := m.uid;
    decision := public.authz_record_decision_for(v_tenant, m.uid, p_resource, p_record_id, 'select', p_location, p_team, p_value, p_tags);
    RETURN NEXT;
  END LOOP;
END $$;

-- Same logic as authz_record_decision but for an explicit principal (members are never owners here).
CREATE OR REPLACE FUNCTION public.authz_record_decision_for(
  p_tenant uuid, p_user uuid, p_resource text, p_record_id uuid, p_action text,
  p_location uuid, p_team uuid, p_value bigint, p_tags text[])
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deny boolean; v_allow boolean; pa authz_principal_attrs%ROWTYPE; pol record;
  v_locs uuid[] := '{}'; v_teams uuid[] := '{}'; v_clr text[] := '{}';
BEGIN
  SELECT COALESCE(bool_or(effect = 'deny'), false), COALESCE(bool_or(effect = 'allow'), false) INTO v_deny, v_allow
    FROM authz_record_acl
   WHERE tenant_id = p_tenant AND resource = p_resource AND record_id = p_record_id AND principal_user_id = p_user
     AND p_action = ANY (actions) AND (expires_at IS NULL OR expires_at > now());
  IF v_deny THEN RETURN 'acl_deny'; END IF;
  IF v_allow THEN RETURN 'acl_allow'; END IF;
  SELECT * INTO pa FROM authz_principal_attrs WHERE tenant_id = p_tenant AND user_id = p_user;
  IF FOUND THEN v_locs := pa.location_ids; v_teams := pa.team_ids; v_clr := pa.clearances; END IF;
  FOR pol IN SELECT * FROM authz_abac_policies WHERE tenant_id = p_tenant AND enabled AND resource = p_resource AND p_action = ANY (actions) ORDER BY id LOOP
    IF pol.applies_min_value_cents IS NOT NULL AND (p_value IS NULL OR p_value < pol.applies_min_value_cents) THEN CONTINUE; END IF;
    IF cardinality(pol.applies_tags) > 0 AND NOT (COALESCE(p_tags, '{}') && pol.applies_tags) THEN CONTINUE; END IF;
    IF pol.require_location_match AND cardinality(v_locs) > 0 AND (p_location IS NULL OR NOT (p_location = ANY (v_locs))) THEN RETURN 'policy_location'; END IF;
    IF pol.require_team_match AND cardinality(v_teams) > 0 AND (p_team IS NULL OR NOT (p_team = ANY (v_teams))) THEN RETURN 'policy_team'; END IF;
    IF pol.require_clearance IS NOT NULL AND NOT (pol.require_clearance = ANY (v_clr)) THEN RETURN 'policy_clearance'; END IF;
  END LOOP;
  RETURN 'pass';
END $$;
REVOKE ALL ON FUNCTION public.authz_record_decision_for(uuid, uuid, text, uuid, text, uuid, uuid, bigint, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authz_simulate_record(text, uuid, uuid, uuid, bigint, text[]) TO authenticated;

-- ================================================================
-- 5. GUEST / EXTERNAL COLLABORATORS
-- ================================================================
CREATE TABLE IF NOT EXISTS public.authz_guest_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  email        text NOT NULL CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  label        text NOT NULL DEFAULT '' CHECK (length(label) <= 120),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  redeemed_by  uuid,
  redeemed_at  timestamptz,
  require_mfa  boolean NOT NULL DEFAULT true,
  watermark    boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '90 days')
);
CREATE INDEX IF NOT EXISTS authz_guest_invites_redeemed_idx ON public.authz_guest_invites (redeemed_by) WHERE redeemed_by IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.authz_guest_scopes (
  invite_id uuid NOT NULL REFERENCES public.authz_guest_invites (id) ON DELETE CASCADE,
  resource  text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_]{1,62}$'),
  record_id uuid NOT NULL,
  actions   text[] NOT NULL CHECK (cardinality(actions) >= 1 AND actions <@ ARRAY['view','comment','upload']::text[]),
  PRIMARY KEY (invite_id, resource, record_id)
);
ALTER TABLE public.authz_guest_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authz_guest_scopes  ENABLE ROW LEVEL SECURITY;

-- Admins of the tenant see invites (never token_hash needed by the client; column privileges below). Guests see nothing directly.
DROP POLICY IF EXISTS authz_guest_invites_select ON public.authz_guest_invites;
CREATE POLICY authz_guest_invites_select ON public.authz_guest_invites FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());
DROP POLICY IF EXISTS authz_guest_scopes_select ON public.authz_guest_scopes;
CREATE POLICY authz_guest_scopes_select ON public.authz_guest_scopes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM authz_guest_invites i WHERE i.id = invite_id AND i.tenant_id = public.get_account_owner_id() AND public.authz_can_admin()));
-- A column REVOKE does not override a table-level grant, so drop the table grant and re-grant every column except token_hash.
REVOKE SELECT ON public.authz_guest_invites FROM authenticated, anon;
GRANT SELECT (id, tenant_id, email, label, expires_at, revoked_at, redeemed_by, redeemed_at, require_mfa, watermark, created_by, created_at)
  ON public.authz_guest_invites TO authenticated;

CREATE OR REPLACE FUNCTION public.authz_create_guest_invite(
  p_email text, p_label text, p_token_hash text, p_expires_at timestamptz, p_scopes jsonb, p_watermark boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); v_id uuid; s jsonb; v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN RAISE EXCEPTION 'authz: not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.authz_can_admin() THEN RAISE EXCEPTION 'authz: admin only' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_scopes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'authz: invalid scopes' USING ERRCODE = '22023'; END IF;
  v_n := jsonb_array_length(p_scopes);
  IF v_n < 1 OR v_n > 50 THEN RAISE EXCEPTION 'authz: scopes must be 1..50' USING ERRCODE = '22023'; END IF;
  IF p_expires_at <= now() OR p_expires_at > now() + interval '90 days' THEN RAISE EXCEPTION 'authz: expiry out of range' USING ERRCODE = '22023'; END IF;

  INSERT INTO authz_guest_invites (tenant_id, email, label, token_hash, expires_at, watermark, created_by)
  VALUES (v_tenant, lower(btrim(p_email)), COALESCE(p_label, ''), p_token_hash, p_expires_at, COALESCE(p_watermark, true), auth.uid())
  RETURNING id INTO v_id;

  FOR s IN SELECT e FROM jsonb_array_elements(p_scopes) AS e LOOP
    INSERT INTO authz_guest_scopes (invite_id, resource, record_id, actions)
    VALUES (v_id, s ->> 'resource', (s ->> 'recordId')::uuid, ARRAY(SELECT jsonb_array_elements_text(s -> 'actions')));
  END LOOP;
  PERFORM public.authz_log(v_tenant, 'guest.invited', 'guest_invite', v_id::text, jsonb_build_object('scopes', v_n, 'expires_at', p_expires_at));
  RETURN v_id;
END $$;

-- Redeem: one generic failure for unknown / expired / revoked / used / wrong user / missing MFA.
CREATE OR REPLACE FUNCTION public.authz_guest_redeem(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(COALESCE(p_token, ''), 'utf8')), 'hex');
  v_email text := lower(COALESCE(auth.jwt() ->> 'email', ''));
  i authz_guest_invites%ROWTYPE;
BEGIN
  SELECT * INTO i FROM authz_guest_invites WHERE token_hash = v_hash FOR UPDATE;
  IF auth.uid() IS NULL OR NOT FOUND
     OR i.revoked_at IS NOT NULL OR i.expires_at <= now()
     OR i.email <> v_email
     OR (i.redeemed_by IS NOT NULL AND i.redeemed_by <> auth.uid())
     OR (i.require_mfa AND COALESCE(auth.jwt() ->> 'aal', '') <> 'aal2') THEN
    RAISE EXCEPTION 'authz: invalid_invite' USING ERRCODE = '42501';
  END IF;
  IF i.redeemed_by IS NULL THEN
    UPDATE authz_guest_invites SET redeemed_by = auth.uid(), redeemed_at = now() WHERE id = i.id;
    PERFORM public.authz_log(i.tenant_id, 'guest.redeemed', 'guest_invite', i.id::text);
  END IF;
  RETURN jsonb_build_object('invite_id', i.id, 'expires_at', i.expires_at, 'watermark', i.watermark);  -- no tenant/org info
END $$;
GRANT EXECUTE ON FUNCTION public.authz_guest_redeem(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.authz_guest_can(p_resource text, p_record_id uuid, p_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM authz_guest_invites i
    JOIN authz_guest_scopes s ON s.invite_id = i.id
    WHERE i.redeemed_by = auth.uid() AND auth.uid() IS NOT NULL
      AND i.revoked_at IS NULL AND i.expires_at > now()
      AND (NOT i.require_mfa OR COALESCE(auth.jwt() ->> 'aal', '') = 'aal2')
      AND s.resource = p_resource AND s.record_id = p_record_id AND p_action = ANY (s.actions)
  );
$$;
GRANT EXECUTE ON FUNCTION public.authz_guest_can(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.authz_revoke_guest_invite(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.authz_can_admin() THEN RAISE EXCEPTION 'authz: admin only' USING ERRCODE = '42501'; END IF;
  UPDATE authz_guest_invites SET revoked_at = now() WHERE id = p_id AND tenant_id = v_tenant AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.authz_log(v_tenant, 'guest.revoked', 'guest_invite', p_id::text);
END $$;

-- ================================================================
-- 6. OWNERSHIP TRANSFER (up to `ready`), ORG DELETION HOLD (offboarding checklist is TS-only for now)
-- ================================================================
CREATE TABLE IF NOT EXISTS public.authz_ownership_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  from_user_id  uuid NOT NULL,
  to_user_id    uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  uuid,
  CHECK (from_user_id <> to_user_id)
);
-- At most one live transfer per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS authz_ownership_transfers_one_live_idx
  ON public.authz_ownership_transfers (tenant_id) WHERE cancelled_at IS NULL;
CREATE TABLE IF NOT EXISTS public.authz_org_deletion_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS authz_org_deletion_one_live_idx
  ON public.authz_org_deletion_requests (tenant_id) WHERE cancelled_at IS NULL;
ALTER TABLE public.authz_ownership_transfers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authz_org_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authz_ownership_transfers_select ON public.authz_ownership_transfers;
CREATE POLICY authz_ownership_transfers_select ON public.authz_ownership_transfers FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND (from_user_id = auth.uid() OR to_user_id = auth.uid() OR public.authz_is_owner()));
DROP POLICY IF EXISTS authz_org_deletion_select ON public.authz_org_deletion_requests;
CREATE POLICY authz_org_deletion_select ON public.authz_org_deletion_requests FOR SELECT TO authenticated
  USING (tenant_id = public.get_account_owner_id() AND public.authz_can_admin());
CREATE OR REPLACE FUNCTION public.authz_request_ownership_transfer(p_to uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF NOT public.authz_is_owner() THEN RAISE EXCEPTION 'authz: not_owner' USING ERRCODE = '42501'; END IF;
  IF p_to = auth.uid() THEN RAISE EXCEPTION 'authz: self_transfer' USING ERRCODE = '22023'; END IF;
  IF NOT public.authz_recent_reauth(300) THEN RAISE EXCEPTION 'authz: reauth_required' USING ERRCODE = '42501'; END IF;
  -- Retire transfers that can no longer complete (ready window 72h + 7d passed, or never accepted within 7d),
  -- otherwise the one-live-transfer index would block new requests forever.
  UPDATE authz_ownership_transfers SET cancelled_at = now()
   WHERE tenant_id = v_tenant AND cancelled_at IS NULL
     AND ((accepted_at IS NOT NULL AND now() >= accepted_at + interval '10 days')
       OR (accepted_at IS NULL AND now() >= requested_at + interval '7 days'));
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE account_owner_id = v_tenant AND user_id = p_to AND invite_status = 'active') THEN
    RAISE EXCEPTION 'authz: target_not_eligible' USING ERRCODE = '22023';
  END IF;
  INSERT INTO authz_ownership_transfers (tenant_id, from_user_id, to_user_id) VALUES (v_tenant, auth.uid(), p_to) RETURNING id INTO v_id;
  PERFORM public.authz_log(v_tenant, 'ownership.transfer_requested', 'ownership_transfer', v_id::text, jsonb_build_object('to', p_to));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.authz_accept_ownership_transfer(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t authz_ownership_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM authz_ownership_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR t.tenant_id <> public.get_account_owner_id() THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  IF t.to_user_id <> auth.uid() THEN RAISE EXCEPTION 'authz: not_target' USING ERRCODE = '42501'; END IF;
  IF t.accepted_at IS NOT NULL OR t.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'authz: not_awaiting_target' USING ERRCODE = '55000'; END IF;
  IF NOT public.authz_recent_reauth(300) THEN RAISE EXCEPTION 'authz: reauth_required' USING ERRCODE = '42501'; END IF;
  UPDATE authz_ownership_transfers SET accepted_at = now() WHERE id = t.id;
  PERFORM public.authz_log(t.tenant_id, 'ownership.transfer_accepted', 'ownership_transfer', t.id::text);
END $$;

CREATE OR REPLACE FUNCTION public.authz_cancel_ownership_transfer(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t authz_ownership_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM authz_ownership_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR t.tenant_id <> public.get_account_owner_id() THEN RAISE EXCEPTION 'authz: not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (auth.uid() IN (t.from_user_id, t.to_user_id) OR public.authz_is_owner()) THEN RAISE EXCEPTION 'authz: not_owner' USING ERRCODE = '42501'; END IF;
  IF t.cancelled_at IS NOT NULL OR (t.accepted_at IS NOT NULL AND now() >= t.accepted_at + interval '72 hours') THEN
    RAISE EXCEPTION 'authz: not_cancellable' USING ERRCODE = '55000';
  END IF;
  UPDATE authz_ownership_transfers SET cancelled_at = now(), cancelled_by = auth.uid() WHERE id = t.id;
  PERFORM public.authz_log(t.tenant_id, 'ownership.transfer_cancelled', 'ownership_transfer', t.id::text);
END $$;

CREATE OR REPLACE FUNCTION public.authz_request_org_deletion()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF NOT public.authz_is_owner() THEN RAISE EXCEPTION 'authz: not_owner' USING ERRCODE = '42501'; END IF;
  IF NOT public.authz_recent_reauth(300) THEN RAISE EXCEPTION 'authz: reauth_required' USING ERRCODE = '42501'; END IF;
  INSERT INTO authz_org_deletion_requests (tenant_id, requested_by) VALUES (v_tenant, auth.uid()) RETURNING id INTO v_id;
  PERFORM public.authz_log(v_tenant, 'org.deletion_requested', 'org_deletion', v_id::text, jsonb_build_object('hold_days', 14));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.authz_cancel_org_deletion(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.authz_is_owner() THEN RAISE EXCEPTION 'authz: not_owner' USING ERRCODE = '42501'; END IF;
  UPDATE authz_org_deletion_requests SET cancelled_at = now()
   WHERE id = p_id AND tenant_id = v_tenant AND cancelled_at IS NULL AND now() < requested_at + interval '14 days';
  IF NOT FOUND THEN RAISE EXCEPTION 'authz: not_on_hold' USING ERRCODE = '55000'; END IF;
  PERFORM public.authz_log(v_tenant, 'org.deletion_cancelled', 'org_deletion', p_id::text);
END $$;

-- ---------------------------------------------------------------- grants
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'authz_is_owner()', 'authz_can_admin()', 'authz_recent_reauth(integer)',
    'authz_create_delegation(uuid, timestamptz, timestamptz, text[])', 'authz_revoke_delegation(uuid)',
    'authz_create_approval(text, text, bigint, text, jsonb)', 'authz_decide_approval(uuid, text, text, text)', 'authz_cancel_approval(uuid, text)',
    'authz_request_access(text[], text, integer)', 'authz_request_staff_access(uuid, text, integer)',
    'authz_decide_access_grant(uuid, boolean)', 'authz_revoke_access_grant(uuid)', 'authz_cancel_access_grant(uuid)',
    'authz_has_active_grant(text)', 'authz_has_permission(text)',
    'authz_create_guest_invite(text, text, text, timestamptz, jsonb, boolean)', 'authz_revoke_guest_invite(uuid)',
    'authz_request_ownership_transfer(uuid)', 'authz_accept_ownership_transfer(uuid)', 'authz_cancel_ownership_transfer(uuid)',
    'authz_request_org_deletion()', 'authz_cancel_org_deletion(uuid)',
    'authz_can_see_approval(uuid)', 'authz_record_decision(text, uuid, text, uuid, uuid, bigint, text[])',
    'authz_allows(text, uuid, text, uuid, uuid, bigint, text[])', 'authz_mask_text(text, text, text)',
    'authz_mask_numeric(text, text, numeric)', 'authz_simulate_record(text, uuid, uuid, uuid, bigint, text[])',
    'authz_guest_redeem(text)', 'authz_guest_can(text, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.authz_mask_rule(text, text) FROM PUBLIC, anon, authenticated;

-- Defense in depth: decision tables change only through the functions above.
REVOKE ALL ON public.authz_events, public.authz_approval_requests, public.authz_approval_step_states, public.authz_approval_decisions,
              public.authz_delegations, public.authz_access_grants, public.authz_guest_scopes, public.authz_ownership_transfers,
              public.authz_org_deletion_requests FROM anon, authenticated;
GRANT SELECT ON public.authz_events, public.authz_approval_requests, public.authz_approval_step_states, public.authz_approval_decisions,
                public.authz_delegations, public.authz_access_grants, public.authz_guest_scopes, public.authz_ownership_transfers,
                public.authz_org_deletion_requests TO authenticated;
REVOKE ALL ON public.authz_guest_invites FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.authz_guest_invites FROM authenticated;
REVOKE ALL ON public.authz_approval_policies, public.authz_principal_attrs, public.authz_abac_policies, public.authz_record_acl, public.authz_field_masks FROM anon;

-- =====================================================================
-- RECIPE: applying ABAC + masking to an existing table (NOT applied by this migration).
-- Example for a table `jobs` with columns location_id, team_id, total_cents, sensitivity_tags:
--
--   -- 1) restrict (AND with the existing tenant policy, keep ACL allow as an override):
--   CREATE POLICY jobs_abac_restrict ON public.jobs AS RESTRICTIVE FOR SELECT TO authenticated
--     USING ( public.authz_allows('jobs', id, 'select', location_id, team_id, total_cents, sensitivity_tags) );
--   -- (a RESTRICTIVE policy is ANDed with existing permissive ones; 'acl_allow' passes here but the
--   --  existing tenant policy still applies, i.e. an ACL allow never reaches beyond the tenant.)
--
--   -- 2) mask: read through a security_invoker view, not the table
--   CREATE VIEW public.jobs_masked WITH (security_invoker = true) AS
--     SELECT id, title, public.authz_mask_numeric('jobs','total_cost_cents', total_cost_cents) AS total_cost_cents
--       FROM public.jobs;
--
--   -- 3) guest access: add a PERMISSIVE policy
--   CREATE POLICY jobs_guest_view ON public.jobs FOR SELECT TO authenticated
--     USING ( public.authz_guest_can('jobs', id, 'view') );
--
-- Measure with EXPLAIN (ANALYZE, BUFFERS) on realistic row counts before enabling on hot tables.
-- =====================================================================
