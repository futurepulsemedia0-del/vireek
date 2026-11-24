/*
  # Commercial Approval-to-Cash v2  (flag + kill switch: `commercial_a2c_v2`, default OFF)

  EXTENDS 20280302000000_commercial_approval_to_cash.sql. Nothing is replaced in parallel:
    - invoices.status is NOT touched (draft|sent|viewed|paid|void). New stages live in commercial_invoice_tracking.stage.
    - commercial_evaluate(invoices) is renamed to commercial_evaluate_v1 and re-created as a DISPATCHER:
      flag OFF / kill switch stopped / no rule version for the customer  ->  the unchanged v1 evaluator.
      Every existing caller (send-gate trigger, precheck, sync trigger, invoice-email) goes through it.
    - commercial_apply_stage(uuid,text,text,boolean) keeps its signature and now delegates to a table-driven v2.

  NEW: commercial_billing_rule_versions (immutable, versioned), commercial_change_order_requests,
       commercial_invoice_documents, commercial_invoice_packets (+ private bucket), commercial_fix_tasks,
       commercial_stage_transitions (data-driven state machine), commercial_a2c_metrics().

  Tenant key: user_id uuid = get_account_owner_id()  (as in every table of the zip).
  The guard below ABORTS (nothing is changed) if the live DB does not match that contract.

  NOT LIVE-VERIFIED: this file was statically reviewed only. No Postgres was available to execute it.
  Run supabase/preflight/a2c_v2_preflight.sql first, then run this file in ONE transaction.
  Rollback: supabase/rollback/20290312000000_commercial_a2c_v2.rollback.sql
*/
BEGIN;

-- =============================================================
-- 0. GUARD: refuse to run against a DB that differs from the zip
-- =============================================================
DO $$
DECLARE v_missing text[] := ARRAY[]::text[]; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','customers','jobs','job_photos','commercial_billing_profiles','commercial_approvals',
    'commercial_invoice_tracking','commercial_invoice_events','commercial_followups','revenue_recovery_events',
    'kill_switches','kill_switch_org_stops','feature_flags'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN v_missing := v_missing || ('table ' || t); END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['get_account_owner_id()','commercial_can_bill()','commercial_apply_stage(uuid,text,text,boolean)',
    'commercial_log_event(uuid,uuid,text,text,text,text,jsonb,text)','commercial_sync_recovery_event(uuid,text,text)',
    'commercial_precheck_core(uuid)','commercial_assert_refs()','commercial_touch_updated_at()',
    'log_audit_event(uuid,text,text,text)','flag_evaluate(text,uuid)'] LOOP
    IF to_regprocedure('public.' || t) IS NULL THEN v_missing := v_missing || ('function ' || t); END IF;
  END LOOP;
  IF to_regprocedure('public.commercial_evaluate(invoices)') IS NULL
     AND to_regprocedure('public.commercial_evaluate_v1(invoices)') IS NULL THEN
    v_missing := v_missing || 'function commercial_evaluate(invoices)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name IN ('invoices','commercial_approvals','commercial_invoice_tracking','commercial_billing_profiles')
             AND column_name = 'user_id' AND data_type <> 'uuid') THEN
    v_missing := v_missing || 'tenant key user_id is not uuid (live DB differs from the zip)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'A2C v2 pre-flight failed, nothing changed. Missing/different: %', array_to_string(v_missing, '; ');
  END IF;
END $$;

-- =============================================================
-- 1. Flag + kill switch (default OFF: an unknown flag key evaluates to false)
-- =============================================================
INSERT INTO kill_switches (key, label, description, risk)
VALUES ('commercial_a2c_v2', 'Commercial A2C v2 gate',
        'Rule-versioned pre-invoice gate, change orders, packets and fix tasks. Stopping it falls back to the v1 gate.', 'high')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.commercial_a2c_v2_enabled(p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner IS NOT NULL
     AND public.flag_evaluate('commercial_a2c_v2', p_owner)
     AND NOT COALESCE((SELECT k.stopped FROM kill_switches k WHERE k.key = 'commercial_a2c_v2'), false)
     AND NOT EXISTS (SELECT 1 FROM kill_switch_org_stops s WHERE s.key = 'commercial_a2c_v2' AND s.tenant_id = p_owner);
$$;
REVOKE ALL ON FUNCTION public.commercial_a2c_v2_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_a2c_v2_enabled(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.commercial_a2c_v2_enabled_me()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.commercial_can_bill() AND public.commercial_a2c_v2_enabled(public.get_account_owner_id());
$$;
GRANT EXECUTE ON FUNCTION public.commercial_a2c_v2_enabled_me() TO authenticated;

-- =============================================================
-- 2. Validators
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_packet_order_valid(p text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 8
     AND p <@ ARRAY['invoice','po','approval_proof','change_order','completion_photos','signature','service_report','other_documents']::text[]
     AND 'invoice' = ANY(p)
     AND cardinality(p) = (SELECT count(DISTINCT x) FROM unnest(p) AS x);
$$;

-- =============================================================
-- 3. Versioned, immutable billing rules
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_billing_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  gate_mode text NOT NULL DEFAULT 'block' CHECK (gate_mode IN ('block', 'warn', 'off')),
  requires_po boolean NOT NULL DEFAULT true,
  po_format_regex text CHECK (po_format_regex IS NULL OR char_length(po_format_regex) BETWEEN 1 AND 120),
  requires_work_order_number boolean NOT NULL DEFAULT false,
  requires_nte_approval boolean NOT NULL DEFAULT false,
  requires_completion_photos boolean NOT NULL DEFAULT true,
  requires_signature boolean NOT NULL DEFAULT false,
  requires_service_report boolean NOT NULL DEFAULT false,
  invoice_due_window_days integer CHECK (invoice_due_window_days IS NULL OR invoice_due_window_days BETWEEN 1 AND 365),
  submission_channel text NOT NULL DEFAULT 'email' CHECK (submission_channel IN ('email', 'portal', 'edi', 'manual')),
  required_attachments text[] NOT NULL DEFAULT '{}'
    CHECK (required_attachments <@ ARRAY['po_copy','approval_proof','completion_photos','signature','service_report','other']::text[]),
  packet_order text[] NOT NULL DEFAULT ARRAY['invoice','po','approval_proof','completion_photos','signature','service_report']
    CHECK (public.commercial_packet_order_valid(packet_order)),
  remit_to text CHECK (remit_to IS NULL OR char_length(remit_to) <= 1000),
  ap_contact_name text CHECK (ap_contact_name IS NULL OR char_length(ap_contact_name) <= 200),
  ap_contact_email text CHECK (ap_contact_email IS NULL OR char_length(ap_contact_email) <= 254),
  ap_contact_phone text CHECK (ap_contact_phone IS NULL OR char_length(ap_contact_phone) <= 50),
  nte_warn_pct smallint NOT NULL DEFAULT 80 CHECK (nte_warn_pct BETWEEN 1 AND 100),
  nte_block_pct smallint NOT NULL DEFAULT 100 CHECK (nte_block_pct BETWEEN 100 AND 120),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  change_reason text NOT NULL CHECK (char_length(btrim(change_reason)) BETWEEN 3 AND 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id, version),
  CONSTRAINT commercial_rules_window CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
-- at most ONE open (current) version per customer
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_rules_open
  ON commercial_billing_rule_versions (user_id, customer_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_rules_lookup
  ON commercial_billing_rule_versions (user_id, customer_id, effective_from DESC);

-- Immutable: the only permitted change is closing an open version (effective_to NULL -> value).
CREATE OR REPLACE FUNCTION public.commercial_rules_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing rule versions are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.effective_to IS NOT NULL
     OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'billing rule versions are immutable; save a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_rules_immutable ON commercial_billing_rule_versions;
CREATE TRIGGER trg_commercial_rules_immutable BEFORE UPDATE OR DELETE ON commercial_billing_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.commercial_rules_immutable();
DROP TRIGGER IF EXISTS trg_commercial_rules_refs ON commercial_billing_rule_versions;
CREATE TRIGGER trg_commercial_rules_refs BEFORE INSERT ON commercial_billing_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.commercial_assert_refs();

-- Save = close current version + insert next + sync the v1 profile + audit. Atomic and race-safe.
CREATE OR REPLACE FUNCTION public.commercial_save_billing_rules(p_customer_id uuid, p_rules jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_ver integer; v_id uuid; v_re text;
  v_att text[]; v_ord text[];
BEGIN
  IF v_owner IS NULL OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'customer does not belong to this account' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'a change reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object' THEN
    RAISE EXCEPTION 'rules must be a JSON object' USING ERRCODE = '22023';
  END IF;

  v_re := NULLIF(btrim(p_rules->>'po_format_regex'), '');
  IF v_re IS NOT NULL THEN
    -- portable subset only (same regex must behave identically in Postgres and JavaScript)
    IF v_re ~ '\(\?' OR v_re ~ '\\[1-9]' THEN
      RAISE EXCEPTION 'po_format_regex: lookaround, flags and back-references are not supported' USING ERRCODE = '22023';
    END IF;
    BEGIN PERFORM '' ~ v_re;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'po_format_regex is not a valid expression' USING ERRCODE = '22023'; END;
  END IF;

  v_att := COALESCE(ARRAY(SELECT jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p_rules->'required_attachments') = 'array' THEN p_rules->'required_attachments' ELSE '[]'::jsonb END)), '{}');
  v_ord := COALESCE(ARRAY(SELECT jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p_rules->'packet_order') = 'array' THEN p_rules->'packet_order' ELSE '[]'::jsonb END)), '{}');
  IF cardinality(v_ord) = 0 THEN v_ord := ARRAY['invoice','po','approval_proof','completion_photos','signature','service_report']; END IF;

  -- v1 profile row is the lock target (serialises concurrent saves) and keeps the v1 gate coherent
  INSERT INTO commercial_billing_profiles (user_id, customer_id) VALUES (v_owner, p_customer_id)
  ON CONFLICT (user_id, customer_id) DO NOTHING;
  PERFORM 1 FROM commercial_billing_profiles WHERE user_id = v_owner AND customer_id = p_customer_id FOR UPDATE;

  SELECT COALESCE(max(version), 0) + 1 INTO v_ver FROM commercial_billing_rule_versions
   WHERE user_id = v_owner AND customer_id = p_customer_id;
  UPDATE commercial_billing_rule_versions SET effective_to = now()
   WHERE user_id = v_owner AND customer_id = p_customer_id AND effective_to IS NULL;

  INSERT INTO commercial_billing_rule_versions (
    user_id, customer_id, version, gate_mode, requires_po, po_format_regex, requires_work_order_number,
    requires_nte_approval, requires_completion_photos, requires_signature, requires_service_report,
    invoice_due_window_days, submission_channel, required_attachments, packet_order, remit_to,
    ap_contact_name, ap_contact_email, ap_contact_phone, nte_warn_pct, nte_block_pct, notes, change_reason)
  VALUES (
    v_owner, p_customer_id, v_ver,
    COALESCE(p_rules->>'gate_mode', 'block'),
    COALESCE((p_rules->>'requires_po')::boolean, true), v_re,
    COALESCE((p_rules->>'requires_work_order_number')::boolean, false),
    COALESCE((p_rules->>'requires_nte_approval')::boolean, false),
    COALESCE((p_rules->>'requires_completion_photos')::boolean, true),
    COALESCE((p_rules->>'requires_signature')::boolean, false),
    COALESCE((p_rules->>'requires_service_report')::boolean, false),
    NULLIF(p_rules->>'invoice_due_window_days', '')::integer,
    COALESCE(p_rules->>'submission_channel', 'email'), v_att, v_ord,
    NULLIF(btrim(p_rules->>'remit_to'), ''), NULLIF(btrim(p_rules->>'ap_contact_name'), ''),
    NULLIF(btrim(p_rules->>'ap_contact_email'), ''), NULLIF(btrim(p_rules->>'ap_contact_phone'), ''),
    COALESCE((p_rules->>'nte_warn_pct')::smallint, 80), COALESCE((p_rules->>'nte_block_pct')::smallint, 100),
    NULLIF(btrim(p_rules->>'notes'), ''), btrim(p_reason))
  RETURNING id INTO v_id;

  -- v1 has no 'off': it maps to the weaker 'warn' so a v2 outage/kill-switch never hard-blocks an 'off' customer
  UPDATE commercial_billing_profiles p SET
    pre_invoice_mode = CASE r.gate_mode WHEN 'block' THEN 'block' ELSE 'warn' END,
    require_po = r.requires_po,
    require_completion_proof = (r.requires_completion_photos OR r.requires_signature)
  FROM commercial_billing_rule_versions r
  WHERE r.id = v_id AND p.user_id = v_owner AND p.customer_id = p_customer_id;

  PERFORM public.log_audit_event(v_owner, 'commercial_billing_rules_changed', 'commercial_billing_rule_versions', v_id::text);
  RETURN jsonb_build_object('id', v_id, 'version', v_ver);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_save_billing_rules(uuid, jsonb, text) TO authenticated;

-- =============================================================
-- 4. Approval evidence: approver role/contact, expiry, hash, uploader/timestamp
-- =============================================================
ALTER TABLE commercial_approvals
  ADD COLUMN IF NOT EXISTS approver_role text CHECK (approver_role IS NULL OR char_length(approver_role) <= 100),
  ADD COLUMN IF NOT EXISTS approver_contact text CHECK (approver_contact IS NULL OR char_length(approver_contact) <= 200),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS evidence_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_uploaded_by uuid;

CREATE OR REPLACE FUNCTION public.commercial_approvals_guard_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= NEW.approved_at THEN
      RAISE EXCEPTION 'expires_at must be after approved_at' USING ERRCODE = '22023';
    END IF;
    IF NEW.evidence_storage_path IS NOT NULL THEN
      IF public.commercial_a2c_v2_enabled(NEW.user_id) AND NEW.evidence_sha256 IS NULL THEN
        RAISE EXCEPTION 'evidence_sha256 is required for uploaded approval evidence' USING ERRCODE = '22023';
      END IF;
      -- server-side truth for who/when; client values are ignored
      NEW.evidence_uploaded_at := now();
      NEW.evidence_uploaded_by := auth.uid();
    ELSE
      NEW.evidence_uploaded_at := NULL; NEW.evidence_uploaded_by := NULL; NEW.evidence_sha256 := NULL;
    END IF;
  ELSIF NEW.approver_role IS DISTINCT FROM OLD.approver_role OR NEW.approver_contact IS DISTINCT FROM OLD.approver_contact
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
     OR NEW.evidence_uploaded_at IS DISTINCT FROM OLD.evidence_uploaded_at
     OR NEW.evidence_uploaded_by IS DISTINCT FROM OLD.evidence_uploaded_by THEN
    RAISE EXCEPTION 'approval evidence is immutable; void it and record a new approval' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_approvals_guard_v2 ON commercial_approvals;
CREATE TRIGGER trg_commercial_approvals_guard_v2 BEFORE INSERT OR UPDATE ON commercial_approvals
  FOR EACH ROW EXECUTE FUNCTION public.commercial_approvals_guard_v2();

-- =============================================================
-- 5. Supporting documents (service report, PO copy, other) + immutable packets
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('po_copy', 'approval_proof', 'service_report', 'other')),
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 500),
  file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  uploaded_by uuid DEFAULT auth.uid(),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commercial_docs_invoice ON commercial_invoice_documents (user_id, invoice_id, doc_type);

CREATE TABLE IF NOT EXISTS commercial_invoice_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
  manifest jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(manifest) = 'array'),
  generated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, version)
);

CREATE OR REPLACE FUNCTION public.commercial_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END;
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_invoice_documents', 'commercial_invoice_packets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.commercial_append_only()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_refs ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_refs BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.commercial_assert_refs()', t, t);
  END LOOP;
END $$;
-- NOTE: append-only also blocks the ON DELETE CASCADE from invoices. Invoices are voided, not deleted; if an
-- invoice must be hard-deleted, an operator drops these two triggers deliberately (documented in the rollback file).

CREATE OR REPLACE FUNCTION public.commercial_documents_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF split_part(NEW.storage_path, '/', 1) <> NEW.user_id::text THEN
    RAISE EXCEPTION 'document must be stored under this account''s folder' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_documents_guard ON commercial_invoice_documents;
CREATE TRIGGER trg_commercial_documents_guard BEFORE INSERT ON commercial_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION public.commercial_documents_guard();

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('commercial-packets', 'commercial-packets', false, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Register first (server assigns version + deterministic name/path), then upload to exactly that path.
CREATE OR REPLACE FUNCTION public.commercial_register_packet(p_invoice_id uuid, p_sha256 text, p_byte_size bigint, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id(); inv invoices; v_ver integer; v_name text; v_path text; v_id uuid;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner;
  IF NOT FOUND OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_id::text, 0));
  SELECT COALESCE(max(version), 0) + 1 INTO v_ver FROM commercial_invoice_packets WHERE invoice_id = p_invoice_id;
  v_name := 'VRK-' || regexp_replace(COALESCE(NULLIF(inv.invoice_number, ''), left(inv.id::text, 8)), '[^A-Za-z0-9_-]', '-', 'g')
            || '-packet-v' || v_ver || '.pdf';
  v_path := v_owner::text || '/' || inv.id::text || '/' || v_name;
  INSERT INTO commercial_invoice_packets (user_id, invoice_id, version, file_name, storage_path, sha256, byte_size, manifest)
  VALUES (v_owner, inv.id, v_ver, v_name, v_path, p_sha256, p_byte_size, COALESCE(p_manifest, '[]'::jsonb))
  RETURNING id INTO v_id;
  PERFORM public.commercial_log_event(v_owner, inv.id, 'packet_registered', NULL, NULL, NULL,
    jsonb_build_object('packet_id', v_id, 'version', v_ver, 'sha256', p_sha256), 'packet:' || v_id);
  RETURN jsonb_build_object('id', v_id, 'version', v_ver, 'file_name', v_name, 'storage_path', v_path);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_register_packet(uuid, text, bigint, jsonb) TO authenticated;

-- =============================================================
-- 6. Change orders (NTE exceeded -> request -> customer approval evidence -> new approval)
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_change_order_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  approval_id uuid NOT NULL REFERENCES commercial_approvals(id) ON DELETE CASCADE,
  requested_amount_cents bigint NOT NULL CHECK (requested_amount_cents > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  approved_by_name text CHECK (approved_by_name IS NULL OR char_length(btrim(approved_by_name)) BETWEEN 2 AND 200),
  evidence_storage_path text CHECK (evidence_storage_path IS NULL OR char_length(evidence_storage_path) <= 500),
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(btrim(evidence_ref)) BETWEEN 1 AND 500),
  resulting_approval_id uuid REFERENCES commercial_approvals(id) ON DELETE SET NULL,
  requested_by uuid DEFAULT auth.uid(),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_co_approved_has_proof CHECK (status <> 'approved'
    OR (approved_by_name IS NOT NULL AND (evidence_storage_path IS NOT NULL OR evidence_ref IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_co_open ON commercial_change_order_requests (approval_id) WHERE status = 'requested';
DROP TRIGGER IF EXISTS trg_commercial_co_touch ON commercial_change_order_requests;
CREATE TRIGGER trg_commercial_co_touch BEFORE UPDATE ON commercial_change_order_requests
  FOR EACH ROW EXECUTE FUNCTION public.commercial_touch_updated_at();

CREATE OR REPLACE FUNCTION public.commercial_request_change_order(p_approval_id uuid, p_requested_amount_cents bigint, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); a commercial_approvals; v_id uuid;
BEGIN
  SELECT * INTO a FROM commercial_approvals WHERE id = p_approval_id AND user_id = v_owner AND status = 'active';
  IF NOT FOUND OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF p_requested_amount_cents IS NULL OR p_requested_amount_cents <= a.approved_amount_cents THEN
    RAISE EXCEPTION 'a change order must raise the approved amount' USING ERRCODE = '22023';
  END IF;
  INSERT INTO commercial_change_order_requests (user_id, approval_id, requested_amount_cents, reason)
  VALUES (v_owner, a.id, p_requested_amount_cents, p_reason)
  ON CONFLICT (approval_id) WHERE status = 'requested' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'a change order is already pending for this approval' USING ERRCODE = '23505'; END IF;
  PERFORM public.log_audit_event(v_owner, 'commercial_change_order_requested', 'commercial_change_order_requests', v_id::text);
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_request_change_order(uuid, bigint, text) TO authenticated;

-- Approve = record a NEW approval at the higher cap, move this approval's open invoices onto it, void the old one.
CREATE OR REPLACE FUNCTION public.commercial_decide_change_order(
  p_request_id uuid, p_approve boolean, p_approved_by_name text, p_evidence_storage_path text,
  p_evidence_sha256 text, p_evidence_ref text, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id(); r commercial_change_order_requests; a commercial_approvals;
  v_new uuid; t record;
BEGIN
  SELECT * INTO r FROM commercial_change_order_requests WHERE id = p_request_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'change order already %', r.status USING ERRCODE = '22023'; END IF;
  IF NOT p_approve THEN
    UPDATE commercial_change_order_requests SET status = 'rejected', decision_note = left(p_note, 2000),
      decided_by = auth.uid(), decided_at = now() WHERE id = r.id;
    PERFORM public.log_audit_event(v_owner, 'commercial_change_order_rejected', 'commercial_change_order_requests', r.id::text);
    RETURN NULL;
  END IF;
  IF p_approved_by_name IS NULL OR (p_evidence_storage_path IS NULL AND p_evidence_ref IS NULL) THEN
    RAISE EXCEPTION 'customer approval name and evidence are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM commercial_approvals WHERE id = r.approval_id AND user_id = v_owner FOR UPDATE;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'the original approval is no longer active' USING ERRCODE = '22023'; END IF;

  INSERT INTO commercial_approvals (user_id, customer_id, job_id, quote_id, po_number, work_order_number, approved_amount_cents,
    approval_source, evidence_storage_path, evidence_ref, approved_by_name, approved_at, notes, evidence_sha256)
  VALUES (v_owner, a.customer_id, a.job_id, a.quote_id, a.po_number, a.work_order_number, r.requested_amount_cents,
    'other', p_evidence_storage_path, p_evidence_ref, btrim(p_approved_by_name), now(),
    left('Change order ' || r.id::text || ': ' || r.reason, 2000), p_evidence_sha256)
  RETURNING id INTO v_new;

  FOR t IN SELECT invoice_id FROM commercial_invoice_tracking
           WHERE approval_id = a.id AND user_id = v_owner AND stage NOT IN ('void') LOOP
    UPDATE commercial_invoice_tracking SET approval_id = v_new WHERE invoice_id = t.invoice_id;
    PERFORM public.commercial_log_event(v_owner, t.invoice_id, 'approval_linked', NULL, NULL, 'change order approved',
      jsonb_build_object('approval_id', v_new, 'previous_approval_id', a.id, 'change_order_id', r.id),
      'co-link:' || r.id || ':' || t.invoice_id);
  END LOOP;
  UPDATE commercial_approvals SET status = 'void', void_reason = 'superseded by change order ' || r.id::text WHERE id = a.id;
  UPDATE commercial_change_order_requests SET status = 'approved', approved_by_name = btrim(p_approved_by_name),
    evidence_storage_path = p_evidence_storage_path, evidence_sha256 = p_evidence_sha256, evidence_ref = p_evidence_ref,
    resulting_approval_id = v_new, decision_note = left(p_note, 2000), decided_by = auth.uid(), decided_at = now()
  WHERE id = r.id;
  PERFORM public.log_audit_event(v_owner, 'commercial_change_order_approved', 'commercial_change_order_requests', r.id::text);
  RETURN v_new;
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_decide_change_order(uuid, boolean, text, text, text, text, text) TO authenticated;

-- =============================================================
-- 7. Rejection taxonomy, fix tasks, extra tracking columns, ladder settings
-- =============================================================
ALTER TABLE commercial_invoice_tracking
  ADD COLUMN IF NOT EXISTS rejection_code text CHECK (rejection_code IS NULL OR rejection_code IN
    ('missing_po','po_mismatch','amount_exceeds_nte','missing_documents','wrong_billing_entity','late_submission','pricing_dispute','duplicate','other')),
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS written_off_at timestamptz;

ALTER TABLE commercial_billing_profiles
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS quiet_start_min smallint NOT NULL DEFAULT 1200 CHECK (quiet_start_min BETWEEN 0 AND 1439),
  ADD COLUMN IF NOT EXISTS quiet_end_min smallint NOT NULL DEFAULT 480 CHECK (quiet_end_min BETWEEN 0 AND 1439);

CREATE OR REPLACE FUNCTION public.commercial_profile_tz_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown IANA time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_profile_tz ON commercial_billing_profiles;
CREATE TRIGGER trg_commercial_profile_tz BEFORE INSERT OR UPDATE OF timezone ON commercial_billing_profiles
  FOR EACH ROW EXECUTE FUNCTION public.commercial_profile_tz_guard();

CREATE TABLE IF NOT EXISTS commercial_fix_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  rejection_code text NOT NULL CHECK (rejection_code IN
    ('missing_po','po_mismatch','amount_exceeds_nte','missing_documents','wrong_billing_entity','late_submission','pricing_dispute','duplicate','other')),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR resolution IN ('resubmitted', 'approved', 'paid', 'disputed', 'written_off', 'void'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_fix_open ON commercial_fix_tasks (invoice_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_commercial_fix_user_status ON commercial_fix_tasks (user_id, status);

-- extend the event-type CHECK (re-read from the live DB, never overwrite blindly)
DO $$
DECLARE v_name text; v_def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.commercial_invoice_events'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ 'event_type = ANY';
  IF v_name IS NULL THEN RAISE EXCEPTION 'commercial_invoice_events event_type CHECK not found'; END IF;
  IF v_def NOT LIKE '%fix_task_opened%' THEN
    EXECUTE format('ALTER TABLE public.commercial_invoice_events DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.commercial_invoice_events ADD CONSTRAINT commercial_invoice_events_event_type_check CHECK (event_type IN (
      'approval_recorded','approval_linked','precheck_passed','precheck_warned','precheck_blocked','override','stage_changed',
      'reminder_sent','reminder_failed','demand_draft_queued','recovery_logged','packet_generated',
      'fix_task_opened','fix_task_resolved','packet_registered','followup_snoozed'));
  END IF;
END $$;

ALTER TABLE commercial_invoice_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'system' CHECK (source IN ('user', 'system', 'portal', 'email_parse'));

-- v1 event writer keeps its signature; it now records WHO acted (a signed-in user vs. cron/system)
CREATE OR REPLACE FUNCTION public.commercial_log_event(
  p_user uuid, p_invoice uuid, p_type text, p_from text, p_to text, p_reason text, p_details jsonb, p_dedupe text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, from_stage, to_stage, reason, details, actor_id, dedupe_key, source)
  VALUES (p_user, p_invoice, p_type, p_from, p_to, p_reason, COALESCE(p_details, '{}'::jsonb), auth.uid(), p_dedupe,
          CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END)
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$;

-- extend the stage CHECK
DO $$
DECLARE v_name text; v_def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.commercial_invoice_tracking'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ 'stage = ANY';
  IF v_name IS NULL THEN RAISE EXCEPTION 'commercial_invoice_tracking stage CHECK not found'; END IF;
  IF v_def NOT LIKE '%written_off%' THEN
    EXECUTE format('ALTER TABLE public.commercial_invoice_tracking DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.commercial_invoice_tracking ADD CONSTRAINT commercial_invoice_tracking_stage_check CHECK (stage IN (
      'draft','ready','blocked_needs_approval','sent','received','approved','rejected','disputed','paid','written_off','void'));
  END IF;
END $$;

-- =============================================================
-- 8. Table-driven state machine (mirrored by src/lib/commercial/a2c/stateMachine.ts; a test diffs the two)
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_stage_transitions (
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  allowed_sources text[] NOT NULL CHECK (allowed_sources <@ ARRAY['user','system','portal','email_parse']::text[] AND cardinality(allowed_sources) >= 1),
  requires_reason boolean NOT NULL DEFAULT false,
  PRIMARY KEY (from_stage, to_stage)
);
INSERT INTO commercial_stage_transitions (from_stage, to_stage, allowed_sources, requires_reason) VALUES
  ('draft','ready','{user,system}',false), ('draft','sent','{user,system}',false), ('draft','paid','{system}',false), ('draft','void','{user,system}',true),
  ('ready','draft','{user,system}',false), ('ready','sent','{user,system}',false), ('ready','void','{user,system}',true),
  ('blocked_needs_approval','draft','{user,system}',false), ('blocked_needs_approval','ready','{user,system}',false), ('blocked_needs_approval','sent','{user,system}',false), ('blocked_needs_approval','void','{user,system}',true),
  ('sent','received','{user,system,portal,email_parse}',false), ('sent','approved','{user,portal,email_parse}',false),
  ('sent','rejected','{user,portal,email_parse}',true), ('sent','disputed','{user,portal,email_parse}',true),
  ('sent','paid','{system}',false), ('sent','written_off','{user}',true), ('sent','void','{user,system}',true),
  ('received','approved','{user,portal,email_parse}',false), ('received','rejected','{user,portal,email_parse}',true),
  ('received','disputed','{user,portal,email_parse}',true), ('received','paid','{system}',false),
  ('received','written_off','{user}',true), ('received','void','{user,system}',true),
  ('approved','rejected','{user,portal,email_parse}',true), ('approved','disputed','{user,portal,email_parse}',true),
  ('approved','paid','{system}',false), ('approved','written_off','{user}',true), ('approved','void','{user,system}',true),
  ('rejected','sent','{user,system}',false), ('rejected','received','{user,portal,email_parse}',false),
  ('rejected','approved','{user,portal,email_parse}',false), ('rejected','disputed','{user,portal,email_parse}',true),
  ('rejected','paid','{system}',false), ('rejected','written_off','{user}',true), ('rejected','void','{user,system}',true),
  ('disputed','approved','{user,portal,email_parse}',false), ('disputed','rejected','{user,portal,email_parse}',true),
  ('disputed','sent','{user,system}',false), ('disputed','paid','{system}',false),
  ('disputed','written_off','{user}',true), ('disputed','void','{user,system}',true),
  ('written_off','paid','{system}',false)
ON CONFLICT (from_stage, to_stage) DO NOTHING;

-- core transition (service role only). Idempotent: same stage -> no-op.
CREATE OR REPLACE FUNCTION public.commercial_apply_stage_v2(
  p_invoice_id uuid, p_to text, p_reason text, p_source text, p_rejection_code text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE trk commercial_invoice_tracking; tr commercial_stage_transitions; v_code text; v_res jsonb;
BEGIN
  SELECT * INTO trk FROM commercial_invoice_tracking WHERE invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not tracked' USING ERRCODE = '22023'; END IF;
  IF trk.stage = p_to THEN RETURN; END IF;
  SELECT * INTO tr FROM commercial_stage_transitions WHERE from_stage = trk.stage AND to_stage = p_to;
  IF NOT FOUND THEN RAISE EXCEPTION 'cannot move an invoice from % to %', trk.stage, p_to USING ERRCODE = '22023'; END IF;
  IF NOT (p_source = ANY (tr.allowed_sources)) THEN
    RAISE EXCEPTION 'source % may not move an invoice from % to %', p_source, trk.stage, p_to USING ERRCODE = '42501';
  END IF;
  IF tr.requires_reason AND (p_reason IS NULL OR char_length(btrim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'this transition needs a reason' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'ready' THEN
    v_res := public.commercial_precheck_core(p_invoice_id);
    IF COALESCE((v_res->>'applies')::boolean, false) AND COALESCE((v_res->>'blocked')::boolean, false) THEN
      RAISE EXCEPTION 'blocked_needs_approval: invoice does not pass the pre-invoice gate' USING ERRCODE = '23514', DETAIL = (v_res->'reasons')::text;
    END IF;
  END IF;
  v_code := CASE WHEN p_to = 'rejected' THEN COALESCE(p_rejection_code, 'other') ELSE NULL END;

  UPDATE commercial_invoice_tracking SET
    stage = p_to, stage_changed_at = now(),
    ready_at       = CASE WHEN p_to = 'ready' THEN now() ELSE ready_at END,
    sent_at        = CASE WHEN p_to = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
    received_at    = CASE WHEN p_to = 'received' THEN now() ELSE received_at END,
    approved_at    = CASE WHEN p_to = 'approved' THEN now() ELSE approved_at END,
    rejected_at    = CASE WHEN p_to = 'rejected' THEN now() ELSE rejected_at END,
    paid_at        = CASE WHEN p_to = 'paid' THEN now() ELSE paid_at END,
    disputed_at    = CASE WHEN p_to = 'disputed' THEN now() ELSE disputed_at END,
    written_off_at = CASE WHEN p_to = 'written_off' THEN now() ELSE written_off_at END,
    rejection_code = CASE WHEN p_to = 'rejected' THEN v_code ELSE rejection_code END,
    rejection_reason = CASE WHEN p_to = 'rejected' THEN btrim(COALESCE(NULLIF(btrim(p_reason), ''), v_code)) ELSE rejection_reason END
  WHERE id = trk.id;

  INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, from_stage, to_stage, reason, details, actor_id, source)
  VALUES (trk.user_id, p_invoice_id, 'stage_changed', trk.stage, p_to, p_reason,
          jsonb_build_object('source', p_source, 'rejection_code', v_code), auth.uid(), p_source);

  -- leaving 'rejected' closes the fix task
  IF trk.stage = 'rejected' THEN
    UPDATE commercial_fix_tasks SET status = 'resolved', resolved_at = now(),
      resolution = CASE WHEN p_to = 'sent' THEN 'resubmitted' ELSE p_to END
    WHERE invoice_id = p_invoice_id AND status = 'open' AND p_to IN ('sent','approved','paid','disputed','written_off','void');
    IF FOUND THEN
      INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, reason, details, actor_id, source, dedupe_key)
      VALUES (trk.user_id, p_invoice_id, 'fix_task_resolved', p_to, '{}'::jsonb, auth.uid(), p_source,
              'fixres:' || p_invoice_id || ':' || trk.stage_changed_at::text)
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    END IF;
  END IF;

  IF p_to = 'rejected' THEN
    INSERT INTO commercial_fix_tasks (user_id, invoice_id, rejection_code, detail)
    VALUES (trk.user_id, p_invoice_id, v_code, left(p_reason, 2000))
    ON CONFLICT (invoice_id) WHERE status = 'open' DO NOTHING;
    INSERT INTO commercial_invoice_events (user_id, invoice_id, event_type, reason, details, actor_id, source, dedupe_key)
    VALUES (trk.user_id, p_invoice_id, 'fix_task_opened', v_code, '{}'::jsonb, auth.uid(), p_source, 'fixopen:' || p_invoice_id || ':' || now()::text)
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    PERFORM public.commercial_sync_recovery_event(p_invoice_id, 'invoice_rejected', 'Rejected by customer (' || v_code || '): ' || btrim(COALESCE(p_reason, '')));
  ELSIF p_to = 'paid' THEN
    UPDATE revenue_recovery_events SET status = 'recovered', recovery_method = 'manual', resolved_at = now(),
      recovered_amount_cents = (SELECT public.invoice_total_cents(i.line_items, i.tax_percent)::integer FROM invoices i WHERE i.id = p_invoice_id)
    WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status IN ('open', 'contacted');
  ELSIF p_to IN ('void', 'written_off') THEN
    UPDATE revenue_recovery_events SET status = 'written_off', resolved_at = now(),
      notes = COALESCE(notes, '') || CASE WHEN p_to = 'void' THEN ' (invoice voided)' ELSE ' (written off)' END
    WHERE source_table = 'invoices' AND source_id = p_invoice_id AND status IN ('open', 'contacted');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_apply_stage_v2(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_apply_stage_v2(uuid, text, text, text, text) TO service_role;

-- v1 signature kept: existing callers (sync trigger, commercial_set_stage, edge functions) now use the table.
CREATE OR REPLACE FUNCTION public.commercial_apply_stage(p_invoice_id uuid, p_to text, p_reason text, p_system boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.commercial_apply_stage_v2(p_invoice_id, p_to, p_reason, CASE WHEN p_system THEN 'system' ELSE 'user' END, NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_apply_stage(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_apply_stage(uuid, text, text, boolean) TO service_role;

-- Human transitions with a rejection code. paid / void stay system-driven (payment / void flows).
CREATE OR REPLACE FUNCTION public.commercial_transition_invoice(p_invoice_id uuid, p_to text, p_reason text DEFAULT NULL, p_rejection_code text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND user_id = public.get_account_owner_id())
     OR NOT public.commercial_can_bill() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_to NOT IN ('ready', 'received', 'approved', 'rejected', 'disputed', 'written_off', 'sent', 'draft') THEN
    RAISE EXCEPTION 'stage % is set by the system (payment / void)', p_to USING ERRCODE = '22023';
  END IF;
  IF p_to = 'rejected' AND (p_rejection_code IS NULL OR p_rejection_code NOT IN
     ('missing_po','po_mismatch','amount_exceeds_nte','missing_documents','wrong_billing_entity','late_submission','pricing_dispute','duplicate','other')) THEN
    RAISE EXCEPTION 'a valid rejection_code is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.commercial_apply_stage_v2(p_invoice_id, p_to, p_reason, 'user', p_rejection_code);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_transition_invoice(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.commercial_snooze_followups(p_invoice_id uuid, p_until timestamptz, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND user_id = v_owner) OR NOT public.commercial_can_bill() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_until IS NOT NULL AND (p_until <= now() OR p_until > now() + interval '90 days') THEN
    RAISE EXCEPTION 'snooze must end between now and 90 days from now' USING ERRCODE = '22023';
  END IF;
  UPDATE commercial_invoice_tracking SET snoozed_until = p_until WHERE invoice_id = p_invoice_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not tracked' USING ERRCODE = '22023'; END IF;
  PERFORM public.commercial_log_event(v_owner, p_invoice_id, 'followup_snoozed', NULL, NULL, p_reason,
    jsonb_build_object('until', p_until), 'snooze:' || p_invoice_id || ':' || COALESCE(p_until::text, 'cleared') || ':' || now()::text);
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_snooze_followups(uuid, timestamptz, text) TO authenticated;

-- =============================================================
-- 9. Evaluator: approval resolver + v2 + dispatcher
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_resolve_approval(p_inv invoices, p_linked uuid)
RETURNS commercial_approvals LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_appr commercial_approvals; v_cust uuid := p_inv.customer_id;
BEGIN
  IF p_linked IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals WHERE id = p_linked AND user_id = p_inv.user_id AND status = 'active';
  END IF;
  IF v_appr.id IS NULL AND p_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals WHERE user_id = p_inv.user_id AND status = 'active' AND job_id = p_inv.job_id
     ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_appr.id IS NULL AND p_inv.quote_id IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals WHERE user_id = p_inv.user_id AND status = 'active' AND quote_id = p_inv.quote_id
     ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_appr.id IS NULL AND v_cust IS NOT NULL THEN
    SELECT * INTO v_appr FROM commercial_approvals WHERE user_id = p_inv.user_id AND status = 'active' AND customer_id = v_cust
       AND job_id IS NULL AND quote_id IS NULL ORDER BY approved_at DESC, created_at DESC LIMIT 1;
  END IF;
  RETURN v_appr;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_resolve_approval(invoices, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_resolve_approval(invoices, uuid) TO service_role;

-- keep the original evaluator under a new name (rename keeps body + grants); idempotent on re-run
DO $$
BEGIN
  IF to_regprocedure('public.commercial_evaluate_v1(invoices)') IS NULL THEN
    ALTER FUNCTION public.commercial_evaluate(invoices) RENAME TO commercial_evaluate_v1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.commercial_evaluate_v2(p_inv invoices)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trk commercial_invoice_tracking; v_rule commercial_billing_rule_versions; v_appr commercial_approvals;
  v_cust uuid; v_total bigint; v_billed bigint := 0;
  v_after boolean := false; v_signed boolean := false; v_completed timestamptz;
  v_docs text[] := '{}'; v_missing text[] := '{}'; a text;
  v_items jsonb := '[]'::jsonb; v_block jsonb := '[]'::jsonb; v_warn jsonb := '[]'::jsonb; e jsonb;
  v_overridden boolean := false; v_blocked boolean; v_co boolean := false; v_all bigint;
BEGIN
  SELECT * INTO v_trk FROM commercial_invoice_tracking WHERE invoice_id = p_inv.id;
  v_cust := COALESCE(p_inv.customer_id, v_trk.customer_id);
  IF v_cust IS NULL THEN RETURN public.commercial_evaluate_v1(p_inv); END IF;
  SELECT * INTO v_rule FROM commercial_billing_rule_versions
   WHERE user_id = p_inv.user_id AND customer_id = v_cust AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
   ORDER BY version DESC LIMIT 1;
  IF v_rule.id IS NULL THEN RETURN public.commercial_evaluate_v1(p_inv); END IF;

  IF v_rule.gate_mode = 'off' THEN
    RETURN jsonb_build_object('applies', true, 'mode', 'off', 'result', 'pass', 'blocked', false, 'overridden', false,
      'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb, 'customer_id', v_cust, 'rule_version', v_rule.version);
  END IF;

  v_total := public.invoice_total_cents(p_inv.line_items, p_inv.tax_percent);
  v_appr := public.commercial_resolve_approval(p_inv, v_trk.approval_id);

  IF v_appr.id IS NOT NULL THEN
    SELECT COALESCE(SUM(public.invoice_total_cents(i.line_items, i.tax_percent)), 0) INTO v_billed
      FROM commercial_invoice_tracking t JOIN invoices i ON i.id = t.invoice_id
     WHERE t.approval_id = v_appr.id AND t.invoice_id <> p_inv.id AND t.stage NOT IN ('void', 'rejected') AND i.status <> 'void';
    SELECT EXISTS (SELECT 1 FROM commercial_change_order_requests WHERE approval_id = v_appr.id AND status = 'requested') INTO v_co;
  END IF;

  IF p_inv.job_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM job_photos jp WHERE jp.job_id = p_inv.job_id AND jp.user_id = p_inv.user_id AND jp.kind = 'after') INTO v_after;
    SELECT j.completed_at, (j.customer_signature_at IS NOT NULL) INTO v_completed, v_signed
      FROM jobs j WHERE j.id = p_inv.job_id AND j.user_id = p_inv.user_id;
    v_signed := COALESCE(v_signed, false);
  END IF;
  SELECT COALESCE(array_agg(DISTINCT d.doc_type), '{}') INTO v_docs
    FROM commercial_invoice_documents d WHERE d.invoice_id = p_inv.id AND d.user_id = p_inv.user_id;

  IF v_rule.requires_po AND (v_appr.id IS NULL OR v_appr.po_number IS NULL) THEN
    v_items := v_items || jsonb_build_object('code', 'missing_po', 'severity', 'block', 'message', 'No PO number is recorded for this invoice.');
  END IF;
  IF v_rule.po_format_regex IS NOT NULL AND v_appr.po_number IS NOT NULL THEN
    BEGIN
      IF v_appr.po_number !~ v_rule.po_format_regex THEN
        v_items := v_items || jsonb_build_object('code', 'po_format_mismatch', 'severity', 'block', 'message', 'The PO number does not match this customer''s required format.');
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL; -- an invalid stored regex is a save-time bug, never an invoicing outage
    END;
  END IF;
  IF v_rule.requires_work_order_number AND (v_appr.id IS NULL OR v_appr.work_order_number IS NULL) THEN
    v_items := v_items || jsonb_build_object('code', 'missing_work_order', 'severity', 'block', 'message', 'No work-order number is recorded for this invoice.');
  END IF;
  IF v_rule.requires_nte_approval AND v_appr.id IS NULL THEN
    v_items := v_items || jsonb_build_object('code', 'missing_nte_approval', 'severity', 'block', 'message', 'No approved amount (NTE) is recorded for this job.');
  END IF;
  IF v_appr.id IS NOT NULL AND v_appr.expires_at IS NOT NULL AND v_appr.expires_at < now() THEN
    v_items := v_items || jsonb_build_object('code', 'approval_expired', 'severity', 'block', 'message', 'The recorded approval has expired.', 'expires_at', v_appr.expires_at);
  END IF;
  IF v_appr.id IS NOT NULL THEN
    v_all := v_total + v_billed;
    IF v_all * 100 > v_appr.approved_amount_cents * v_rule.nte_block_pct THEN
      v_items := v_items || jsonb_build_object('code', 'over_approved_amount', 'severity', 'block',
        'message', 'Invoice total plus previously billed amounts exceeds the approved amount (NTE). A change order is required.',
        'invoice_total_cents', v_total, 'previously_billed_cents', v_billed, 'approved_amount_cents', v_appr.approved_amount_cents,
        'excess_cents', v_all - v_appr.approved_amount_cents, 'change_order_pending', v_co);
    ELSIF v_all * 100 >= v_appr.approved_amount_cents * v_rule.nte_warn_pct THEN
      v_items := v_items || jsonb_build_object('code', 'nte_near_limit', 'severity', 'warn',
        'message', 'Billing is close to the approved amount (NTE).',
        'invoice_total_cents', v_total, 'previously_billed_cents', v_billed, 'approved_amount_cents', v_appr.approved_amount_cents);
    END IF;
  END IF;
  IF v_rule.requires_completion_photos AND NOT v_after THEN
    v_items := v_items || jsonb_build_object('code', 'missing_completion_photos', 'severity', 'block', 'message', 'The job has no completion photo.');
  END IF;
  IF v_rule.requires_signature AND NOT v_signed THEN
    v_items := v_items || jsonb_build_object('code', 'missing_signature', 'severity', 'block', 'message', 'The job has no customer signature.');
  END IF;
  IF v_rule.requires_service_report AND NOT ('service_report' = ANY (v_docs)) THEN
    v_items := v_items || jsonb_build_object('code', 'missing_service_report', 'severity', 'block', 'message', 'No service report is attached to this invoice.');
  END IF;

  FOREACH a IN ARRAY v_rule.required_attachments LOOP
    IF (a = 'po_copy' AND NOT ('po_copy' = ANY (v_docs)))
       OR (a = 'approval_proof' AND NOT ('approval_proof' = ANY (v_docs))
           AND NOT (v_appr.id IS NOT NULL AND (v_appr.evidence_storage_path IS NOT NULL OR v_appr.evidence_ref IS NOT NULL)))
       OR (a = 'other' AND NOT ('other' = ANY (v_docs)))
       OR (a = 'completion_photos' AND NOT v_after AND NOT v_rule.requires_completion_photos)
       OR (a = 'signature' AND NOT v_signed AND NOT v_rule.requires_signature)
       OR (a = 'service_report' AND NOT ('service_report' = ANY (v_docs)) AND NOT v_rule.requires_service_report) THEN
      v_missing := v_missing || a;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    v_items := v_items || jsonb_build_object('code', 'missing_documents', 'severity', 'block',
      'message', 'Required attachments are missing.', 'missing', to_jsonb(v_missing));
  END IF;

  -- late submission can never be fixed by the user, so it only ever warns (blocking would deadlock the invoice)
  IF v_rule.invoice_due_window_days IS NOT NULL AND v_completed IS NOT NULL
     AND now() > v_completed + make_interval(days => v_rule.invoice_due_window_days) THEN
    v_items := v_items || jsonb_build_object('code', 'late_submission', 'severity', 'warn',
      'message', 'This customer''s submission window after completion has passed.', 'window_days', v_rule.invoice_due_window_days);
  END IF;

  IF v_trk.override_at IS NOT NULL AND COALESCE(v_trk.override_total_cents, -1) >= v_total THEN v_overridden := true; END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    IF v_rule.gate_mode = 'block' AND e->>'severity' = 'block' THEN v_block := v_block || e; END IF;
  END LOOP;
  v_blocked := jsonb_array_length(v_block) > 0 AND NOT v_overridden;
  IF v_blocked THEN
    FOR e IN SELECT * FROM jsonb_array_elements(v_items) LOOP
      IF e->>'severity' <> 'block' OR v_rule.gate_mode <> 'block' THEN v_warn := v_warn || e; END IF;
    END LOOP;
  ELSE
    v_warn := v_items;
  END IF;

  RETURN jsonb_build_object(
    'applies', true, 'mode', v_rule.gate_mode, 'blocked', v_blocked, 'overridden', v_overridden,
    'result', CASE WHEN v_blocked THEN 'blocked_needs_approval' WHEN jsonb_array_length(v_warn) > 0 THEN 'warn' ELSE 'pass' END,
    'reasons', CASE WHEN v_blocked THEN v_block ELSE '[]'::jsonb END, 'warnings', v_warn,
    'approval_id', v_appr.id, 'customer_id', v_cust, 'total_cents', v_total, 'billed_other_cents', v_billed,
    'approved_amount_cents', v_appr.approved_amount_cents, 'rule_version', v_rule.version);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_evaluate_v2(invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_evaluate_v2(invoices) TO service_role;

CREATE OR REPLACE FUNCTION public.commercial_evaluate(p_inv invoices)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.commercial_a2c_v2_enabled(p_inv.user_id) THEN RETURN public.commercial_evaluate_v2(p_inv); END IF;
  RETURN public.commercial_evaluate_v1(p_inv);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_evaluate(invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_evaluate(invoices) TO service_role;

-- =============================================================
-- 10. Cron candidates: snooze + quiet-hours inputs (OUT shape changes -> drop + recreate)
-- =============================================================
DROP FUNCTION IF EXISTS public.commercial_collections_candidates(integer);
CREATE FUNCTION public.commercial_collections_candidates(p_limit integer DEFAULT 500)
RETURNS TABLE (
  invoice_id uuid, user_id uuid, customer_id uuid, invoice_number text, customer_name text,
  customer_email text, customer_phone text, due_date date, invoice_sent_at timestamptz,
  stage text, balance_cents bigint, ladder_days integer[], ladder_basis text,
  demand_draft_after_days integer, po_number text, work_order_number text,
  timezone text, quiet_start_min smallint, quiet_end_min smallint, snoozed_until timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.user_id, p.customer_id, i.invoice_number, i.customer_name, i.customer_email, i.customer_phone,
         i.due_date, COALESCE(t.sent_at, i.sent_at), COALESCE(t.stage, 'sent'),
         public.commercial_balance_cents(i.id), p.ladder_days, p.ladder_basis, p.demand_draft_after_days,
         a.po_number, a.work_order_number, p.timezone, p.quiet_start_min, p.quiet_end_min, t.snoozed_until
  FROM invoices i
  JOIN commercial_billing_profiles p ON p.user_id = i.user_id AND p.customer_id = i.customer_id
  LEFT JOIN commercial_invoice_tracking t ON t.invoice_id = i.id
  LEFT JOIN commercial_approvals a ON a.id = t.approval_id
  WHERE p.reminders_enabled
    AND i.status IN ('sent', 'viewed')
    AND COALESCE(t.stage, 'sent') IN ('sent', 'received', 'approved', 'rejected')   -- disputed / written_off / paid / void never chased
    AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())
    AND COALESCE(t.sent_at, i.sent_at) IS NOT NULL
    AND public.commercial_balance_cents(i.id) > 0
  ORDER BY COALESCE(t.sent_at, i.sent_at)
  LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.commercial_collections_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_collections_candidates(integer) TO service_role;

-- =============================================================
-- 11. Metrics (first_pass_acceptance_rate, rejection_reason_counts, days_to_approval, days_to_cash)
--     Cohort = invoices FIRST sent inside [p_from, p_to).
--     first-pass = decided (approved/paid/ever-rejected) and never rejected. rate = first_pass / decided.
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_a2c_metrics(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); r jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.commercial_can_bill() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'invalid reporting window' USING ERRCODE = '22023';
  END IF;
  WITH cohort AS (
    SELECT t.invoice_id, t.sent_at, t.approved_at, t.paid_at, t.stage,
           EXISTS (SELECT 1 FROM commercial_invoice_events e WHERE e.invoice_id = t.invoice_id AND e.event_type = 'stage_changed' AND e.to_stage = 'rejected') AS ever_rejected
      FROM commercial_invoice_tracking t
     WHERE t.user_id = v_owner AND t.sent_at >= p_from AND t.sent_at < p_to
  ), decided AS (
    SELECT * FROM cohort WHERE ever_rejected OR approved_at IS NOT NULL OR paid_at IS NOT NULL
  )
  SELECT jsonb_build_object(
    'sent_count', (SELECT count(*) FROM cohort),
    'decided_count', (SELECT count(*) FROM decided),
    'first_pass_count', (SELECT count(*) FROM decided WHERE NOT ever_rejected),
    'first_pass_acceptance_rate', (SELECT CASE WHEN count(*) = 0 THEN NULL
        ELSE round((count(*) FILTER (WHERE NOT ever_rejected))::numeric / count(*), 4) END FROM decided),
    'rejection_reason_counts', COALESCE((SELECT jsonb_object_agg(code, n) FROM (
        SELECT COALESCE(e.details->>'rejection_code', 'other') AS code, count(*) AS n
          FROM commercial_invoice_events e JOIN cohort c ON c.invoice_id = e.invoice_id
         WHERE e.event_type = 'stage_changed' AND e.to_stage = 'rejected' GROUP BY 1) s), '{}'::jsonb),
    'days_to_approval', (SELECT round(avg(extract(epoch FROM (approved_at - sent_at)) / 86400)::numeric, 2) FROM cohort WHERE approved_at IS NOT NULL),
    'days_to_cash', (SELECT round(avg(extract(epoch FROM (paid_at - sent_at)) / 86400)::numeric, 2) FROM cohort WHERE paid_at IS NOT NULL)
  ) INTO r;
  RETURN r;
END;
$$;
GRANT EXECUTE ON FUNCTION public.commercial_a2c_metrics(timestamptz, timestamptz) TO authenticated;

-- =============================================================
-- 12. RLS (every new table; writes only via the SECURITY DEFINER functions above)
-- =============================================================
ALTER TABLE commercial_billing_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_change_order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_invoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_invoice_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_fix_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_stage_transitions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_billing_rule_versions','commercial_change_order_requests','commercial_invoice_documents',
                           'commercial_invoice_packets','commercial_fix_tasks'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "a2c_%s_select" ON %I', t, t);
    EXECUTE format('CREATE POLICY "a2c_%s_select" ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill())', t, t);
  END LOOP;
END $$;

-- documents may be added directly by a billing user (they are append-only evidence)
DROP POLICY IF EXISTS "a2c_documents_insert" ON commercial_invoice_documents;
CREATE POLICY "a2c_documents_insert" ON commercial_invoice_documents FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.commercial_can_bill());

DROP POLICY IF EXISTS "a2c_transitions_select" ON commercial_stage_transitions;
CREATE POLICY "a2c_transitions_select" ON commercial_stage_transitions FOR SELECT TO authenticated USING (true);

REVOKE ALL ON commercial_billing_rule_versions, commercial_change_order_requests, commercial_invoice_packets,
  commercial_fix_tasks, commercial_stage_transitions, commercial_invoice_documents FROM anon;
REVOKE INSERT, UPDATE, DELETE ON commercial_billing_rule_versions, commercial_change_order_requests, commercial_invoice_packets,
  commercial_fix_tasks, commercial_stage_transitions FROM authenticated;
REVOKE UPDATE, DELETE ON commercial_invoice_documents FROM authenticated;

-- storage: packets are write-once and only to a path that commercial_register_packet() issued
DROP POLICY IF EXISTS "a2c_packets_read" ON storage.objects;
CREATE POLICY "a2c_packets_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'commercial-packets' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.commercial_can_bill());
DROP POLICY IF EXISTS "a2c_packets_insert" ON storage.objects;
CREATE POLICY "a2c_packets_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'commercial-packets' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.commercial_can_bill()
    AND EXISTS (SELECT 1 FROM commercial_invoice_packets p WHERE p.storage_path = name AND p.user_id = public.get_account_owner_id()));

COMMIT;
