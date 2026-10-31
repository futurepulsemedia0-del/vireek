/*
# QuickBooks reconciliation audit (read-only)

## What this migration does
Backend for the accountant reconciliation report on /dashboard/quickbooks: findings between imported
incumbent invoices and QuickBooks invoices, a resolve-with-note workflow and an audit trail.

- `ar_invoices.source_system / source_id`  where an imported invoice came from (nullable; extended, not replaced,
                                           if an earlier import task already added them)
- `ar_invoices.bill_to_role`               'owner' | 'tenant' (nullable) for the bill-to rule check
- `qbo_recon_runs`                         one row per audit run (summary + status)
- `qbo_recon_findings`                     one row per finding, stable per (connection, fingerprint)
- `qbo_recon_events`                       append-only audit trail (detected / reopened / resolved / cleared ...)
- `qbo_recon_apply()`                      service-role only: atomically upserts a run's findings and events
- `qbo_recon_set_status()`                 authenticated: a human resolves / reopens a finding with a note

## Security model
1. Every row carries `user_id` = ACCOUNT OWNER id. Clients can SELECT when can_manage_quickbooks().
2. Clients can NEVER insert/update/delete these tables. Findings come from the edge function (service role);
   a human changes status only through qbo_recon_set_status(), which re-checks owner + permission.
3. Nothing here writes ar_invoices, ar_payments, the ledger or QuickBooks. An invoice with payments is
   therefore never touched by the audit.
*/

-- =============================================================
-- 1. SOURCE COLUMNS (idempotent)
-- =============================================================
ALTER TABLE public.ar_invoices ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE public.ar_invoices ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE public.ar_invoices ADD COLUMN IF NOT EXISTS bill_to_role text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ar_invoices_bill_to_role_chk') THEN
    ALTER TABLE public.ar_invoices
      ADD CONSTRAINT ar_invoices_bill_to_role_chk CHECK (bill_to_role IS NULL OR bill_to_role IN ('owner', 'tenant'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ar_invoices_source
  ON public.ar_invoices (user_id, source_system, source_id) WHERE source_system IS NOT NULL AND source_id IS NOT NULL;

-- =============================================================
-- 2. RUNS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.qbo_recon_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_qbo_recon_runs_conn ON public.qbo_recon_runs (connection_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qbo_recon_one_running ON public.qbo_recon_runs (connection_id) WHERE status = 'running';

-- =============================================================
-- 3. FINDINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.qbo_recon_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  bucket text NOT NULL CHECK (bucket IN (
    'missing_in_qbo', 'missing_in_fsm', 'amount_mismatch', 'duplicate_in_qbo',
    'modified_after_export', 'deposit_credit_mismatch', 'tax_mismatch', 'bill_to_mismatch')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  cents_at_stake integer NOT NULL CHECK (cents_at_stake >= 0),
  vireek_id uuid,
  qbo_id text,
  has_payments boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_sig text NOT NULL,
  suggested_action text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cleared')),
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  resolved_by uuid,
  resolved_at timestamptz,
  first_run_id uuid REFERENCES public.qbo_recon_runs (id) ON DELETE SET NULL,
  last_run_id uuid REFERENCES public.qbo_recon_runs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, fingerprint),
  CHECK (status <> 'resolved' OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_qbo_recon_findings_conn_status ON public.qbo_recon_findings (connection_id, status, bucket);

-- =============================================================
-- 4. EVENTS (append-only audit trail)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.qbo_recon_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections (id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES public.qbo_recon_findings (id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.qbo_recon_runs (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('detected', 'reopened', 'resolved', 'unresolved', 'cleared')),
  actor uuid,
  note text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qbo_recon_events_finding ON public.qbo_recon_events (finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qbo_recon_events_conn ON public.qbo_recon_events (connection_id, created_at DESC);

-- =============================================================
-- 5. RLS: read-only for permitted users, no client writes
-- =============================================================
ALTER TABLE public.qbo_recon_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_recon_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_recon_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qbo_recon_runs_select" ON public.qbo_recon_runs;
CREATE POLICY "qbo_recon_runs_select" ON public.qbo_recon_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());
DROP POLICY IF EXISTS "qbo_recon_findings_select" ON public.qbo_recon_findings;
CREATE POLICY "qbo_recon_findings_select" ON public.qbo_recon_findings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());
DROP POLICY IF EXISTS "qbo_recon_events_select" ON public.qbo_recon_events;
CREATE POLICY "qbo_recon_events_select" ON public.qbo_recon_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_quickbooks());

-- lint:allow-destructive REVOKE of the TRUNCATE privilege only; no data is removed
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.qbo_recon_runs, public.qbo_recon_findings, public.qbo_recon_events FROM anon, authenticated;
REVOKE ALL ON public.qbo_recon_runs, public.qbo_recon_findings, public.qbo_recon_events FROM anon;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'qbo_recon_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qbo_recon_runs;
  END IF;
END $$;

-- =============================================================
-- 6. qbo_recon_apply (service role): idempotent upsert of one run's findings
--    p_findings: [{fingerprint,bucket,severity,cents_at_stake,vireek_id,qbo_id,has_payments,evidence,evidence_sig,suggested_action}]
--    p_complete: true only when the audit saw ALL QuickBooks invoices; only then are unseen open findings cleared.
-- =============================================================
CREATE OR REPLACE FUNCTION public.qbo_recon_apply(p_owner uuid, p_connection uuid, p_run uuid, p_findings jsonb, p_complete boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f jsonb;
  ex public.qbo_recon_findings%ROWTYPE;
  v_id uuid;
  v_new int := 0;
  v_reopened int := 0;
  v_cleared int := 0;
  v_seen int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qbo_connections WHERE id = p_connection AND user_id = p_owner) THEN
    RAISE EXCEPTION 'Connection not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM qbo_recon_runs WHERE id = p_run AND user_id = p_owner AND connection_id = p_connection) THEN
    RAISE EXCEPTION 'Run not found';
  END IF;
  IF p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array' THEN
    RAISE EXCEPTION 'Findings must be an array';
  END IF;

  FOR f IN SELECT * FROM jsonb_array_elements(p_findings) LOOP
    v_seen := v_seen + 1;
    SELECT * INTO ex FROM qbo_recon_findings WHERE connection_id = p_connection AND fingerprint = f ->> 'fingerprint' FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO qbo_recon_findings (user_id, connection_id, fingerprint, bucket, severity, cents_at_stake, vireek_id, qbo_id, has_payments,
                                      evidence, evidence_sig, suggested_action, first_run_id, last_run_id)
      VALUES (p_owner, p_connection, f ->> 'fingerprint', f ->> 'bucket', f ->> 'severity', (f ->> 'cents_at_stake')::integer,
              nullif(f ->> 'vireek_id', '')::uuid, nullif(f ->> 'qbo_id', ''), coalesce((f ->> 'has_payments')::boolean, false),
              coalesce(f -> 'evidence', '{}'::jsonb), f ->> 'evidence_sig', f ->> 'suggested_action', p_run, p_run)
      RETURNING id INTO v_id;
      INSERT INTO qbo_recon_events (user_id, connection_id, finding_id, run_id, action) VALUES (p_owner, p_connection, v_id, p_run, 'detected');
      v_new := v_new + 1;
    ELSE
      UPDATE qbo_recon_findings SET
        severity = f ->> 'severity',
        cents_at_stake = (f ->> 'cents_at_stake')::integer,
        has_payments = coalesce((f ->> 'has_payments')::boolean, false),
        evidence = coalesce(f -> 'evidence', '{}'::jsonb),
        suggested_action = f ->> 'suggested_action',
        last_run_id = p_run,
        updated_at = now(),
        -- a resolved finding whose numbers changed, or a cleared one that came back, is open again
        status = CASE WHEN ex.status = 'cleared' OR (ex.status = 'resolved' AND ex.evidence_sig IS DISTINCT FROM f ->> 'evidence_sig') THEN 'open' ELSE ex.status END,
        resolution_note = CASE WHEN ex.status = 'cleared' OR (ex.status = 'resolved' AND ex.evidence_sig IS DISTINCT FROM f ->> 'evidence_sig') THEN NULL ELSE ex.resolution_note END,
        resolved_by = CASE WHEN ex.status = 'cleared' OR (ex.status = 'resolved' AND ex.evidence_sig IS DISTINCT FROM f ->> 'evidence_sig') THEN NULL ELSE ex.resolved_by END,
        resolved_at = CASE WHEN ex.status = 'cleared' OR (ex.status = 'resolved' AND ex.evidence_sig IS DISTINCT FROM f ->> 'evidence_sig') THEN NULL ELSE ex.resolved_at END,
        evidence_sig = f ->> 'evidence_sig'
      WHERE id = ex.id;
      IF ex.status = 'cleared' OR (ex.status = 'resolved' AND ex.evidence_sig IS DISTINCT FROM f ->> 'evidence_sig') THEN
        INSERT INTO qbo_recon_events (user_id, connection_id, finding_id, run_id, action, note, details)
        VALUES (p_owner, p_connection, ex.id, p_run, 'reopened',
                CASE WHEN ex.status = 'resolved' THEN 'Numbers changed after it was resolved.' ELSE 'Detected again.' END,
                jsonb_build_object('previous_status', ex.status, 'previous_cents', ex.cents_at_stake, 'cents', (f ->> 'cents_at_stake')::integer));
        v_reopened := v_reopened + 1;
      END IF;
    END IF;
  END LOOP;

  IF p_complete THEN
    WITH gone AS (
      UPDATE qbo_recon_findings SET status = 'cleared', updated_at = now()
      WHERE connection_id = p_connection AND user_id = p_owner AND status = 'open' AND last_run_id IS DISTINCT FROM p_run
      RETURNING id
    ), ev AS (
      INSERT INTO qbo_recon_events (user_id, connection_id, finding_id, run_id, action, note)
      SELECT p_owner, p_connection, id, p_run, 'cleared', 'No longer detected in a complete audit.' FROM gone
      RETURNING 1
    )
    SELECT count(*) INTO v_cleared FROM ev;
  END IF;

  RETURN jsonb_build_object('seen', v_seen, 'new', v_new, 'reopened', v_reopened, 'cleared', v_cleared);
END;
$$;

-- =============================================================
-- 7. qbo_recon_set_status (human): resolve with a note, or reopen
-- =============================================================
CREATE OR REPLACE FUNCTION public.qbo_recon_set_status(p_finding uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  f public.qbo_recon_findings%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_quickbooks() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('open', 'resolved') THEN RAISE EXCEPTION 'Status must be open or resolved'; END IF;

  SELECT * INTO f FROM qbo_recon_findings WHERE id = p_finding AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found'; END IF;

  IF p_status = 'resolved' THEN
    IF f.status <> 'open' THEN RAISE EXCEPTION 'Only an open finding can be resolved'; END IF;
    IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'A resolution note is required'; END IF;
    IF length(v_note) > 1000 THEN RAISE EXCEPTION 'Resolution note is too long'; END IF;
    UPDATE qbo_recon_findings SET status = 'resolved', resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now(), updated_at = now() WHERE id = f.id;
    INSERT INTO qbo_recon_events (user_id, connection_id, finding_id, action, actor, note) VALUES (v_owner, f.connection_id, f.id, 'resolved', auth.uid(), v_note);
  ELSE
    IF f.status <> 'resolved' THEN RAISE EXCEPTION 'Only a resolved finding can be reopened'; END IF;
    UPDATE qbo_recon_findings SET status = 'open', resolution_note = NULL, resolved_by = NULL, resolved_at = NULL, updated_at = now() WHERE id = f.id;
    INSERT INTO qbo_recon_events (user_id, connection_id, finding_id, action, actor, note) VALUES (v_owner, f.connection_id, f.id, 'unresolved', auth.uid(), v_note);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.qbo_recon_apply(uuid, uuid, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_recon_apply(uuid, uuid, uuid, jsonb, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.qbo_recon_set_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qbo_recon_set_status(uuid, text, text) TO authenticated;
