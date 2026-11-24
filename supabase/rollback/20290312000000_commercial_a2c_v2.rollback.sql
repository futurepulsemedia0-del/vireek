/*
  Rollback for 20290312000000_commercial_a2c_v2.sql  (data in the NEW tables is deleted - export first if needed).
  Safe non-destructive off-switch WITHOUT running this file: turn flag/kill switch `commercial_a2c_v2` off;
  the dispatcher then uses the unchanged v1 evaluator.
  NOT LIVE-VERIFIED.
*/
BEGIN;

-- 1. dispatcher back to the original evaluator
DROP FUNCTION IF EXISTS public.commercial_evaluate_v2(invoices);
DROP FUNCTION IF EXISTS public.commercial_evaluate(invoices);
DO $$
BEGIN
  IF to_regprocedure('public.commercial_evaluate_v1(invoices)') IS NOT NULL THEN
    ALTER FUNCTION public.commercial_evaluate_v1(invoices) RENAME TO commercial_evaluate;
  END IF;
END $$;

-- 2. cron candidates back to the v1 shape
DROP FUNCTION IF EXISTS public.commercial_collections_candidates(integer);
CREATE FUNCTION public.commercial_collections_candidates(p_limit integer DEFAULT 500)
RETURNS TABLE (
  invoice_id uuid, user_id uuid, customer_id uuid, invoice_number text, customer_name text,
  customer_email text, customer_phone text, due_date date, invoice_sent_at timestamptz,
  stage text, balance_cents bigint, ladder_days integer[], ladder_basis text,
  demand_draft_after_days integer, po_number text, work_order_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.user_id, p.customer_id, i.invoice_number, i.customer_name, i.customer_email, i.customer_phone,
         i.due_date, COALESCE(t.sent_at, i.sent_at), COALESCE(t.stage, 'sent'),
         public.commercial_balance_cents(i.id), p.ladder_days, p.ladder_basis, p.demand_draft_after_days,
         a.po_number, a.work_order_number
  FROM invoices i
  JOIN commercial_billing_profiles p ON p.user_id = i.user_id AND p.customer_id = i.customer_id
  LEFT JOIN commercial_invoice_tracking t ON t.invoice_id = i.id
  LEFT JOIN commercial_approvals a ON a.id = t.approval_id
  WHERE p.reminders_enabled AND i.status IN ('sent', 'viewed')
    AND COALESCE(t.stage, 'sent') IN ('sent', 'received', 'approved', 'rejected')
    AND COALESCE(t.sent_at, i.sent_at) IS NOT NULL AND public.commercial_balance_cents(i.id) > 0
  ORDER BY COALESCE(t.sent_at, i.sent_at) LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.commercial_collections_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_collections_candidates(integer) TO service_role;

-- 3. v1 state machine body (the original CASE table) and event writer
CREATE OR REPLACE FUNCTION public.commercial_apply_stage(p_invoice_id uuid, p_to text, p_reason text, p_system boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE trk commercial_invoice_tracking; v_ok boolean;
BEGIN
  SELECT * INTO trk FROM commercial_invoice_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not tracked' USING ERRCODE = '22023'; END IF;
  IF trk.stage = p_to THEN RETURN; END IF;
  v_ok := CASE trk.stage
    WHEN 'draft' THEN p_to IN ('sent', 'paid', 'void')
    WHEN 'blocked_needs_approval' THEN p_to IN ('sent', 'void')
    WHEN 'sent' THEN p_to IN ('received', 'approved', 'rejected', 'paid', 'void')
    WHEN 'received' THEN p_to IN ('approved', 'rejected', 'paid', 'void')
    WHEN 'approved' THEN p_to IN ('rejected', 'paid', 'void')
    WHEN 'rejected' THEN p_to IN ('sent', 'received', 'approved', 'paid', 'void')
    ELSE false END;
  IF NOT v_ok THEN RAISE EXCEPTION 'cannot move an invoice from % to %', trk.stage, p_to USING ERRCODE = '22023'; END IF;
  IF p_to = 'rejected' AND (p_reason IS NULL OR char_length(btrim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = '22023';
  END IF;
  UPDATE commercial_invoice_tracking SET stage = p_to, stage_changed_at = now(),
    sent_at = CASE WHEN p_to = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
    received_at = CASE WHEN p_to = 'received' THEN now() ELSE received_at END,
    approved_at = CASE WHEN p_to = 'approved' THEN now() ELSE approved_at END,
    rejected_at = CASE WHEN p_to = 'rejected' THEN now() ELSE rejected_at END,
    paid_at = CASE WHEN p_to = 'paid' THEN now() ELSE paid_at END,
    rejection_reason = CASE WHEN p_to = 'rejected' THEN btrim(p_reason) ELSE rejection_reason END
  WHERE id = trk.id;
  PERFORM public.commercial_log_event(trk.user_id, p_invoice_id, 'stage_changed', trk.stage, p_to, p_reason, jsonb_build_object('system', p_system));
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

CREATE OR REPLACE FUNCTION public.commercial_log_event(
  p_user uuid, p_invoice uuid, p_type text, p_from text, p_to text, p_reason text, p_details jsonb, p_dedupe text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, from_stage, to_stage, reason, details, actor_id, dedupe_key)
  VALUES (p_user, p_invoice, p_type, p_from, p_to, p_reason, COALESCE(p_details, '{}'::jsonb), auth.uid(), p_dedupe)
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$;

-- 4. rows that use v2-only stages/types must be moved back before constraints are narrowed
UPDATE commercial_invoice_tracking SET stage = 'sent' WHERE stage IN ('disputed', 'written_off');
UPDATE commercial_invoice_tracking SET stage = 'draft' WHERE stage = 'ready';
DELETE FROM commercial_fix_tasks;
-- events are append-only by trigger: disable it for this one cleanup, then restore it
ALTER TABLE commercial_invoice_events DISABLE TRIGGER trg_commercial_events_no_update;
DELETE FROM commercial_invoice_events WHERE event_type IN ('fix_task_opened','fix_task_resolved','packet_registered','followup_snoozed');
ALTER TABLE commercial_invoice_events ENABLE TRIGGER trg_commercial_events_no_update;

DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name FROM pg_constraint c WHERE c.conrelid = 'public.commercial_invoice_tracking'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ 'stage = ANY';
  IF v_name IS NOT NULL THEN EXECUTE format('ALTER TABLE public.commercial_invoice_tracking DROP CONSTRAINT %I', v_name); END IF;
  ALTER TABLE public.commercial_invoice_tracking ADD CONSTRAINT commercial_invoice_tracking_stage_check
    CHECK (stage IN ('draft','blocked_needs_approval','sent','received','approved','rejected','paid','void'));
  v_name := NULL;
  SELECT c.conname INTO v_name FROM pg_constraint c WHERE c.conrelid = 'public.commercial_invoice_events'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ 'event_type = ANY';
  IF v_name IS NOT NULL THEN EXECUTE format('ALTER TABLE public.commercial_invoice_events DROP CONSTRAINT %I', v_name); END IF;
  ALTER TABLE public.commercial_invoice_events ADD CONSTRAINT commercial_invoice_events_event_type_check CHECK (event_type IN (
    'approval_recorded','approval_linked','precheck_passed','precheck_warned','precheck_blocked','override','stage_changed',
    'reminder_sent','reminder_failed','demand_draft_queued','recovery_logged','packet_generated'));
END $$;

-- 5. new objects (append-only triggers must be dropped first so the tables can be removed with their invoices)
DROP POLICY IF EXISTS "a2c_packets_read" ON storage.objects;
DROP POLICY IF EXISTS "a2c_packets_insert" ON storage.objects;
DROP TRIGGER IF EXISTS trg_commercial_invoice_documents_append_only ON commercial_invoice_documents;
DROP TRIGGER IF EXISTS trg_commercial_invoice_packets_append_only ON commercial_invoice_packets;
DROP TABLE IF EXISTS commercial_stage_transitions, commercial_fix_tasks, commercial_change_order_requests,
  commercial_invoice_packets, commercial_invoice_documents, commercial_billing_rule_versions CASCADE;
-- the 'commercial-packets' bucket is NOT deleted (it may hold customer files): empty and remove it in the Storage UI.

ALTER TABLE commercial_invoice_events DROP COLUMN IF EXISTS source;
ALTER TABLE commercial_invoice_tracking DROP COLUMN IF EXISTS rejection_code, DROP COLUMN IF EXISTS snoozed_until,
  DROP COLUMN IF EXISTS ready_at, DROP COLUMN IF EXISTS disputed_at, DROP COLUMN IF EXISTS written_off_at;
DROP TRIGGER IF EXISTS trg_commercial_profile_tz ON commercial_billing_profiles;
ALTER TABLE commercial_billing_profiles DROP COLUMN IF EXISTS timezone, DROP COLUMN IF EXISTS quiet_start_min, DROP COLUMN IF EXISTS quiet_end_min;
DROP TRIGGER IF EXISTS trg_commercial_approvals_guard_v2 ON commercial_approvals;
ALTER TABLE commercial_approvals DROP COLUMN IF EXISTS approver_role, DROP COLUMN IF EXISTS approver_contact, DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS evidence_sha256, DROP COLUMN IF EXISTS evidence_uploaded_at, DROP COLUMN IF EXISTS evidence_uploaded_by;

DROP FUNCTION IF EXISTS public.commercial_apply_stage_v2(uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.commercial_transition_invoice(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.commercial_snooze_followups(uuid, timestamptz, text);
DROP FUNCTION IF EXISTS public.commercial_a2c_metrics(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.commercial_register_packet(uuid, text, bigint, jsonb);
DROP FUNCTION IF EXISTS public.commercial_request_change_order(uuid, bigint, text);
DROP FUNCTION IF EXISTS public.commercial_decide_change_order(uuid, boolean, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.commercial_save_billing_rules(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.commercial_resolve_approval(invoices, uuid);
DROP FUNCTION IF EXISTS public.commercial_approvals_guard_v2();
DROP FUNCTION IF EXISTS public.commercial_documents_guard();
DROP FUNCTION IF EXISTS public.commercial_profile_tz_guard();
DROP FUNCTION IF EXISTS public.commercial_rules_immutable();
DROP FUNCTION IF EXISTS public.commercial_append_only();
DROP FUNCTION IF EXISTS public.commercial_packet_order_valid(text[]);
DROP FUNCTION IF EXISTS public.commercial_a2c_v2_enabled_me();
DROP FUNCTION IF EXISTS public.commercial_a2c_v2_enabled(uuid);
DELETE FROM kill_switches WHERE key = 'commercial_a2c_v2';

COMMIT;
