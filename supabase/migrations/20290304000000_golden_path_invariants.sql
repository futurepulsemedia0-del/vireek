/*
  # Golden path: money bridge, DB invariants, immutable workflow events

  Additive only. Nothing is renamed, dropped or backfilled. Requires (all already in the repo):
    20261205000000_invoicing.sql, 20270402000000_invoice_detail.sql (invoice_total_cents, _invoice_recalc, _invoice_audit),
    20271210000000_invoice_split_payments.sql (_invoice_net_paid, uq_invoice_payments_intent),
    20260916010000_smart_payment_collection.sql (payment_requests).

  1. A paid single-payer Stripe payment_request is mirrored into invoice_payments for the invoice linked to the same job
     (finalize_paid_payment_request only touched payment_requests + jobs.invoice_status). The mirror can NEVER fail the
     webhook: any error is rolled back to a savepoint and written to audit_log as 'invoice_payment_mirror_failed'.
     Amount is capped at the invoice balance; any excess is flagged 'invoice_payment_needs_review', never silently booked.
  2. DB guards that hold for every write path (RPC, edge function, service role):
       - invoice_payments: amount <= balance due, invoice not void, same tenant.
       - invoice_refunds : refund <= payment - earlier refunds, same invoice, same tenant.
       - invoices (NOT VALID, so existing rows are untouched): line_items is a jsonb array; tax_percent in [0, 100].
       - jobs: an authenticated end user cannot move a job to 'completed' with no assigned technician
         (service_role / imports / automation, where auth.uid() IS NULL, are exempt).
  3. workflow_events: append-only trail (no FK to profiles, so a team member with no profile row cannot make it fail)
     for job status/assignment, invoice creation/status, payments, refunds and payment_request status.

  Behaviour change to announce: the web UI can no longer complete a job that has no assigned technician.

  Execution: add to supabase/migrations as-is (timestamp is later than 20290303000000), then `supabase test db`.
  Run against a dev project first. Never `db push` to production before review.

  ROLLBACK (manual; data in workflow_events is lost if the table is dropped):
    DROP TRIGGER IF EXISTS trg_mirror_payment_request_to_invoice ON payment_requests;
    DROP TRIGGER IF EXISTS trg_guard_invoice_payment_amount ON invoice_payments;
    DROP TRIGGER IF EXISTS trg_guard_invoice_refund_amount ON invoice_refunds;
    DROP TRIGGER IF EXISTS trg_guard_job_completion_technician ON jobs;
    DROP TRIGGER IF EXISTS trg_wf_jobs ON jobs;
    DROP TRIGGER IF EXISTS trg_wf_invoices ON invoices;
    DROP TRIGGER IF EXISTS trg_wf_invoice_payments ON invoice_payments;
    DROP TRIGGER IF EXISTS trg_wf_invoice_refunds ON invoice_refunds;
    DROP TRIGGER IF EXISTS trg_wf_payment_requests ON payment_requests;
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_line_items_is_array;
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tax_percent_range;
    -- optional: DROP TABLE workflow_events;
*/

-- =============================================================
-- 1. workflow_events (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_events (
  id           bigserial PRIMARY KEY,
  user_id      uuid        NOT NULL,
  entity_type  text        NOT NULL CHECK (entity_type IN ('job', 'invoice', 'payment')),
  entity_id    uuid        NOT NULL,
  event_type   text        NOT NULL,
  from_status  text,
  to_status    text,
  amount_cents bigint,
  actor_id     uuid,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_entity
  ON workflow_events (user_id, entity_type, entity_id, id);

ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workflow_events" ON workflow_events;
CREATE POLICY "select_own_workflow_events" ON workflow_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE ALL ON workflow_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON workflow_events FROM authenticated;
GRANT SELECT ON workflow_events TO authenticated;

CREATE OR REPLACE FUNCTION public.workflow_events_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_events is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_events_no_update ON workflow_events;
CREATE TRIGGER trg_workflow_events_no_update BEFORE UPDATE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION public.workflow_events_reject_mutation();
DROP TRIGGER IF EXISTS trg_workflow_events_no_delete ON workflow_events;
CREATE TRIGGER trg_workflow_events_no_delete BEFORE DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION public.workflow_events_reject_mutation();

CREATE OR REPLACE FUNCTION public._wf_emit(
  p_user uuid, p_type text, p_id uuid, p_event text,
  p_from text, p_to text, p_amount bigint, p_meta jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO workflow_events (user_id, entity_type, entity_id, event_type, from_status, to_status, amount_cents, actor_id, metadata)
  VALUES (p_user, p_type, p_id, p_event, p_from, p_to, p_amount, auth.uid(), COALESCE(p_meta, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public._wf_emit(uuid, text, uuid, text, text, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;

-- ---- jobs
CREATE OR REPLACE FUNCTION public.wf_log_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public._wf_emit(NEW.user_id, 'job', NEW.id, 'job.created', NULL, NEW.job_status, NULL,
      jsonb_build_object('technician_id', NEW.assigned_technician_id));
    RETURN NEW;
  END IF;
  IF OLD.job_status IS DISTINCT FROM NEW.job_status THEN
    PERFORM public._wf_emit(NEW.user_id, 'job', NEW.id, 'job.status_changed', OLD.job_status, NEW.job_status, NULL,
      jsonb_build_object('technician_id', NEW.assigned_technician_id));
  END IF;
  IF OLD.assigned_technician_id IS DISTINCT FROM NEW.assigned_technician_id THEN
    PERFORM public._wf_emit(NEW.user_id, 'job', NEW.id, 'job.technician_changed', NULL, NULL, NULL,
      jsonb_build_object('from', OLD.assigned_technician_id, 'to', NEW.assigned_technician_id));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wf_jobs ON jobs;
CREATE TRIGGER trg_wf_jobs AFTER INSERT OR UPDATE OF job_status, assigned_technician_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.wf_log_job();

-- ---- invoices
CREATE OR REPLACE FUNCTION public.wf_log_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public._wf_emit(NEW.user_id, 'invoice', NEW.id, 'invoice.created', NULL, NEW.status,
      public.invoice_total_cents(NEW.line_items, NEW.tax_percent), jsonb_build_object('job_id', NEW.job_id));
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public._wf_emit(NEW.user_id, 'invoice', NEW.id, 'invoice.status_changed', OLD.status, NEW.status,
      public.invoice_total_cents(NEW.line_items, NEW.tax_percent), '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wf_invoices ON invoices;
CREATE TRIGGER trg_wf_invoices AFTER INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.wf_log_invoice();

-- ---- invoice payments / refunds
CREATE OR REPLACE FUNCTION public.wf_log_invoice_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._wf_emit(NEW.user_id, 'invoice', NEW.invoice_id, 'invoice.payment_recorded', NULL, NULL, NEW.amount_cents,
    jsonb_build_object('payment_id', NEW.id, 'method', NEW.method, 'reference', NEW.reference));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wf_invoice_payments ON invoice_payments;
CREATE TRIGGER trg_wf_invoice_payments AFTER INSERT ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.wf_log_invoice_payment();

CREATE OR REPLACE FUNCTION public.wf_log_invoice_refund()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._wf_emit(NEW.user_id, 'invoice', NEW.invoice_id, 'invoice.refund_recorded', NULL, NULL, NEW.amount_cents,
    jsonb_build_object('refund_id', NEW.id, 'payment_id', NEW.payment_id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wf_invoice_refunds ON invoice_refunds;
CREATE TRIGGER trg_wf_invoice_refunds AFTER INSERT ON invoice_refunds
  FOR EACH ROW EXECUTE FUNCTION public.wf_log_invoice_refund();

-- ---- payment_requests (Stripe checkout requests)
CREATE OR REPLACE FUNCTION public.wf_log_payment_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public._wf_emit(NEW.user_id, 'payment', NEW.id, 'payment.created', NULL, NEW.status,
      round(NEW.amount * 100)::bigint, jsonb_build_object('job_id', NEW.job_id));
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public._wf_emit(NEW.user_id, 'payment', NEW.id, 'payment.status_changed', OLD.status, NEW.status,
      round(NEW.amount * 100)::bigint, jsonb_build_object('job_id', NEW.job_id));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wf_payment_requests ON payment_requests;
CREATE TRIGGER trg_wf_payment_requests AFTER INSERT OR UPDATE OF status ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION public.wf_log_payment_request();

-- =============================================================
-- 2. Invariants
-- =============================================================
CREATE OR REPLACE FUNCTION public.guard_invoice_payment_amount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv invoices%ROWTYPE;
  v_due bigint;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_inv.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Payment tenant does not match invoice tenant' USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.status = 'void' THEN
    RAISE EXCEPTION 'This invoice is void' USING ERRCODE = 'check_violation';
  END IF;
  v_due := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent) - public._invoice_net_paid(NEW.invoice_id);
  IF NEW.amount_cents > v_due THEN
    RAISE EXCEPTION 'Payment exceeds the balance due' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_invoice_payment_amount ON invoice_payments;
CREATE TRIGGER trg_guard_invoice_payment_amount BEFORE INSERT ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_payment_amount();

CREATE OR REPLACE FUNCTION public.guard_invoice_refund_amount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay invoice_payments%ROWTYPE;
  v_refunded bigint;
BEGIN
  SELECT * INTO v_pay FROM invoice_payments WHERE id = NEW.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_pay.invoice_id IS DISTINCT FROM NEW.invoice_id OR v_pay.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Refund does not match the payment''s invoice/tenant' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(amount_cents), 0) INTO v_refunded FROM invoice_refunds WHERE payment_id = NEW.payment_id;
  IF NEW.amount_cents > v_pay.amount_cents - v_refunded THEN
    RAISE EXCEPTION 'Refund exceeds the refundable amount of this payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_invoice_refund_amount ON invoice_refunds;
CREATE TRIGGER trg_guard_invoice_refund_amount BEFORE INSERT ON invoice_refunds
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_refund_amount();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_line_items_is_array' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_line_items_is_array
      CHECK (jsonb_typeof(line_items) = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_tax_percent_range' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_tax_percent_range
      CHECK (tax_percent >= 0 AND tax_percent <= 100) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_job_completion_technician()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_status = 'completed'
     AND OLD.job_status IS DISTINCT FROM 'completed'
     AND NEW.assigned_technician_id IS NULL
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'A job cannot be completed without an assigned technician' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_job_completion_technician ON jobs;
CREATE TRIGGER trg_guard_job_completion_technician BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_completion_technician();

-- =============================================================
-- 3. Stripe single-payer payment -> invoice_payments (never fails the webhook)
-- =============================================================
CREATE OR REPLACE FUNCTION public._mirror_payment_request_to_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv    invoices%ROWTYPE;
  v_total  bigint;
  v_due    bigint;
  v_base   bigint;
  v_amount bigint;
  v_ref    text := 'payment_request:' || NEW.id::text;
  v_id     uuid;
BEGIN
  IF NEW.job_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    SELECT * INTO v_inv FROM invoices
     WHERE job_id = NEW.job_id AND user_id = NEW.user_id AND status <> 'void'
     ORDER BY (public.invoice_total_cents(line_items, tax_percent) - public._invoice_net_paid(id) > 0) DESC, created_at ASC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN RETURN NEW; END IF;

    IF EXISTS (SELECT 1 FROM invoice_payments WHERE invoice_id = v_inv.id AND reference = v_ref) THEN
      RETURN NEW;  -- idempotent
    END IF;

    v_total  := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
    v_due    := GREATEST(v_total - public._invoice_net_paid(v_inv.id), 0);
    v_base   := round(NEW.amount * 100)::bigint;       -- invoice amount only; the tip is never part of the invoice
    v_amount := LEAST(v_base, v_due);

    IF v_amount <= 0 THEN
      PERFORM public._invoice_audit(NEW.user_id, 'invoice_payment_needs_review', v_inv.id,
        jsonb_build_object('payment_request_id', NEW.id, 'amount_cents', v_base, 'reason', 'no_balance_due'));
      RETURN NEW;
    END IF;

    INSERT INTO invoice_payments (user_id, invoice_id, amount_cents, method, reference, note, paid_at, stripe_payment_intent_id)
    VALUES (NEW.user_id, v_inv.id, v_amount, 'card', v_ref, 'Paid online (Stripe)', COALESCE(NEW.paid_at, now()),
            NULLIF(NEW.stripe_payment_intent_id, ''))
    RETURNING id INTO v_id;

    PERFORM public._invoice_recalc(v_inv.id);
    PERFORM public._invoice_audit(NEW.user_id, 'invoice_payment_recorded', v_inv.id,
      jsonb_build_object('payment_id', v_id, 'amount_cents', v_amount, 'method', 'card', 'online', true,
                         'payment_request_id', NEW.id));

    IF v_amount < v_base THEN
      PERFORM public._invoice_audit(NEW.user_id, 'invoice_payment_needs_review', v_inv.id,
        jsonb_build_object('payment_request_id', NEW.id, 'unbooked_cents', v_base - v_amount, 'reason', 'exceeds_balance'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public._invoice_audit(NEW.user_id, 'invoice_payment_mirror_failed', v_inv.id,
        jsonb_build_object('payment_request_id', NEW.id, 'error', SQLERRM));
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- the payment itself is already final; never fail the webhook
    END;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_payment_request_to_invoice ON payment_requests;
CREATE TRIGGER trg_mirror_payment_request_to_invoice
  AFTER UPDATE OF status ON payment_requests
  FOR EACH ROW WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public._mirror_payment_request_to_invoice();

REVOKE ALL ON FUNCTION public._mirror_payment_request_to_invoice() FROM PUBLIC, anon, authenticated;
