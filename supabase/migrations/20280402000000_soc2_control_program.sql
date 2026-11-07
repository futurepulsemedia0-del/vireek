/*
  # SOC 2 readiness program — control registry, evidence ledger, public-claims gate

  This is READINESS tooling. It does not make Vireek SOC 2 compliant and no
  value stored here may be presented as an attestation.

  ## New objects
  - compliance_controls        control definitions, synced from docs/compliance/soc2/controls.json
  - compliance_claim_controls  which controls gate which public Trust Center claim
  - compliance_evidence        APPEND-ONLY ledger of timestamped, hashed evidence records
  - compliance_control_status  view: declared status + evidence freshness (staff only, security_invoker)
  - public_trust_claims()      anon-callable: claim_key, 'evidenced' | 'in_progress', last_verified date.
                               Exposes no control ids, owners, gaps or evidence content.
  - compliance_rls_coverage() / compliance_access_summary() / compliance_audit_summary(int) /
    compliance_retention_summary()   service_role-only snapshot functions used by the
                               compliance-evidence edge function
  - storage bucket compliance-evidence (private; no policies => service_role only)

  ## Security model
  - All three tables: RLS on, SELECT for Vireek staff only, NO client INSERT/UPDATE/DELETE.
    Writes happen only through the compliance-evidence edge function (service role).
  - compliance_evidence is immutable: a trigger rejects UPDATE and DELETE, including for the
    service role. Evidence that can be edited is not evidence.
  - Idempotency: UNIQUE (control_id, collector, sha256) — a retried upload is a no-op.

  ## Rollback
  Additive only. To remove: drop the functions, view and tables created here (in reverse order)
  and delete the 'compliance-evidence' bucket after exporting its contents. Do this only by a
  reviewed migration — evidence deletion must itself be a recorded decision.
*/

-- =============================================================
-- 1) CONTROL DEFINITIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_controls (
  id text PRIMARY KEY CHECK (id ~ '^[A-Z]{3}-[0-9]{2}$'),
  criteria text[] NOT NULL CHECK (cardinality(criteria) > 0),
  category text NOT NULL CHECK (category IN ('security', 'availability', 'confidentiality')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 8 AND 300),
  status text NOT NULL CHECK (status IN ('met', 'partial', 'missing')),
  owner_role text NOT NULL CHECK (char_length(owner_role) BETWEEN 3 AND 200),
  owner text CHECK (owner IS NULL OR char_length(owner) BETWEEN 2 AND 200),
  frequency_days integer NOT NULL CHECK (frequency_days BETWEEN 1 AND 400),
  collectors text[] NOT NULL DEFAULT '{}',
  implementation text[] NOT NULL DEFAULT '{}',
  gap text NOT NULL CHECK (char_length(gap) BETWEEN 5 AND 2000),
  registry_version text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.compliance_controls ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.compliance_claim_controls (
  claim_key text NOT NULL CHECK (claim_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  control_id text NOT NULL REFERENCES public.compliance_controls (id) ON DELETE CASCADE,
  PRIMARY KEY (claim_key, control_id)
);

ALTER TABLE public.compliance_claim_controls ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 2) EVIDENCE LEDGER (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.compliance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id text NOT NULL REFERENCES public.compliance_controls (id) ON DELETE RESTRICT,
  collector text NOT NULL CHECK (collector ~ '^(repo|github|supabase|manual)\.[a-z_]+$'),
  collected_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('collected', 'blocked', 'error')),
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'info')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(summary) <= 16384),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text CHECK (storage_path IS NULL OR char_length(storage_path) <= 400),
  run_ref text CHECK (run_ref IS NULL OR char_length(run_ref) <= 300),
  source text NOT NULL CHECK (source IN ('ci', 'edge', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_id, collector, sha256)
);

CREATE INDEX IF NOT EXISTS compliance_evidence_latest_idx
  ON public.compliance_evidence (control_id, collector, collected_at DESC);

ALTER TABLE public.compliance_evidence ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.compliance_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'compliance_evidence is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_compliance_evidence_immutable ON public.compliance_evidence;
CREATE TRIGGER trg_compliance_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.compliance_evidence
  FOR EACH ROW EXECUTE FUNCTION public.compliance_evidence_immutable();

-- =============================================================
-- 3) ACCESS: staff read-only; writes only via service role
-- =============================================================
REVOKE ALL ON public.compliance_controls, public.compliance_claim_controls, public.compliance_evidence FROM anon, authenticated;
GRANT SELECT ON public.compliance_controls, public.compliance_claim_controls, public.compliance_evidence TO authenticated;

DROP POLICY IF EXISTS "staff_select_compliance_controls" ON public.compliance_controls;
CREATE POLICY "staff_select_compliance_controls" ON public.compliance_controls
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_select_compliance_claim_controls" ON public.compliance_claim_controls;
CREATE POLICY "staff_select_compliance_claim_controls" ON public.compliance_claim_controls
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_select_compliance_evidence" ON public.compliance_evidence;
CREATE POLICY "staff_select_compliance_evidence" ON public.compliance_evidence
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- =============================================================
-- 4) STATUS VIEW — the single place that decides "fresh / overdue / failing"
--    evidence_state precedence: never > incomplete > failing > overdue > fresh
--    (not_applicable = control has no automated or manual collector configured)
-- =============================================================
CREATE OR REPLACE VIEW public.compliance_control_status
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT c.id AS control_id,
         c.frequency_days,
         e.collected_at,
         e.result,
         e.outcome
    FROM public.compliance_controls c
   CROSS JOIN LATERAL unnest(c.collectors) AS k (collector)
    LEFT JOIN LATERAL (
      SELECT ev.collected_at, ev.result, ev.outcome
        FROM public.compliance_evidence ev
       WHERE ev.control_id = c.id AND ev.collector = k.collector
       ORDER BY ev.collected_at DESC
       LIMIT 1
    ) e ON true
), agg AS (
  SELECT l.control_id,
         count(*) AS collector_count,
         count(l.collected_at) AS with_evidence,
         max(l.collected_at) AS last_evidence_at,
         min(l.collected_at) AS oldest_latest_at,
         coalesce(bool_or(l.collected_at IS NOT NULL AND (l.result <> 'collected' OR l.outcome = 'fail')), false) AS any_failing,
         coalesce(bool_or(l.collected_at IS NOT NULL AND l.collected_at < now() - make_interval(days => l.frequency_days)), false) AS any_overdue
    FROM latest l
   GROUP BY l.control_id
)
SELECT c.id,
       c.criteria,
       c.category,
       c.title,
       c.status,
       c.owner_role,
       c.owner,
       c.frequency_days,
       c.collectors,
       c.implementation,
       c.gap,
       c.registry_version,
       c.synced_at,
       a.last_evidence_at,
       a.oldest_latest_at AS oldest_evidence_at,
       CASE WHEN a.with_evidence = a.collector_count AND a.oldest_latest_at IS NOT NULL
            THEN a.oldest_latest_at + make_interval(days => c.frequency_days) END AS next_due_at,
       CASE
         WHEN coalesce(a.collector_count, 0) = 0 THEN 'not_applicable'
         WHEN a.with_evidence = 0 THEN 'never'
         WHEN a.with_evidence < a.collector_count THEN 'incomplete'
         WHEN a.any_failing THEN 'failing'
         WHEN a.any_overdue THEN 'overdue'
         ELSE 'fresh'
       END AS evidence_state
  FROM public.compliance_controls c
  LEFT JOIN agg a ON a.control_id = c.id;

REVOKE ALL ON public.compliance_control_status FROM anon, authenticated;
GRANT SELECT ON public.compliance_control_status TO authenticated;

-- =============================================================
-- 5) PUBLIC CLAIMS GATE
--    A claim is 'evidenced' ONLY if every gating control is declared 'met' AND
--    its evidence is fresh and not failing. Anything else — including no data,
--    an unsynced registry or an unknown claim — is simply absent or 'in_progress'.
-- =============================================================
CREATE OR REPLACE FUNCTION public.public_trust_claims()
RETURNS TABLE (claim_key text, status text, last_verified date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cc.claim_key,
         CASE WHEN bool_and(s.status = 'met' AND s.evidence_state = 'fresh') THEN 'evidenced' ELSE 'in_progress' END,
         CASE WHEN bool_and(s.status = 'met' AND s.evidence_state = 'fresh')
              THEN (min(s.oldest_evidence_at) AT TIME ZONE 'utc')::date END
    FROM public.compliance_claim_controls cc
    JOIN public.compliance_control_status s ON s.id = cc.control_id
   GROUP BY cc.claim_key
   ORDER BY cc.claim_key;
$$;

REVOKE ALL ON FUNCTION public.public_trust_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_trust_claims() TO anon, authenticated, service_role;

-- =============================================================
-- 6) SNAPSHOT FUNCTIONS (service_role only) used by the evidence collector
-- =============================================================
CREATE OR REPLACE FUNCTION public.compliance_rls_coverage()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH t AS (
    SELECT c.oid, c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  ), pol AS (
    SELECT tablename, count(*) AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'tables_total', (SELECT count(*) FROM t),
    'tables_with_rls', (SELECT count(*) FROM t WHERE relrowsecurity),
    'tables_without_rls', coalesce((SELECT jsonb_agg(relname ORDER BY relname) FROM t WHERE NOT relrowsecurity), '[]'::jsonb),
    'rls_enabled_without_policies', coalesce((
      SELECT jsonb_agg(t.relname ORDER BY t.relname) FROM t LEFT JOIN pol ON pol.tablename = t.relname
       WHERE t.relrowsecurity AND pol.tablename IS NULL), '[]'::jsonb),
    'permissive_select_using_true', coalesce((
      SELECT jsonb_agg(jsonb_build_object('table', p.tablename, 'policy', p.policyname, 'roles', p.roles) ORDER BY p.tablename, p.policyname)
        FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.cmd IN ('SELECT', 'ALL') AND p.qual = 'true'), '[]'::jsonb),
    'anon_executable_security_definer_functions', coalesce((
      SELECT jsonb_agg(DISTINCT p.proname ORDER BY p.proname)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'execute')), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.compliance_access_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'staff_profiles', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'role', p.role, 'status', p.status, 'created_at', p.created_at) ORDER BY p.created_at)
        FROM public.profiles p WHERE p.is_staff), '[]'::jsonb),
    'profiles_by_role', coalesce((
      SELECT jsonb_agg(jsonb_build_object('role', x.role, 'status', x.status, 'count', x.n) ORDER BY x.role, x.status)
        FROM (SELECT role, status, count(*) AS n FROM public.profiles GROUP BY role, status) x), '[]'::jsonb),
    'team_members_by_role', coalesce((
      SELECT jsonb_agg(jsonb_build_object('role', x.role, 'invite_status', x.invite_status, 'count', x.n) ORDER BY x.role, x.invite_status)
        FROM (SELECT role, invite_status, count(*) AS n FROM public.team_members GROUP BY role, invite_status) x), '[]'::jsonb),
    'sso_domains_by_status', coalesce((
      SELECT jsonb_agg(jsonb_build_object('status', x.status, 'count', x.n) ORDER BY x.status)
        FROM (SELECT status, count(*) AS n FROM public.sso_domains GROUP BY status) x), '[]'::jsonb),
    'scim', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE revoked_at IS NULL),
        'revoked', count(*) FILTER (WHERE revoked_at IS NOT NULL),
        'active_unused_90d', count(*) FILTER (WHERE revoked_at IS NULL AND coalesce(last_used_at, created_at) < now() - interval '90 days'))
        FROM public.scim_tokens),
    'custom_roles', (SELECT count(*) FROM public.custom_roles)
  );
$$;

CREATE OR REPLACE FUNCTION public.compliance_audit_summary(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH params AS (SELECT least(greatest(coalesce(p_days, 30), 1), 90) AS d),
  w AS (
    SELECT a.user_id, a.action
      FROM public.audit_log a, params
     WHERE a.created_at >= now() - make_interval(days => params.d)
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window_days', (SELECT d FROM params),
    'entries_in_window', (SELECT count(*) FROM w),
    'accounts_with_entries', (SELECT count(DISTINCT user_id) FROM w),
    'by_action', coalesce((
      SELECT jsonb_agg(jsonb_build_object('action', t.action, 'count', t.n) ORDER BY t.n DESC, t.action)
        FROM (SELECT action, count(*) AS n FROM w GROUP BY action ORDER BY n DESC LIMIT 200) t), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.compliance_retention_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'policies', (
      SELECT jsonb_build_object(
        'total', count(*),
        'auto_delete_enabled', count(*) FILTER (WHERE auto_delete_enabled),
        'legal_hold', count(*) FILTER (WHERE legal_hold),
        'last_swept_at', max(last_swept_at))
        FROM public.data_retention_policies),
    'deletion_requests_by_status', coalesce((
      SELECT jsonb_agg(jsonb_build_object('status', x.status, 'count', x.n) ORDER BY x.status)
        FROM (SELECT status, count(*) AS n FROM public.deletion_requests GROUP BY status) x), '[]'::jsonb),
    'deletion_requests_overdue', (
      SELECT count(*) FROM public.deletion_requests
       WHERE status = 'grace_period' AND scheduled_for < now() - interval '1 day')
  );
$$;

REVOKE ALL ON FUNCTION public.compliance_rls_coverage() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_access_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_audit_summary(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_retention_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_rls_coverage() TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_access_summary() TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_audit_summary(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_retention_summary() TO service_role;

-- =============================================================
-- 7) PRIVATE EVIDENCE BUCKET (no storage policies => only the service role can touch it)
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('compliance-evidence', 'compliance-evidence', false, 10485760, ARRAY['application/json'])
ON CONFLICT (id) DO NOTHING;
