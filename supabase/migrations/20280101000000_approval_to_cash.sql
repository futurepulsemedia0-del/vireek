/*
  # Commercial Approval-to-Cash

  ## What already exists (and is REUSED, not duplicated)
  - `work_orders` (20270410000000) IS the customer PO / work-order entity: po_number, not_to_exceed_cents,
    approval_status, approver_name, approved_at, approval_notes. (`purchase_orders` is vendor procurement
    — it has vendor_id — and is not touched.)
  - `invoices` + `invoice_total_cents()` + `invoice_payments/refunds` + `invoice_reminders` + `_invoice_audit()`
    (20261205000000, 20270402000000) — totals, balances, reminder log, audit trail.
  - `job_evidence_chain_entries` (20261231000000) + `work_order_visits` — completion proof.
  - `revenue_recovery_events` (20260922000000) — the recovery queue.
  - `audit_log` — the audit trail for every status change here.

  ## What this adds
  1. `work_order_id` link on invoices / quotes / jobs (same-account enforced; an invoice inherits it from its
     quote or job at insert). Once an invoice has left draft its link can be added but never changed/removed.
  2. Account policy on `business_profile`: a2c_require_po, a2c_require_completion_proof, a2c_followup_days.
  3. Pre-invoice gate `_a2c_gate()` — BLOCK: work order not approved, billed total over NTE, (optionally) missing PO /
     completion proof. WARN: missing PO / completion proof by default. Enforced in the database on the
     draft -> sent transition (BEFORE trigger) and exposed to the UI / invoice-email via RPC. A block can be
     overridden only by the account owner, with a written reason; the override is void if the total changes.
  4. `invoice_ar_tracking` — customer-side state: sent -> received -> approved | rejected(reason) -> paid.
     `paid` is set ONLY by the invoice-payment trigger. Every change is written to audit_log.
  5. Follow-up ladder: configurable days after due date. A human must approve follow-ups per invoice
     (`followups_approved_at`) before anything is emailed. Idempotent via compare-and-set claim.
  6. `invoice_demand_drafts` — factual payment-request DRAFT text. Status draft | reviewed | discarded.
     There is deliberately NO "sent" state and no send path anywhere in Vireek.
  7. Overdue / rejected invoices -> `revenue_recovery_events` (source_table 'invoices'; new source_type
     'invoice_rejected', existing 'invoice_overdue'). One row per invoice (existing UNIQUE).
  8. `invoice_packet_data()` — DB-derived facts for the invoice packet PDF (invoice + PO + completion proof + approval).

  ## Security
  - Every new table: RLS ON, SELECT scoped to get_account_owner_id() + can_view_billing, NO client write
    policies (writes revoked). All writes go through SECURITY DEFINER RPCs/triggers that re-check owner + permission.
  - Cron-only functions are granted to service_role only.
  - No LLM-generated numbers. Money is integer cents; totals come from invoice_total_cents().

  ## Deploy order
    1. Run this migration (additive; backfills tracking rows for existing sent/viewed/paid invoices — no emails,
       followups are NOT approved for any backfilled invoice).
    2. supabase functions deploy invoice-email invoice-followup-ladder
    3. Set secret APPROVAL_TO_CASH_CRON_SECRET and schedule invoice-followup-ladder (daily) with header X-Cron-Secret.
    4. Ship the frontend changes.

  ## Rollback
  Behavioural kill-switch: DROP TRIGGER trigger_a2c_b_send_guard ON invoices;  (gate stops blocking).
  Full: drop the triggers/functions/tables created here and the added columns (all new, nothing else depends on them).
  The widened revenue_recovery_events CHECKs are supersets and safe to leave.
*/

-- =============================================================
-- 1. LINKS: invoices / quotes / jobs -> work_orders
-- =============================================================
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL;
ALTER TABLE public.quotes   ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL;
ALTER TABLE public.jobs     ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_work_order ON public.invoices(work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_work_order   ON public.quotes(work_order_id)   WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_work_order     ON public.jobs(work_order_id)     WHERE work_order_id IS NOT NULL;

-- Link integrity. Trigger names sort alphabetically and BEFORE triggers fire in that order:
-- trigger_a2c_a_link_guard (fills/validates the link) must run before trigger_a2c_b_send_guard (the gate).
CREATE OR REPLACE FUNCTION public.a2c_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inherit uuid;
  v_wo_user uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' AND TG_OP = 'INSERT' AND NEW.work_order_id IS NULL THEN
    IF NEW.quote_id IS NOT NULL THEN
      SELECT q.work_order_id INTO v_inherit FROM public.quotes q WHERE q.id = NEW.quote_id AND q.user_id = NEW.user_id;
    END IF;
    IF v_inherit IS NULL AND NEW.job_id IS NOT NULL THEN
      SELECT j.work_order_id INTO v_inherit FROM public.jobs j WHERE j.id = NEW.job_id AND j.user_id = NEW.user_id;
    END IF;
    NEW.work_order_id := v_inherit;
  END IF;

  IF NEW.work_order_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id) THEN
    SELECT w.user_id INTO v_wo_user FROM public.work_orders w WHERE w.id = NEW.work_order_id;
    IF v_wo_user IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'Work order does not belong to this account' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'invoices' AND TG_OP = 'UPDATE' AND NEW.work_order_id IS DISTINCT FROM OLD.work_order_id THEN
    -- After an invoice has left draft the link may be ADDED (more evidence) but never swapped or removed
    -- (that would let a sent invoice dodge the approved-amount check). Void and re-issue instead.
    IF OLD.status <> 'draft' AND OLD.work_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'The work order link of a sent invoice cannot be changed. Void and re-issue the invoice.' USING ERRCODE = '23514';
    END IF;
    PERFORM public._invoice_audit(NEW.user_id, 'invoice_work_order_linked', NEW.id,
      jsonb_build_object('from', OLD.work_order_id, 'to', NEW.work_order_id));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_a2c_a_link_guard ON public.invoices;
CREATE TRIGGER trigger_a2c_a_link_guard
  BEFORE INSERT OR UPDATE OF work_order_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.a2c_link_guard();

DROP TRIGGER IF EXISTS trigger_a2c_link_guard ON public.quotes;
CREATE TRIGGER trigger_a2c_link_guard
  BEFORE INSERT OR UPDATE OF work_order_id ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.a2c_link_guard();

DROP TRIGGER IF EXISTS trigger_a2c_link_guard ON public.jobs;
CREATE TRIGGER trigger_a2c_link_guard
  BEFORE INSERT OR UPDATE OF work_order_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.a2c_link_guard();

-- =============================================================
-- 2. ACCOUNT POLICY (business_profile)
-- =============================================================
CREATE OR REPLACE FUNCTION public.a2c_valid_ladder(p integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p IS NOT NULL
    AND cardinality(p) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1 FROM generate_subscripts(p, 1) AS i
      WHERE p[i] IS NULL OR p[i] < 1 OR p[i] > 365 OR (i > 1 AND p[i] <= p[i - 1])
    );
$$;

ALTER TABLE public.business_profile
  ADD COLUMN IF NOT EXISTS a2c_require_po boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS a2c_require_completion_proof boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS a2c_followup_days integer[] NOT NULL DEFAULT '{3,7,14,30}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_profile_a2c_ladder_chk') THEN
    ALTER TABLE public.business_profile
      ADD CONSTRAINT business_profile_a2c_ladder_chk CHECK (public.a2c_valid_ladder(a2c_followup_days));
  END IF;
END $$;

-- =============================================================
-- 3. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.invoice_ar_tracking (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ap_state text NOT NULL DEFAULT 'sent'
    CHECK (ap_state IN ('sent', 'received', 'approved', 'rejected', 'paid')),
  prev_ap_state text CHECK (prev_ap_state IS NULL OR prev_ap_state IN ('sent', 'received', 'approved', 'rejected')),
  rejection_reason text CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 1000),
  state_note text CHECK (state_note IS NULL OR char_length(state_note) <= 1000),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  state_changed_by uuid,
  followups_approved_at timestamptz,
  followups_approved_by uuid,
  followups_paused boolean NOT NULL DEFAULT false,
  last_ladder_step integer NOT NULL DEFAULT 0 CHECK (last_ladder_step BETWEEN 0 AND 8),
  last_followup_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_ar_rejected_needs_reason
    CHECK (ap_state <> 'rejected' OR char_length(btrim(COALESCE(rejection_reason, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS idx_invoice_ar_user_state ON public.invoice_ar_tracking(user_id, ap_state);
CREATE INDEX IF NOT EXISTS idx_invoice_ar_followups ON public.invoice_ar_tracking(followups_approved_at)
  WHERE followups_approved_at IS NOT NULL AND NOT followups_paused;

CREATE TABLE IF NOT EXISTS public.invoice_gate_overrides (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  blocked_codes text[] NOT NULL DEFAULT '{}',
  overridden_by uuid NOT NULL,
  overridden_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_demand_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  -- No 'sent' state on purpose: this text is never transmitted by Vireek.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'discarded')),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 8000),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_demand_reviewed_pair CHECK ((status = 'reviewed') = (reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_demand_one_open_draft
  ON public.invoice_demand_drafts(invoice_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_invoice_demand_invoice ON public.invoice_demand_drafts(invoice_id, created_at DESC);

-- Follow-up ladder step recorded on the existing reminder log (kind stays 'reminder').
ALTER TABLE public.invoice_reminders ADD COLUMN IF NOT EXISTS ladder_step integer CHECK (ladder_step IS NULL OR ladder_step BETWEEN 1 AND 8);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_reminders_ladder_step
  ON public.invoice_reminders(invoice_id, ladder_step) WHERE ladder_step IS NOT NULL AND status = 'sent';

-- touch triggers
CREATE OR REPLACE FUNCTION public.a2c_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trigger_a2c_touch_tracking ON public.invoice_ar_tracking;
CREATE TRIGGER trigger_a2c_touch_tracking BEFORE UPDATE ON public.invoice_ar_tracking
  FOR EACH ROW EXECUTE FUNCTION public.a2c_touch_updated_at();
DROP TRIGGER IF EXISTS trigger_a2c_touch_drafts ON public.invoice_demand_drafts;
CREATE TRIGGER trigger_a2c_touch_drafts BEFORE UPDATE ON public.invoice_demand_drafts
  FOR EACH ROW EXECUTE FUNCTION public.a2c_touch_updated_at();

-- =============================================================
-- 4. RLS — read-only for clients; all writes via RPC/trigger
-- =============================================================
ALTER TABLE public.invoice_ar_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_gate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_demand_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_invoice_ar_tracking" ON public.invoice_ar_tracking;
CREATE POLICY "select_invoice_ar_tracking" ON public.invoice_ar_tracking FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "select_invoice_gate_overrides" ON public.invoice_gate_overrides;
CREATE POLICY "select_invoice_gate_overrides" ON public.invoice_gate_overrides FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "select_invoice_demand_drafts" ON public.invoice_demand_drafts;
CREATE POLICY "select_invoice_demand_drafts" ON public.invoice_demand_drafts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_ar_tracking FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_gate_overrides FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_demand_drafts FROM anon, authenticated;

-- =============================================================
-- 5. HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public._a2c_money(p_cents bigint)
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT '$' || to_char(COALESCE(p_cents, 0) / 100.0, 'FM999,999,999,999,990.00'); $$;

CREATE OR REPLACE FUNCTION public._a2c_net_paid(p_invoice_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT SUM(amount_cents) FROM public.invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - COALESCE((SELECT SUM(amount_cents) FROM public.invoice_refunds WHERE invoice_id = p_invoice_id), 0);
$$;

-- Account-owner-only (override authority).
CREATE OR REPLACE FUNCTION public._a2c_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'owner'); $$;

-- =============================================================
-- 6. THE GATE  (mirrors evaluateInvoiceGate in functions/_shared/approvalToCash/logic.ts)
-- =============================================================
CREATE OR REPLACE FUNCTION public._a2c_gate(p_inv public.invoices)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint := public.invoice_total_cents(p_inv.line_items, p_inv.tax_percent);
  v_req_po boolean;
  v_req_proof boolean;
  v_wo public.work_orders%ROWTYPE;
  v_has_wo boolean := false;
  v_other bigint := 0;
  v_committed bigint := NULL;
  v_approved bigint := NULL;
  v_proof boolean := false;
  v_find jsonb := '[]'::jsonb;
  v_blocks integer := 0;
  v_ovr_total bigint;
  v_ovr_reason text;
  v_overridden boolean := false;
  v_sev text;
BEGIN
  SELECT bp.a2c_require_po, bp.a2c_require_completion_proof
    INTO v_req_po, v_req_proof
    FROM public.business_profile bp WHERE bp.user_id = p_inv.user_id;
  v_req_po := COALESCE(v_req_po, false);
  v_req_proof := COALESCE(v_req_proof, false);

  IF p_inv.work_order_id IS NOT NULL THEN
    SELECT * INTO v_wo FROM public.work_orders w WHERE w.id = p_inv.work_order_id AND w.user_id = p_inv.user_id;
    v_has_wo := FOUND;
  END IF;

  v_proof :=
    (v_has_wo AND EXISTS (SELECT 1 FROM public.work_order_visits v WHERE v.work_order_id = v_wo.id AND v.status = 'completed'))
    OR (
      p_inv.job_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_inv.job_id AND j.user_id = p_inv.user_id AND j.job_status = 'completed')
      AND EXISTS (SELECT 1 FROM public.job_evidence_chain_entries e
                  WHERE e.job_id = p_inv.job_id AND e.user_id = p_inv.user_id
                    AND (e.stage IN ('work', 'test', 'result') OR e.kind = 'media'))
    );

  IF NOT v_has_wo THEN
    IF v_req_po THEN
      v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'MISSING_PO', 'severity', 'block',
        'message', 'No customer PO / work order is linked to this invoice.'));
    END IF;
    IF v_req_proof AND NOT v_proof THEN
      v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'MISSING_COMPLETION_PROOF', 'severity', 'block',
        'message', 'No completion proof is on file for this invoice.'));
    END IF;
  ELSE
    IF v_wo.approval_status IN ('pending', 'rejected') THEN
      v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'WO_NOT_APPROVED', 'severity', 'block',
        'message', CASE WHEN v_wo.approval_status = 'rejected'
                        THEN 'The linked work order was rejected by the customer.'
                        ELSE 'The linked work order has not been approved yet.' END));
    END IF;

    IF v_wo.po_number IS NULL OR btrim(v_wo.po_number) = '' THEN
      v_sev := CASE WHEN v_req_po THEN 'block' ELSE 'warn' END;
      v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'MISSING_PO', 'severity', v_sev,
        'message', 'The linked work order has no customer PO number.'));
    END IF;

    v_approved := v_wo.not_to_exceed_cents;
    IF v_approved IS NOT NULL THEN
      SELECT COALESCE(SUM(public.invoice_total_cents(i.line_items, i.tax_percent)), 0) INTO v_other
        FROM public.invoices i
       WHERE i.work_order_id = v_wo.id AND i.id <> p_inv.id AND i.status IN ('sent', 'viewed', 'paid');
      v_committed := v_other + v_total;
      IF v_committed > v_approved THEN
        v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'OVER_APPROVED_AMOUNT', 'severity', 'block',
          'message', 'Billed total ' || public._a2c_money(v_committed) || ' would exceed the approved not-to-exceed ' || public._a2c_money(v_approved) || '.'));
      END IF;
    END IF;

    IF NOT v_proof THEN
      v_sev := CASE WHEN v_req_proof THEN 'block' ELSE 'warn' END;
      v_find := v_find || jsonb_build_array(jsonb_build_object('code', 'MISSING_COMPLETION_PROOF', 'severity', v_sev,
        'message', 'No completion proof (completed visit or job evidence) is on file.'));
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_blocks FROM jsonb_array_elements(v_find) f WHERE f->>'severity' = 'block';

  IF v_blocks > 0 THEN
    SELECT o.total_cents, o.reason INTO v_ovr_total, v_ovr_reason
      FROM public.invoice_gate_overrides o WHERE o.invoice_id = p_inv.id;
    v_overridden := v_ovr_total IS NOT NULL AND v_ovr_total = v_total AND char_length(btrim(COALESCE(v_ovr_reason, ''))) > 0;
  END IF;

  RETURN jsonb_build_object(
    'ok', (v_blocks = 0 OR v_overridden),
    'overridden', v_overridden,
    'findings', v_find,
    'total_cents', v_total,
    'approved_cents', v_approved,
    'committed_cents', v_committed,
    'has_work_order', v_has_wo
  );
END;
$$;

REVOKE ALL ON FUNCTION public._a2c_gate(public.invoices) FROM PUBLIC, anon, authenticated;

-- Client RPC: evaluate the gate for an invoice of the caller's account.
CREATE OR REPLACE FUNCTION public.invoice_send_gate(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  RETURN public._a2c_gate(v_inv);
END;
$$;

-- Service RPC for edge functions (the caller's JWT was already verified and the owner resolved server-side).
CREATE OR REPLACE FUNCTION public.a2c_gate_for_service(p_owner uuid, p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  RETURN public._a2c_gate(v_inv);
END;
$$;

-- DB backstop: the first send (draft -> sent/viewed, or inserted already sent) must pass the gate.
CREATE OR REPLACE FUNCTION public.a2c_invoice_send_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate jsonb;
  v_msgs text;
BEGIN
  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status = 'sent')
    OR (TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status IN ('sent', 'viewed'))
  ) THEN
    RETURN NEW;
  END IF;

  -- Serialise concurrent first-sends against the same work order so the NTE check cannot be raced.
  IF NEW.work_order_id IS NOT NULL THEN
    PERFORM 1 FROM public.work_orders w WHERE w.id = NEW.work_order_id FOR UPDATE;
  END IF;

  v_gate := public._a2c_gate(NEW);
  IF NOT (v_gate->>'ok')::boolean THEN
    SELECT string_agg(f->>'message', ' ') INTO v_msgs
      FROM jsonb_array_elements(v_gate->'findings') f WHERE f->>'severity' = 'block';
    RAISE EXCEPTION 'Approval-to-cash check failed: %', v_msgs USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_a2c_b_send_guard ON public.invoices;
CREATE TRIGGER trigger_a2c_b_send_guard
  BEFORE INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.a2c_invoice_send_guard();

-- Owner-only, reasoned, audited override. Void if the total changes afterwards.
CREATE OR REPLACE FUNCTION public.a2c_override_gate(p_invoice_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv public.invoices%ROWTYPE;
  v_gate jsonb;
  v_codes text[];
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public._a2c_is_owner() THEN
    RAISE EXCEPTION 'Only the account owner can override an approval check';
  END IF;
  IF char_length(v_reason) < 10 THEN RAISE EXCEPTION 'Enter a reason of at least 10 characters'; END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft invoice needs an override'; END IF;

  -- Evaluate WITHOUT any existing override, so we record exactly what is being overridden.
  DELETE FROM public.invoice_gate_overrides WHERE invoice_id = p_invoice_id;
  v_gate := public._a2c_gate(v_inv);
  SELECT COALESCE(array_agg(f->>'code'), '{}') INTO v_codes
    FROM jsonb_array_elements(v_gate->'findings') f WHERE f->>'severity' = 'block';
  IF cardinality(v_codes) = 0 THEN RAISE EXCEPTION 'Nothing to override: this invoice has no blocking issues'; END IF;

  INSERT INTO public.invoice_gate_overrides (invoice_id, user_id, reason, total_cents, blocked_codes, overridden_by)
  VALUES (p_invoice_id, v_owner, v_reason, (v_gate->>'total_cents')::bigint, v_codes, auth.uid());

  PERFORM public._invoice_audit(v_owner, 'invoice_gate_overridden', p_invoice_id,
    jsonb_build_object('reason', v_reason, 'blocked_codes', v_codes, 'total_cents', (v_gate->>'total_cents')::bigint));
  RETURN public._a2c_gate(v_inv);
END;
$$;

-- =============================================================
-- 7. TRACKING SYNC (invoice status -> customer-side state) and recovery ledger
-- =============================================================
-- Widen the ledger CHECKs (supersets of 20261126000000 / 20261105000000; additive).
ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;
ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    'quote_financing_stalled', 'quote_accepted_unbooked',
    'job_completed_unbilled', 'invoice_overdue',
    'membership_cancelled', 'membership_churned',
    'job_parts_unbilled', 'payment_failed',
    -- new: approval-to-cash
    'invoice_rejected'
  ));
ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;
ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls', 'quotes', 'jobs', 'payment_requests', 'memberships', 'invoices'));

-- One code path decides what the ledger should say about one invoice (mirrors recoveryKindFor in logic.ts).
CREATE OR REPLACE FUNCTION public._a2c_refresh_recovery(p_invoice_id uuid, p_today date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_t public.invoice_ar_tracking%ROWTYPE;
  v_total bigint;
  v_net bigint;
  v_balance bigint;
  v_kind text;
  v_occurred timestamptz;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    DELETE FROM public.revenue_recovery_events WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status = 'open';
    RETURN;
  END IF;
  SELECT * INTO v_t FROM public.invoice_ar_tracking WHERE invoice_id = p_invoice_id;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  v_net := public._a2c_net_paid(p_invoice_id);
  v_balance := GREATEST(v_total - v_net, 0);

  v_kind := CASE
    WHEN v_inv.status NOT IN ('sent', 'viewed') THEN NULL
    WHEN v_t.invoice_id IS NULL THEN NULL
    WHEN v_balance <= 0 OR v_t.ap_state = 'paid' THEN NULL
    WHEN v_t.ap_state = 'rejected' THEN 'invoice_rejected'
    WHEN v_inv.due_date IS NOT NULL AND v_inv.due_date < p_today THEN 'invoice_overdue'
    ELSE NULL
  END;

  IF v_kind IS NULL THEN
    -- Someone actually worked it (status 'contacted') and the invoice is now paid: that IS a recovery.
    IF v_inv.status = 'paid' THEN
      UPDATE public.revenue_recovery_events
         SET status = 'recovered', recovery_method = COALESCE(recovery_method, 'other'),
             recovered_amount_cents = LEAST(GREATEST(v_net, 0), 2147483647)::integer, resolved_at = now()
       WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status = 'contacted';
    END IF;
    -- Never worked (still 'open') and no longer a problem (paid on their own / voided / resolved): remove it
    -- rather than claim a recovery Vireek did not make. 'written_off' / 'recovered' rows are never touched.
    DELETE FROM public.revenue_recovery_events
     WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status = 'open';
    RETURN;
  END IF;

  v_occurred := CASE WHEN v_kind = 'invoice_rejected' THEN v_t.state_changed_at
                     ELSE (v_inv.due_date + 1)::timestamptz END;

  INSERT INTO public.revenue_recovery_events (
    user_id, source_type, source_table, source_id, customer_name, customer_phone,
    occurred_at, estimated_value_cents, estimated_value_basis, status
  ) VALUES (
    v_inv.user_id, v_kind, 'invoices', v_inv.id, COALESCE(NULLIF(btrim(v_inv.customer_name), ''), 'Unknown customer'), v_inv.customer_phone,
    v_occurred, LEAST(v_balance, 2147483647)::integer, 'job_invoice', 'open'
  )
  ON CONFLICT (source_table, source_id) DO UPDATE
    SET source_type = EXCLUDED.source_type,
        estimated_value_cents = EXCLUDED.estimated_value_cents,
        -- a 'recovered' row that becomes unpaid again (refund) re-opens; 'contacted' / 'written_off' are human decisions
        status = CASE WHEN public.revenue_recovery_events.status = 'recovered' THEN 'open' ELSE public.revenue_recovery_events.status END,
        resolved_at = CASE WHEN public.revenue_recovery_events.status = 'recovered' THEN NULL ELSE public.revenue_recovery_events.resolved_at END;
END;
$$;

REVOKE ALL ON FUNCTION public._a2c_refresh_recovery(uuid, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.a2c_sync_tracking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.invoice_ar_tracking%ROWTYPE;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.status = 'void' THEN
    PERFORM public._a2c_refresh_recovery(NEW.id, current_date);
    RETURN NEW;
  END IF;

  INSERT INTO public.invoice_ar_tracking (invoice_id, user_id, ap_state, prev_ap_state)
  VALUES (NEW.id, NEW.user_id,
          CASE NEW.status WHEN 'paid' THEN 'paid' WHEN 'viewed' THEN 'received' ELSE 'sent' END,
          CASE WHEN NEW.status = 'paid' THEN 'sent' END)
  ON CONFLICT (invoice_id) DO NOTHING;

  SELECT * INTO v_t FROM public.invoice_ar_tracking WHERE invoice_id = NEW.id FOR UPDATE;

  IF NEW.status = 'paid' AND v_t.ap_state <> 'paid' THEN
    UPDATE public.invoice_ar_tracking
       SET prev_ap_state = v_t.ap_state, ap_state = 'paid', rejection_reason = NULL,
           state_note = 'Paid in full', state_changed_at = now(), state_changed_by = NULL
     WHERE invoice_id = NEW.id;
    PERFORM public._invoice_audit(NEW.user_id, 'invoice_ap_state_changed', NEW.id,
      jsonb_build_object('from', v_t.ap_state, 'to', 'paid', 'auto', true));
  ELSIF NEW.status IN ('sent', 'viewed') THEN
    IF v_t.ap_state = 'paid' THEN
      -- A refund un-paid the invoice: restore the state it had before it was paid.
      UPDATE public.invoice_ar_tracking
         SET ap_state = COALESCE(prev_ap_state, 'sent'), prev_ap_state = NULL,
             state_note = 'Payment reversed', state_changed_at = now(), state_changed_by = NULL
       WHERE invoice_id = NEW.id;
      PERFORM public._invoice_audit(NEW.user_id, 'invoice_ap_state_changed', NEW.id,
        jsonb_build_object('from', 'paid', 'to', COALESCE(v_t.prev_ap_state, 'sent'), 'auto', true));
    ELSIF NEW.status = 'viewed' AND v_t.ap_state = 'sent' THEN
      UPDATE public.invoice_ar_tracking
         SET ap_state = 'received', state_note = 'Customer opened the invoice link',
             state_changed_at = now(), state_changed_by = NULL
       WHERE invoice_id = NEW.id;
      PERFORM public._invoice_audit(NEW.user_id, 'invoice_ap_state_changed', NEW.id,
        jsonb_build_object('from', 'sent', 'to', 'received', 'auto', true));
    END IF;
  END IF;

  PERFORM public._a2c_refresh_recovery(NEW.id, current_date);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_a2c_sync_tracking ON public.invoices;
CREATE TRIGGER trigger_a2c_sync_tracking
  AFTER INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.a2c_sync_tracking();

-- Backfill: tracking rows for invoices that already left draft. No emails; follow-ups are NOT approved.
INSERT INTO public.invoice_ar_tracking (invoice_id, user_id, ap_state, prev_ap_state)
SELECT i.id, i.user_id,
       CASE i.status WHEN 'paid' THEN 'paid' WHEN 'viewed' THEN 'received' ELSE 'sent' END,
       CASE WHEN i.status = 'paid' THEN CASE WHEN i.viewed_at IS NOT NULL THEN 'received' ELSE 'sent' END END
  FROM public.invoices i
 WHERE i.status IN ('sent', 'viewed', 'paid')
ON CONFLICT (invoice_id) DO NOTHING;

-- =============================================================
-- 8. HUMAN ACTIONS (RPCs)
-- =============================================================
-- Customer-side state change (mirrors AP_TRANSITIONS / validateApTransition).
CREATE OR REPLACE FUNCTION public.set_invoice_ap_state(
  p_invoice_id uuid, p_state text, p_reason text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv public.invoices%ROWTYPE;
  v_t public.invoice_ar_tracking%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_state NOT IN ('received', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid state. Paid is set automatically when payments cover the balance.';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN RAISE EXCEPTION 'Reason is too long'; END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN RAISE EXCEPTION 'Note is too long'; END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is void'; END IF;
  IF v_inv.status = 'draft' THEN RAISE EXCEPTION 'Send the invoice first'; END IF;

  SELECT * INTO v_t FROM public.invoice_ar_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice tracking not found'; END IF;

  IF v_t.ap_state = 'paid' THEN RAISE EXCEPTION 'This invoice is already paid'; END IF;
  IF v_t.ap_state = p_state THEN RAISE EXCEPTION 'The invoice is already in that state'; END IF;
  IF NOT (
       (v_t.ap_state = 'sent'     AND p_state IN ('received', 'approved', 'rejected'))
    OR (v_t.ap_state = 'received' AND p_state IN ('approved', 'rejected'))
    OR (v_t.ap_state = 'approved' AND p_state = 'rejected')
    OR (v_t.ap_state = 'rejected' AND p_state IN ('received', 'approved'))
  ) THEN
    RAISE EXCEPTION 'Cannot move from % to %', v_t.ap_state, p_state;
  END IF;
  IF p_state = 'rejected' AND v_reason IS NULL THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;

  UPDATE public.invoice_ar_tracking
     SET ap_state = p_state,
         rejection_reason = CASE WHEN p_state = 'rejected' THEN v_reason ELSE NULL END,
         state_note = v_note, state_changed_at = now(), state_changed_by = auth.uid()
   WHERE invoice_id = p_invoice_id;

  PERFORM public._invoice_audit(v_owner, 'invoice_ap_state_changed', p_invoice_id,
    jsonb_build_object('from', v_t.ap_state, 'to', p_state, 'reason', v_reason, 'note', v_note));
  PERFORM public._a2c_refresh_recovery(p_invoice_id, current_date);
  RETURN p_state;
END;
$$;

-- Explicit human approval before ANY follow-up email can be sent for this invoice.
CREATE OR REPLACE FUNCTION public.a2c_approve_followups(p_invoice_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv public.invoices%ROWTYPE;
  v_t public.invoice_ar_tracking%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status NOT IN ('sent', 'viewed') THEN RAISE EXCEPTION 'Only a sent, unpaid invoice can have follow-ups'; END IF;
  IF v_inv.due_date IS NULL THEN RAISE EXCEPTION 'Set a due date before enabling follow-ups'; END IF;
  SELECT * INTO v_t FROM public.invoice_ar_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice tracking not found'; END IF;
  IF v_t.followups_approved_at IS NOT NULL THEN RETURN v_t.followups_approved_at; END IF; -- idempotent

  UPDATE public.invoice_ar_tracking
     SET followups_approved_at = now(), followups_approved_by = auth.uid(), followups_paused = false
   WHERE invoice_id = p_invoice_id
  RETURNING followups_approved_at INTO v_t.followups_approved_at;

  PERFORM public._invoice_audit(v_owner, 'invoice_followups_approved', p_invoice_id, '{}'::jsonb);
  RETURN v_t.followups_approved_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.a2c_set_followups_paused(p_invoice_id uuid, p_paused boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.invoice_ar_tracking SET followups_paused = COALESCE(p_paused, false)
   WHERE invoice_id = p_invoice_id AND user_id = v_owner AND followups_paused IS DISTINCT FROM COALESCE(p_paused, false);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public._invoice_audit(v_owner, CASE WHEN p_paused THEN 'invoice_followups_paused' ELSE 'invoice_followups_resumed' END, p_invoice_id, '{}'::jsonb);
  END IF;
  RETURN COALESCE(p_paused, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.a2c_save_settings(p_require_po boolean, p_require_proof boolean, p_days integer[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT public.a2c_valid_ladder(p_days) THEN
    RAISE EXCEPTION 'Follow-up days must be 1-8 strictly increasing whole numbers between 1 and 365';
  END IF;
  INSERT INTO public.business_profile (user_id, a2c_require_po, a2c_require_completion_proof, a2c_followup_days)
  VALUES (v_owner, COALESCE(p_require_po, false), COALESCE(p_require_proof, false), p_days)
  ON CONFLICT (user_id) DO UPDATE
    SET a2c_require_po = EXCLUDED.a2c_require_po,
        a2c_require_completion_proof = EXCLUDED.a2c_require_completion_proof,
        a2c_followup_days = EXCLUDED.a2c_followup_days;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, details)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          'a2c_settings_changed', 'business_profile', v_owner::text,
          jsonb_build_object('require_po', COALESCE(p_require_po, false), 'require_completion_proof', COALESCE(p_require_proof, false), 'followup_days', p_days));
END;
$$;

-- Demand-letter DRAFT: stores human-editable text + a server-computed facts snapshot. Never sent by Vireek.
CREATE OR REPLACE FUNCTION public.a2c_save_demand_draft(p_invoice_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv public.invoices%ROWTYPE;
  v_total bigint;
  v_net bigint;
  v_balance bigint;
  v_overdue integer;
  v_facts jsonb;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) = 0 THEN RAISE EXCEPTION 'The draft is empty'; END IF;
  IF char_length(p_body) > 8000 THEN RAISE EXCEPTION 'The draft is too long (8000 characters max)'; END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status NOT IN ('sent', 'viewed') THEN RAISE EXCEPTION 'Only a sent, unpaid invoice can have a payment-request draft'; END IF;
  IF v_inv.due_date IS NULL THEN RAISE EXCEPTION 'The invoice has no due date'; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  v_net := public._a2c_net_paid(p_invoice_id);
  v_balance := GREATEST(v_total - v_net, 0);
  IF v_balance <= 0 THEN RAISE EXCEPTION 'This invoice has no balance due'; END IF;
  v_overdue := current_date - v_inv.due_date;
  IF v_overdue < 1 THEN RAISE EXCEPTION 'The invoice is not past due yet'; END IF;

  v_facts := jsonb_build_object('invoice_number', v_inv.invoice_number, 'total_cents', v_total, 'paid_cents', v_net,
                                'balance_cents', v_balance, 'due_date', v_inv.due_date, 'days_overdue', v_overdue,
                                'snapshot_at', now());

  INSERT INTO public.invoice_demand_drafts (user_id, invoice_id, body, facts, created_by)
  VALUES (v_owner, p_invoice_id, p_body, v_facts, auth.uid())
  ON CONFLICT (invoice_id) WHERE status = 'draft' DO UPDATE
    SET body = EXCLUDED.body, facts = EXCLUDED.facts
  RETURNING id INTO v_id;

  PERFORM public._invoice_audit(v_owner, 'invoice_demand_draft_saved', p_invoice_id,
    jsonb_build_object('draft_id', v_id, 'balance_cents', v_balance, 'days_overdue', v_overdue));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.a2c_review_demand_draft(p_draft_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_d public.invoice_demand_drafts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_d FROM public.invoice_demand_drafts WHERE id = p_draft_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft not found'; END IF;
  IF v_d.status = 'reviewed' THEN RETURN 'reviewed'; END IF; -- idempotent
  IF v_d.status <> 'draft' THEN RAISE EXCEPTION 'This draft was discarded'; END IF;
  UPDATE public.invoice_demand_drafts SET status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now() WHERE id = p_draft_id;
  PERFORM public._invoice_audit(v_owner, 'invoice_demand_draft_reviewed', v_d.invoice_id, jsonb_build_object('draft_id', p_draft_id));
  RETURN 'reviewed';
END;
$$;

CREATE OR REPLACE FUNCTION public.a2c_discard_demand_draft(p_draft_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_d public.invoice_demand_drafts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_d FROM public.invoice_demand_drafts WHERE id = p_draft_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft not found'; END IF;
  IF v_d.status = 'discarded' THEN RETURN 'discarded'; END IF;
  UPDATE public.invoice_demand_drafts SET status = 'discarded', reviewed_at = NULL, reviewed_by = NULL WHERE id = p_draft_id;
  PERFORM public._invoice_audit(v_owner, 'invoice_demand_draft_discarded', v_d.invoice_id, jsonb_build_object('draft_id', p_draft_id));
  RETURN 'discarded';
END;
$$;

-- =============================================================
-- 9. INVOICE PACKET DATA  (facts only; the PDF is rendered client-side from this)
-- =============================================================
CREATE OR REPLACE FUNCTION public.invoice_packet_data(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inv public.invoices%ROWTYPE;
  v_wo public.work_orders%ROWTYPE;
  v_has_wo boolean := false;
  v_total bigint;
  v_net bigint;
  v_t public.invoice_ar_tracking%ROWTYPE;
  v_visits jsonb := '[]'::jsonb;
  v_evidence jsonb := '[]'::jsonb;
  v_company text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.invoice_permission('can_view_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  v_net := public._a2c_net_paid(p_invoice_id);
  SELECT company_name INTO v_company FROM public.profiles WHERE id = v_owner;
  SELECT * INTO v_t FROM public.invoice_ar_tracking WHERE invoice_id = p_invoice_id;

  IF v_inv.work_order_id IS NOT NULL THEN
    SELECT * INTO v_wo FROM public.work_orders WHERE id = v_inv.work_order_id AND user_id = v_owner;
    v_has_wo := FOUND;
  END IF;

  IF v_has_wo THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'visit_number', v.visit_number, 'completed_at', v.completed_at, 'notes', v.notes) ORDER BY v.visit_number), '[]'::jsonb)
      INTO v_visits
      FROM public.work_order_visits v WHERE v.work_order_id = v_wo.id AND v.status = 'completed';
  END IF;

  IF v_inv.job_id IS NOT NULL THEN
    -- Titles and metadata only (no free-text detail, no media URLs): the packet goes to the customer.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'seq', x.seq, 'stage', x.stage, 'kind', x.kind, 'title', x.title, 'recorded_at', x.recorded_at,
             'actor_name', x.actor_name, 'media_count', jsonb_array_length(x.media)) ORDER BY x.seq), '[]'::jsonb)
      INTO v_evidence
      FROM (
        SELECT e.* FROM public.job_evidence_chain_entries e
         WHERE e.job_id = v_inv.job_id AND e.user_id = v_owner
           AND e.stage IN ('work', 'test', 'result', 'customer_approval')
         ORDER BY e.seq LIMIT 25
      ) x;
  END IF;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'business_name', v_company,
    'invoice', jsonb_build_object(
      'id', v_inv.id, 'number', v_inv.invoice_number, 'status', v_inv.status, 'sent_at', v_inv.sent_at,
      'due_date', v_inv.due_date, 'customer_name', v_inv.customer_name, 'line_items', v_inv.line_items,
      'tax_percent', v_inv.tax_percent, 'notes', v_inv.notes,
      'total_cents', v_total, 'paid_cents', v_net, 'balance_cents', GREATEST(v_total - v_net, 0)),
    'work_order', CASE WHEN v_has_wo THEN jsonb_build_object(
      'number', v_wo.work_order_number, 'po_number', v_wo.po_number, 'title', v_wo.title,
      'approval_status', v_wo.approval_status, 'approver_name', v_wo.approver_name, 'approved_at', v_wo.approved_at,
      'approval_notes', v_wo.approval_notes, 'not_to_exceed_cents', v_wo.not_to_exceed_cents,
      'site_name', v_wo.site_name, 'site_address', v_wo.site_address) END,
    'completed_visits', v_visits,
    'evidence', v_evidence,
    'ap', CASE WHEN v_t.invoice_id IS NOT NULL THEN jsonb_build_object(
      'state', v_t.ap_state, 'rejection_reason', v_t.rejection_reason, 'changed_at', v_t.state_changed_at) END,
    'gate', public._a2c_gate(v_inv)
  );
END;
$$;

-- =============================================================
-- 10. CRON SURFACE (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.a2c_followup_candidates(p_today date, p_limit integer DEFAULT 200)
RETURNS TABLE (
  invoice_id uuid, owner_id uuid, customer_id uuid, customer_name text, customer_email text, customer_phone text,
  invoice_number text, invoice_token uuid, due_date date, invoice_status text, balance_cents bigint,
  ap_state text, followups_paused boolean, last_ladder_step integer, ladder integer[], business_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.user_id, i.customer_id, i.customer_name, i.customer_email, i.customer_phone,
         i.invoice_number, i.invoice_token, i.due_date, i.status,
         GREATEST(public.invoice_total_cents(i.line_items, i.tax_percent) - public._a2c_net_paid(i.id), 0),
         t.ap_state, t.followups_paused, t.last_ladder_step,
         COALESCE(bp.a2c_followup_days, '{3,7,14,30}'::integer[]), p.company_name
    FROM public.invoice_ar_tracking t
    JOIN public.invoices i ON i.id = t.invoice_id
    LEFT JOIN public.business_profile bp ON bp.user_id = i.user_id
    LEFT JOIN public.profiles p ON p.id = i.user_id
   WHERE t.followups_approved_at IS NOT NULL
     AND NOT t.followups_paused
     AND t.ap_state NOT IN ('rejected', 'paid')
     AND i.status IN ('sent', 'viewed')
     AND i.due_date IS NOT NULL
     AND i.due_date < p_today
   ORDER BY i.due_date, i.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
$$;

-- Atomic compare-and-set claim: exactly one concurrent runner wins a given step.
CREATE OR REPLACE FUNCTION public.a2c_claim_followup_step(p_invoice_id uuid, p_from_step integer, p_to_step integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_to_step <= p_from_step OR p_to_step > 8 OR p_from_step < 0 THEN RETURN false; END IF;
  UPDATE public.invoice_ar_tracking
     SET last_ladder_step = p_to_step, last_followup_at = now()
   WHERE invoice_id = p_invoice_id
     AND last_ladder_step = p_from_step
     AND followups_approved_at IS NOT NULL
     AND NOT followups_paused
     AND ap_state NOT IN ('rejected', 'paid');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- Undo a claim after a failed send so the next run retries (only if nobody advanced it meanwhile).
CREATE OR REPLACE FUNCTION public.a2c_release_followup_step(p_invoice_id uuid, p_from_step integer, p_to_step integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.invoice_ar_tracking SET last_ladder_step = p_from_step
   WHERE invoice_id = p_invoice_id AND last_ladder_step = p_to_step;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.a2c_sync_recovery_events(p_today date, p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_n integer := 0;
BEGIN
  FOR v_id IN
    SELECT x.id FROM (
      SELECT i.id FROM public.invoices i
        JOIN public.invoice_ar_tracking t ON t.invoice_id = i.id
       WHERE i.status IN ('sent', 'viewed')
         AND (t.ap_state = 'rejected' OR (i.due_date IS NOT NULL AND i.due_date < p_today))
      UNION
      SELECT e.source_id FROM public.revenue_recovery_events e
       WHERE e.source_table = 'invoices' AND e.status IN ('open', 'contacted')
    ) x
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5000), 20000))
  LOOP
    PERFORM public._a2c_refresh_recovery(v_id, p_today);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- =============================================================
-- 11. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.a2c_followup_candidates(date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_claim_followup_step(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_release_followup_step(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_sync_recovery_events(date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_gate_for_service(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_followup_candidates(date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.a2c_claim_followup_step(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.a2c_release_followup_step(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.a2c_sync_recovery_events(date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.a2c_gate_for_service(uuid, uuid) TO service_role;

-- Internal helpers / trigger functions: not callable by clients.
REVOKE ALL ON FUNCTION public.a2c_link_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_invoice_send_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2c_sync_tracking() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._a2c_net_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._a2c_is_owner() FROM PUBLIC, anon, authenticated;

-- Client RPCs: authenticated only (each re-checks owner + can_view_billing inside).
REVOKE ALL ON FUNCTION public.invoice_send_gate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_override_gate(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_invoice_ap_state(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_approve_followups(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_set_followups_paused(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_save_settings(boolean, boolean, integer[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_save_demand_draft(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_review_demand_draft(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.a2c_discard_demand_draft(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invoice_packet_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_send_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_override_gate(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_invoice_ap_state(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_approve_followups(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_set_followups_paused(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_save_settings(boolean, boolean, integer[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_save_demand_draft(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_review_demand_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.a2c_discard_demand_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_packet_data(uuid) TO authenticated;
