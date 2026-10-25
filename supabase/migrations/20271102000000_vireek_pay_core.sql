/*
  # Vireek Pay — core: platform controls (kill switch), disclosures, payout ledger

  Foundations for instant payouts and earned-wage access (EWA) through a LICENSED
  payment partner. Vireek never holds, lends or transmits the money: everything up
  to the provider boundary lives here; the provider adapter moves the funds.

  ## Safety model (defence in depth — every layer fails CLOSED)
  1. pay_platform_controls.enabled = false by default for every product.
  2. killed_at set by staff_pay_kill_all()/staff_pay_update_control() -> instantly off.
  3. pay_tenant_controls: staff can freeze one tenant (one product or all).
  4. mode = 'live' is impossible without partner_agreement_ref + live_approved_at (CHECK)
     and without the latest disclosure of the product being legal_reviewed.
  5. Edge functions additionally refuse when the live provider adapter is not configured.
  6. Sandbox money movements are flagged sandbox = true and can never become live.

  ## Access model
  - Controls / audit: staff only (is_vireek_staff). Tenants read availability through
    pay_get_my_availability() only (no internal caps/partner refs leak).
  - Transfers / payout accounts: the technician sees their own rows, owner/admin see all
    (tech_pay_can_manage()). NO client writes — service-role edge functions only.
  - Service-only RPCs (reserve/finalize/inputs) are REVOKEd from anon + authenticated.
*/

-- =============================================================
-- 1. PLATFORM CONTROLS
-- =============================================================

CREATE TABLE IF NOT EXISTS pay_platform_controls (
  product text PRIMARY KEY CHECK (product IN ('instant_payouts', 'earned_wage_access', 'spend_cards', 'capital')),
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox', 'live')),
  partner_name text CHECK (partner_name IS NULL OR char_length(partner_name) <= 120),
  partner_agreement_ref text CHECK (partner_agreement_ref IS NULL OR char_length(btrim(partner_agreement_ref)) BETWEEN 3 AND 200),
  live_approved_by uuid,
  live_approved_at timestamptz,
  killed_at timestamptz,
  killed_by uuid,
  kill_reason text,
  fee_bps integer NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 2500),
  min_fee_cents integer NOT NULL DEFAULT 0 CHECK (min_fee_cents >= 0),
  max_fee_cents integer NOT NULL DEFAULT 0 CHECK (max_fee_cents >= min_fee_cents),
  max_single_cents bigint NOT NULL DEFAULT 0 CHECK (max_single_cents >= 0),
  max_daily_tenant_cents bigint NOT NULL DEFAULT 0 CHECK (max_daily_tenant_cents >= 0),
  max_pct_of_accrued integer NOT NULL DEFAULT 50 CHECK (max_pct_of_accrued BETWEEN 0 AND 100),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT pay_live_requires_agreement CHECK (
    mode <> 'live' OR (partner_agreement_ref IS NOT NULL AND live_approved_at IS NOT NULL AND live_approved_by IS NOT NULL)
  )
);

-- Seeds: everything OFF + sandbox. Fee/caps are SANDBOX placeholders — staff must set
-- the real, disclosed values (and get the disclosures legal-reviewed) before going live.
INSERT INTO pay_platform_controls (product, fee_bps, min_fee_cents, max_fee_cents, max_single_cents, max_daily_tenant_cents, max_pct_of_accrued)
VALUES
  ('instant_payouts',    100,  50, 1000,  500000, 1000000, 100),
  ('earned_wage_access',   0, 299,  299,   50000,  250000,  50),
  ('spend_cards',          0,   0,    0, 1000000,       0,   0),
  ('capital',              0,   0,    0, 5000000,       0,   0)
ON CONFLICT (product) DO NOTHING;

CREATE TABLE IF NOT EXISTS pay_tenant_controls (
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('all', 'instant_payouts', 'earned_wage_access', 'spend_cards', 'capital')),
  frozen boolean NOT NULL DEFAULT true,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 8 AND 500),
  set_by uuid DEFAULT auth.uid(),
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product)
);

CREATE TABLE IF NOT EXISTS pay_control_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL,            -- product, or 'tenant:<uuid>:<product>'
  action text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_control_audit_created ON pay_control_audit(created_at DESC);

ALTER TABLE pay_platform_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_tenant_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_control_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pay_platform_controls, pay_tenant_controls, pay_control_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pay_platform_controls, pay_tenant_controls, pay_control_audit FROM authenticated;

DROP POLICY IF EXISTS "staff_read_pay_controls" ON pay_platform_controls;
CREATE POLICY "staff_read_pay_controls" ON pay_platform_controls FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_pay_tenant_controls" ON pay_tenant_controls;
CREATE POLICY "staff_read_pay_tenant_controls" ON pay_tenant_controls FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_read_pay_control_audit" ON pay_control_audit;
CREATE POLICY "staff_read_pay_control_audit" ON pay_control_audit FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

-- Audit trail (the reason travels in a transaction-local setting set by the staff RPCs).
CREATE OR REPLACE FUNCTION public.pay_controls_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := NULLIF(current_setting('vireek.pay_reason', true), '');
  v_subject text;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_TABLE_NAME = 'pay_platform_controls' THEN
    v_subject := COALESCE(NEW.product, OLD.product);
    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD) - 'config' - 'updated_at';
      v_new := to_jsonb(NEW) - 'config' - 'updated_at';
      IF v_old = v_new AND NEW.config = OLD.config THEN RETURN NEW; END IF;
    END IF;
  ELSE
    v_subject := 'tenant:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text || ':' || COALESCE(NEW.product, OLD.product);
  END IF;

  INSERT INTO pay_control_audit (subject, action, before, after, reason, actor)
  VALUES (
    v_subject, lower(TG_OP),
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    COALESCE(v_reason, CASE WHEN TG_TABLE_NAME = 'pay_tenant_controls' THEN COALESCE(NEW.reason, OLD.reason) END),
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_pay_platform_controls_audit ON pay_platform_controls;
CREATE TRIGGER trg_pay_platform_controls_audit AFTER UPDATE ON pay_platform_controls
  FOR EACH ROW EXECUTE FUNCTION public.pay_controls_audit();
DROP TRIGGER IF EXISTS trg_pay_tenant_controls_audit ON pay_tenant_controls;
CREATE TRIGGER trg_pay_tenant_controls_audit AFTER INSERT OR UPDATE OR DELETE ON pay_tenant_controls
  FOR EACH ROW EXECUTE FUNCTION public.pay_controls_audit();

-- =============================================================
-- 2. DISCLOSURES (versioned, immutable, acceptance recorded with content hash)
-- =============================================================

CREATE TABLE IF NOT EXISTS pay_disclosures (
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  body text NOT NULL CHECK (char_length(btrim(body)) >= 40),
  content_sha256 text GENERATED ALWAYS AS (encode(sha256(convert_to(title || E'\n' || body, 'UTF8')), 'hex')) STORED,
  legal_reviewed boolean NOT NULL DEFAULT false,
  reviewed_by text,
  reviewed_at timestamptz,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
);

ALTER TABLE pay_disclosures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pay_disclosures FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pay_disclosures FROM authenticated;
DROP POLICY IF EXISTS "authenticated_read_pay_disclosures" ON pay_disclosures;
CREATE POLICY "authenticated_read_pay_disclosures" ON pay_disclosures FOR SELECT TO authenticated USING (true);

-- Text can never change once published (acceptances reference its hash); only the review flag can.
CREATE OR REPLACE FUNCTION public.pay_disclosures_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Published disclosures cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.key <> OLD.key OR NEW.version <> OLD.version OR NEW.title <> OLD.title OR NEW.body <> OLD.body THEN
    RAISE EXCEPTION 'Disclosure text is immutable — publish a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pay_disclosures_guard ON pay_disclosures;
CREATE TRIGGER trg_pay_disclosures_guard BEFORE UPDATE OR DELETE ON pay_disclosures
  FOR EACH ROW EXECUTE FUNCTION public.pay_disclosures_guard();

CREATE TABLE IF NOT EXISTS pay_disclosure_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                 -- tenant (account owner id)
  accepted_by uuid NOT NULL,             -- auth user who clicked accept
  team_member_id uuid,
  disclosure_key text NOT NULL,
  version integer NOT NULL,
  content_sha256 text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (disclosure_key, version) REFERENCES pay_disclosures(key, version),
  UNIQUE (accepted_by, disclosure_key, version)
);
CREATE INDEX IF NOT EXISTS idx_pay_disclosure_acc_user ON pay_disclosure_acceptances(user_id, disclosure_key);

ALTER TABLE pay_disclosure_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pay_disclosure_acceptances FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pay_disclosure_acceptances FROM authenticated;
DROP POLICY IF EXISTS "read_own_pay_acceptances" ON pay_disclosure_acceptances;
CREATE POLICY "read_own_pay_acceptances" ON pay_disclosure_acceptances FOR SELECT TO authenticated
  USING (accepted_by = auth.uid() OR (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage()));

-- Seed DRAFT v1 texts. legal_reviewed = false => the product cannot go live until counsel
-- signs off (staff_pay_mark_disclosure_reviewed). Replace placeholders in [BRACKETS].
INSERT INTO pay_disclosures (key, version, title, body) VALUES
('instant_payout_fees', 1, 'Instant payout — fees and timing',
 E'DRAFT — pending legal review.\n\nInstant payout sends pay that your employer has ALREADY APPROVED to your linked debit card or account before the scheduled pay date.\n\n• Fee: shown to you in dollars before you confirm. You always see the exact amount you will receive.\n• Timing: usually within minutes, but not guaranteed. Your bank or card network may delay it.\n• Not a loan: you receive your own approved net pay; nothing is owed back.\n• Your standard payday method stays free. You are never required to use instant payout.\n• Money is moved by [LICENSED PAYMENT PARTNER — name at launch], not by Vireek.\n\n[COUNSEL: confirm money-transmission, state fee-disclosure and wage-payment-law wording.]'),
('ewa_terms', 1, 'Earned wage access — how it works',
 E'DRAFT — pending legal review.\n\nEarned wage access lets you take part of the pay you have ALREADY EARNED (approved hours and commission) before payday.\n\n• Limit: a percentage of your estimated earned take-home pay, minus any advance you have not yet repaid. The limit can change and may be zero.\n• Fee: a flat fee, shown in dollars before you confirm. No interest, no credit check, no tips required.\n• Repayment: the advance is deducted from your next paycheck. If that paycheck is too small, the remaining balance carries to the next one.\n• You choose each time; declining has no effect on your job or pay.\n• Funds are provided and moved by [LICENSED PAYMENT PARTNER — name at launch]. Vireek only calculates what is available from your employer''s pay records.\n\n[COUNSEL: confirm legal characterization of the advance, state EWA registration/disclosure rules, and wage-deduction authorization.]'),
('spend_card_terms', 1, 'Business spend card — terms',
 E'DRAFT — pending legal review.\n\nBusiness spend cards are for business expenses approved by your employer.\n\n• Cards are issued by [ISSUING BANK] through [CARD PROGRAM PARTNER]; Vireek is not a bank.\n• Your employer sets limits and allowed merchant categories. A purchase can be declined if it breaks a rule; the reason is shown.\n• Upload a receipt for purchases above your employer''s receipt threshold.\n• Personal purchases are not allowed. Your employer is responsible for the card balance.\n• Report a lost or stolen card to your employer immediately so it can be frozen.\n\n[COUNSEL: confirm cardholder agreement, program-manager and E-Sign disclosures.]'),
('capital_prescreen', 1, 'Working-capital pre-screen — what this is (and is not)',
 E'DRAFT — pending legal review.\n\nThis pre-screen only checks whether your Vireek revenue and invoice data meets the basic criteria to SEND AN APPLICATION to our lending partner.\n\n• It is NOT an offer, an approval, a credit decision or a promise of funding.\n• Vireek does not pull credit and does not decide who is approved. Only the lending partner decides, using its own criteria.\n• If you are not yet eligible, we show the specific reasons.\n• Nothing is shared with the lending partner until you submit an application.\n\n[COUNSEL: confirm commercial-financing disclosure obligations and adverse-action wording.]'),
('capital_application', 1, 'Working-capital application — data sharing and terms',
 E'DRAFT — pending legal review.\n\nBy applying you ask Vireek to send the lending partner a summary of your business revenue and the unpaid invoices you choose to put forward.\n\n• You are under no obligation to accept any offer.\n• Every offer shows the amount, total repayment, finance charge, term and estimated APR, set by the partner, before you can accept it.\n• Invoices put forward cannot be used for another application while this one is active.\n• Repayment terms, fees and remedies are in the partner''s agreement, not Vireek''s.\n• [DISCLOSE ANY REFERRAL COMPENSATION VIREEK RECEIVES.]\n\n[COUNSEL: confirm data-sharing consent, state commercial-financing disclosures (e.g. CA, NY, UT, FL and others), and fair-lending obligations.]')
ON CONFLICT (key, version) DO NOTHING;

-- =============================================================
-- 3. PRODUCT STATE (single source of truth for "can this tenant use this product?")
-- =============================================================

CREATE OR REPLACE FUNCTION public.pay_product_disclosure_keys(p_product text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_product
    WHEN 'instant_payouts' THEN ARRAY['instant_payout_fees']
    WHEN 'earned_wage_access' THEN ARRAY['ewa_terms']
    WHEN 'spend_cards' THEN ARRAY['spend_card_terms']
    WHEN 'capital' THEN ARRAY['capital_prescreen', 'capital_application']
    ELSE ARRAY[]::text[]
  END;
$$;

-- Service-role only (it accepts an arbitrary tenant id). Tenants use pay_get_my_availability().
CREATE OR REPLACE FUNCTION public.pay_product_state(p_product text, p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c pay_platform_controls%ROWTYPE;
  v_reason text := NULL;
BEGIN
  SELECT * INTO c FROM pay_platform_controls WHERE product = p_product;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('available', false, 'product', p_product, 'mode', 'sandbox', 'reason', 'unknown_product');
  END IF;

  IF c.killed_at IS NOT NULL THEN
    v_reason := 'killed';
  ELSIF NOT c.enabled THEN
    v_reason := 'platform_disabled';
  ELSIF p_tenant IS NULL THEN
    v_reason := 'no_tenant';
  ELSIF EXISTS (
    SELECT 1 FROM pay_tenant_controls t
     WHERE t.tenant_id = p_tenant AND t.frozen AND t.product IN ('all', p_product)
  ) THEN
    v_reason := 'tenant_frozen';
  ELSIF c.mode = 'live' AND EXISTS (
    SELECT 1 FROM unnest(public.pay_product_disclosure_keys(p_product)) AS k(key)
     WHERE COALESCE((SELECT d.legal_reviewed FROM pay_disclosures d WHERE d.key = k.key ORDER BY d.version DESC LIMIT 1), false) = false
  ) THEN
    v_reason := 'disclosures_not_reviewed';
  END IF;

  RETURN jsonb_build_object(
    'available', v_reason IS NULL,
    'product', c.product,
    'mode', c.mode,
    'reason', v_reason,
    'partner_name', c.partner_name,
    'fee_bps', c.fee_bps,
    'min_fee_cents', c.min_fee_cents,
    'max_fee_cents', c.max_fee_cents,
    'max_single_cents', c.max_single_cents,
    'max_daily_tenant_cents', c.max_daily_tenant_cents,
    'max_pct_of_accrued', c.max_pct_of_accrued,
    'config', c.config
  );
END;
$$;

-- Tenant-safe view for the UI: no caps, no agreement refs, just "can I use it, in which mode".
CREATE OR REPLACE FUNCTION public.pay_get_my_availability()
RETURNS TABLE (product text, available boolean, mode text, reason text, partner_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.product,
         (s->>'available')::boolean,
         s->>'mode',
         s->>'reason',
         s->>'partner_name'
    FROM pay_platform_controls c
   CROSS JOIN LATERAL (SELECT public.pay_product_state(c.product, public.get_account_owner_id()) AS s) x
   WHERE public.get_account_owner_id() IS NOT NULL
   ORDER BY c.product;
$$;

-- =============================================================
-- 4. DISCLOSURE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.pay_get_disclosure(p_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'key', d.key, 'version', d.version, 'title', d.title, 'body', d.body,
    'content_sha256', d.content_sha256, 'legal_reviewed', d.legal_reviewed,
    'accepted', EXISTS (
      SELECT 1 FROM pay_disclosure_acceptances a
       WHERE a.accepted_by = auth.uid() AND a.disclosure_key = d.key AND a.version = d.version)
  )
  FROM pay_disclosures d
  WHERE d.key = p_key AND auth.uid() IS NOT NULL
  ORDER BY d.version DESC
  LIMIT 1;
$$;

-- The caller accepts the LATEST version (and the exact hash they were shown must match).
CREATE OR REPLACE FUNCTION public.pay_accept_disclosure(p_key text, p_expected_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d pay_disclosures%ROWTYPE;
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  SELECT * INTO d FROM pay_disclosures WHERE key = p_key ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF p_expected_sha256 IS DISTINCT FROM d.content_sha256 THEN
    RETURN jsonb_build_object('status', 'stale_version');   -- text changed since the user loaded it
  END IF;

  INSERT INTO pay_disclosure_acceptances (user_id, accepted_by, team_member_id, disclosure_key, version, content_sha256)
  VALUES (v_owner, auth.uid(), public.get_my_team_member_id(), d.key, d.version, d.content_sha256)
  ON CONFLICT (accepted_by, disclosure_key, version) DO NOTHING;

  RETURN jsonb_build_object('status', 'accepted', 'version', d.version);
END;
$$;

-- Service-role: has this auth user accepted the latest version of the disclosure?
CREATE OR REPLACE FUNCTION public.pay_disclosure_accepted(p_auth_user uuid, p_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.version
    FROM (SELECT version FROM pay_disclosures WHERE key = p_key ORDER BY version DESC LIMIT 1) d
   WHERE EXISTS (SELECT 1 FROM pay_disclosure_acceptances a
                  WHERE a.accepted_by = p_auth_user AND a.disclosure_key = p_key AND a.version = d.version);
$$;

-- =============================================================
-- 5. PAYOUT ACCOUNTS + TRANSFER LEDGER
-- =============================================================

CREATE TABLE IF NOT EXISTS pay_payout_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_account_id text NOT NULL,
  account_type text NOT NULL DEFAULT 'debit_card' CHECK (account_type IN ('debit_card', 'bank_account')),
  last4 text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  instant_eligible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'restricted', 'removed')),
  sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_pay_payout_accounts_member ON pay_payout_accounts(team_member_id, status);

CREATE TABLE IF NOT EXISTS pay_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  holder_name text,
  kind text NOT NULL CHECK (kind IN ('instant_payout', 'earned_wage_advance')),
  status text NOT NULL DEFAULT 'pending_provider'
    CHECK (status IN ('pending_provider', 'processing', 'paid', 'failed', 'needs_review', 'reversed', 'canceled')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  receive_cents bigint GENERATED ALWAYS AS (amount_cents - fee_cents) STORED,
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  provider text NOT NULL,
  sandbox boolean NOT NULL,
  external_id text,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  pay_run_item_id uuid REFERENCES pay_run_items(id) ON DELETE SET NULL,
  payout_account_id uuid REFERENCES pay_payout_accounts(id) ON DELETE SET NULL,
  disclosure_key text,
  disclosure_version integer,
  eligibility_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  marked_item_paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (fee_cents < amount_cents),
  UNIQUE (user_id, idempotency_key)
);

-- One live instant payout per pay-run item, ever (double-pay guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_transfers_item_active
  ON pay_transfers(pay_run_item_id)
  WHERE kind = 'instant_payout' AND status IN ('pending_provider', 'processing', 'paid', 'needs_review');
CREATE INDEX IF NOT EXISTS idx_pay_transfers_user_created ON pay_transfers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_transfers_member_created ON pay_transfers(team_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_transfers_pending ON pay_transfers(created_at) WHERE status = 'pending_provider';
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_transfers_external ON pay_transfers(provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pay_transfer_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES pay_transfers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_transfer_events_transfer ON pay_transfer_events(transfer_id, id);

CREATE TABLE IF NOT EXISTS pay_advance_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  transfer_id uuid NOT NULL REFERENCES pay_transfers(id) ON DELETE RESTRICT,
  pay_run_id uuid NOT NULL REFERENCES pay_runs(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  recorded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, pay_run_id)
);
CREATE INDEX IF NOT EXISTS idx_pay_advance_recoveries_user ON pay_advance_recoveries(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trigger_pay_payout_accounts_updated_at ON pay_payout_accounts;
CREATE TRIGGER trigger_pay_payout_accounts_updated_at BEFORE UPDATE ON pay_payout_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_pay_transfers_updated_at ON pay_transfers;
CREATE TRIGGER trigger_pay_transfers_updated_at BEFORE UPDATE ON pay_transfers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Ledger immutability: money fields and ownership never change after insert.
CREATE OR REPLACE FUNCTION public.pay_transfers_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.fee_cents <> OLD.fee_cents OR NEW.sandbox <> OLD.sandbox OR NEW.provider <> OLD.provider
     OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'Transfer money fields are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pay_transfers_guard ON pay_transfers;
CREATE TRIGGER trg_pay_transfers_guard BEFORE UPDATE ON pay_transfers
  FOR EACH ROW EXECUTE FUNCTION public.pay_transfers_guard();

ALTER TABLE pay_payout_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_transfer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_advance_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pay_payout_accounts, pay_transfers, pay_transfer_events, pay_advance_recoveries FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pay_payout_accounts, pay_transfers, pay_transfer_events, pay_advance_recoveries FROM authenticated;

DROP POLICY IF EXISTS "read_pay_payout_accounts" ON pay_payout_accounts;
CREATE POLICY "read_pay_payout_accounts" ON pay_payout_accounts FOR SELECT TO authenticated
  USING (team_member_id = public.get_my_team_member_id()
         OR (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage()));

DROP POLICY IF EXISTS "read_pay_transfers" ON pay_transfers;
CREATE POLICY "read_pay_transfers" ON pay_transfers FOR SELECT TO authenticated
  USING (team_member_id = public.get_my_team_member_id()
         OR (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage()));

DROP POLICY IF EXISTS "managers_read_pay_transfer_events" ON pay_transfer_events;
CREATE POLICY "managers_read_pay_transfer_events" ON pay_transfer_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());

DROP POLICY IF EXISTS "managers_read_pay_advance_recoveries" ON pay_advance_recoveries;
CREATE POLICY "managers_read_pay_advance_recoveries" ON pay_advance_recoveries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());

-- =============================================================
-- 6. SERVICE-ONLY RPCs (called by edge functions with the service role)
-- =============================================================

-- Outstanding (un-repaid) EWA principal for one employee.
CREATE OR REPLACE FUNCTION public.pay_advance_outstanding_cents(p_employee_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(t.amount_cents - COALESCE(r.recovered, 0)), 0)::bigint
    FROM pay_transfers t
    LEFT JOIN LATERAL (SELECT SUM(amount_cents) AS recovered FROM pay_advance_recoveries WHERE transfer_id = t.id) r ON true
   WHERE t.employee_id = p_employee_id
     AND t.kind = 'earned_wage_advance'
     AND t.status IN ('pending_provider', 'processing', 'paid', 'needs_review');
$$;

-- Raw inputs for the availability engine (math lives in _shared/pay/ewaEngine.ts, tested).
-- Only APPROVED hours/commission count; pending/rejected never do.
CREATE OR REPLACE FUNCTION public.pay_get_ewa_inputs(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e employees%ROWTYPE;
  v_last_final date;
  v_start date;
  v_period_days integer;
  v_reg numeric;
  v_ot numeric;
  v_comm bigint;
  v_today bigint;
BEGIN
  SELECT * INTO e FROM employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT max(r.pay_period_end) INTO v_last_final
    FROM pay_runs r WHERE r.user_id = e.user_id AND r.status IN ('approved', 'paid');

  v_start := COALESCE(v_last_final + 1, e.created_at::date);
  v_period_days := CASE e.pay_schedule WHEN 'weekly' THEN 7 WHEN 'biweekly' THEN 14 WHEN 'semimonthly' THEN 15 ELSE 30 END;

  SELECT COALESCE(SUM(t.regular_hours), 0), COALESCE(SUM(t.overtime_hours), 0)
    INTO v_reg, v_ot
    FROM timesheets t
    LEFT JOIN pay_run_items i ON i.id = t.pay_run_item_id
    LEFT JOIN pay_runs r ON r.id = i.pay_run_id
   WHERE t.employee_id = e.id AND t.status = 'approved'
     AND (t.pay_run_item_id IS NULL OR r.status = 'draft');

  SELECT COALESCE(SUM(cr.commission_cents), 0)::bigint
    INTO v_comm
    FROM commission_records cr
    LEFT JOIN pay_run_items i ON i.id = cr.pay_run_item_id
    LEFT JOIN pay_runs r ON r.id = i.pay_run_id
   WHERE cr.employee_id = e.id AND cr.status = 'approved'
     AND (cr.pay_run_item_id IS NULL OR r.status = 'draft');

  SELECT COALESCE(SUM(t.amount_cents), 0)::bigint INTO v_today
    FROM pay_transfers t
   WHERE t.user_id = e.user_id AND t.created_at >= date_trunc('day', now())
     AND t.status IN ('pending_provider', 'processing', 'paid', 'needs_review');

  RETURN jsonb_build_object(
    'employee_id', e.id,
    'owner_id', e.user_id,
    'active', e.active,
    'pay_type', e.pay_type,
    'hourly_rate_cents', COALESCE(e.hourly_rate_cents, 0),
    'annual_salary_cents', COALESCE(e.annual_salary_cents, 0),
    'overtime_multiplier', e.overtime_multiplier,
    'pay_schedule', e.pay_schedule,
    'withholding_pct', e.default_tax_withholding_percent,
    'period_days', v_period_days,
    'elapsed_days', LEAST(v_period_days, GREATEST(0, (current_date - v_start) + 1)),
    'approved_regular_hours', v_reg,
    'approved_overtime_hours', v_ot,
    'approved_commission_cents', v_comm,
    'outstanding_advance_cents', public.pay_advance_outstanding_cents(e.id),
    'tenant_transferred_today_cents', v_today
  );
END;
$$;

-- Approved-but-unpaid pay-run items this employee could take early (net pay only).
CREATE OR REPLACE FUNCTION public.pay_list_instant_items(p_employee_id uuid)
RETURNS TABLE (item_id uuid, pay_run_id uuid, pay_date date, net_pay_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, r.id, r.pay_date, i.net_pay_cents::bigint
    FROM pay_run_items i
    JOIN pay_runs r ON r.id = i.pay_run_id
    JOIN employees e ON e.id = i.employee_id
   WHERE i.employee_id = p_employee_id
     AND r.status = 'approved' AND r.user_id = e.user_id
     AND i.paid_at IS NULL AND i.net_pay_cents > 0
     AND NOT EXISTS (
       SELECT 1 FROM pay_transfers t
        WHERE t.pay_run_item_id = i.id AND t.kind = 'instant_payout'
          AND t.status IN ('pending_provider', 'processing', 'paid', 'needs_review'))
   ORDER BY r.pay_date, i.id;
$$;

-- Atomic reservation: lock -> idempotency -> caps -> insert. The edge function computed
-- fee/ceiling with the tested engine; this function re-checks everything money-critical.
CREATE OR REPLACE FUNCTION public.pay_reserve_transfer(
  p_user_id uuid, p_team_member_id uuid, p_employee_id uuid, p_holder_name text,
  p_kind text, p_amount_cents bigint, p_fee_cents bigint, p_ceiling_cents bigint,
  p_daily_cap_cents bigint, p_idempotency_key text, p_pay_run_item_id uuid,
  p_provider text, p_sandbox boolean, p_payout_account_id uuid,
  p_disclosure_key text, p_disclosure_version integer, p_snapshot jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing pay_transfers%ROWTYPE;
  v_outstanding bigint;
  v_today bigint;
  v_item record;
  v_new pay_transfers%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('instant_payout', 'earned_wage_advance') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'invalid_kind');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_fee_cents IS NULL OR p_fee_cents < 0 OR p_fee_cents >= p_amount_cents THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'invalid_amount');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pay_transfer:' || p_employee_id::text, 0));

  SELECT * INTO v_existing FROM pay_transfers WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.employee_id IS DISTINCT FROM p_employee_id OR v_existing.amount_cents <> p_amount_cents OR v_existing.kind <> p_kind THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'idempotency_key_reused');
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'transfer', to_jsonb(v_existing));
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_today
    FROM pay_transfers
   WHERE user_id = p_user_id AND created_at >= date_trunc('day', now())
     AND status IN ('pending_provider', 'processing', 'paid', 'needs_review');
  IF p_daily_cap_cents IS NOT NULL AND v_today + p_amount_cents > p_daily_cap_cents THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'daily_cap_reached');
  END IF;

  IF p_kind = 'earned_wage_advance' THEN
    v_outstanding := public.pay_advance_outstanding_cents(p_employee_id);
    IF p_ceiling_cents IS NULL OR p_amount_cents + v_outstanding > p_ceiling_cents THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'exceeds_available');
    END IF;
  ELSE
    SELECT i.net_pay_cents, i.paid_at, r.status AS run_status, i.employee_id, r.user_id
      INTO v_item
      FROM pay_run_items i JOIN pay_runs r ON r.id = i.pay_run_id
     WHERE i.id = p_pay_run_item_id;
    IF NOT FOUND OR v_item.user_id <> p_user_id OR v_item.employee_id <> p_employee_id
       OR v_item.run_status <> 'approved' OR v_item.paid_at IS NOT NULL
       OR v_item.net_pay_cents <> p_amount_cents THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'item_not_eligible');
    END IF;
  END IF;

  BEGIN
    INSERT INTO pay_transfers (
      user_id, team_member_id, employee_id, holder_name, kind, status, amount_cents, fee_cents,
      provider, sandbox, idempotency_key, pay_run_item_id, payout_account_id,
      disclosure_key, disclosure_version, eligibility_snapshot
    ) VALUES (
      p_user_id, p_team_member_id, p_employee_id, left(p_holder_name, 120), p_kind, 'pending_provider', p_amount_cents, p_fee_cents,
      p_provider, p_sandbox, p_idempotency_key, p_pay_run_item_id, p_payout_account_id,
      p_disclosure_key, p_disclosure_version, COALESCE(p_snapshot, '{}'::jsonb)
    ) RETURNING * INTO v_new;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'item_already_requested');
  END;

  INSERT INTO pay_transfer_events (transfer_id, user_id, event_type, to_status, payload)
  VALUES (v_new.id, p_user_id, 'reserved', 'pending_provider',
          jsonb_build_object('amount_cents', p_amount_cents, 'fee_cents', p_fee_cents, 'sandbox', p_sandbox));

  RETURN jsonb_build_object('status', 'reserved', 'transfer', to_jsonb(v_new));
END;
$$;

-- State machine for provider results / webhooks. Idempotent: re-applying the same state is a no-op.
CREATE OR REPLACE FUNCTION public.pay_finalize_transfer(
  p_transfer_id uuid, p_status text, p_external_id text, p_failure_code text, p_event jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t pay_transfers%ROWTYPE;
  v_ok boolean;
BEGIN
  SELECT * INTO t FROM pay_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF t.status = p_status THEN RETURN jsonb_build_object('status', 'unchanged', 'transfer', to_jsonb(t)); END IF;

  v_ok := CASE t.status
    WHEN 'pending_provider' THEN p_status IN ('processing', 'paid', 'failed', 'needs_review', 'canceled')
    WHEN 'processing'       THEN p_status IN ('paid', 'failed', 'reversed', 'needs_review')
    WHEN 'needs_review'     THEN p_status IN ('processing', 'paid', 'failed', 'reversed')
    WHEN 'paid'             THEN p_status IN ('reversed')
    ELSE false
  END;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('status', 'invalid_transition', 'from', t.status, 'to', p_status);
  END IF;

  UPDATE pay_transfers
     SET status = p_status,
         external_id = COALESCE(p_external_id, external_id),
         failure_code = CASE WHEN p_status IN ('failed', 'needs_review', 'reversed') THEN left(p_failure_code, 120) ELSE failure_code END,
         settled_at = CASE WHEN p_status IN ('paid', 'failed', 'reversed', 'canceled') THEN now() ELSE settled_at END
   WHERE id = t.id
   RETURNING * INTO t;

  IF t.kind = 'instant_payout' AND t.pay_run_item_id IS NOT NULL THEN
    IF p_status = 'paid' THEN
      UPDATE pay_run_items SET paid_at = now() WHERE id = t.pay_run_item_id AND paid_at IS NULL;
      IF FOUND THEN UPDATE pay_transfers SET marked_item_paid = true WHERE id = t.id; END IF;
    ELSIF p_status = 'reversed' AND t.marked_item_paid THEN
      UPDATE pay_run_items SET paid_at = NULL WHERE id = t.pay_run_item_id;
      UPDATE pay_transfers SET marked_item_paid = false WHERE id = t.id;
    END IF;
  END IF;

  INSERT INTO pay_transfer_events (transfer_id, user_id, event_type, from_status, to_status, payload)
  VALUES (t.id, t.user_id, 'status_change', NULL, p_status, COALESCE(p_event, '{}'::jsonb));

  RETURN jsonb_build_object('status', 'applied', 'transfer', to_jsonb(t));
END;
$$;

-- A reservation the provider never answered is a money-in-flight risk: flag for human review.
CREATE OR REPLACE FUNCTION public.pay_flag_stuck_transfers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
  r record;
BEGIN
  FOR r IN SELECT id FROM pay_transfers WHERE status = 'pending_provider' AND created_at < now() - interval '10 minutes' LOOP
    PERFORM public.pay_finalize_transfer(r.id, 'needs_review', NULL, 'provider_no_response', '{"source":"stuck_sweeper"}'::jsonb);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- =============================================================
-- 7. PAY-RUN SETTLEMENT (manager) — what to actually disburse after instant payouts + advances
-- =============================================================

CREATE OR REPLACE FUNCTION public.pay_run_settlement(p_pay_run_id uuid)
RETURNS TABLE (
  item_id uuid, employee_id uuid, employee_name text, net_pay_cents bigint,
  instant_paid_cents bigint, outstanding_advance_cents bigint, recommended_recovery_cents bigint, disbursement_due_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.tech_pay_can_manage() THEN
    RAISE EXCEPTION 'Owner or admin only' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pay_runs WHERE id = p_pay_run_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Pay run not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT i.id AS item_id, i.employee_id, e.full_name, i.net_pay_cents::bigint AS net,
           COALESCE((SELECT SUM(t.amount_cents) FROM pay_transfers t
                      WHERE t.pay_run_item_id = i.id AND t.kind = 'instant_payout' AND t.status = 'paid'), 0)::bigint AS instant_paid,
           public.pay_advance_outstanding_cents(i.employee_id) AS outstanding
      FROM pay_run_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.pay_run_id = p_pay_run_id
  )
  SELECT b.item_id, b.employee_id, b.full_name, b.net, b.instant_paid, b.outstanding,
         GREATEST(0, LEAST(b.outstanding, b.net - b.instant_paid)) AS rec,
         GREATEST(0, b.net - b.instant_paid - GREATEST(0, LEAST(b.outstanding, b.net - b.instant_paid))) AS due
    FROM base b
   ORDER BY b.full_name;
END;
$$;

-- Records (idempotently, oldest advance first) the recoveries the settlement report recommends.
-- It does NOT touch payroll tables or the ledger: the cash deduction happens when net pay is disbursed.
CREATE OR REPLACE FUNCTION public.pay_record_advance_recovery(p_pay_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_run pay_runs%ROWTYPE;
  s record;
  t record;
  v_left bigint;
  v_take bigint;
  v_total bigint := 0;
BEGIN
  IF NOT public.tech_pay_can_manage() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  SELECT * INTO v_run FROM pay_runs WHERE id = p_pay_run_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_run.status NOT IN ('approved', 'paid') THEN RETURN jsonb_build_object('status', 'run_not_final'); END IF;

  FOR s IN SELECT * FROM public.pay_run_settlement(p_pay_run_id) WHERE recommended_recovery_cents > 0 LOOP
    v_left := s.recommended_recovery_cents;
    FOR t IN
      SELECT x.id, x.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM pay_advance_recoveries WHERE transfer_id = x.id), 0) AS remaining
        FROM pay_transfers x
       WHERE x.employee_id = s.employee_id AND x.kind = 'earned_wage_advance'
         AND x.status IN ('pending_provider', 'processing', 'paid', 'needs_review')
       ORDER BY x.created_at
    LOOP
      EXIT WHEN v_left <= 0;
      CONTINUE WHEN t.remaining <= 0;
      v_take := LEAST(v_left, t.remaining);
      INSERT INTO pay_advance_recoveries (user_id, transfer_id, pay_run_id, amount_cents)
      VALUES (v_owner, t.id, p_pay_run_id, v_take)
      ON CONFLICT (transfer_id, pay_run_id) DO NOTHING;
      IF FOUND THEN
        v_left := v_left - v_take;
        v_total := v_total + v_take;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'recorded', 'recovered_cents', v_total);
END;
$$;

-- =============================================================
-- 8. STAFF RPCs (kill switch, limits, tenant freeze, disclosure review)
-- =============================================================

CREATE OR REPLACE FUNCTION public.staff_pay_list_controls()
RETURNS SETOF pay_platform_controls
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT * FROM pay_platform_controls ORDER BY product;
END;
$$;

-- p_patch keys: enabled, mode, partner_name, partner_agreement_ref, fee_bps, min_fee_cents,
-- max_fee_cents, max_single_cents, max_daily_tenant_cents, max_pct_of_accrued, config.
-- A written reason (>= 8 chars) is mandatory for every change.
CREATE OR REPLACE FUNCTION public.staff_pay_update_control(p_product text, p_patch jsonb, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c pay_platform_controls%ROWTYPE;
  v_enabled boolean;
  v_mode text;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A reason of at least 8 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Patch must be an object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
              WHERE k NOT IN ('enabled','mode','partner_name','partner_agreement_ref','fee_bps','min_fee_cents',
                              'max_fee_cents','max_single_cents','max_daily_tenant_cents','max_pct_of_accrued','config')) THEN
    RAISE EXCEPTION 'Unknown field in patch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO c FROM pay_platform_controls WHERE product = p_product FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product' USING ERRCODE = 'P0002'; END IF;

  PERFORM set_config('vireek.pay_reason', btrim(p_reason), true);

  v_enabled := COALESCE((p_patch->>'enabled')::boolean, c.enabled);
  v_mode := COALESCE(p_patch->>'mode', c.mode);

  UPDATE pay_platform_controls SET
    enabled = v_enabled,
    mode = v_mode,
    partner_name = CASE WHEN p_patch ? 'partner_name' THEN NULLIF(btrim(p_patch->>'partner_name'), '') ELSE partner_name END,
    partner_agreement_ref = CASE WHEN p_patch ? 'partner_agreement_ref' THEN NULLIF(btrim(p_patch->>'partner_agreement_ref'), '') ELSE partner_agreement_ref END,
    fee_bps = COALESCE((p_patch->>'fee_bps')::integer, fee_bps),
    min_fee_cents = COALESCE((p_patch->>'min_fee_cents')::integer, min_fee_cents),
    max_fee_cents = COALESCE((p_patch->>'max_fee_cents')::integer, max_fee_cents),
    max_single_cents = COALESCE((p_patch->>'max_single_cents')::bigint, max_single_cents),
    max_daily_tenant_cents = COALESCE((p_patch->>'max_daily_tenant_cents')::bigint, max_daily_tenant_cents),
    max_pct_of_accrued = COALESCE((p_patch->>'max_pct_of_accrued')::integer, max_pct_of_accrued),
    config = CASE WHEN p_patch ? 'config' THEN p_patch->'config' ELSE config END,
    -- Going live needs an explicit approver stamp; leaving live clears it.
    live_approved_by = CASE WHEN v_mode = 'live' AND c.mode <> 'live' THEN auth.uid() WHEN v_mode = 'sandbox' THEN NULL ELSE live_approved_by END,
    live_approved_at = CASE WHEN v_mode = 'live' AND c.mode <> 'live' THEN now() WHEN v_mode = 'sandbox' THEN NULL ELSE live_approved_at END,
    -- Re-enabling clears the kill state; the audit row keeps who/why.
    killed_at = CASE WHEN v_enabled AND NOT c.enabled THEN NULL ELSE killed_at END,
    killed_by = CASE WHEN v_enabled AND NOT c.enabled THEN NULL ELSE killed_by END,
    kill_reason = CASE WHEN v_enabled AND NOT c.enabled THEN NULL ELSE kill_reason END,
    updated_at = now(),
    updated_by = auth.uid()
  WHERE product = p_product;
END;
$$;

-- PANIC BUTTON: every product off, immediately, one call.
CREATE OR REPLACE FUNCTION public.staff_pay_kill_all(p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A reason of at least 8 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.pay_reason', 'KILL ALL: ' || btrim(p_reason), true);
  UPDATE pay_platform_controls
     SET enabled = false, killed_at = now(), killed_by = auth.uid(), kill_reason = btrim(p_reason),
         updated_at = now(), updated_by = auth.uid()
   WHERE killed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pay_set_tenant_freeze(p_tenant uuid, p_product text, p_frozen boolean, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF p_product NOT IN ('all', 'instant_payouts', 'earned_wage_access', 'spend_cards', 'capital') THEN
    RAISE EXCEPTION 'Unknown product' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_frozen THEN
    INSERT INTO pay_tenant_controls (tenant_id, product, frozen, reason)
    VALUES (p_tenant, p_product, true, COALESCE(p_reason, ''))
    ON CONFLICT (tenant_id, product) DO UPDATE SET frozen = true, reason = EXCLUDED.reason, set_by = auth.uid(), set_at = now();
  ELSE
    PERFORM set_config('vireek.pay_reason', COALESCE(NULLIF(btrim(p_reason), ''), 'unfrozen by staff'), true);
    DELETE FROM pay_tenant_controls WHERE tenant_id = p_tenant AND product = p_product;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pay_list_frozen_tenants()
RETURNS TABLE (tenant_id uuid, product text, reason text, set_at timestamptz, email text, company_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT t.tenant_id, t.product, t.reason, t.set_at, p.email, p.company_name
    FROM pay_tenant_controls t JOIN profiles p ON p.id = t.tenant_id
   WHERE t.frozen ORDER BY t.set_at DESC LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pay_list_audit(p_limit integer DEFAULT 50)
RETURNS TABLE (id bigint, subject text, action text, reason text, created_at timestamptz, actor_email text, after jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT a.id, a.subject, a.action, a.reason, a.created_at, p.email, a.after
    FROM pay_control_audit a LEFT JOIN profiles p ON p.id = a.actor
   ORDER BY a.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pay_mark_disclosure_reviewed(p_key text, p_version integer, p_reviewer_ref text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reviewer_ref, ''))) < 3 THEN
    RAISE EXCEPTION 'Reviewer reference (counsel name / memo id) is required' USING ERRCODE = '22023';
  END IF;
  UPDATE pay_disclosures SET legal_reviewed = true, reviewed_by = btrim(p_reviewer_ref), reviewed_at = now()
   WHERE key = p_key AND version = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Disclosure not found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

-- New version = new row; previous acceptances stay valid for audit but users must re-accept.
CREATE OR REPLACE FUNCTION public.staff_pay_publish_disclosure(p_key text, p_title text, p_body text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pay_disclosures WHERE key = p_key) THEN
    RAISE EXCEPTION 'Unknown disclosure key' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next FROM pay_disclosures WHERE key = p_key;
  INSERT INTO pay_disclosures (key, version, title, body) VALUES (p_key, v_next, p_title, p_body);
  RETURN v_next;
END;
$$;

-- =============================================================
-- 9. GRANTS
-- =============================================================

-- Service-only: never callable from the browser.
REVOKE ALL ON FUNCTION public.pay_product_state(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_disclosure_accepted(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_advance_outstanding_cents(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_get_ewa_inputs(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_list_instant_items(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_reserve_transfer(uuid, uuid, uuid, text, text, bigint, bigint, bigint, bigint, text, uuid, text, boolean, uuid, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_finalize_transfer(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_flag_stuck_transfers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_controls_audit() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pay_product_state(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_disclosure_accepted(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_advance_outstanding_cents(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_get_ewa_inputs(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_list_instant_items(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_reserve_transfer(uuid, uuid, uuid, text, text, bigint, bigint, bigint, bigint, text, uuid, text, boolean, uuid, text, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_finalize_transfer(uuid, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_flag_stuck_transfers() TO service_role;

-- Signed-in users.
REVOKE ALL ON FUNCTION public.pay_get_my_availability() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_get_disclosure(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_accept_disclosure(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_run_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_record_advance_recovery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_get_my_availability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_get_disclosure(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_accept_disclosure(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_run_settlement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_record_advance_recovery(uuid) TO authenticated;

-- Staff (each function re-checks is_vireek_staff).
REVOKE ALL ON FUNCTION public.staff_pay_list_controls() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_update_control(text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_kill_all(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_set_tenant_freeze(uuid, text, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_list_frozen_tenants() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_list_audit(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_mark_disclosure_reviewed(text, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_pay_publish_disclosure(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_pay_list_controls() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_update_control(text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_kill_all(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_set_tenant_freeze(uuid, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_list_frozen_tenants() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_list_audit(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_mark_disclosure_reviewed(text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_pay_publish_disclosure(text, text, text) TO authenticated;

-- Stuck-reservation sweeper every 5 minutes (only if pg_cron exists in this project).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pay-flag-stuck-transfers';
    PERFORM cron.schedule('pay-flag-stuck-transfers', '*/5 * * * *', 'SELECT public.pay_flag_stuck_transfers()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END;
$$;

COMMENT ON TABLE pay_transfers IS
  'Ledger of instant payouts and earned-wage advances to technicians. Money is moved by the licensed partner; Vireek records and gates. sandbox rows are simulations.';
COMMENT ON TABLE pay_platform_controls IS
  'Per-product kill switch + sandbox/live mode + disclosed fee schedule and caps. Fail-closed: enabled defaults to false.';
