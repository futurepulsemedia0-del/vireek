/*
  # Commercial Approval-to-Cash

  Links a commercial customer's PO / work-order approval (+ NTE) to the
  job / quote / invoice, checks the invoice BEFORE it is sent, tracks the
  invoice through sent > received > approved/rejected > paid, runs a
  configurable follow-up ladder, and feeds overdue / rejected invoices into
  the existing `revenue_recovery_events` ledger.

  ## Reuses (no new concepts)
  - invoices, quotes, jobs, customers (customer_type = 'commercial')
  - public.invoice_total_cents()          (same total the invoice balance uses)
  - job_photos (kind = 'after') + jobs.customer_signature_at  -> completion proof
  - invoice_reminders + invoice-email templates -> reminder emails
  - revenue_recovery_events               -> overdue / rejected queue
  - audit_log via log_audit_event()       -> owner-initiated overrides

  ## Rules
  - Opt-in per customer: a row in commercial_billing_profiles. No profile =
    nothing here touches that customer's invoices.
  - Hard block: BEFORE trigger on invoices refuses draft -> sent when the
    pre-invoice check fails (mode 'block'). 'warn' mode only records warnings.
  - Demand letters: stored as drafts, status 'pending_review'. Nothing in this
    migration or its cron sends them. There is no 'sent' state.
  - RLS: every table scoped to get_account_owner_id() + can_view_billing.
    Events/follow-ups/drafts have no client INSERT policy.

  ## Deploy order
    1. Run this migration (needs 20261126 revenue ledger + 20270402 invoice_detail).
    2. supabase functions deploy commercial-collections-run --no-verify-jwt
    3. Redeploy invoice-email (adds the pre-send gate).
    4. Schedule the cron (commented block at the bottom).

  ## Rollback
    DROP TRIGGER trg_commercial_gate_invoice_send / trg_commercial_sync_invoice ON invoices;
    DROP the commercial_* tables and functions. The revenue_recovery_events
    constraint additions are harmless to leave in place.
*/

-- =============================================================
-- 0. Extend the shared recovery ledger (constraints re-read from the live DB,
--    so we add to whatever list is actually deployed instead of overwriting it)
-- =============================================================
DO $$
DECLARE
  v_name text;
  v_def  text;
  v_new  text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.revenue_recovery_events'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ~ 'source_type = ANY'
  LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'revenue_recovery_events source_type CHECK not found; run the revenue ledger migrations first';
  END IF;
  IF v_def NOT LIKE '%invoice_rejected%' THEN
    v_new := replace(v_def, '''invoice_overdue''::text', '''invoice_overdue''::text, ''invoice_rejected''::text');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'source_type CHECK has no invoice_overdue value to extend: %', v_def;
    END IF;
    EXECUTE format('ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT %I', v_name);
    EXECUTE format('ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT %I %s', v_name, v_new);
  END IF;

  v_name := NULL;
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.revenue_recovery_events'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ~ 'source_table = ANY'
  LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'revenue_recovery_events source_table CHECK not found';
  END IF;
  IF v_def NOT LIKE '%''invoices''%' THEN
    v_new := replace(v_def, '''quotes''::text', '''quotes''::text, ''invoices''::text');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'source_table CHECK has no quotes value to extend: %', v_def;
    END IF;
    EXECUTE format('ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT %I', v_name);
    EXECUTE format('ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT %I %s', v_name, v_new);
  END IF;
END $$;

-- =============================================================
-- 1. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public.commercial_can_bill()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.invoice_permission('can_view_billing');
$$;
GRANT EXECUTE ON FUNCTION public.commercial_can_bill() TO authenticated;

-- ladder_days: 1..6 strictly ascending whole days, 1..365
CREATE OR REPLACE FUNCTION public.commercial_ladder_valid(p integer[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL
     AND cardinality(p) BETWEEN 1 AND 6
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p) WITH ORDINALITY AS u(v, i)
       WHERE u.v < 1 OR u.v > 365 OR (u.i > 1 AND u.v <= p[(u.i - 1)::int])
     );
$$;

-- =============================================================
-- 2. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pre_invoice_mode text NOT NULL DEFAULT 'block' CHECK (pre_invoice_mode IN ('block', 'warn')),
  require_po boolean NOT NULL DEFAULT true,
  require_completion_proof boolean NOT NULL DEFAULT true,
  reminders_enabled boolean NOT NULL DEFAULT true,
  ladder_days integer[] NOT NULL DEFAULT '{30,45,60}' CHECK (public.commercial_ladder_valid(ladder_days)),
  -- 'sent' = days since the invoice was sent, 'due' = days past the due date
  ladder_basis text NOT NULL DEFAULT 'sent' CHECK (ladder_basis IN ('sent', 'due')),
  demand_draft_after_days integer NOT NULL DEFAULT 60 CHECK (demand_draft_after_days BETWEEN 1 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id)
);

CREATE TABLE IF NOT EXISTS commercial_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  po_number text CHECK (po_number IS NULL OR char_length(btrim(po_number)) BETWEEN 1 AND 100),
  work_order_number text CHECK (work_order_number IS NULL OR char_length(btrim(work_order_number)) BETWEEN 1 AND 100),
  approved_amount_cents bigint NOT NULL CHECK (approved_amount_cents > 0),
  approval_source text NOT NULL
    CHECK (approval_source IN ('purchase_order', 'work_order', 'email', 'portal', 'verbal_logged', 'other')),
  evidence_storage_path text CHECK (evidence_storage_path IS NULL OR char_length(evidence_storage_path) <= 500),
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(btrim(evidence_ref)) BETWEEN 1 AND 500),
  approved_by_name text NOT NULL CHECK (char_length(btrim(approved_by_name)) BETWEEN 2 AND 200),
  approved_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason text,
  recorded_by uuid DEFAULT auth.uid(),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_approvals_has_number CHECK (po_number IS NOT NULL OR work_order_number IS NOT NULL),
  CONSTRAINT commercial_approvals_has_link CHECK (customer_id IS NOT NULL OR job_id IS NOT NULL OR quote_id IS NOT NULL),
  CONSTRAINT commercial_approvals_has_evidence CHECK (evidence_storage_path IS NOT NULL OR evidence_ref IS NOT NULL),
  CONSTRAINT commercial_approvals_void_reason CHECK (status <> 'void' OR (void_reason IS NOT NULL AND btrim(void_reason) <> ''))
);
CREATE INDEX IF NOT EXISTS idx_commercial_approvals_job ON commercial_approvals(user_id, job_id) WHERE job_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_commercial_approvals_quote ON commercial_approvals(user_id, quote_id) WHERE quote_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_commercial_approvals_customer ON commercial_approvals(user_id, customer_id) WHERE customer_id IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS commercial_invoice_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  approval_id uuid REFERENCES commercial_approvals(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'draft'
    CHECK (stage IN ('draft', 'blocked_needs_approval', 'sent', 'received', 'approved', 'rejected', 'paid', 'void')),
  block_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(block_reasons) = 'array'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  checked_at timestamptz,
  last_check_hash text,
  rejection_reason text,
  override_by uuid,
  override_reason text,
  override_at timestamptz,
  override_total_cents bigint,
  sent_at timestamptz,
  received_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  paid_at timestamptz,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id),
  CONSTRAINT commercial_tracking_rejection_reason
    CHECK (stage <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''))
);
CREATE INDEX IF NOT EXISTS idx_commercial_tracking_user_stage ON commercial_invoice_tracking(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_commercial_tracking_approval ON commercial_invoice_tracking(approval_id) WHERE approval_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'approval_recorded', 'approval_linked', 'precheck_passed', 'precheck_warned', 'precheck_blocked',
    'override', 'stage_changed', 'reminder_sent', 'reminder_failed', 'demand_draft_queued',
    'recovery_logged', 'packet_generated'
  )),
  from_stage text,
  to_stage text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commercial_events_invoice ON commercial_invoice_events(invoice_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_events_dedupe ON commercial_invoice_events(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  step_day integer NOT NULL CHECK (step_day BETWEEN 1 AND 365),
  kind text NOT NULL CHECK (kind IN ('reminder', 'demand_draft')),
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'queued', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text,
  UNIQUE (invoice_id, step_day, kind)
);

CREATE TABLE IF NOT EXISTS commercial_demand_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  disclaimer text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Always true. There is deliberately no 'sent' status: Vireek never sends these.
  review_required boolean NOT NULL DEFAULT true CHECK (review_required),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'reviewed', 'dismissed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_billing_profiles', 'commercial_approvals', 'commercial_invoice_tracking', 'commercial_demand_drafts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.commercial_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================
-- 3. Tenant-integrity triggers: a row may only reference the SAME account's
--    customer / job / quote / invoice / approval, whatever the caller passes.
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_assert_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  v_ok boolean;
BEGIN
  IF j->>'customer_id' IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM customers WHERE id = (j->>'customer_id')::uuid AND user_id = NEW.user_id) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'customer does not belong to this account' USING ERRCODE = '42501'; END IF;
  END IF;
  IF j->>'job_id' IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM jobs WHERE id = (j->>'job_id')::uuid AND user_id = NEW.user_id) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'job does not belong to this account' USING ERRCODE = '42501'; END IF;
  END IF;
  IF j->>'quote_id' IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM quotes WHERE id = (j->>'quote_id')::uuid AND user_id = NEW.user_id) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'quote does not belong to this account' USING ERRCODE = '42501'; END IF;
  END IF;
  IF j->>'invoice_id' IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM invoices WHERE id = (j->>'invoice_id')::uuid AND user_id = NEW.user_id) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'invoice does not belong to this account' USING ERRCODE = '42501'; END IF;
  END IF;
  IF j->>'approval_id' IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM commercial_approvals WHERE id = (j->>'approval_id')::uuid AND user_id = NEW.user_id) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'approval does not belong to this account' USING ERRCODE = '42501'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_billing_profiles', 'commercial_approvals', 'commercial_invoice_tracking', 'commercial_demand_drafts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_refs ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_refs BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.commercial_assert_refs()', t, t);
  END LOOP;
END $$;

-- Approvals are evidence: only status/void_reason/notes may change after insert,
-- and the evidence file must live in this account's storage folder.
CREATE OR REPLACE FUNCTION public.commercial_approvals_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_storage_path IS NOT NULL AND split_part(NEW.evidence_storage_path, '/', 1) <> NEW.user_id::text THEN
    RAISE EXCEPTION 'evidence file must be stored under this account''s folder' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
       OR NEW.po_number IS DISTINCT FROM OLD.po_number OR NEW.work_order_number IS DISTINCT FROM OLD.work_order_number
       OR NEW.approved_amount_cents IS DISTINCT FROM OLD.approved_amount_cents
       OR NEW.approval_source IS DISTINCT FROM OLD.approval_source
       OR NEW.evidence_storage_path IS DISTINCT FROM OLD.evidence_storage_path
       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
       OR NEW.approved_by_name IS DISTINCT FROM OLD.approved_by_name
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by THEN
      RAISE EXCEPTION 'approval evidence is immutable; void it and record a new approval' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'void' AND NEW.status <> 'void' THEN
      RAISE EXCEPTION 'a voided approval cannot be reactivated' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_approvals_guard ON commercial_approvals;
CREATE TRIGGER trg_commercial_approvals_guard BEFORE INSERT OR UPDATE ON commercial_approvals
  FOR EACH ROW EXECUTE FUNCTION public.commercial_approvals_guard();

CREATE OR REPLACE FUNCTION public.commercial_events_no_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'commercial_invoice_events is append-only' USING ERRCODE = '42501'; END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_events_no_update ON commercial_invoice_events;
CREATE TRIGGER trg_commercial_events_no_update BEFORE UPDATE ON commercial_invoice_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_events_no_update();

-- Drafts: a human may edit the text and mark it reviewed/dismissed. Nothing else.
CREATE OR REPLACE FUNCTION public.commercial_drafts_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.disclaimer IS DISTINCT FROM OLD.disclaimer OR NEW.facts IS DISTINCT FROM OLD.facts
     OR NEW.review_required IS DISTINCT FROM OLD.review_required THEN
    RAISE EXCEPTION 'only the draft text and review status can change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending_review' THEN
      RAISE EXCEPTION 'draft already %', OLD.status USING ERRCODE = '42501';
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_drafts_guard ON commercial_demand_drafts;
CREATE TRIGGER trg_commercial_drafts_guard BEFORE UPDATE ON commercial_demand_drafts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_drafts_guard();

-- =============================================================
-- 4. RLS
-- =============================================================
ALTER TABLE commercial_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_invoice_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_invoice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_demand_drafts ENABLE ROW LEVEL SECURITY;

-- profiles + approvals: full CRUD for the owner / billing-permitted team members (delete: profiles only)
DROP POLICY IF EXISTS "cc_profiles_select" ON commercial_billing_profiles;
CREATE POLICY "cc_profiles_select" ON commercial_billing_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_profiles_insert" ON commercial_billing_profiles;
CREATE POLICY "cc_profiles_insert" ON commercial_billing_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_profiles_update" ON commercial_billing_profiles;
CREATE POLICY "cc_profiles_update" ON commercial_billing_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_profiles_delete" ON commercial_billing_profiles;
CREATE POLICY "cc_profiles_delete" ON commercial_billing_profiles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());

DROP POLICY IF EXISTS "cc_approvals_select" ON commercial_approvals;
CREATE POLICY "cc_approvals_select" ON commercial_approvals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_approvals_insert" ON commercial_approvals;
CREATE POLICY "cc_approvals_insert" ON commercial_approvals FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_approvals_update" ON commercial_approvals;
CREATE POLICY "cc_approvals_update" ON commercial_approvals FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
-- no DELETE policy: evidence is voided, never deleted

-- tracking / events / followups: read-only to clients (all writes via the SECURITY DEFINER functions below)
DROP POLICY IF EXISTS "cc_tracking_select" ON commercial_invoice_tracking;
CREATE POLICY "cc_tracking_select" ON commercial_invoice_tracking FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_events_select" ON commercial_invoice_events;
CREATE POLICY "cc_events_select" ON commercial_invoice_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_followups_select" ON commercial_followups;
CREATE POLICY "cc_followups_select" ON commercial_followups FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());

-- drafts: read + review (update), no client insert/delete
DROP POLICY IF EXISTS "cc_drafts_select" ON commercial_demand_drafts;
CREATE POLICY "cc_drafts_select" ON commercial_demand_drafts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_drafts_update" ON commercial_demand_drafts;
CREATE POLICY "cc_drafts_update" ON commercial_demand_drafts FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());

REVOKE INSERT, UPDATE, DELETE ON commercial_invoice_tracking, commercial_invoice_events, commercial_followups FROM authenticated, anon;
REVOKE INSERT, DELETE ON commercial_demand_drafts FROM authenticated, anon;
REVOKE ALL ON commercial_billing_profiles, commercial_approvals, commercial_invoice_tracking,
  commercial_invoice_events, commercial_followups, commercial_demand_drafts FROM anon;

-- =============================================================
-- 5. Approval evidence bucket (private, per-account folder, no deletes)
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('commercial-approvals', 'commercial-approvals', false, 10485760,
        ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'message/rfc822'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "cc_evidence_read" ON storage.objects;
CREATE POLICY "cc_evidence_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'commercial-approvals' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.commercial_can_bill());
DROP POLICY IF EXISTS "cc_evidence_insert" ON storage.objects;
CREATE POLICY "cc_evidence_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'commercial-approvals' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.commercial_can_bill());

-- =============================================================
-- 6. Core evaluator (read-only). Used by the RPC, the send gate and invoice-email.
--    Returns jsonb: { applies, mode, blocked, overridden, reasons[], warnings[],
--                     approval_id, total_cents, billed_other_cents, approved_amount_cents }
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_evaluate(p_inv invoices)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trk commercial_invoice_tracking;
  v_prof commercial_billing_profiles;
  v_appr commercial_approvals;
  v_cust uuid;
  v_total bigint;
  v_billed bigint := 0;
  v_proof boolean := false;
  v_items jsonb := '[]'::jsonb;
  v_overridden boolean := false;
  v_blocked boolean;
BEGIN
  SELECT * INTO v_trk FROM commercial_invoice_tracking WHERE invoice_id = p_inv.id;
  v_cust := COALESCE(p_inv.customer_id, v_trk.customer_id);
  IF v_cust IS NULL THEN
    RETURN jsonb_build_object('applies', false, 'blocked', false, 'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb);
  END IF;
  SELECT * INTO v_prof FROM commercial_billing_profiles WHERE user_id = p_inv.user_id AND customer_id = v_cust;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applies', false, 'blocked', false, 'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb);
  END IF;

  v_total := public.invoice_total_cents(p_inv.line_items, p_inv.tax_percent);

  -- approval: explicit link first, else job, else quote, else customer-level; newest active wins
  IF v_trk.approval_id IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals WHERE id = v_trk.approval_id AND user_id = p_inv.user_id AND status = 'active';
  END IF;
  IF v_appr.id IS NULL AND p_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals
    WHERE user_id = p_inv.user_id AND status = 'active' AND job_id = p_inv.job_id
    ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_appr.id IS NULL AND p_inv.quote_id IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals
    WHERE user_id = p_inv.user_id AND status = 'active' AND quote_id = p_inv.quote_id
    ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_appr.id IS NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals
    WHERE user_id = p_inv.user_id AND status = 'active' AND customer_id = v_cust AND job_id IS NULL AND quote_id IS NULL
    ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;

  -- rule 1: PO / work-order number
  IF v_prof.require_po AND v_appr.id IS NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'code', 'missing_po', 'message', 'No PO or work-order approval is recorded for this invoice.'));
  END IF;

  -- rule 2: total vs approved amount (NTE is cumulative over this approval's other open invoices)
  IF v_appr.id IS NOT NULL THEN
    SELECT COALESCE(SUM(public.invoice_total_cents(i.line_items, i.tax_percent)), 0) INTO v_billed
    FROM commercial_invoice_tracking t JOIN invoices i ON i.id = t.invoice_id
    WHERE t.approval_id = v_appr.id AND t.invoice_id <> p_inv.id
      AND t.stage NOT IN ('void', 'rejected') AND i.status <> 'void';
    IF v_total + v_billed > v_appr.approved_amount_cents THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'code', 'over_approved_amount',
        'message', 'Invoice total plus previously billed amounts exceeds the approved amount (NTE).',
        'invoice_total_cents', v_total, 'previously_billed_cents', v_billed,
        'approved_amount_cents', v_appr.approved_amount_cents,
        'excess_cents', v_total + v_billed - v_appr.approved_amount_cents));
    END IF;
  END IF;

  -- rule 3: completion proof = an 'after' photo on the job OR the customer's signature on the job
  IF v_prof.require_completion_proof THEN
    IF p_inv.job_id IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM job_photos jp WHERE jp.job_id = p_inv.job_id AND jp.user_id = p_inv.user_id AND jp.kind = 'after')
          OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_inv.job_id AND j.user_id = p_inv.user_id AND j.customer_signature_at IS NOT NULL)
      INTO v_proof;
    END IF;
    IF NOT v_proof THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'code', 'missing_completion_proof',
        'message', CASE WHEN p_inv.job_id IS NULL THEN 'No job is linked, so there is no completion proof.'
                        ELSE 'The job has no completion photo or customer signature.' END));
    END IF;
  END IF;

  -- an override only counts while the total has not grown past what the owner accepted
  IF v_trk.override_at IS NOT NULL AND COALESCE(v_trk.override_total_cents, -1) >= v_total THEN
    v_overridden := true;
  END IF;

  v_blocked := v_prof.pre_invoice_mode = 'block' AND NOT v_overridden AND jsonb_array_length(v_items) > 0;

  RETURN jsonb_build_object(
    'applies', true, 'mode', v_prof.pre_invoice_mode, 'blocked', v_blocked, 'overridden', v_overridden,
    'reasons', CASE WHEN v_blocked THEN v_items ELSE '[]'::jsonb END,
    'warnings', CASE WHEN v_blocked THEN '[]'::jsonb ELSE v_items END,
    'approval_id', v_appr.id, 'customer_id', v_cust, 'total_cents', v_total,
    'billed_other_cents', v_billed, 'approved_amount_cents', v_appr.approved_amount_cents);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_evaluate(invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_evaluate(invoices) TO service_role;

-- internal event writer (idempotent through dedupe_key)
CREATE OR REPLACE FUNCTION public.commercial_log_event(
  p_user uuid, p_invoice uuid, p_type text, p_from text, p_to text, p_reason text, p_details jsonb, p_dedupe text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, from_stage, to_stage, reason, details, actor_id, dedupe_key)
  VALUES (p_user, p_invoice, p_type, p_from, p_to, p_reason, COALESCE(p_details, '{}'::jsonb), auth.uid(), p_dedupe)
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_log_event(uuid, uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_log_event(uuid, uuid, text, text, text, text, jsonb, text) TO service_role;

-- =============================================================
-- 7. Pre-invoice check: persists "blocked_needs_approval" + reasons (service-role core + owner RPC)
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_precheck_core(p_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv invoices;
  res jsonb;
  trk commercial_invoice_tracking;
  v_hash text;
  v_new_stage text;
  v_type text;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice not found' USING ERRCODE = 'P0002'; END IF;
  res := public.commercial_evaluate(inv);
  IF NOT (res->>'applies')::boolean THEN RETURN res; END IF;

  INSERT INTO commercial_invoice_tracking (user_id, invoice_id, customer_id)
  VALUES (inv.user_id, inv.id, (res->>'customer_id')::uuid)
  ON CONFLICT (invoice_id) DO NOTHING;
  SELECT * INTO trk FROM commercial_invoice_tracking WHERE invoice_id = inv.id FOR UPDATE;

  -- only a not-yet-sent invoice changes stage; later stages just report
  IF trk.stage IN ('draft', 'blocked_needs_approval') THEN
    v_new_stage := CASE WHEN (res->>'blocked')::boolean THEN 'blocked_needs_approval' ELSE 'draft' END;
    v_hash := md5((res - 'checked_at')::text);
    UPDATE commercial_invoice_tracking SET
      stage = v_new_stage,
      stage_changed_at = CASE WHEN stage <> v_new_stage THEN now() ELSE stage_changed_at END,
      approval_id = COALESCE(approval_id, NULLIF(res->>'approval_id', '')::uuid),
      block_reasons = res->'reasons', warnings = res->'warnings',
      checked_at = now(), last_check_hash = v_hash
    WHERE id = trk.id;
    IF trk.last_check_hash IS DISTINCT FROM v_hash THEN
      v_type := CASE WHEN (res->>'blocked')::boolean THEN 'precheck_blocked'
                     WHEN jsonb_array_length(res->'warnings') > 0 THEN 'precheck_warned' ELSE 'precheck_passed' END;
      PERFORM public.commercial_log_event(inv.user_id, inv.id, v_type, trk.stage, v_new_stage,
        NULL, jsonb_build_object('reasons', res->'reasons', 'warnings', res->'warnings', 'total_cents', res->'total_cents'),
        'precheck:' || inv.id || ':' || v_hash);
    END IF;
  END IF;
  RETURN res;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_precheck_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_precheck_core(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.commercial_precheck_invoice(p_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id())
     OR NOT public.commercial_can_bill() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN public.commercial_precheck_core(p_invoice_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_precheck_invoice(uuid) TO authenticated;

-- Owner-only exception. Valid only while the total stays <= the total the owner accepted.
CREATE OR REPLACE FUNCTION public.commercial_override_block(p_invoice_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invoices; trk commercial_invoice_tracking; v_total bigint;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR inv.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'only the account owner can override a block' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'an override needs a written reason (10+ characters)' USING ERRCODE = '22023';
  END IF;
  PERFORM public.commercial_precheck_core(p_invoice_id);
  SELECT * INTO trk FROM commercial_invoice_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not tracked' USING ERRCODE = '22023'; END IF;
  IF trk.stage NOT IN ('draft', 'blocked_needs_approval') THEN
    RAISE EXCEPTION 'invoice already sent' USING ERRCODE = '22023';
  END IF;
  v_total := public.invoice_total_cents(inv.line_items, inv.tax_percent);
  UPDATE commercial_invoice_tracking SET override_by = auth.uid(), override_reason = btrim(p_reason),
    override_at = now(), override_total_cents = v_total WHERE id = trk.id;
  PERFORM public.commercial_log_event(inv.user_id, inv.id, 'override', trk.stage, trk.stage, btrim(p_reason),
    jsonb_build_object('override_total_cents', v_total, 'was_blocked_for', trk.block_reasons));
  PERFORM public.log_audit_event(inv.user_id, 'commercial_block_override', 'invoices', inv.id::text);
  RETURN public.commercial_precheck_core(p_invoice_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_override_block(uuid, text) TO authenticated;

-- Link / re-link an invoice to a recorded approval (e.g. after a change order)
CREATE OR REPLACE FUNCTION public.commercial_link_invoice_approval(p_invoice_id uuid, p_approval_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invoices; v_prev uuid;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commercial_approvals WHERE id = p_approval_id AND user_id = inv.user_id AND status = 'active') THEN
    RAISE EXCEPTION 'approval not found or not active' USING ERRCODE = '42501';
  END IF;
  INSERT INTO commercial_invoice_tracking (user_id, invoice_id, customer_id)
  VALUES (inv.user_id, inv.id, inv.customer_id) ON CONFLICT (invoice_id) DO NOTHING;
  SELECT approval_id INTO v_prev FROM commercial_invoice_tracking WHERE invoice_id = inv.id FOR UPDATE;
  UPDATE commercial_invoice_tracking SET approval_id = p_approval_id WHERE invoice_id = inv.id;
  PERFORM public.commercial_log_event(inv.user_id, inv.id, 'approval_linked', NULL, NULL, NULL,
    jsonb_build_object('approval_id', p_approval_id, 'previous_approval_id', v_prev));
  RETURN public.commercial_precheck_core(inv.id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_link_invoice_approval(uuid, uuid) TO authenticated;

-- =============================================================
-- 8. Hard send gate + status sync on invoices
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_gate_invoice_send()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE res jsonb;
BEGIN
  IF NEW.status = 'sent' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    res := public.commercial_evaluate(NEW);
    IF (res->>'applies')::boolean AND (res->>'blocked')::boolean THEN
      RAISE EXCEPTION 'blocked_needs_approval: %', (SELECT string_agg(r->>'code', ', ') FROM jsonb_array_elements(res->'reasons') r)
        USING ERRCODE = '23514', DETAIL = (res->'reasons')::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_gate_invoice_send ON invoices;
CREATE TRIGGER trg_commercial_gate_invoice_send BEFORE INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.commercial_gate_invoice_send();

CREATE OR REPLACE FUNCTION public.commercial_balance_cents(p_invoice_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(0,
    public.invoice_total_cents(i.line_items, i.tax_percent)
    - COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = i.id), 0)
    + COALESCE((SELECT SUM(amount_cents) FROM invoice_refunds WHERE invoice_id = i.id), 0))::bigint
  FROM invoices i WHERE i.id = p_invoice_id;
$$;
REVOKE ALL ON FUNCTION public.commercial_balance_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_balance_cents(uuid) TO service_role;

-- Write/refresh the overdue / rejected row in the shared ledger. One row per invoice.
CREATE OR REPLACE FUNCTION public.commercial_sync_recovery_event(p_invoice_id uuid, p_source_type text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invoices;
BEGIN
  IF p_source_type NOT IN ('invoice_overdue', 'invoice_rejected') THEN
    RAISE EXCEPTION 'bad source_type' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO revenue_recovery_events
    (user_id, source_type, source_table, source_id, customer_name, occurred_at,
     estimated_value_cents, estimated_value_basis, status, notes)
  VALUES
    (inv.user_id, p_source_type, 'invoices', inv.id, COALESCE(NULLIF(inv.customer_name, ''), 'Unknown customer'), now(),
     public.commercial_balance_cents(inv.id)::integer, 'job_invoice', 'open', p_note)
  ON CONFLICT (source_table, source_id) DO UPDATE SET
    source_type = CASE WHEN revenue_recovery_events.source_type = 'invoice_rejected' THEN 'invoice_rejected' ELSE EXCLUDED.source_type END,
    estimated_value_cents = EXCLUDED.estimated_value_cents,
    notes = EXCLUDED.notes
  WHERE revenue_recovery_events.status IN ('open', 'contacted');
  PERFORM public.commercial_log_event(inv.user_id, inv.id, 'recovery_logged', NULL, NULL, p_note,
    jsonb_build_object('source_type', p_source_type), 'recovery:' || inv.id || ':' || p_source_type);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_sync_recovery_event(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_sync_recovery_event(uuid, text, text) TO service_role;

-- Set a stage with the allowed-transition table + full event log. Internal core.
CREATE OR REPLACE FUNCTION public.commercial_apply_stage(p_invoice_id uuid, p_to text, p_reason text, p_system boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE trk commercial_invoice_tracking; v_ok boolean;
BEGIN
  SELECT * INTO trk FROM commercial_invoice_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not tracked' USING ERRCODE = '22023'; END IF;
  IF trk.stage = p_to THEN RETURN; END IF;  -- idempotent
  v_ok := CASE trk.stage
    WHEN 'draft'                  THEN p_to IN ('sent', 'paid', 'void')
    WHEN 'blocked_needs_approval' THEN p_to IN ('sent', 'void')
    WHEN 'sent'                   THEN p_to IN ('received', 'approved', 'rejected', 'paid', 'void')
    WHEN 'received'               THEN p_to IN ('approved', 'rejected', 'paid', 'void')
    WHEN 'approved'               THEN p_to IN ('rejected', 'paid', 'void')
    WHEN 'rejected'               THEN p_to IN ('sent', 'received', 'approved', 'paid', 'void')
    ELSE false END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'cannot move an invoice from % to %', trk.stage, p_to USING ERRCODE = '22023';
  END IF;
  IF p_to = 'rejected' AND (p_reason IS NULL OR char_length(btrim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = '22023';
  END IF;
  UPDATE commercial_invoice_tracking SET
    stage = p_to, stage_changed_at = now(),
    sent_at     = CASE WHEN p_to = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
    received_at = CASE WHEN p_to = 'received' THEN now() ELSE received_at END,
    approved_at = CASE WHEN p_to = 'approved' THEN now() ELSE approved_at END,
    rejected_at = CASE WHEN p_to = 'rejected' THEN now() ELSE rejected_at END,
    paid_at     = CASE WHEN p_to = 'paid' THEN now() ELSE paid_at END,
    rejection_reason = CASE WHEN p_to = 'rejected' THEN btrim(p_reason) ELSE rejection_reason END
  WHERE id = trk.id;
  PERFORM public.commercial_log_event(trk.user_id, p_invoice_id, 'stage_changed', trk.stage, p_to, p_reason,
    jsonb_build_object('system', p_system));
  IF p_to = 'rejected' THEN
    PERFORM public.commercial_sync_recovery_event(p_invoice_id, 'invoice_rejected', 'Rejected by customer: ' || btrim(p_reason));
  ELSIF p_to = 'paid' THEN
    UPDATE revenue_recovery_events SET status = 'recovered', recovery_method = 'manual', resolved_at = now(),
      recovered_amount_cents = (SELECT public.invoice_total_cents(i.line_items, i.tax_percent)::integer FROM invoices i WHERE i.id = p_invoice_id)
    WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status IN ('open', 'contacted');
  ELSIF p_to = 'void' THEN
    UPDATE revenue_recovery_events SET status = 'written_off', resolved_at = now(), notes = COALESCE(notes, '') || ' (invoice voided)'
    WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status IN ('open', 'contacted');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_apply_stage(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_apply_stage(uuid, text, text, boolean) TO service_role;

-- Human-driven transitions only: customer received / approved / rejected(reason) / resubmitted.
CREATE OR REPLACE FUNCTION public.commercial_set_stage(p_invoice_id uuid, p_to text, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id())
     OR NOT public.commercial_can_bill() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_to NOT IN ('received', 'approved', 'rejected', 'sent') THEN
    RAISE EXCEPTION 'stage % is set by the system (send / payment / void)', p_to USING ERRCODE = '22023';
  END IF;
  PERFORM public.commercial_apply_stage(p_invoice_id, p_to, p_reason, false);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_set_stage(uuid, text, text) TO authenticated;

-- Keep the stage in step with invoices.status (sent / paid / void). Creates the row on first send.
CREATE OR REPLACE FUNCTION public.commercial_sync_invoice_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE res jsonb; v_to text;
BEGIN
  IF NEW.status NOT IN ('sent', 'paid', 'void') OR (TG_OP = 'UPDATE' AND OLD.status = NEW.status) THEN
    RETURN NEW;
  END IF;
  res := public.commercial_evaluate(NEW);
  IF NOT (res->>'applies')::boolean AND NOT EXISTS (SELECT 1 FROM commercial_invoice_tracking WHERE invoice_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO commercial_invoice_tracking (user_id, invoice_id, customer_id)
  VALUES (NEW.user_id, NEW.id, NEW.customer_id) ON CONFLICT (invoice_id) DO NOTHING;
  v_to := NEW.status;
  -- 'sent' only advances an unsent invoice; a re-send must not undo received/approved
  IF v_to = 'sent' AND EXISTS (SELECT 1 FROM commercial_invoice_tracking WHERE invoice_id = NEW.id AND stage NOT IN ('draft', 'blocked_needs_approval')) THEN
    RETURN NEW;
  END IF;
  PERFORM public.commercial_apply_stage(NEW.id, v_to, NULL, true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_sync_invoice ON invoices;
CREATE TRIGGER trg_commercial_sync_invoice AFTER INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.commercial_sync_invoice_status();

-- =============================================================
-- 9. Cron support (service role only): candidates, idempotent claims, draft queue
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_collections_candidates(p_limit integer DEFAULT 500)
RETURNS TABLE (
  invoice_id uuid, user_id uuid, customer_id uuid, invoice_number text, customer_name text,
  customer_email text, customer_phone text, due_date date, invoice_sent_at timestamptz,
  stage text, balance_cents bigint, ladder_days integer[], ladder_basis text,
  demand_draft_after_days integer, po_number text, work_order_number text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.user_id, p.customer_id, i.invoice_number, i.customer_name, i.customer_email, i.customer_phone,
         i.due_date, COALESCE(t.sent_at, i.sent_at), COALESCE(t.stage, 'sent'),
         public.commercial_balance_cents(i.id), p.ladder_days, p.ladder_basis, p.demand_draft_after_days,
         a.po_number, a.work_order_number
  FROM invoices i
  JOIN commercial_billing_profiles p ON p.user_id = i.user_id AND p.customer_id = i.customer_id
  LEFT JOIN commercial_invoice_tracking t ON t.invoice_id = i.id
  LEFT JOIN commercial_approvals a ON a.id = t.approval_id
  WHERE p.reminders_enabled
    AND i.status IN ('sent', 'viewed')
    AND COALESCE(t.stage, 'sent') IN ('sent', 'received', 'approved', 'rejected')
    AND COALESCE(t.sent_at, i.sent_at) IS NOT NULL
    AND public.commercial_balance_cents(i.id) > 0
  ORDER BY COALESCE(t.sent_at, i.sent_at)
  LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.commercial_collections_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_collections_candidates(integer) TO service_role;

-- Exactly-once claim of one (invoice, step, kind). A failed or stale claim may be retried up to 3 times.
CREATE OR REPLACE FUNCTION public.commercial_claim_followup(p_invoice_id uuid, p_step_day integer, p_kind text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_id uuid;
BEGIN
  SELECT user_id INTO v_user FROM invoices WHERE id = p_invoice_id;
  IF v_user IS NULL THEN RETURN false; END IF;
  INSERT INTO commercial_followups AS f (user_id, invoice_id, step_day, kind)
  VALUES (v_user, p_invoice_id, p_step_day, p_kind)
  ON CONFLICT (invoice_id, step_day, kind) DO UPDATE
    SET status = 'claimed', attempts = f.attempts + 1, claimed_at = now(), error = NULL
    WHERE f.attempts < 3 AND (f.status = 'failed' OR (f.status = 'claimed' AND f.claimed_at < now() - interval '15 minutes'))
  RETURNING f.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_claim_followup(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_claim_followup(uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.commercial_complete_followup(
  p_invoice_id uuid, p_step_day integer, p_kind text, p_status text, p_error text DEFAULT NULL, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f commercial_followups;
BEGIN
  IF p_status NOT IN ('sent', 'queued', 'failed', 'skipped') THEN RAISE EXCEPTION 'bad status' USING ERRCODE = '22023'; END IF;
  UPDATE commercial_followups SET status = p_status, completed_at = now(), error = left(p_error, 500)
  WHERE invoice_id = p_invoice_id AND step_day = p_step_day AND kind = p_kind RETURNING * INTO f;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_kind = 'reminder' AND p_status IN ('sent', 'failed') THEN
    PERFORM public.commercial_log_event(f.user_id, p_invoice_id,
      CASE WHEN p_status = 'sent' THEN 'reminder_sent' ELSE 'reminder_failed' END, NULL, NULL, p_error,
      p_details || jsonb_build_object('step_day', p_step_day),
      'followup:' || p_invoice_id || ':' || p_kind || ':' || p_step_day || ':' || p_status || ':' || f.attempts);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_complete_followup(uuid, integer, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_complete_followup(uuid, integer, text, text, text, jsonb) TO service_role;

-- Queue the demand-letter DRAFT (idempotent: one per invoice). Never sends anything.
CREATE OR REPLACE FUNCTION public.commercial_queue_demand_draft(
  p_invoice_id uuid, p_body text, p_disclaimer text, p_facts jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invoices; v_id uuid;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO commercial_demand_drafts (user_id, invoice_id, customer_id, body, disclaimer, facts)
  VALUES (inv.user_id, inv.id, inv.customer_id, p_body, p_disclaimer, COALESCE(p_facts, '{}'::jsonb))
  ON CONFLICT (invoice_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    PERFORM public.commercial_log_event(inv.user_id, inv.id, 'demand_draft_queued', NULL, NULL,
      'Draft only - review required, never auto-sent', jsonb_build_object('draft_id', v_id), 'draft:' || inv.id);
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_queue_demand_draft(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_queue_demand_draft(uuid, text, text, jsonb) TO service_role;

-- Packet generation is client-side; this just records that it happened (owner/billing only).
CREATE OR REPLACE FUNCTION public.commercial_log_packet(p_invoice_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id();
  IF v_user IS NULL OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM public.commercial_log_event(v_user, p_invoice_id, 'packet_generated', NULL, NULL, NULL, '{}'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_log_packet(uuid) TO authenticated;

/*
  ## Schedule (run once in the Supabase SQL editor; fill the two placeholders)
    select cron.schedule('commercial-collections-run', '17 6 * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/commercial-collections-run',
        headers := jsonb_build_object('X-Cron-Secret', '<COMMERCIAL_COLLECTIONS_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/
