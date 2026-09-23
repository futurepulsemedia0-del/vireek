/*
# Disaster Recovery & Data Governance

Adds a full DR + governance layer on top of the existing account model
(profiles / team_members / get_account_owner_id() / log_audit_event()).
Nothing here changes existing tables' behavior — every policy and trigger
is additive, same convention as 20261103000000_enterprise_identity_security.sql.

## New tables
- `data_retention_policies` — per-account, per-dataset retention config
  (retention_days, auto_delete_enabled, legal_hold). Owner-managed.
- `deletion_requests` — GDPR/CCPA erasure workflow with a grace period,
  legal-hold blocking, and a durable audit trail (full account, a single
  customer record, or one dataset).
- `consent_records` — persisted consent ledger (call recording, marketing,
  data processing) per customer/contact, distinct from the in-call verbal
  notice in `_shared/compliance/recordingConsent.ts` (that decides what to
  SAY; this records what was actually granted/revoked and when).
- `pii_field_registry` — read-only reference catalog of which columns
  hold PII, for compliance documentation and the Data Governance UI.
  Seeded here; extend with new INSERTs (not app code) as schema grows.
- `platform_backup_runs` — log of application-level logical backup jobs
  (see supabase/functions/dr-backup-run). Complements Supabase's own
  infra-level PITR/daily backups; does not replace them.
- `platform_restore_drills` — log of periodic restore-verification drills
  (see supabase/functions/dr-restore-drill) proving backups are actually
  restorable, with measured RTO.

Backup/restore tables are platform-wide (service-role written), not
account-scoped — every authenticated user may SELECT them (status only,
no tenant data) so any account owner can see DR health as a trust signal.
There are intentionally no client-facing INSERT/UPDATE/DELETE policies on
them, same reasoning as `audit_log`.
*/

-- =============================================================
-- DATA RETENTION POLICIES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  dataset text NOT NULL,
  retention_days integer CHECK (retention_days IS NULL OR retention_days > 0),
  auto_delete_enabled boolean NOT NULL DEFAULT false,
  anonymize_instead_of_delete boolean NOT NULL DEFAULT true,
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  last_swept_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dataset)
);

CREATE INDEX IF NOT EXISTS data_retention_policies_user_id_idx ON public.data_retention_policies (user_id);
CREATE INDEX IF NOT EXISTS data_retention_policies_sweep_idx
  ON public.data_retention_policies (auto_delete_enabled, legal_hold)
  WHERE auto_delete_enabled = true AND legal_hold = false;

ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_select_retention_policies"
  ON public.data_retention_policies FOR SELECT
  USING (user_id = public.get_account_owner_id());

CREATE POLICY "owner_manage_retention_policies"
  ON public.data_retention_policies FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- HELPER: does this account have an active legal hold?
-- Checked before any hard delete — retention sweep, deletion-request
-- processing, and (patched in) delete-account all defer to this.
-- =============================================================

CREATE OR REPLACE FUNCTION public.has_active_legal_hold(p_user_id uuid, p_dataset text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.data_retention_policies
    WHERE user_id = p_user_id
      AND legal_hold = true
      AND (p_dataset IS NULL OR dataset = p_dataset)
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_active_legal_hold(uuid, text) TO authenticated;

-- =============================================================
-- DELETION REQUESTS (right-to-erasure workflow)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  requested_by uuid,
  request_type text NOT NULL CHECK (request_type IN ('full_account', 'customer_record', 'dataset')),
  target_customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  target_dataset text,
  reason text,
  status text NOT NULL DEFAULT 'grace_period'
    CHECK (status IN ('grace_period', 'processing', 'completed', 'cancelled', 'blocked_legal_hold')),
  grace_period_days integer NOT NULL DEFAULT 14,
  scheduled_for timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deletion_requests_user_id_idx ON public.deletion_requests (user_id);
CREATE INDEX IF NOT EXISTS deletion_requests_due_idx
  ON public.deletion_requests (scheduled_for)
  WHERE status = 'grace_period';

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_select_deletion_requests"
  ON public.deletion_requests FOR SELECT
  USING (user_id = public.get_account_owner_id());

CREATE POLICY "owner_insert_deletion_requests"
  ON public.deletion_requests FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Owners may only cancel a request that hasn't started processing yet —
-- everything else (status transitions to processing/completed/blocked)
-- is written exclusively by the service-role sweep function.
CREATE POLICY "owner_cancel_deletion_requests"
  ON public.deletion_requests FOR UPDATE
  USING (user_id = auth.uid() AND status = 'grace_period')
  WITH CHECK (user_id = auth.uid() AND status = 'cancelled');

-- Auto-block full_account / dataset requests against an active legal hold
-- the moment they're created, instead of silently sitting in grace_period
-- until the sweep runs and only then reveals it can't proceed.
CREATE OR REPLACE FUNCTION public.check_deletion_request_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.has_active_legal_hold(NEW.user_id, NEW.target_dataset) THEN
    NEW.status := 'blocked_legal_hold';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deletion_request_legal_hold ON public.deletion_requests;
CREATE TRIGGER trg_check_deletion_request_legal_hold
  BEFORE INSERT ON public.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.check_deletion_request_legal_hold();

-- =============================================================
-- CONSENT RECORDS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  contact_phone text,
  contact_email text,
  consent_type text NOT NULL
    CHECK (consent_type IN ('call_recording', 'marketing_sms', 'marketing_email', 'data_processing')),
  granted boolean NOT NULL,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('ivr_verbal', 'web_form', 'manual', 'import', 'sms_reply')),
  recorded_by uuid,
  ip_address text,
  notes text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_records_user_id_idx ON public.consent_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consent_records_customer_id_idx ON public.consent_records (customer_id);
-- Fast "what's the current consent state for this contact" lookup —
-- consent is a ledger (every grant/revoke is a new row), so callers take
-- the latest row per (user_id, contact_phone/email, consent_type).
CREATE INDEX IF NOT EXISTS consent_records_contact_lookup_idx
  ON public.consent_records (user_id, consent_type, contact_phone, contact_email, created_at DESC);

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_select_consent_records"
  ON public.consent_records FOR SELECT
  USING (user_id = public.get_account_owner_id());

CREATE POLICY "account_insert_consent_records"
  ON public.consent_records FOR INSERT
  WITH CHECK (user_id = public.get_account_owner_id());

-- Consent is a ledger, not a mutable field: no UPDATE/DELETE policy.
-- To revoke, insert a new row with granted = false.

-- =============================================================
-- PII FIELD REGISTRY (read-only compliance catalog)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.pii_field_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  column_name text NOT NULL,
  classification text NOT NULL
    CHECK (classification IN ('name', 'email', 'phone', 'address', 'financial', 'call_recording', 'transcript', 'device_ip', 'auth_credential')),
  sensitivity text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('standard', 'high', 'critical')),
  masking_strategy text NOT NULL DEFAULT 'redact_on_export'
    CHECK (masking_strategy IN ('redact_on_export', 'hash', 'truncate', 'none_business_required')),
  notes text,
  UNIQUE (table_name, column_name)
);

ALTER TABLE public.pii_field_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_pii_registry"
  ON public.pii_field_registry FOR SELECT
  TO authenticated
  USING (true);

INSERT INTO public.pii_field_registry (table_name, column_name, classification, sensitivity, masking_strategy, notes) VALUES
  ('customers', 'name', 'name', 'standard', 'redact_on_export', 'Full name of a contact'),
  ('customers', 'phone', 'phone', 'high', 'redact_on_export', 'Direct contact number'),
  ('customers', 'email', 'email', 'high', 'redact_on_export', 'Direct contact email'),
  ('customers', 'address', 'address', 'high', 'redact_on_export', 'Service address'),
  ('leads', 'phone', 'phone', 'high', 'redact_on_export', NULL),
  ('leads', 'email', 'email', 'high', 'redact_on_export', NULL),
  ('calls', 'caller_number', 'phone', 'high', 'redact_on_export', NULL),
  ('calls', 'recording_url', 'call_recording', 'critical', 'none_business_required', 'Subject to state consent law — see recordingConsent.ts'),
  ('calls', 'transcript', 'transcript', 'critical', 'redact_on_export', 'May contain caller PII spoken during the call'),
  ('profiles', 'email', 'email', 'high', 'redact_on_export', 'Account owner login email'),
  ('team_members', 'member_email', 'email', 'high', 'redact_on_export', NULL),
  ('business_profile', 'phone', 'phone', 'standard', 'redact_on_export', 'Business (not personal) contact number')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- =============================================================
-- PLATFORM BACKUP RUNS (service-role written, everyone can read status)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.platform_backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  backup_type text NOT NULL DEFAULT 'logical_snapshot' CHECK (backup_type IN ('logical_snapshot', 'incremental')),
  storage_path text,
  size_bytes bigint,
  checksum_sha256 text,
  table_row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS platform_backup_runs_started_at_idx ON public.platform_backup_runs (started_at DESC);

ALTER TABLE public.platform_backup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_backup_runs"
  ON public.platform_backup_runs FOR SELECT
  TO authenticated
  USING (true);

-- =============================================================
-- PLATFORM RESTORE DRILLS (DR testing log)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.platform_restore_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_run_id uuid REFERENCES public.platform_backup_runs(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  rto_seconds numeric,
  row_count_mismatches jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text
);

CREATE INDEX IF NOT EXISTS platform_restore_drills_started_at_idx ON public.platform_restore_drills (started_at DESC);

ALTER TABLE public.platform_restore_drills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_restore_drills"
  ON public.platform_restore_drills FOR SELECT
  TO authenticated
  USING (true);

-- =============================================================
-- AUDIT: log every governance action through the existing
-- log_audit_event() helper so nothing here creates a second,
-- inconsistent trail.
-- =============================================================

COMMENT ON TABLE public.data_retention_policies IS
  'Governance: writes here should also call public.log_audit_event(user_id, ''updated_retention_policy'', ''data_retention_policies'', id::text) from the client.';
COMMENT ON TABLE public.deletion_requests IS
  'Governance: writes here should also call public.log_audit_event(user_id, ''requested_deletion'', ''deletion_requests'', id::text) from the client.';
