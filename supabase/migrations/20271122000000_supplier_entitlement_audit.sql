/*
  # Supplier Entitlement Audit

  Finds money a contractor is owed by distributors / manufacturers (unapplied credit memos,
  rebate / patronage tiers, co-op, price-agreement deviations, warranty credits).

  ## Principles
  - Additive + idempotent: nothing existing is altered or dropped. Safe to run twice.
  - Program rules are DATA (supplier_programs.rules / rules_override), never hardcoded.
  - Estimates stay "estimates". Only a confirmed receipt (supplier_recoveries, append-only) is "recovered".
  - Nothing is ever sent anywhere by the system. A claim packet must be approved by a human
    before it can be marked as sent (CHECK constraint + RPC-only writes).

  ## Security
  - RLS on every table: user_id = get_account_owner_id() AND sa_can_manage()
    (account owner, or team member with can_view_billing).
  - Findings, packets, recoveries and the audit log have NO client write policies: all writes go
    through SECURITY DEFINER RPCs that re-check the role and account ownership of every id.
  - Ledger + audit log are append-only (UPDATE blocked by trigger; no DELETE policy).

  ## Requires
  get_account_owner_id(), profiles, vendors, vendor_bills, team_members(user_id, account_owner_id,
  permissions), warranty_claims. bank_transactions is optional (only needed to confirm bank deposits).
*/

-- =============================================================
-- 0. PREFLIGHT
-- =============================================================
DO $$
DECLARE missing text[] := '{}'; t text; c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'vendors', 'vendor_bills', 'team_members', 'warranty_claims'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || ('table ' || t); END IF;
  END LOOP;
  IF to_regprocedure('public.get_account_owner_id()') IS NULL THEN missing := missing || 'function get_account_owner_id()'; END IF;
  FOREACH c IN ARRAY ARRAY['team_members.user_id', 'team_members.account_owner_id', 'team_members.permissions',
                           'vendors.user_id', 'vendors.name', 'warranty_claims.user_id'] LOOP
    IF to_regclass('public.' || split_part(c, '.', 1)) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = split_part(c, '.', 1) AND column_name = split_part(c, '.', 2)
    ) THEN missing := missing || ('column ' || c); END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Supplier Entitlement Audit prerequisites are missing: %', array_to_string(missing, ', ');
  END IF;
END $$;

-- =============================================================
-- 1. HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.sa_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public.sa_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be modified', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- Owner, or a team member with can_view_billing (same gate as Procurement / Vendor Management nav).
CREATE OR REPLACE FUNCTION public.sa_can_manage()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND public.get_account_owner_id() IS NOT NULL AND (
    auth.uid() = public.get_account_owner_id()
    OR EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.sa_assert_manage()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.sa_can_manage() THEN
    RAISE EXCEPTION 'Supplier audit is limited to the account owner and office staff.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- =============================================================
-- 2. TABLES
-- =============================================================

-- 2a. Programs (rules are DATA; rules_override = per-account adjustments layered on top of rules)
CREATE TABLE IF NOT EXISTS supplier_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  program_type text NOT NULL
    CHECK (program_type IN ('volume_rebate', 'patronage', 'co_op', 'price_agreement', 'warranty_credit')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  period_start date,
  period_end date,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(rules) = 'object' AND pg_column_size(rules) <= 65536),
  rules_override jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(rules_override) = 'object' AND pg_column_size(rules_override) <= 65536),
  enrollment_status text NOT NULL DEFAULT 'unknown'
    CHECK (enrollment_status IN ('not_required', 'enrolled', 'not_enrolled', 'unknown')),
  claim_deadline date,
  required_documents text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_documents) <= 30),
  documents_on_file text[] NOT NULL DEFAULT '{}' CHECK (cardinality(documents_on_file) <= 30),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  last_verified_at date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_programs_period_ordered CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_supplier_programs_user_vendor ON supplier_programs(user_id, vendor_id, status);

-- 2b. Statements
CREATE TABLE IF NOT EXISTS supplier_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  source_kind text NOT NULL DEFAULT 'csv' CHECK (source_kind IN ('pdf', 'csv', 'xlsx', 'manual')),
  source_file_path text,
  source_file_name text CHECK (source_file_name IS NULL OR char_length(source_file_name) <= 300),
  file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  parse_status text NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'parsed', 'needs_review', 'reviewed', 'failed')),
  parse_error text CHECK (parse_error IS NULL OR char_length(parse_error) <= 500),
  line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_statements_period_ordered CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_supplier_statements_user_vendor ON supplier_statements(user_id, vendor_id, period_end DESC);
-- Re-uploading the identical file can never create a second statement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_statements_file ON supplier_statements(user_id, file_sha256) WHERE file_sha256 IS NOT NULL;

-- 2c. Statement lines (money as integer cents; credits are positive amounts with is_credit = true)
CREATE TABLE IF NOT EXISTS supplier_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL REFERENCES supplier_statements(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no >= 1),
  invoice_no text CHECK (invoice_no IS NULL OR char_length(invoice_no) <= 80),
  invoice_date date,
  sku text CHECK (sku IS NULL OR char_length(sku) <= 120),
  description text CHECK (description IS NULL OR char_length(description) <= 400),
  qty numeric(14, 4) CHECK (qty IS NULL OR qty >= 0),
  unit_price_cents bigint CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  extended_cents bigint CHECK (extended_cents IS NULL OR extended_cents >= 0),
  is_credit boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  confidence numeric(4, 3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(field_confidence) = 'object' AND pg_column_size(field_confidence) <= 4096),
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('auto_accepted', 'needs_review', 'confirmed', 'rejected')),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_supplier_lines_user_review ON supplier_statement_lines(user_id, review_status);
CREATE INDEX IF NOT EXISTS idx_supplier_lines_invoice ON supplier_statement_lines(user_id, invoice_no) WHERE invoice_no IS NOT NULL;

-- 2d. Credit memos
CREATE TABLE IF NOT EXISTS supplier_credit_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  memo_no text CHECK (memo_no IS NULL OR char_length(memo_no) <= 80),
  memo_date date,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  applied_cents bigint NOT NULL DEFAULT 0 CHECK (applied_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL DEFAULT 'other'
    CHECK (reason IN ('rebate', 'patronage', 'co_op', 'price_adjustment', 'return', 'warranty', 'other')),
  applied_status text NOT NULL DEFAULT 'unapplied'
    CHECK (applied_status IN ('unapplied', 'partially_applied', 'applied', 'void')),
  invoice_no text CHECK (invoice_no IS NULL OR char_length(invoice_no) <= 80),
  statement_id uuid REFERENCES supplier_statements(id) ON DELETE SET NULL,
  program_id uuid REFERENCES supplier_programs(id) ON DELETE SET NULL,
  warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE SET NULL,
  confidence numeric(4, 3) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  needs_review boolean NOT NULL DEFAULT false,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_credit_memos_applied_le_amount CHECK (applied_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS idx_supplier_memos_user_vendor ON supplier_credit_memos(user_id, vendor_id, applied_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_memos_no ON supplier_credit_memos(user_id, vendor_id, memo_no) WHERE memo_no IS NOT NULL;

-- 2e. Findings (written ONLY by sa_upsert_findings)
CREATE TABLE IF NOT EXISTS supplier_audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  finding_type text NOT NULL CHECK (finding_type IN (
    'price_deviation', 'rebate_owed', 'rebate_accruing', 'tier_gap', 'unapplied_credit',
    'warranty_credit_missing', 'warranty_credit_short', 'coop_unclaimed', 'duplicate_invoice')),
  kind text,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  program_id uuid REFERENCES supplier_programs(id) ON DELETE SET NULL,
  warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) <= 240),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 2000),
  low_cents bigint NOT NULL DEFAULT 0 CHECK (low_cents >= 0),
  likely_cents bigint NOT NULL DEFAULT 0 CHECK (likely_cents >= 0),
  high_cents bigint NOT NULL DEFAULT 0 CHECK (high_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  confidence_band text NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high')),
  deadline date,
  deadline_risk text NOT NULL DEFAULT 'none' CHECK (deadline_risk IN ('none', 'ok', 'soon', 'critical', 'expired')),
  is_opportunity boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND pg_column_size(evidence) <= 262144),
  how_calculated jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(how_calculated) = 'array' AND pg_column_size(how_calculated) <= 32768),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(warnings) = 'array' AND pg_column_size(warnings) <= 16384),
  fingerprint text NOT NULL,
  label text NOT NULL DEFAULT 'estimate' CHECK (label = 'estimate'),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'packet_ready', 'claimed', 'partially_recovered', 'recovered', 'dismissed', 'superseded')),
  dismiss_reason text CHECK (dismiss_reason IS NULL OR char_length(dismiss_reason) BETWEEN 3 AND 500),
  dismissed_at timestamptz,
  dismissed_by uuid,
  recovered_cents bigint NOT NULL DEFAULT 0 CHECK (recovered_cents >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key),
  CONSTRAINT supplier_findings_range_ordered CHECK (low_cents <= likely_cents AND likely_cents <= high_cents),
  CONSTRAINT supplier_findings_dismiss_has_reason CHECK (status <> 'dismissed' OR dismiss_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_supplier_findings_user_status ON supplier_audit_findings(user_id, status, deadline);
CREATE INDEX IF NOT EXISTS idx_supplier_findings_vendor ON supplier_audit_findings(user_id, vendor_id);

-- 2f. Claim packets (human approval gate)
CREATE TABLE IF NOT EXISTS supplier_claim_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES supplier_audit_findings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'marked_sent', 'cancelled')),
  draft_message text NOT NULL DEFAULT '' CHECK (char_length(draft_message) <= 8000),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(checklist) = 'array' AND pg_column_size(checklist) <= 16384),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 524288),
  generated_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  sent_marked_by uuid,
  sent_marked_at timestamptz,
  sent_note text CHECK (sent_note IS NULL OR char_length(sent_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The database itself refuses "sent" without a prior human approval.
  CONSTRAINT supplier_packets_sent_needs_approval CHECK (status <> 'marked_sent' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CONSTRAINT supplier_packets_approved_has_actor CHECK (status NOT IN ('approved', 'marked_sent') OR approved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_supplier_packets_finding ON supplier_claim_packets(user_id, finding_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_packets_one_draft ON supplier_claim_packets(finding_id) WHERE status = 'draft';

-- 2g. Recoveries = the measured ledger (append-only)
CREATE TABLE IF NOT EXISTS supplier_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES supplier_audit_findings(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('bank_deposit', 'warranty_credit', 'credit_applied')),
  evidence_id text NOT NULL,
  evidence_label text,
  received_on date NOT NULL,
  capped boolean NOT NULL DEFAULT false,
  confirmed_by uuid,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR char_length(note) <= 500)
);
-- One receipt can confirm only one recovery (a deposit can never be counted twice).
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_recoveries_receipt ON supplier_recoveries(user_id, source, evidence_id);
CREATE INDEX IF NOT EXISTS idx_supplier_recoveries_user ON supplier_recoveries(user_id, received_on DESC);

-- 2h. Audit log (append-only)
CREATE TABLE IF NOT EXISTS supplier_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_email text,
  action text NOT NULL CHECK (char_length(action) <= 80),
  entity_type text NOT NULL CHECK (char_length(entity_type) <= 60),
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_audit_log_user ON supplier_audit_log(user_id, created_at DESC);

-- 2i. Statement-parse quota (service role only; no policies on purpose)
CREATE TABLE IF NOT EXISTS supplier_parse_usage (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE supplier_parse_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_supplier_parse_quota(p_user_id uuid, p_max integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO supplier_parse_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE u.window_start END,
    request_count = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE u.request_count + 1 END
  RETURNING u.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_supplier_parse_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_supplier_parse_quota(uuid, integer, integer) TO service_role;

-- =============================================================
-- 3. TRIGGERS
-- =============================================================
DROP TRIGGER IF EXISTS trg_supplier_programs_touch ON supplier_programs;
CREATE TRIGGER trg_supplier_programs_touch BEFORE UPDATE ON supplier_programs FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();
DROP TRIGGER IF EXISTS trg_supplier_statements_touch ON supplier_statements;
CREATE TRIGGER trg_supplier_statements_touch BEFORE UPDATE ON supplier_statements FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();
DROP TRIGGER IF EXISTS trg_supplier_lines_touch ON supplier_statement_lines;
CREATE TRIGGER trg_supplier_lines_touch BEFORE UPDATE ON supplier_statement_lines FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();
DROP TRIGGER IF EXISTS trg_supplier_memos_touch ON supplier_credit_memos;
CREATE TRIGGER trg_supplier_memos_touch BEFORE UPDATE ON supplier_credit_memos FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();
DROP TRIGGER IF EXISTS trg_supplier_findings_touch ON supplier_audit_findings;
CREATE TRIGGER trg_supplier_findings_touch BEFORE UPDATE ON supplier_audit_findings FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();
DROP TRIGGER IF EXISTS trg_supplier_packets_touch ON supplier_claim_packets;
CREATE TRIGGER trg_supplier_packets_touch BEFORE UPDATE ON supplier_claim_packets FOR EACH ROW EXECUTE FUNCTION public.sa_touch_updated_at();

DROP TRIGGER IF EXISTS trg_supplier_recoveries_immutable ON supplier_recoveries;
CREATE TRIGGER trg_supplier_recoveries_immutable BEFORE UPDATE ON supplier_recoveries FOR EACH ROW EXECUTE FUNCTION public.sa_block_update();
DROP TRIGGER IF EXISTS trg_supplier_audit_log_immutable ON supplier_audit_log;
CREATE TRIGGER trg_supplier_audit_log_immutable BEFORE UPDATE ON supplier_audit_log FOR EACH ROW EXECUTE FUNCTION public.sa_block_update();

-- A line, memo or statement can only reference rows of the same account (defence in depth on top of RLS).
CREATE OR REPLACE FUNCTION public.sa_guard_ownership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'supplier_statement_lines' THEN
    IF NOT EXISTS (SELECT 1 FROM supplier_statements s WHERE s.id = NEW.statement_id AND s.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'statement does not belong to this account' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM vendors v WHERE v.id = NEW.vendor_id AND v.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'vendor does not belong to this account' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'supplier_credit_memos' THEN
      IF NEW.program_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_programs p WHERE p.id = NEW.program_id AND p.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'program does not belong to this account' USING ERRCODE = '42501';
      END IF;
      IF NEW.statement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_statements s WHERE s.id = NEW.statement_id AND s.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'statement does not belong to this account' USING ERRCODE = '42501';
      END IF;
      IF NEW.warranty_claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM warranty_claims w WHERE w.id = NEW.warranty_claim_id AND w.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'warranty claim does not belong to this account' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_supplier_programs_guard ON supplier_programs;
CREATE TRIGGER trg_supplier_programs_guard BEFORE INSERT OR UPDATE ON supplier_programs FOR EACH ROW EXECUTE FUNCTION public.sa_guard_ownership();
DROP TRIGGER IF EXISTS trg_supplier_statements_guard ON supplier_statements;
CREATE TRIGGER trg_supplier_statements_guard BEFORE INSERT OR UPDATE ON supplier_statements FOR EACH ROW EXECUTE FUNCTION public.sa_guard_ownership();
DROP TRIGGER IF EXISTS trg_supplier_memos_guard ON supplier_credit_memos;
CREATE TRIGGER trg_supplier_memos_guard BEFORE INSERT OR UPDATE ON supplier_credit_memos FOR EACH ROW EXECUTE FUNCTION public.sa_guard_ownership();
DROP TRIGGER IF EXISTS trg_supplier_lines_guard ON supplier_statement_lines;
CREATE TRIGGER trg_supplier_lines_guard BEFORE INSERT OR UPDATE ON supplier_statement_lines FOR EACH ROW EXECUTE FUNCTION public.sa_guard_ownership();

-- =============================================================
-- 4. ROW LEVEL SECURITY
-- =============================================================
-- Full CRUD (owner / office only): programs, statements, lines, credit memos
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_programs', 'supplier_statements', 'supplier_statement_lines', 'supplier_credit_memos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sa_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sa_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sa_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sa_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.sa_can_manage())', t || '_sa_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.sa_can_manage())', t || '_sa_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id() AND public.sa_can_manage()) WITH CHECK (user_id = public.get_account_owner_id() AND public.sa_can_manage())', t || '_sa_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id() AND public.sa_can_manage())', t || '_sa_delete', t);
  END LOOP;
  -- Read-only for clients (all writes via SECURITY DEFINER RPCs): findings, packets, recoveries, audit log
  FOREACH t IN ARRAY ARRAY['supplier_audit_findings', 'supplier_claim_packets', 'supplier_recoveries', 'supplier_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sa_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.sa_can_manage())', t || '_sa_select', t);
  END LOOP;
END $$;

-- =============================================================
-- 5. INTERNAL LOG HELPER (not callable by clients)
-- =============================================================
CREATE OR REPLACE FUNCTION public.sa_log(p_owner uuid, p_action text, p_entity_type text, p_entity_id text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email text;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  INSERT INTO supplier_audit_log (user_id, actor_id, actor_email, action, entity_type, entity_id, detail)
  VALUES (p_owner, auth.uid(), v_email, p_action, p_entity_type, p_entity_id, COALESCE(p_detail, '{}'::jsonb));
  -- Mirror into the account-wide audit log when the helper exists (never blocks the action).
  IF to_regprocedure('public.log_audit_event(uuid,text,text,text)') IS NOT NULL THEN
    BEGIN
      PERFORM public.log_audit_event(p_owner, 'supplier_audit.' || p_action, p_entity_type, p_entity_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sa_log(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. RPCs
-- =============================================================

-- 6a. Idempotent findings upsert. Same dedupe_key never creates a second row; dismissed / claimed /
--     recovered findings are never reopened or rewritten (only last_seen_at moves).
CREATE OR REPLACE FUNCTION public.sa_upsert_findings(p_findings jsonb, p_complete boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_run timestamptz := clock_timestamp();
  f jsonb;
  v_ex record;
  v_vendor uuid; v_program uuid; v_claim uuid;
  v_ins integer := 0; v_upd integer := 0; v_same integer := 0; v_sup integer := 0;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  IF p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array' THEN
    RAISE EXCEPTION 'p_findings must be a JSON array';
  END IF;
  IF jsonb_array_length(p_findings) > 2000 THEN
    RAISE EXCEPTION 'Too many findings in one run (max 2000)';
  END IF;

  FOR f IN SELECT value FROM jsonb_array_elements(p_findings) LOOP
    v_vendor := (f ->> 'vendor_id')::uuid;
    v_program := NULLIF(f ->> 'program_id', '')::uuid;
    v_claim := NULLIF(f ->> 'warranty_claim_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = v_vendor AND user_id = v_owner) THEN
      RAISE EXCEPTION 'vendor does not belong to this account' USING ERRCODE = '42501';
    END IF;
    IF v_program IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_programs WHERE id = v_program AND user_id = v_owner) THEN
      RAISE EXCEPTION 'program does not belong to this account' USING ERRCODE = '42501';
    END IF;
    IF v_claim IS NOT NULL AND NOT EXISTS (SELECT 1 FROM warranty_claims WHERE id = v_claim AND user_id = v_owner) THEN
      RAISE EXCEPTION 'warranty claim does not belong to this account' USING ERRCODE = '42501';
    END IF;

    SELECT id, status, fingerprint INTO v_ex
    FROM supplier_audit_findings WHERE user_id = v_owner AND dedupe_key = f ->> 'dedupe_key' FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO supplier_audit_findings (
        user_id, dedupe_key, finding_type, kind, vendor_id, program_id, warranty_claim_id, title, summary,
        low_cents, likely_cents, high_cents, currency, confidence, confidence_band, deadline, deadline_risk,
        is_opportunity, evidence, how_calculated, warnings, fingerprint, first_seen_at, last_seen_at)
      VALUES (
        v_owner, f ->> 'dedupe_key', f ->> 'finding_type', f ->> 'kind', v_vendor, v_program, v_claim,
        f ->> 'title', COALESCE(f ->> 'summary', ''),
        (f ->> 'low_cents')::bigint, (f ->> 'likely_cents')::bigint, (f ->> 'high_cents')::bigint,
        COALESCE(f ->> 'currency', 'USD'), (f ->> 'confidence')::numeric, f ->> 'confidence_band',
        NULLIF(f ->> 'deadline', '')::date, COALESCE(f ->> 'deadline_risk', 'none'),
        COALESCE((f ->> 'is_opportunity')::boolean, false),
        COALESCE(f -> 'evidence', '[]'::jsonb), COALESCE(f -> 'how_calculated', '[]'::jsonb),
        COALESCE(f -> 'warnings', '[]'::jsonb), f ->> 'fingerprint', v_run, v_run);
      v_ins := v_ins + 1;
    ELSIF v_ex.status IN ('open', 'packet_ready', 'superseded') THEN
      IF v_ex.status = 'superseded' OR v_ex.fingerprint IS DISTINCT FROM (f ->> 'fingerprint') THEN
        UPDATE supplier_audit_findings SET
          finding_type = f ->> 'finding_type', kind = f ->> 'kind', program_id = v_program, warranty_claim_id = v_claim,
          title = f ->> 'title', summary = COALESCE(f ->> 'summary', ''),
          low_cents = (f ->> 'low_cents')::bigint, likely_cents = (f ->> 'likely_cents')::bigint,
          high_cents = (f ->> 'high_cents')::bigint, currency = COALESCE(f ->> 'currency', 'USD'),
          confidence = (f ->> 'confidence')::numeric, confidence_band = f ->> 'confidence_band',
          deadline = NULLIF(f ->> 'deadline', '')::date, deadline_risk = COALESCE(f ->> 'deadline_risk', 'none'),
          is_opportunity = COALESCE((f ->> 'is_opportunity')::boolean, false),
          evidence = COALESCE(f -> 'evidence', '[]'::jsonb), how_calculated = COALESCE(f -> 'how_calculated', '[]'::jsonb),
          warnings = COALESCE(f -> 'warnings', '[]'::jsonb), fingerprint = f ->> 'fingerprint',
          status = CASE WHEN v_ex.status = 'superseded' THEN 'open' ELSE v_ex.status END,
          last_seen_at = v_run
        WHERE id = v_ex.id;
        v_upd := v_upd + 1;
      ELSE
        UPDATE supplier_audit_findings SET last_seen_at = v_run WHERE id = v_ex.id;
        v_same := v_same + 1;
      END IF;
    ELSE
      UPDATE supplier_audit_findings SET last_seen_at = v_run WHERE id = v_ex.id;
      v_same := v_same + 1;
    END IF;
  END LOOP;

  -- A full run that no longer produces an open finding means the situation resolved (e.g. the credit
  -- was applied by the distributor). Mark it superseded; it reopens automatically if it ever reappears.
  IF p_complete THEN
    UPDATE supplier_audit_findings SET status = 'superseded'
    WHERE user_id = v_owner AND status IN ('open', 'packet_ready') AND last_seen_at < v_run;
    GET DIAGNOSTICS v_sup = ROW_COUNT;
  END IF;

  PERFORM public.sa_log(v_owner, 'audit_run', 'supplier_audit_findings', NULL,
    jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'unchanged', v_same, 'superseded', v_sup));
  RETURN jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'unchanged', v_same, 'superseded', v_sup);
END;
$$;

-- 6b. Dismiss / reopen
CREATE OR REPLACE FUNCTION public.sa_dismiss_finding(p_finding uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_status text;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A reason (at least 3 characters) is required to dismiss a finding.';
  END IF;
  SELECT status INTO v_status FROM supplier_audit_findings WHERE id = p_finding AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found.'; END IF;
  IF v_status IN ('recovered', 'partially_recovered') THEN
    RAISE EXCEPTION 'A finding with confirmed recoveries cannot be dismissed.';
  END IF;
  UPDATE supplier_audit_findings
    SET status = 'dismissed', dismiss_reason = left(btrim(p_reason), 500), dismissed_at = now(), dismissed_by = auth.uid()
    WHERE id = p_finding;
  UPDATE supplier_claim_packets SET status = 'cancelled' WHERE finding_id = p_finding AND status IN ('draft', 'approved');
  PERFORM public.sa_log(v_owner, 'finding_dismissed', 'supplier_audit_findings', p_finding::text, jsonb_build_object('reason', left(btrim(p_reason), 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_reopen_finding(p_finding uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  UPDATE supplier_audit_findings
    SET status = 'open', dismiss_reason = NULL, dismissed_at = NULL, dismissed_by = NULL
    WHERE id = p_finding AND user_id = v_owner AND status = 'dismissed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found or not dismissed.'; END IF;
  PERFORM public.sa_log(v_owner, 'finding_reopened', 'supplier_audit_findings', p_finding::text);
END;
$$;

-- 6c. Claim packets: draft -> approved (human) -> marked_sent (human says THEY sent it). Nothing is transmitted.
CREATE OR REPLACE FUNCTION public.sa_save_packet(p_finding uuid, p_message text, p_checklist jsonb, p_snapshot jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_id uuid; v_status text;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  SELECT status INTO v_status FROM supplier_audit_findings WHERE id = p_finding AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found.'; END IF;
  IF v_status IN ('dismissed', 'superseded') THEN RAISE EXCEPTION 'This finding is no longer active.'; END IF;
  SELECT id INTO v_id FROM supplier_claim_packets WHERE finding_id = p_finding AND user_id = v_owner AND status = 'draft';
  IF v_id IS NULL THEN
    INSERT INTO supplier_claim_packets (user_id, finding_id, draft_message, checklist, snapshot, generated_by)
    VALUES (v_owner, p_finding, COALESCE(p_message, ''), COALESCE(p_checklist, '[]'::jsonb), COALESCE(p_snapshot, '{}'::jsonb), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE supplier_claim_packets
      SET draft_message = COALESCE(p_message, ''), checklist = COALESCE(p_checklist, '[]'::jsonb), snapshot = COALESCE(p_snapshot, '{}'::jsonb)
      WHERE id = v_id;
  END IF;
  IF v_status = 'open' THEN UPDATE supplier_audit_findings SET status = 'packet_ready' WHERE id = p_finding; END IF;
  PERFORM public.sa_log(v_owner, 'packet_saved', 'supplier_claim_packets', v_id::text, jsonb_build_object('finding_id', p_finding));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_approve_packet(p_packet uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  UPDATE supplier_claim_packets SET status = 'approved', approved_by = auth.uid(), approved_at = now()
    WHERE id = p_packet AND user_id = v_owner AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'Packet not found or already approved.'; END IF;
  PERFORM public.sa_log(v_owner, 'packet_approved', 'supplier_claim_packets', p_packet::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_mark_packet_sent(p_packet uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_finding uuid;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  UPDATE supplier_claim_packets
    SET status = 'marked_sent', sent_marked_by = auth.uid(), sent_marked_at = now(), sent_note = left(NULLIF(btrim(p_note), ''), 500)
    WHERE id = p_packet AND user_id = v_owner AND status = 'approved'
    RETURNING finding_id INTO v_finding;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an approved packet can be marked as sent.'; END IF;
  UPDATE supplier_audit_findings SET status = 'claimed' WHERE id = v_finding AND status IN ('open', 'packet_ready');
  PERFORM public.sa_log(v_owner, 'packet_marked_sent', 'supplier_claim_packets', p_packet::text, jsonb_build_object('finding_id', v_finding));
END;
$$;

-- 6d. Recoveries. The amount is ALWAYS derived server-side from the receipt, never taken from the client,
--     and a receipt dated before the finding was first seen can never be attributed to it.
CREATE OR REPLACE FUNCTION public.sa__record_recovery(
  p_owner uuid, p_finding uuid, p_source text, p_evidence_id text, p_amount bigint, p_received_on date, p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_f record; v_credit bigint; v_capped boolean := false; v_total bigint; v_new_status text; v_rows integer;
BEGIN
  SELECT * INTO v_f FROM supplier_audit_findings WHERE id = p_finding AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found.'; END IF;
  IF v_f.is_opportunity THEN RAISE EXCEPTION 'Opportunities are not recoverable money; nothing to confirm.'; END IF;
  IF v_f.status IN ('dismissed') THEN RAISE EXCEPTION 'This finding was dismissed.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'The receipt has no positive amount.'; END IF;
  IF p_received_on < v_f.first_seen_at::date THEN
    RAISE EXCEPTION 'This receipt predates the finding, so it cannot be counted as recovered by this audit.';
  END IF;
  v_credit := p_amount;
  IF v_f.high_cents > 0 AND v_credit > v_f.high_cents THEN v_credit := v_f.high_cents; v_capped := true; END IF;

  INSERT INTO supplier_recoveries (user_id, finding_id, amount_cents, currency, source, evidence_id, evidence_label, received_on, capped, confirmed_by)
  VALUES (p_owner, p_finding, v_credit, v_f.currency, p_source, p_evidence_id, left(p_label, 200), p_received_on, v_capped, auth.uid())
  ON CONFLICT (user_id, source, evidence_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'This receipt is already confirmed against a finding.'; END IF;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_total FROM supplier_recoveries WHERE finding_id = p_finding AND user_id = p_owner;
  v_new_status := CASE WHEN v_total >= v_f.likely_cents AND v_f.likely_cents > 0 THEN 'recovered' ELSE 'partially_recovered' END;
  UPDATE supplier_audit_findings SET recovered_cents = v_total, status = v_new_status WHERE id = p_finding;
  UPDATE supplier_claim_packets SET status = 'cancelled' WHERE finding_id = p_finding AND status = 'draft';
  PERFORM public.sa_log(p_owner, 'recovery_confirmed', 'supplier_recoveries', p_evidence_id,
    jsonb_build_object('finding_id', p_finding, 'source', p_source, 'amount_cents', v_credit, 'capped', v_capped));
  RETURN jsonb_build_object('amount_cents', v_credit, 'capped', v_capped, 'recovered_cents', v_total, 'status', v_new_status);
END;
$$;
REVOKE ALL ON FUNCTION public.sa__record_recovery(uuid, uuid, text, text, bigint, date, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sa_confirm_recovery(p_finding uuid, p_source text, p_evidence_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid; v_f record; v_amount bigint; v_date date; v_label text; v_claim record; v_memo record;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  SELECT * INTO v_f FROM supplier_audit_findings WHERE id = p_finding AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finding not found.'; END IF;

  IF p_source = 'bank_deposit' THEN
    IF to_regclass('public.bank_transactions') IS NULL THEN RAISE EXCEPTION 'Bank transactions are not available in this account.'; END IF;
    EXECUTE 'SELECT amount_cents, posted_date FROM public.bank_transactions WHERE id = $1 AND user_id = $2'
      INTO v_amount, v_date USING p_evidence_id::uuid, v_owner;
    IF v_amount IS NULL THEN RAISE EXCEPTION 'Bank transaction not found.'; END IF;
    IF v_amount <= 0 THEN RAISE EXCEPTION 'Only a deposit (money in) can confirm a recovery.'; END IF;
    v_label := 'Bank deposit ' || v_date::text;
  ELSIF p_source = 'warranty_credit' THEN
    IF v_f.warranty_claim_id IS NULL OR p_evidence_id <> v_f.warranty_claim_id::text THEN
      RAISE EXCEPTION 'That warranty claim is not linked to this finding.';
    END IF;
    SELECT status, credit_received_cents, credit_received_at INTO v_claim
      FROM warranty_claims WHERE id = v_f.warranty_claim_id AND user_id = v_owner;
    IF NOT FOUND OR v_claim.status <> 'credit_received' OR COALESCE(v_claim.credit_received_cents, 0) <= 0 THEN
      RAISE EXCEPTION 'The warranty claim has no recorded credit yet.';
    END IF;
    v_amount := v_claim.credit_received_cents;
    v_date := COALESCE(v_claim.credit_received_at, current_date);
    v_label := 'Warranty credit received';
  ELSIF p_source = 'credit_applied' THEN
    SELECT * INTO v_memo FROM supplier_credit_memos WHERE id = p_evidence_id::uuid AND user_id = v_owner;
    IF NOT FOUND OR v_memo.vendor_id <> v_f.vendor_id THEN RAISE EXCEPTION 'Credit memo not found for this vendor.'; END IF;
    IF NOT (v_f.evidence @> jsonb_build_array(jsonb_build_object('id', p_evidence_id))) THEN
      RAISE EXCEPTION 'That credit memo is not evidence for this finding.';
    END IF;
    IF v_memo.applied_status NOT IN ('applied', 'partially_applied') OR v_memo.applied_cents <= 0 THEN
      RAISE EXCEPTION 'The credit memo has not been applied yet.';
    END IF;
    v_amount := v_memo.applied_cents; v_date := current_date; v_label := 'Credit memo applied ' || COALESCE(v_memo.memo_no, '');
  ELSE
    RAISE EXCEPTION 'Unknown recovery source.';
  END IF;

  RETURN public.sa__record_recovery(v_owner, p_finding, p_source, p_evidence_id, v_amount, v_date, v_label);
END;
$$;

-- Warranty credits that arrived after Vireek flagged them are measured automatically (a documented receipt).
CREATE OR REPLACE FUNCTION public.sa_sync_warranty_recoveries()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; r record; v_n integer := 0;
BEGIN
  PERFORM public.sa_assert_manage();
  v_owner := public.get_account_owner_id();
  FOR r IN
    SELECT f.id AS finding_id, w.id AS claim_id, w.credit_received_cents AS amt, COALESCE(w.credit_received_at, current_date) AS rec_on
    FROM supplier_audit_findings f
    JOIN warranty_claims w ON w.id = f.warranty_claim_id AND w.user_id = v_owner
    WHERE f.user_id = v_owner
      AND f.finding_type IN ('warranty_credit_missing', 'warranty_credit_short')
      AND f.status IN ('open', 'packet_ready', 'claimed', 'partially_recovered', 'superseded')
      AND w.status = 'credit_received' AND COALESCE(w.credit_received_cents, 0) > 0
      AND COALESCE(w.credit_received_at, current_date) >= f.first_seen_at::date
      AND NOT EXISTS (SELECT 1 FROM supplier_recoveries sr WHERE sr.user_id = v_owner AND sr.source = 'warranty_credit' AND sr.evidence_id = w.id::text)
  LOOP
    PERFORM public.sa__record_recovery(v_owner, r.finding_id, 'warranty_credit', r.claim_id::text, r.amt, r.rec_on, 'Warranty credit received');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Thin interface to the money-recovered ledger: measured supplier recoveries only.
CREATE OR REPLACE VIEW public.supplier_recovery_ledger_v WITH (security_invoker = true) AS
SELECT sr.id, sr.user_id, sr.finding_id, f.vendor_id, f.finding_type, f.title,
       sr.amount_cents, sr.currency, sr.source, sr.received_on, sr.confirmed_at
FROM supplier_recoveries sr
JOIN supplier_audit_findings f ON f.id = sr.finding_id;

-- =============================================================
-- 7. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.sa_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_assert_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_upsert_findings(jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_dismiss_finding(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_reopen_finding(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_save_packet(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_approve_packet(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_mark_packet_sent(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_confirm_recovery(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_sync_warranty_recoveries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_can_manage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_upsert_findings(jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_dismiss_finding(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_reopen_finding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_save_packet(uuid, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_approve_packet(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_mark_packet_sent(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_confirm_recovery(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_sync_warranty_recoveries() TO authenticated;
GRANT SELECT ON public.supplier_recovery_ledger_v TO authenticated;

-- =============================================================
-- 8. STATEMENT FILE STORAGE (private). Path: {owner_id}/{uploader_uid}/{file}
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('supplier-statements', 'supplier-statements', false, 10485760,
  ARRAY['application/pdf', 'text/csv', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "supplier_statements_obj_insert" ON storage.objects;
CREATE POLICY "supplier_statements_obj_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'supplier-statements' AND public.sa_can_manage()
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND (storage.foldername(name))[2] = auth.uid()::text);
DROP POLICY IF EXISTS "supplier_statements_obj_select" ON storage.objects;
CREATE POLICY "supplier_statements_obj_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'supplier-statements' AND public.sa_can_manage()
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
DROP POLICY IF EXISTS "supplier_statements_obj_delete" ON storage.objects;
CREATE POLICY "supplier_statements_obj_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'supplier-statements' AND public.sa_can_manage()
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
