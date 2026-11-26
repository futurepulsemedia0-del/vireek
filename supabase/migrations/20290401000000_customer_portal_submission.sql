/*
  # Customer Portal Submission (Task B)

  Channel ladder: email-in -> assisted -> API/EDI adapter -> browser automation (disabled by default).
  Everything is default-OFF (feature flags + kill switches). Writes go through SECURITY DEFINER functions; clients get SELECT only.

  Tenancy follows the uploaded repo: user_id uuid = public.get_account_owner_id(); gate = public.commercial_can_bill().
  NOT live-verified: run supabase/ops/portal-preflight.sql first (the DO block below also aborts with a clear message if a dependency is missing).
  Rollback: supabase/rollbacks/20290401000000_customer_portal_submission.rollback.sql
*/
BEGIN;

-- 0. Dependency guard (fail early, nothing half-created) -------------------------------------------------------------
DO $$
DECLARE m text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.invoices') IS NULL THEN m := m || 'table invoices'; END IF;
  IF to_regclass('public.customers') IS NULL THEN m := m || 'table customers'; END IF;
  IF to_regclass('public.tasks') IS NULL THEN m := m || 'table tasks'; END IF;
  IF to_regclass('public.profiles') IS NULL THEN m := m || 'table profiles'; END IF;
  IF to_regclass('public.commercial_invoice_tracking') IS NULL THEN m := m || 'table commercial_invoice_tracking'; END IF;
  IF to_regprocedure('public.get_account_owner_id()') IS NULL THEN m := m || 'function get_account_owner_id()'; END IF;
  IF to_regprocedure('public.commercial_can_bill()') IS NULL THEN m := m || 'function commercial_can_bill()'; END IF;
  IF to_regprocedure('public.commercial_apply_stage(uuid,text,text,boolean)') IS NULL THEN m := m || 'function commercial_apply_stage(uuid,text,text,boolean)'; END IF;
  IF to_regprocedure('public.log_audit_event(uuid,text,text,text)') IS NULL THEN m := m || 'function log_audit_event(uuid,text,text,text)'; END IF;
  IF array_length(m, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'portal migration prerequisites missing: %', array_to_string(m, ', ') USING ERRCODE = '55000';
  END IF;
END $$;

-- 1. Helpers --------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

-- Direct UPDATE/DELETE is refused. A DELETE fired by a foreign-key CASCADE (pg_trigger_depth() > 1: invoice/customer/account
-- deletion, GDPR erasure) is allowed so existing delete behaviour of invoices/customers/auth.users is preserved.
CREATE OR REPLACE FUNCTION public.portal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END; $$;

-- caller may act for p_user: service role (no JWT) or the account's billing-permitted member
CREATE OR REPLACE FUNCTION public.portal_may_act(p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NULL OR (p_user = public.get_account_owner_id() AND public.commercial_can_bill());
$$;
GRANT EXECUTE ON FUNCTION public.portal_may_act(uuid) TO authenticated;

-- 2. Flags + kill switches (ALL default OFF) --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_global_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  automation_enabled boolean NOT NULL DEFAULT false,
  global_kill boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO portal_global_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS portal_account_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  submission_enabled boolean NOT NULL DEFAULT false,
  email_channel_enabled boolean NOT NULL DEFAULT false,
  assisted_channel_enabled boolean NOT NULL DEFAULT false,
  api_channel_enabled boolean NOT NULL DEFAULT false,
  automation_channel_enabled boolean NOT NULL DEFAULT false,
  automation_kill boolean NOT NULL DEFAULT false,
  require_approval boolean NOT NULL DEFAULT true,
  approval_waiver_consent_id uuid,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_waiver_needs_consent CHECK (require_approval OR approval_waiver_consent_id IS NOT NULL)
);

-- 3. Profiles (data, versioned) --------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_portal_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  portal_type text NOT NULL DEFAULT 'generic' CHECK (portal_type IN
    ('generic','yardi_vendorcafe','coupa','ariba','appfolio','buildium','procore','email_ap','edi_cxml','other')),
  portal_url text CHECK (portal_url IS NULL OR (portal_url ~* '^https://[^\s/@]+(/[^\s]*)?$' AND char_length(portal_url) <= 500)),
  ap_email text CHECK (ap_email IS NULL OR (char_length(ap_email) <= 254 AND ap_email ~* '^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$')),
  contact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(contact) = 'object' AND pg_column_size(contact) < 4096),
  channel_preference text NOT NULL DEFAULT 'assisted' CHECK (channel_preference IN ('email','assisted','api','automation')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  automation_kill boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id, name)
);
CREATE INDEX IF NOT EXISTS idx_portal_profiles_user ON customer_portal_profiles(user_id, status);
CREATE INDEX IF NOT EXISTS idx_portal_profiles_customer ON customer_portal_profiles(customer_id);
DROP TRIGGER IF EXISTS trg_portal_profiles_touch ON customer_portal_profiles;
CREATE TRIGGER trg_portal_profiles_touch BEFORE UPDATE ON customer_portal_profiles FOR EACH ROW EXECUTE FUNCTION public.portal_touch_updated_at();

CREATE TABLE IF NOT EXISTS portal_profile_versions (
  profile_id uuid NOT NULL REFERENCES customer_portal_profiles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  user_id uuid NOT NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) < 32768),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, version)
);
DROP TRIGGER IF EXISTS trg_portal_versions_ro ON portal_profile_versions;
CREATE TRIGGER trg_portal_versions_ro BEFORE UPDATE ON portal_profile_versions FOR EACH ROW EXECUTE FUNCTION public.portal_append_only();

-- 4. Consent (append-only except revoked_at) --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid REFERENCES customer_portal_profiles(id) ON DELETE CASCADE,
  consent_type text NOT NULL CHECK (consent_type IN ('automation','approval_waiver')),
  text_version text NOT NULL CHECK (char_length(text_version) BETWEEN 1 AND 40),
  accepted_by uuid NOT NULL DEFAULT auth.uid(),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid
);
CREATE INDEX IF NOT EXISTS idx_portal_consents_active ON portal_consents(user_id, profile_id, consent_type) WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION public.portal_consents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;   -- cascade from profile / account deletion
    RAISE EXCEPTION 'consent records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.profile_id, NEW.consent_type, NEW.text_version, NEW.accepted_by, NEW.accepted_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.profile_id, OLD.consent_type, OLD.text_version, OLD.accepted_by, OLD.accepted_at)
     OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'consent records are immutable (revoke only)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_portal_consents_guard ON portal_consents;
CREATE TRIGGER trg_portal_consents_guard BEFORE UPDATE OR DELETE ON portal_consents FOR EACH ROW EXECUTE FUNCTION public.portal_consents_guard();

-- 5. Credential vault (service role ONLY; ciphertext only) ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_credentials (
  profile_id uuid PRIMARY KEY REFERENCES customer_portal_profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ciphertext text NOT NULL CHECK (ciphertext LIKE 'v2.%'),
  field_names text[] NOT NULL DEFAULT '{}',
  key_version smallint NOT NULL DEFAULT 1,
  rotated_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_portal_credentials_touch ON portal_credentials;
CREATE TRIGGER trg_portal_credentials_touch BEFORE UPDATE ON portal_credentials FOR EACH ROW EXECUTE FUNCTION public.portal_touch_updated_at();

-- metadata-only view for the UI (no ciphertext column exists in it)
CREATE OR REPLACE FUNCTION public.portal_credential_meta(p_profile_id uuid)
RETURNS TABLE (has_secret boolean, fields text[], updated_at timestamptz, rotated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true, c.field_names, c.updated_at, c.rotated_at FROM portal_credentials c
  WHERE c.profile_id = p_profile_id AND c.user_id = public.get_account_owner_id() AND public.commercial_can_bill()
  UNION ALL SELECT false, '{}'::text[], NULL::timestamptz, NULL::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM portal_credentials c WHERE c.profile_id = p_profile_id AND c.user_id = public.get_account_owner_id())
$$;
GRANT EXECUTE ON FUNCTION public.portal_credential_meta(uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS portal_credential_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('write','rotate','read_for_run','wipe','read_denied')),
  purpose text CHECK (purpose IS NULL OR char_length(purpose) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_cred_log ON portal_credential_access_log(user_id, profile_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_portal_cred_log_ro ON portal_credential_access_log;
CREATE TRIGGER trg_portal_cred_log_ro BEFORE UPDATE OR DELETE ON portal_credential_access_log FOR EACH ROW EXECUTE FUNCTION public.portal_append_only();

-- 6. Submissions + events ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES customer_portal_profiles(id) ON DELETE CASCADE,
  profile_version integer NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','assisted','api','automation')),
  packet_version integer NOT NULL CHECK (packet_version >= 1),
  packet_hash text NOT NULL CHECK (packet_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','prepared','awaiting_human','submitting','submitted','acknowledged',
    'approved','rejected','scheduled_for_payment','paid','failed','cancelled')),
  external_ref text CHECK (external_ref IS NULL OR char_length(external_ref) <= 200),
  rejection_reason text CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 2000),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) <= 80),
  pause_reason text CHECK (pause_reason IS NULL OR char_length(pause_reason) <= 80),
  approved_by uuid,
  approved_at timestamptz,
  submitted_at timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  next_poll_at timestamptz,
  last_polled_at timestamptz,
  poll_attempts integer NOT NULL DEFAULT 0,
  consecutive_poll_errors integer NOT NULL DEFAULT 0,
  supersedes_id uuid REFERENCES portal_submissions(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_rejected_has_reason CHECK (state <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''))
);
-- HARD duplicate prevention #1: one row per (invoice, packet version, channel)
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_sub_natural ON portal_submissions(user_id, invoice_id, packet_version, channel);
-- HARD duplicate prevention #2: only ONE live submission per (invoice, portal profile), across channels
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_sub_active ON portal_submissions(user_id, invoice_id, profile_id) WHERE state NOT IN ('rejected','failed','cancelled');
-- idempotent retries of the same request
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_sub_idem ON portal_submissions(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_portal_sub_poll ON portal_submissions(next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_sub_user_state ON portal_submissions(user_id, state, state_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_sub_profile ON portal_submissions(profile_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_portal_sub_touch ON portal_submissions;
CREATE TRIGGER trg_portal_sub_touch BEFORE UPDATE ON portal_submissions FOR EACH ROW EXECUTE FUNCTION public.portal_touch_updated_at();

CREATE TABLE IF NOT EXISTS portal_submission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES portal_submissions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 60),
  from_state text,
  to_state text,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','system','worker','portal')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) < 8192),
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_events_sub ON portal_submission_events(submission_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_events_dedupe ON portal_submission_events(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
DROP TRIGGER IF EXISTS trg_portal_events_ro ON portal_submission_events;
CREATE TRIGGER trg_portal_events_ro BEFORE UPDATE OR DELETE ON portal_submission_events FOR EACH ROW EXECUTE FUNCTION public.portal_append_only();

CREATE TABLE IF NOT EXISTS portal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES portal_submissions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('screenshot','confirmation_upload','email_receipt','packet')),
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 500 AND storage_path NOT LIKE '%..%'),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  redacted boolean NOT NULL DEFAULT false,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_evidence_sub ON portal_evidence(submission_id);

CREATE TABLE IF NOT EXISTS portal_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES portal_submissions(id) ON DELETE CASCADE,
  provider_message_id text,
  to_address text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced','complained','failed')),
  bounce_type text,
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_email_msg ON portal_email_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_email_sub ON portal_email_deliveries(submission_id);
DROP TRIGGER IF EXISTS trg_portal_email_touch ON portal_email_deliveries;
CREATE TRIGGER trg_portal_email_touch BEFORE UPDATE ON portal_email_deliveries FOR EACH ROW EXECUTE FUNCTION public.portal_touch_updated_at();

-- 7. Worker runs ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_worker_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  submission_id uuid REFERENCES portal_submissions(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES customer_portal_profiles(id) ON DELETE CASCADE,
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run','live')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused_human','succeeded','dry_run_complete','failed','drift','halted')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  failed_step integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_portal_runs_profile ON portal_worker_runs(profile_id, started_at DESC);

-- 8. Remittances ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid REFERENCES customer_portal_profiles(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('upload','email')),
  storage_path text CHECK (storage_path IS NULL OR (char_length(storage_path) <= 500 AND storage_path NOT LIKE '%..%')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  parse_method text NOT NULL CHECK (parse_method IN ('rule','ai_assisted')),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','confirmed','dismissed')),
  payment_ref text CHECK (payment_ref IS NULL OR char_length(payment_ref) <= 80),
  paid_on date,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- the same document can never be ingested twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_remit_hash ON portal_remittances(user_id, content_hash);
CREATE TABLE IF NOT EXISTS portal_remittance_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  remittance_id uuid NOT NULL REFERENCES portal_remittances(id) ON DELETE CASCADE,
  invoice_number text NOT NULL CHECK (char_length(invoice_number) <= 60),
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  amount_cents bigint NOT NULL,
  match_status text NOT NULL CHECK (match_status IN ('matched','amount_mismatch','unmatched','duplicate')),
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending','applied','dismissed')),
  resolved_by uuid,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_portal_remit_lines ON portal_remittance_lines(remittance_id);

-- 9. RLS: SELECT for billing-permitted members of the account; NO direct client writes ---------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_account_settings','customer_portal_profiles','portal_profile_versions','portal_consents','portal_credential_access_log',
    'portal_submissions','portal_submission_events','portal_evidence','portal_email_deliveries','portal_worker_runs','portal_remittances','portal_remittance_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'portal_select_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.commercial_can_bill())', 'portal_select_' || t, t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
  END LOOP;
  -- service-role-only tables: RLS on, no policies, no grants
  FOREACH t IN ARRAY ARRAY['portal_credentials','portal_global_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;
-- profile versions inherit their owner via user_id column populated by portal_save_profile()

-- 10. Private evidence bucket (no storage policies => service role / signed URLs only) --------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public) VALUES ('portal-evidence', 'portal-evidence', false) ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 11. RPCs --------------------------------------------------------------------------------------------------------------
-- 11a. account settings (OWNER only; flags default OFF; waiver of approval needs a recorded consent)
CREATE OR REPLACE FUNCTION public.portal_set_account_settings(
  p_submission_enabled boolean, p_email boolean, p_assisted boolean, p_api boolean, p_automation boolean,
  p_automation_kill boolean, p_require_approval boolean DEFAULT true)
RETURNS portal_account_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_waiver uuid; r portal_account_settings;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN RAISE EXCEPTION 'only the account owner can change portal settings' USING ERRCODE = '42501'; END IF;
  IF NOT p_require_approval THEN
    SELECT id INTO v_waiver FROM portal_consents WHERE user_id = v_owner AND consent_type = 'approval_waiver' AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT 1;
    IF v_waiver IS NULL THEN RAISE EXCEPTION 'approval waiver consent required' USING ERRCODE = '22023'; END IF;
  END IF;
  INSERT INTO portal_account_settings AS s (user_id, submission_enabled, email_channel_enabled, assisted_channel_enabled, api_channel_enabled,
      automation_channel_enabled, automation_kill, require_approval, approval_waiver_consent_id, updated_by)
  VALUES (v_owner, p_submission_enabled, p_email, p_assisted, p_api, p_automation, p_automation_kill, p_require_approval, v_waiver, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET submission_enabled = EXCLUDED.submission_enabled, email_channel_enabled = EXCLUDED.email_channel_enabled,
      assisted_channel_enabled = EXCLUDED.assisted_channel_enabled, api_channel_enabled = EXCLUDED.api_channel_enabled,
      automation_channel_enabled = EXCLUDED.automation_channel_enabled, automation_kill = EXCLUDED.automation_kill,
      require_approval = EXCLUDED.require_approval, approval_waiver_consent_id = EXCLUDED.approval_waiver_consent_id,
      updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING * INTO r;
  PERFORM public.log_audit_event(v_owner, 'portal.settings.changed', 'portal_account_settings', v_owner::text);
  RETURN r;
END; $$;

-- 11b. consent (owner only)
CREATE OR REPLACE FUNCTION public.portal_record_consent(p_profile_id uuid, p_type text, p_text_version text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN RAISE EXCEPTION 'only the account owner can record consent' USING ERRCODE = '42501'; END IF;
  IF p_type NOT IN ('automation','approval_waiver') THEN RAISE EXCEPTION 'invalid consent type' USING ERRCODE = '22023'; END IF;
  IF p_type = 'automation' AND NOT EXISTS (SELECT 1 FROM customer_portal_profiles WHERE id = p_profile_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'profile not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO portal_consents (user_id, profile_id, consent_type, text_version, accepted_by)
  VALUES (v_owner, CASE WHEN p_type = 'automation' THEN p_profile_id END, p_type, p_text_version, auth.uid()) RETURNING id INTO v_id;
  PERFORM public.log_audit_event(v_owner, 'portal.consent.recorded:' || p_type, 'portal_consents', v_id::text);
  RETURN v_id;
END; $$;

-- 11c. disconnect = revoke consents + kill automation + wipe credentials (owner only)
CREATE OR REPLACE FUNCTION public.portal_disconnect_profile(p_profile_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN RAISE EXCEPTION 'only the account owner can disconnect a portal' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_portal_profiles WHERE id = p_profile_id AND user_id = v_owner) THEN RAISE EXCEPTION 'profile not found' USING ERRCODE = '42501'; END IF;
  UPDATE portal_consents SET revoked_at = now(), revoked_by = auth.uid() WHERE profile_id = p_profile_id AND user_id = v_owner AND revoked_at IS NULL;
  UPDATE customer_portal_profiles SET automation_kill = true, channel_preference = CASE WHEN channel_preference = 'automation' THEN 'assisted' ELSE channel_preference END WHERE id = p_profile_id;
  IF EXISTS (SELECT 1 FROM portal_credentials WHERE profile_id = p_profile_id) THEN
    DELETE FROM portal_credentials WHERE profile_id = p_profile_id;
    INSERT INTO portal_credential_access_log (user_id, profile_id, actor_id, action, purpose) VALUES (v_owner, p_profile_id, auth.uid(), 'wipe', 'disconnect');
  END IF;
  PERFORM public.log_audit_event(v_owner, 'portal.profile.disconnected', 'customer_portal_profiles', p_profile_id::text);
END; $$;

-- 11d. save profile (creates a new immutable version on every change)
CREATE OR REPLACE FUNCTION public.portal_save_profile(
  p_profile_id uuid, p_customer_id uuid, p_name text, p_portal_type text, p_portal_url text, p_ap_email text,
  p_contact jsonb, p_channel_preference text, p_config jsonb)
RETURNS customer_portal_profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); r customer_portal_profiles;
BEGIN
  IF NOT public.portal_may_act(v_owner) OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR jsonb_typeof(p_config->'required_fields') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_config->'checklist') IS DISTINCT FROM 'array' OR jsonb_typeof(p_config->'status_map') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'config must contain required_fields[], checklist[], status_map{}' USING ERRCODE = '22023';
  END IF;
  IF p_channel_preference = 'automation' THEN RAISE EXCEPTION 'automation cannot be chosen here; it requires a consent record' USING ERRCODE = '22023'; END IF;
  IF p_profile_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner) THEN RAISE EXCEPTION 'customer not found' USING ERRCODE = '42501'; END IF;
    INSERT INTO customer_portal_profiles (user_id, customer_id, name, portal_type, portal_url, ap_email, contact, channel_preference)
    VALUES (v_owner, p_customer_id, p_name, p_portal_type, p_portal_url, p_ap_email, COALESCE(p_contact, '{}'::jsonb), p_channel_preference) RETURNING * INTO r;
  ELSE
    UPDATE customer_portal_profiles SET name = p_name, portal_type = p_portal_type, portal_url = p_portal_url, ap_email = p_ap_email,
      contact = COALESCE(p_contact, '{}'::jsonb), channel_preference = p_channel_preference, current_version = current_version + 1
    WHERE id = p_profile_id AND user_id = v_owner RETURNING * INTO r;
    IF NOT FOUND THEN RAISE EXCEPTION 'profile not found' USING ERRCODE = '42501'; END IF;
  END IF;
  INSERT INTO portal_profile_versions (profile_id, version, user_id, config) VALUES (r.id, r.current_version, v_owner, p_config);
  PERFORM public.log_audit_event(v_owner, 'portal.profile.saved:v' || r.current_version, 'customer_portal_profiles', r.id::text);
  RETURN r;
END; $$;

-- 11e. fix-and-resubmit task (closes the Task A gap: the rejection reason text becomes the task description)
CREATE OR REPLACE FUNCTION public.portal_create_fix_task(p_submission_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s portal_submissions; v_num text; v_pname text; v_cust uuid; v_job uuid; v_id uuid; v_marker text;
BEGIN
  SELECT * INTO s FROM portal_submissions WHERE id = p_submission_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_marker := '[portal:' || s.id || ']';
  SELECT i.invoice_number, i.job_id INTO v_num, v_job FROM invoices i WHERE i.id = s.invoice_id;
  SELECT p.name, p.customer_id INTO v_pname, v_cust FROM customer_portal_profiles p WHERE p.id = s.profile_id;
  SELECT id INTO v_id FROM tasks WHERE user_id = s.user_id AND description LIKE '%' || v_marker || '%' LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;     -- idempotent: one task per rejected submission
  INSERT INTO tasks (user_id, title, description, priority, customer_id, job_id, due_at)
  VALUES (s.user_id, left('Fix and resubmit invoice ' || COALESCE(v_num, '') || ' (' || COALESCE(v_pname, 'portal') || ')', 200),
          left('Portal rejection reason: ' || COALESCE(s.rejection_reason, '') || E'\n' || v_marker, 4000), 'high', v_cust, v_job, now() + interval '2 days')
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.portal_create_fix_task(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_create_fix_task(uuid) TO service_role;

-- 11f. the ONE state-transition function (matrix mirrored in stateMachine.ts; a test fails on drift)
CREATE OR REPLACE FUNCTION public.portal_apply_transition(
  p_submission_id uuid, p_to text, p_actor_kind text DEFAULT 'user', p_details jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL)
RETURNS portal_submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s portal_submissions; v_from text; v_ok boolean; v_kind text; v_ref text; v_reason text; v_g portal_global_settings; v_a portal_account_settings; v_det jsonb;
BEGIN
  SELECT * INTO s FROM portal_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.portal_may_act(s.user_id) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  v_kind := CASE WHEN auth.uid() IS NOT NULL THEN 'user' ELSE p_actor_kind END;
  IF v_kind NOT IN ('user','system','worker','portal') THEN RAISE EXCEPTION 'invalid actor kind' USING ERRCODE = '22023'; END IF;
  v_det := COALESCE(p_details, '{}'::jsonb);

  IF p_dedupe_key IS NOT NULL AND EXISTS (SELECT 1 FROM portal_submission_events WHERE user_id = s.user_id AND dedupe_key = p_dedupe_key) THEN RETURN s; END IF;
  IF s.state = p_to THEN RETURN s; END IF;           -- idempotent replay
  v_from := s.state;

  v_ok := CASE s.state
    WHEN 'queued'                THEN p_to IN ('prepared','cancelled','failed')
    WHEN 'prepared'              THEN p_to IN ('awaiting_human','submitting','cancelled','failed')
    WHEN 'awaiting_human'        THEN p_to IN ('submitting','submitted','cancelled','failed')
    WHEN 'submitting'            THEN p_to IN ('submitted','awaiting_human','failed')
    WHEN 'submitted'             THEN p_to IN ('acknowledged','approved','rejected','scheduled_for_payment','paid','failed')
    WHEN 'acknowledged'          THEN p_to IN ('approved','rejected','scheduled_for_payment','paid')
    WHEN 'approved'              THEN p_to IN ('scheduled_for_payment','paid')
    WHEN 'scheduled_for_payment' THEN p_to IN ('paid')
    WHEN 'failed'                THEN p_to IN ('queued')
    ELSE false END;
  IF NOT v_ok THEN RAISE EXCEPTION 'illegal transition % -> %', s.state, p_to USING ERRCODE = '22023'; END IF;

  v_ref := NULLIF(btrim(v_det->>'reference'), '');
  v_reason := NULLIF(btrim(v_det->>'reason'), '');

  -- human gates
  IF s.state = 'awaiting_human' AND p_to = 'submitting' AND v_kind <> 'user' THEN RAISE EXCEPTION 'approval must come from a person' USING ERRCODE = '42501'; END IF;
  IF s.state = 'awaiting_human' AND p_to = 'submitted' AND (v_kind <> 'user' OR (v_ref IS NULL AND NULLIF(v_det->>'evidence_id', '') IS NULL)) THEN
    RAISE EXCEPTION 'assisted confirmation needs a person and a reference or evidence' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'submitted' AND s.state = 'submitting' AND v_ref IS NULL THEN RAISE EXCEPTION 'a submission reference is required' USING ERRCODE = '22023'; END IF;
  IF p_to = 'rejected' AND (v_reason IS NULL OR char_length(v_reason) < 3) THEN RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = '22023'; END IF;
  IF s.state = 'failed' AND p_to = 'queued' AND v_kind <> 'user' THEN RAISE EXCEPTION 'retry after failure is a human decision' USING ERRCODE = '42501'; END IF;

  -- flags + kill switches re-checked at the moment any external side effect starts
  IF p_to = 'submitting' THEN
    SELECT * INTO v_g FROM portal_global_settings WHERE id;
    SELECT * INTO v_a FROM portal_account_settings WHERE user_id = s.user_id;
    IF v_g.global_kill OR v_a.user_id IS NULL OR NOT v_a.submission_enabled THEN RAISE EXCEPTION 'portal submission is disabled' USING ERRCODE = '55000'; END IF;
    IF s.channel = 'automation' AND (NOT v_g.automation_enabled OR NOT v_a.automation_channel_enabled OR v_a.automation_kill
       OR EXISTS (SELECT 1 FROM customer_portal_profiles p WHERE p.id = s.profile_id AND p.automation_kill)
       OR NOT EXISTS (SELECT 1 FROM portal_consents c WHERE c.profile_id = s.profile_id AND c.consent_type = 'automation' AND c.revoked_at IS NULL)) THEN
      RAISE EXCEPTION 'automation is disabled for this portal' USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE portal_submissions SET
    state = p_to, state_changed_at = now(),
    external_ref = COALESCE(v_ref, external_ref),
    rejection_reason = CASE WHEN p_to = 'rejected' THEN left(v_reason, 2000) ELSE rejection_reason END,
    failure_code = CASE WHEN p_to = 'failed' THEN left(COALESCE(v_det->>'code', 'unknown'), 80) ELSE failure_code END,
    pause_reason = CASE WHEN p_to = 'awaiting_human' THEN left(v_det->>'pause_reason', 80) ELSE NULL END,
    -- an approval is single-use: it is cleared whenever the run pauses again, so a stale approval can never authorise a later submit
    approved_by = CASE WHEN s.state = 'awaiting_human' AND p_to = 'submitting' THEN auth.uid() WHEN p_to = 'awaiting_human' THEN NULL ELSE approved_by END,
    approved_at = CASE WHEN s.state = 'awaiting_human' AND p_to = 'submitting' THEN now() WHEN p_to = 'awaiting_human' THEN NULL ELSE approved_at END,
    submitted_at = CASE WHEN p_to = 'submitted' THEN now() ELSE submitted_at END,
    next_poll_at = CASE WHEN p_to IN ('submitted','acknowledged','approved','scheduled_for_payment') AND channel IN ('api','automation') THEN now() + interval '1 hour' ELSE NULL END,
    consecutive_poll_errors = CASE WHEN p_to IN ('submitted','acknowledged','approved','scheduled_for_payment') THEN 0 ELSE consecutive_poll_errors END
  WHERE id = s.id RETURNING * INTO s;

  INSERT INTO portal_submission_events (user_id, submission_id, event_type, from_state, to_state, actor_id, actor_kind, details, dedupe_key)
  VALUES (s.user_id, s.id, 'state_changed', v_from, p_to, auth.uid(), v_kind,
          (v_det - 'password' - 'secret' - 'token' - 'api_key'), p_dedupe_key);
  PERFORM public.log_audit_event(s.user_id, 'portal.submission.' || p_to, 'portal_submissions', s.id::text);

  -- downstream effects: never allowed to roll back the recorded state
  IF p_to = 'rejected' THEN
    BEGIN PERFORM public.portal_create_fix_task(s.id);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO portal_submission_events (user_id, submission_id, event_type, actor_kind, details) VALUES (s.user_id, s.id, 'fix_task_failed', 'system', jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END IF;
  IF p_to IN ('submitted','acknowledged','approved','rejected') THEN
    BEGIN
      PERFORM public.commercial_apply_stage(s.invoice_id, CASE p_to WHEN 'submitted' THEN 'sent' WHEN 'acknowledged' THEN 'received' ELSE p_to END, s.rejection_reason, true);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO portal_submission_events (user_id, submission_id, event_type, actor_kind, details) VALUES (s.user_id, s.id, 'commercial_sync_skipped', 'system', jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END IF;
  RETURN s;
END; $$;
GRANT EXECUTE ON FUNCTION public.portal_apply_transition(uuid, text, text, jsonb, text) TO authenticated, service_role;

-- 11g. enqueue: pre-check + lock + hard constraints = no duplicate submissions
CREATE OR REPLACE FUNCTION public.portal_enqueue_submission(
  p_invoice_id uuid, p_profile_id uuid, p_channel text, p_packet_hash text, p_idempotency_key text)
RETURNS TABLE (o_submission_id uuid, o_duplicate boolean, o_state text, o_packet_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; p customer_portal_profiles; v_a portal_account_settings; v_g portal_global_settings; ex portal_submissions; v_ver integer; v_new uuid; v_enabled boolean;
BEGIN
  SELECT i.user_id INTO v_owner FROM invoices i WHERE i.id = p_invoice_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'invoice not found' USING ERRCODE = '42501'; END IF;
  IF NOT public.portal_may_act(v_owner) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF auth.uid() IS NOT NULL AND v_owner <> public.get_account_owner_id() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM customer_portal_profiles WHERE id = p_profile_id AND user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'portal profile not found' USING ERRCODE = '42501'; END IF;
  IF p_channel NOT IN ('email','assisted','api','automation') THEN RAISE EXCEPTION 'invalid channel' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_g FROM portal_global_settings WHERE id;
  SELECT * INTO v_a FROM portal_account_settings WHERE user_id = v_owner;
  v_enabled := v_a.user_id IS NOT NULL AND v_a.submission_enabled AND NOT v_g.global_kill AND CASE p_channel
    WHEN 'email' THEN v_a.email_channel_enabled WHEN 'assisted' THEN v_a.assisted_channel_enabled
    WHEN 'api' THEN v_a.api_channel_enabled ELSE v_a.automation_channel_enabled AND v_g.automation_enabled END;
  IF NOT v_enabled THEN RAISE EXCEPTION 'portal submission channel is disabled' USING ERRCODE = '55000'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('portal:' || v_owner || ':' || p_invoice_id, 0));
  SELECT * INTO ex FROM portal_submissions WHERE user_id = v_owner AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN QUERY SELECT ex.id, true, ex.state, ex.packet_version; RETURN; END IF;
  SELECT * INTO ex FROM portal_submissions WHERE user_id = v_owner AND invoice_id = p_invoice_id AND profile_id = p_profile_id AND state NOT IN ('rejected','failed','cancelled');
  IF FOUND THEN RETURN QUERY SELECT ex.id, true, ex.state, ex.packet_version; RETURN; END IF;

  SELECT COALESCE(MAX(ps.packet_version), 0) + 1 INTO v_ver FROM portal_submissions ps WHERE ps.user_id = v_owner AND ps.invoice_id = p_invoice_id;
  INSERT INTO portal_submissions (user_id, invoice_id, profile_id, profile_version, channel, packet_version, packet_hash, idempotency_key, supersedes_id)
  VALUES (v_owner, p_invoice_id, p_profile_id, p.current_version, p_channel, v_ver, p_packet_hash, p_idempotency_key,
          (SELECT ps.id FROM portal_submissions ps WHERE ps.user_id = v_owner AND ps.invoice_id = p_invoice_id AND ps.profile_id = p_profile_id ORDER BY ps.packet_version DESC LIMIT 1))
  RETURNING id INTO v_new;
  INSERT INTO portal_submission_events (user_id, submission_id, event_type, to_state, actor_id, actor_kind, details)
  VALUES (v_owner, v_new, 'enqueued', 'queued', auth.uid(), CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END, jsonb_build_object('channel', p_channel, 'packet_version', v_ver));
  PERFORM public.log_audit_event(v_owner, 'portal.submission.enqueued', 'portal_submissions', v_new::text);
  RETURN QUERY SELECT v_new, false, 'queued'::text, v_ver;
END; $$;
GRANT EXECUTE ON FUNCTION public.portal_enqueue_submission(uuid, uuid, text, text, text) TO authenticated, service_role;

-- 11h. polling (service role)
CREATE OR REPLACE FUNCTION public.portal_claim_due_polls(p_limit integer DEFAULT 50)
RETURNS SETOF portal_submissions LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE portal_submissions s SET next_poll_at = now() + interval '15 minutes', poll_attempts = s.poll_attempts + 1
  WHERE s.id IN (SELECT id FROM portal_submissions WHERE next_poll_at <= now() AND state IN ('submitted','acknowledged','approved','scheduled_for_payment')
                 ORDER BY next_poll_at LIMIT LEAST(GREATEST(p_limit, 1), 200) FOR UPDATE SKIP LOCKED)
  RETURNING s.*;
$$;
CREATE OR REPLACE FUNCTION public.portal_record_poll(p_id uuid, p_ok boolean, p_delay_seconds integer, p_stop boolean DEFAULT false, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s portal_submissions;
BEGIN
  UPDATE portal_submissions SET last_polled_at = now(),
    consecutive_poll_errors = CASE WHEN p_ok THEN 0 ELSE consecutive_poll_errors + 1 END,
    next_poll_at = CASE WHEN p_stop THEN NULL ELSE now() + make_interval(secs => GREATEST(60, LEAST(p_delay_seconds, 172800))) END
  WHERE id = p_id RETURNING * INTO s;
  IF FOUND AND (NOT p_ok OR p_stop) THEN
    INSERT INTO portal_submission_events (user_id, submission_id, event_type, actor_kind, details)
    VALUES (s.user_id, s.id, CASE WHEN p_stop THEN 'poll_stopped' ELSE 'poll_failed' END, 'system', jsonb_build_object('error', left(COALESCE(p_error, ''), 200)));
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.portal_claim_due_polls(integer), public.portal_record_poll(uuid, boolean, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_claim_due_polls(integer), public.portal_record_poll(uuid, boolean, integer, boolean, text) TO service_role;

-- 11i. e-mail delivery webhook application (service role)
CREATE OR REPLACE FUNCTION public.portal_apply_email_event(p_message_id text, p_event text, p_bounce_type text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d portal_email_deliveries; v_status text; v_hard boolean;
BEGIN
  v_status := CASE p_event WHEN 'email.delivered' THEN 'delivered' WHEN 'email.bounced' THEN 'bounced' WHEN 'email.complained' THEN 'complained' ELSE NULL END;
  IF v_status IS NULL THEN RETURN false; END IF;
  UPDATE portal_email_deliveries SET status = v_status, bounce_type = left(p_bounce_type, 40) WHERE provider_message_id = p_message_id RETURNING * INTO d;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO portal_submission_events (user_id, submission_id, event_type, actor_kind, details, dedupe_key)
  VALUES (d.user_id, d.submission_id, 'email_' || v_status, 'portal', jsonb_build_object('bounce_type', p_bounce_type), 'email:' || p_message_id || ':' || v_status) ON CONFLICT DO NOTHING;
  v_hard := v_status = 'complained' OR (v_status = 'bounced' AND lower(COALESCE(p_bounce_type, '')) NOT IN ('transient','soft'));
  IF v_hard AND EXISTS (SELECT 1 FROM portal_submissions WHERE id = d.submission_id AND state = 'submitted') THEN
    PERFORM public.portal_apply_transition(d.submission_id, 'failed', 'system', jsonb_build_object('code', 'email_' || v_status), 'email-fail:' || p_message_id);
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.portal_apply_email_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_apply_email_event(text, text, text) TO service_role;

-- 11j. remittance review: confirm applies ONLY exact matches; everything else stays in the queue (human decides)
CREATE OR REPLACE FUNCTION public.portal_confirm_remittance(p_remittance_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r portal_remittances; l portal_remittance_lines; v_sub uuid; n integer := 0;
BEGIN
  SELECT * INTO r FROM portal_remittances WHERE id = p_remittance_id FOR UPDATE;
  IF NOT FOUND OR NOT public.portal_may_act(r.user_id) OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'needs_review' THEN RETURN 0; END IF;
  FOR l IN SELECT * FROM portal_remittance_lines WHERE remittance_id = r.id AND match_status = 'matched' AND resolution = 'pending' LOOP
    SELECT id INTO v_sub FROM portal_submissions WHERE user_id = r.user_id AND invoice_id = l.invoice_id AND state IN ('submitted','acknowledged','approved','scheduled_for_payment') LIMIT 1;
    IF v_sub IS NOT NULL THEN
      PERFORM public.portal_apply_transition(v_sub, 'paid', 'user', jsonb_build_object('remittance_id', r.id, 'payment_ref', r.payment_ref), 'remit:' || r.id || ':' || l.id);
      UPDATE portal_remittance_lines SET resolution = 'applied', resolved_by = auth.uid(), resolved_at = now() WHERE id = l.id;
      n := n + 1;
    END IF;
  END LOOP;
  UPDATE portal_remittances SET status = CASE WHEN EXISTS (SELECT 1 FROM portal_remittance_lines WHERE remittance_id = r.id AND resolution = 'pending') THEN 'needs_review' ELSE 'confirmed' END,
    confirmed_by = auth.uid(), confirmed_at = now() WHERE id = r.id;
  PERFORM public.log_audit_event(r.user_id, 'portal.remittance.confirmed', 'portal_remittances', r.id::text);
  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION public.portal_confirm_remittance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.portal_dismiss_remittance_line(p_line_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l portal_remittance_lines;
BEGIN
  SELECT * INTO l FROM portal_remittance_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND OR NOT public.portal_may_act(l.user_id) OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE portal_remittance_lines SET resolution = 'dismissed', resolved_by = auth.uid(), resolved_at = now() WHERE id = l.id AND resolution = 'pending';
  UPDATE portal_remittances SET status = 'confirmed' WHERE id = l.remittance_id AND status = 'needs_review'
    AND NOT EXISTS (SELECT 1 FROM portal_remittance_lines WHERE remittance_id = l.remittance_id AND resolution = 'pending');
  PERFORM public.log_audit_event(l.user_id, 'portal.remittance.line_dismissed', 'portal_remittance_lines', l.id::text);
END; $$;
GRANT EXECUTE ON FUNCTION public.portal_dismiss_remittance_line(uuid) TO authenticated;

-- 11k. observability (SECURITY INVOKER: RLS applies)
CREATE OR REPLACE FUNCTION public.portal_profile_stats(p_days integer DEFAULT 90)
RETURNS TABLE (profile_id uuid, profile_name text, total bigint, succeeded bigint, rejected bigint, failed bigint, success_rate numeric, median_time_to_submit_seconds numeric, drift_runs bigint)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name, COUNT(s.id),
    COUNT(*) FILTER (WHERE s.state IN ('submitted','acknowledged','approved','scheduled_for_payment','paid')),
    COUNT(*) FILTER (WHERE s.state = 'rejected'), COUNT(*) FILTER (WHERE s.state = 'failed'),
    CASE WHEN COUNT(s.id) = 0 THEN NULL ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE s.state IN ('submitted','acknowledged','approved','scheduled_for_payment','paid')) / COUNT(s.id), 1) END,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.submitted_at - s.created_at))) FILTER (WHERE s.submitted_at IS NOT NULL),
    (SELECT COUNT(*) FROM portal_worker_runs w WHERE w.profile_id = p.id AND w.status = 'drift' AND w.started_at > now() - make_interval(days => p_days))
  FROM customer_portal_profiles p LEFT JOIN portal_submissions s ON s.profile_id = p.id AND s.created_at > now() - make_interval(days => p_days)
  WHERE p.user_id = public.get_account_owner_id() AND public.commercial_can_bill()
  GROUP BY p.id, p.name ORDER BY p.name;
$$;
GRANT EXECUTE ON FUNCTION public.portal_profile_stats(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.portal_failure_reasons(p_days integer DEFAULT 90)
RETURNS TABLE (profile_id uuid, reason text, kind text, occurrences bigint) LANGUAGE sql STABLE AS $$
  SELECT s.profile_id, COALESCE(s.failure_code, left(s.rejection_reason, 80), 'unknown'), s.state, COUNT(*)
  FROM portal_submissions s WHERE s.state IN ('failed','rejected') AND s.created_at > now() - make_interval(days => p_days)
    AND s.user_id = public.get_account_owner_id() AND public.commercial_can_bill()
  GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION public.portal_failure_reasons(integer) TO authenticated;

COMMIT;
