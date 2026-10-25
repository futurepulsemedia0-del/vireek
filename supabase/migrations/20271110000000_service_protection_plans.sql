/*
  # Service Protection Plans (extended-warranty / protection plans)

  Sell a protection plan on a quote (customer checkout) or on an invoice, link it to the
  customer's equipment, adjudicate + pay claims, renew it, and account for premium,
  claims reserve and earned/unearned revenue.

  Distinct from memberships (recurring maintenance programs): a protection plan is a ONE-TIME
  priced contract with a fixed term, deductible, limits, waiting period and a claims workflow.

  ## What it reuses (nothing is duplicated)
  - `equipment`            -> covered units (via protection_contract_equipment)
  - `warranty_claims`      -> plan claims are rows here with claim_type = 'protection_plan'
                              (manufacturer claims stay claim_type = 'manufacturer', default)
  - `invoices`             -> plan is added as an invoice line item; paying the invoice activates it
  - `quotes.optional_items`-> plan is offered as a customer-toggled add-on at quote acceptance
                              (item id = 'protection:<template uuid>'); accepting creates the contract

  ## Money rules (mirrored 1:1 in src/lib/protectionPlans.ts - change one, change the other)
  - All money = integer cents. Premium recognised = plan price (pre-tax).
  - Coverage: coverage_end = start + term_months - 1 day (inclusive). Earned premium is straight-line, daily:
      earned = floor(price * clamp(as_of - start + 1, 0, term_days) / term_days)
  - Cancellation refund (effective date = first uncovered day):
      free-look (days used <= free_look_days, no paid and no non-denied claims) -> full price
      otherwise -> max(0, floor(price * unused_days / term_days) - cancellation_fee - claims_paid), capped at price
  - Claim payout = min(claimed - deductible, per_claim_limit, aggregate_remaining) floored at 0.
    claimed_amount_cents = gross repair cost, approved_amount_cents = net payout to the customer.
  - Reserve: reserve_percent of premium is earmarked at activation (ledger reserve_funded). Payouts draw it
    down (claim_paid). Remaining reserve is released 30 days after coverage ends (claims reporting window)
    once no claim is open, or at cancellation.

  ## Safety
  - Contracts, links and ledger are written ONLY by SECURITY DEFINER RPCs/triggers (no client write policies).
  - Ledger is append-only (UPDATE always blocked, DELETE blocked except FK cascades).
  - Plan claims in warranty_claims cannot be created/changed/deleted directly from the client.
  - Activation from an invoice payment can never block or fail the payment: problems are recorded in
    protection_contracts.activation_blocker and shown in the UI.

  ## Deploy
    1. Run this migration (idempotent).
    2. Apply the code edits delivered with it.
    No edge function is required. Optional daily job is registered automatically only if pg_cron is enabled.
*/

-- =============================================================
-- 0. Shared helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.protection_text_array_ok(p_arr text[], p_max_items integer, p_max_len integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(cardinality(p_arr), 0) <= p_max_items
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(p_arr, '{}'::text[])) AS x
       WHERE x IS NULL OR btrim(x) = '' OR length(x) > p_max_len
     );
$$;

-- coverage_end is inclusive: start + N months - 1 day
CREATE OR REPLACE FUNCTION public.protection_coverage_end(p_start date, p_term_months integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ((p_start + make_interval(months => p_term_months))::date - 1);
$$;

CREATE OR REPLACE FUNCTION public.protection_earned_cents(p_price bigint, p_start date, p_end date, p_as_of date)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_as_of IS NULL THEN 0::bigint
    ELSE (p_price * LEAST(GREATEST(p_as_of - p_start + 1, 0), p_end - p_start + 1)::bigint)
         / (p_end - p_start + 1)::bigint
  END;
$$;

CREATE OR REPLACE FUNCTION public.protection_refund_cents(
  p_price bigint,
  p_start date,
  p_end date,
  p_effective date,
  p_free_look_days integer,
  p_fee bigint,
  p_paid_out bigint,
  p_claims_filed integer
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_total integer;
  v_used integer;
  v_unearned bigint;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RETURN p_price;
  END IF;
  v_total := p_end - p_start + 1;
  v_used := LEAST(GREATEST(p_effective - p_start, 0), v_total);

  IF (p_effective - p_start) <= COALESCE(p_free_look_days, 0)
     AND COALESCE(p_paid_out, 0) = 0
     AND COALESCE(p_claims_filed, 0) = 0 THEN
    RETURN p_price;
  END IF;

  v_unearned := (p_price * (v_total - v_used)::bigint) / v_total::bigint;
  RETURN LEAST(p_price, GREATEST(0, v_unearned - COALESCE(p_fee, 0) - COALESCE(p_paid_out, 0)));
END;
$$;

CREATE OR REPLACE FUNCTION public.protection_payable_cents(
  p_claimed bigint,
  p_deductible bigint,
  p_per_claim_limit bigint,
  p_aggregate_remaining bigint
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_net bigint := GREATEST(COALESCE(p_claimed, 0) - COALESCE(p_deductible, 0), 0);
BEGIN
  IF p_per_claim_limit IS NOT NULL THEN v_net := LEAST(v_net, p_per_claim_limit); END IF;
  IF p_aggregate_remaining IS NOT NULL THEN v_net := LEAST(v_net, GREATEST(p_aggregate_remaining, 0)); END IF;
  RETURN v_net;
END;
$$;

-- =============================================================
-- 1. Plan catalog
-- =============================================================

CREATE TABLE IF NOT EXISTS public.protection_plan_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 1 AND 10000000),
  renewal_price_cents integer CHECK (renewal_price_cents IS NULL OR renewal_price_cents BETWEEN 1 AND 10000000),
  deductible_cents integer NOT NULL DEFAULT 0 CHECK (deductible_cents BETWEEN 0 AND 1000000),
  per_claim_limit_cents integer CHECK (per_claim_limit_cents IS NULL OR per_claim_limit_cents > 0),
  aggregate_limit_cents integer CHECK (aggregate_limit_cents IS NULL OR aggregate_limit_cents > 0),
  waiting_period_days integer NOT NULL DEFAULT 30 CHECK (waiting_period_days BETWEEN 0 AND 365),
  free_look_days integer NOT NULL DEFAULT 30 CHECK (free_look_days BETWEEN 0 AND 90),
  cancellation_fee_cents integer NOT NULL DEFAULT 0 CHECK (cancellation_fee_cents BETWEEN 0 AND 1000000),
  reserve_percent numeric(5,2) NOT NULL DEFAULT 35 CHECK (reserve_percent BETWEEN 0 AND 100),
  max_equipment integer NOT NULL DEFAULT 1 CHECK (max_equipment BETWEEN 1 AND 50),
  eligible_equipment_types text[] NOT NULL DEFAULT '{}'
    CHECK (public.protection_text_array_ok(eligible_equipment_types, 30, 60)),
  max_equipment_age_years integer CHECK (max_equipment_age_years IS NULL OR max_equipment_age_years BETWEEN 0 AND 60),
  covered_items text[] NOT NULL DEFAULT '{}'
    CHECK (public.protection_text_array_ok(covered_items, 30, 120)),
  exclusions text[] NOT NULL DEFAULT '{}'
    CHECK (public.protection_text_array_ok(exclusions, 30, 160)),
  terms text NOT NULL DEFAULT '' CHECK (length(terms) <= 20000),
  renewable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT protection_templates_limits_ordered
    CHECK (per_claim_limit_cents IS NULL OR aggregate_limit_cents IS NULL OR per_claim_limit_cents <= aggregate_limit_cents)
);

CREATE INDEX IF NOT EXISTS idx_protection_templates_user ON public.protection_plan_templates (user_id, active, sort_order, created_at);

DROP TRIGGER IF EXISTS trg_protection_templates_updated_at ON public.protection_plan_templates;
CREATE TRIGGER trg_protection_templates_updated_at
  BEFORE UPDATE ON public.protection_plan_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.protection_plan_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_protection_templates" ON public.protection_plan_templates;
CREATE POLICY "select_protection_templates" ON public.protection_plan_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_protection_templates" ON public.protection_plan_templates;
CREATE POLICY "insert_protection_templates" ON public.protection_plan_templates FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "update_protection_templates" ON public.protection_plan_templates;
CREATE POLICY "update_protection_templates" ON public.protection_plan_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'))
  WITH CHECK (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

DROP POLICY IF EXISTS "delete_protection_templates" ON public.protection_plan_templates;
CREATE POLICY "delete_protection_templates" ON public.protection_plan_templates FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

-- =============================================================
-- 2. Contracts (sold plans) - terms are SNAPSHOTTED at sale
-- =============================================================

CREATE TABLE IF NOT EXISTS public.protection_counters (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0
);
ALTER TABLE public.protection_counters ENABLE ROW LEVEL SECURITY;
-- no policies: internal counter, written only by SECURITY DEFINER code

CREATE TABLE IF NOT EXISTS public.protection_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  template_id uuid REFERENCES public.protection_plan_templates(id) ON DELETE SET NULL,
  contract_number text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'invoice', 'quote', 'renewal')),
  source_ref text,

  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,

  plan_name text NOT NULL,
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 1 AND 10000000),
  deductible_cents integer NOT NULL DEFAULT 0 CHECK (deductible_cents >= 0),
  per_claim_limit_cents integer CHECK (per_claim_limit_cents IS NULL OR per_claim_limit_cents > 0),
  aggregate_limit_cents integer CHECK (aggregate_limit_cents IS NULL OR aggregate_limit_cents > 0),
  waiting_period_days integer NOT NULL DEFAULT 0 CHECK (waiting_period_days BETWEEN 0 AND 365),
  free_look_days integer NOT NULL DEFAULT 0 CHECK (free_look_days BETWEEN 0 AND 90),
  cancellation_fee_cents integer NOT NULL DEFAULT 0 CHECK (cancellation_fee_cents >= 0),
  reserve_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (reserve_percent BETWEEN 0 AND 100),
  max_equipment integer NOT NULL DEFAULT 1 CHECK (max_equipment BETWEEN 1 AND 50),
  eligible_equipment_types text[] NOT NULL DEFAULT '{}',
  max_equipment_age_years integer CHECK (max_equipment_age_years IS NULL OR max_equipment_age_years >= 0),
  covered_items text[] NOT NULL DEFAULT '{}',
  exclusions text[] NOT NULL DEFAULT '{}',
  terms text NOT NULL DEFAULT '',
  renewable boolean NOT NULL DEFAULT true,

  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  renewed_from_id uuid REFERENCES public.protection_contracts(id) ON DELETE SET NULL,

  coverage_start date,
  coverage_end date,
  activated_at timestamptz,
  payment_method text,
  activation_blocker text,
  expired_at timestamptz,
  reserve_released_at timestamptz,
  cancelled_at timestamptz,
  cancelled_effective date,
  cancel_reason text,
  refund_cents bigint NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  paid_out_cents bigint NOT NULL DEFAULT 0 CHECK (paid_out_cents >= 0),
  renewal_offered_at timestamptz,
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT protection_contracts_dates_ordered
    CHECK (coverage_start IS NULL OR coverage_end IS NULL OR coverage_end >= coverage_start),
  CONSTRAINT protection_contracts_active_has_dates
    CHECK (status NOT IN ('active', 'expired') OR (coverage_start IS NOT NULL AND coverage_end IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_contracts_number ON public.protection_contracts (user_id, contract_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_contracts_token ON public.protection_contracts (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_contracts_source_ref
  ON public.protection_contracts (user_id, quote_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protection_contracts_user_status ON public.protection_contracts (user_id, status, coverage_end);
CREATE INDEX IF NOT EXISTS idx_protection_contracts_customer ON public.protection_contracts (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protection_contracts_invoice ON public.protection_contracts (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protection_contracts_quote ON public.protection_contracts (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protection_contracts_renewed_from ON public.protection_contracts (renewed_from_id) WHERE renewed_from_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_protection_contracts_updated_at ON public.protection_contracts;
CREATE TRIGGER trg_protection_contracts_updated_at
  BEFORE UPDATE ON public.protection_contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.protection_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_protection_contracts" ON public.protection_contracts;
CREATE POLICY "select_protection_contracts" ON public.protection_contracts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Deliberately NO insert/update/delete policies: written only through the RPCs below.

CREATE OR REPLACE FUNCTION public.guard_protection_contract_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- FK cascades (account deletion) run at trigger depth > 1 and are allowed.
  IF OLD.status <> 'pending_payment' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'contract_not_deletable' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_protection_contracts_guard_delete ON public.protection_contracts;
CREATE TRIGGER trg_protection_contracts_guard_delete
  BEFORE DELETE ON public.protection_contracts
  FOR EACH ROW EXECUTE FUNCTION public.guard_protection_contract_delete();

-- Covered equipment
CREATE TABLE IF NOT EXISTS public.protection_contract_equipment (
  contract_id uuid NOT NULL REFERENCES public.protection_contracts(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS idx_protection_contract_equipment_equipment ON public.protection_contract_equipment (equipment_id);
CREATE INDEX IF NOT EXISTS idx_protection_contract_equipment_user ON public.protection_contract_equipment (user_id);

ALTER TABLE public.protection_contract_equipment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_protection_contract_equipment" ON public.protection_contract_equipment;
CREATE POLICY "select_protection_contract_equipment" ON public.protection_contract_equipment FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. Append-only ledger (premium, reserve, payouts, refunds)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.protection_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.protection_contracts(id) ON DELETE CASCADE,
  claim_id uuid REFERENCES public.warranty_claims(id) ON DELETE SET NULL,
  entry_type text NOT NULL
    CHECK (entry_type IN ('premium_written', 'reserve_funded', 'claim_paid', 'refund_issued', 'reserve_released')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  effective_date date NOT NULL DEFAULT current_date,
  memo text CHECK (memo IS NULL OR length(memo) <= 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protection_ledger_user_date ON public.protection_ledger (user_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_protection_ledger_contract ON public.protection_ledger (contract_id, created_at);
CREATE INDEX IF NOT EXISTS idx_protection_ledger_claim ON public.protection_ledger (claim_id) WHERE claim_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_protection_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'protection_ledger_is_append_only' USING ERRCODE = '23000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'protection_ledger_is_append_only' USING ERRCODE = '23000';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protection_ledger_guard ON public.protection_ledger;
CREATE TRIGGER trg_protection_ledger_guard
  BEFORE UPDATE OR DELETE ON public.protection_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_protection_ledger();

ALTER TABLE public.protection_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_protection_ledger" ON public.protection_ledger;
CREATE POLICY "select_protection_ledger" ON public.protection_ledger FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.invoice_permission('can_view_billing'));

REVOKE INSERT, UPDATE, DELETE ON public.protection_contracts, public.protection_contract_equipment,
  public.protection_ledger, public.protection_counters FROM anon, authenticated;
REVOKE ALL ON public.protection_counters FROM anon, authenticated;
REVOKE ALL ON public.protection_plan_templates, public.protection_contracts,
  public.protection_contract_equipment, public.protection_ledger FROM anon;

-- =============================================================
-- 4. warranty_claims: plan claims live beside manufacturer claims
-- =============================================================

ALTER TABLE public.warranty_claims
  ADD COLUMN IF NOT EXISTS claim_type text NOT NULL DEFAULT 'manufacturer'
    CHECK (claim_type IN ('manufacturer', 'protection_plan')),
  ADD COLUMN IF NOT EXISTS protection_contract_id uuid REFERENCES public.protection_contracts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS repair_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deductible_cents integer CHECK (deductible_cents IS NULL OR deductible_cents >= 0),
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by uuid;

ALTER TABLE public.warranty_claims DROP CONSTRAINT IF EXISTS warranty_claims_plan_needs_contract;
ALTER TABLE public.warranty_claims
  ADD CONSTRAINT warranty_claims_plan_needs_contract
  CHECK (claim_type = 'manufacturer' OR protection_contract_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_warranty_claims_protection_contract
  ON public.warranty_claims (protection_contract_id) WHERE protection_contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_warranty_claims_user_type ON public.warranty_claims (user_id, claim_type);

CREATE OR REPLACE FUNCTION public.guard_protection_claims()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bypass boolean := COALESCE(current_setting('vireek.protection_rpc', true), '') = 'on';
BEGIN
  IF v_bypass THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.claim_type = 'protection_plan' OR NEW.protection_contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'protection_claims_via_rpc_only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.claim_type = 'protection_plan' OR NEW.claim_type = 'protection_plan' THEN
      IF NEW.claim_type IS DISTINCT FROM OLD.claim_type
         OR NEW.protection_contract_id IS DISTINCT FROM OLD.protection_contract_id
         OR NEW.status IS DISTINCT FROM OLD.status
         OR NEW.claimed_amount_cents IS DISTINCT FROM OLD.claimed_amount_cents
         OR NEW.approved_amount_cents IS DISTINCT FROM OLD.approved_amount_cents
         OR NEW.credit_received_cents IS DISTINCT FROM OLD.credit_received_cents
         OR NEW.deductible_cents IS DISTINCT FROM OLD.deductible_cents
         OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id
         OR NEW.part_cost_cents IS DISTINCT FROM OLD.part_cost_cents
         OR NEW.labor_cost_cents IS DISTINCT FROM OLD.labor_cost_cents THEN
        RAISE EXCEPTION 'protection_claim_locked' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  IF OLD.claim_type = 'protection_plan' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'protection_claim_locked' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_warranty_claims_protection_guard ON public.warranty_claims;
CREATE TRIGGER trg_warranty_claims_protection_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_protection_claims();

-- =============================================================
-- 5. Internal helpers (never granted to clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._pp_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := public.get_account_owner_id();
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public._pp_require_billing()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.invoice_permission('can_view_billing'), false) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._pp_next_number(p_owner uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
BEGIN
  INSERT INTO protection_counters (user_id, seq) VALUES (p_owner, 1)
  ON CONFLICT (user_id) DO UPDATE SET seq = protection_counters.seq + 1
  RETURNING seq INTO v_seq;
  RETURN 'PPC-' || lpad(v_seq::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public._pp_ledger(
  p_owner uuid, p_contract uuid, p_type text, p_amount bigint,
  p_effective date DEFAULT current_date, p_claim uuid DEFAULT NULL, p_memo text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  INSERT INTO protection_ledger (user_id, contract_id, claim_id, entry_type, amount_cents, effective_date, memo)
  VALUES (p_owner, p_contract, p_claim, p_type, p_amount, COALESCE(p_effective, current_date), p_memo);
END;
$$;

CREATE OR REPLACE FUNCTION public._pp_audit(p_owner uuid, p_action text, p_contract uuid, p_details jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO audit_log (user_id, actor_id, actor_email, action, target_table, target_id, details)
    VALUES (p_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
            p_action, 'protection_contracts', p_contract::text, p_details);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit must never block the business action
  END;
END;
$$;

-- aggregate_limit - paid - approved-but-unpaid claims (excluding p_exclude_claim). NULL = unlimited.
CREATE OR REPLACE FUNCTION public._pp_remaining_cents(p_contract uuid, p_exclude_claim uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN c.aggregate_limit_cents IS NULL THEN NULL
    ELSE GREATEST(0,
      c.aggregate_limit_cents::bigint - c.paid_out_cents
      - COALESCE((
          SELECT sum(w.approved_amount_cents)::bigint FROM warranty_claims w
          WHERE w.protection_contract_id = c.id AND w.status = 'approved'
            AND (p_exclude_claim IS NULL OR w.id <> p_exclude_claim)
        ), 0))
  END
  FROM protection_contracts c WHERE c.id = p_contract;
$$;

-- Equipment eligibility + capacity for a set of units. Raises a stable error code on the first problem.
CREATE OR REPLACE FUNCTION public._pp_check_equipment(
  p_owner uuid, p_contract protection_contracts, p_equipment_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eq equipment%ROWTYPE;
  v_id uuid;
  v_existing integer;
  v_new integer;
BEGIN
  FOREACH v_id IN ARRAY COALESCE(p_equipment_ids, '{}'::uuid[]) LOOP
    SELECT * INTO v_eq FROM equipment WHERE id = v_id AND user_id = p_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'equipment_not_found'; END IF;
    IF v_eq.status <> 'active' THEN RAISE EXCEPTION 'equipment_not_active'; END IF;
    IF p_contract.customer_id IS NOT NULL AND v_eq.customer_id IS DISTINCT FROM p_contract.customer_id THEN
      RAISE EXCEPTION 'equipment_customer_mismatch';
    END IF;
    IF cardinality(p_contract.eligible_equipment_types) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(p_contract.eligible_equipment_types) t WHERE lower(t) = lower(v_eq.equipment_type)
    ) THEN
      RAISE EXCEPTION 'equipment_type_not_eligible';
    END IF;
    IF p_contract.max_equipment_age_years IS NOT NULL THEN
      IF v_eq.install_date IS NULL THEN RAISE EXCEPTION 'equipment_age_unknown'; END IF;
      IF v_eq.install_date < (current_date - make_interval(years => p_contract.max_equipment_age_years))::date THEN
        RAISE EXCEPTION 'equipment_too_old';
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_existing FROM protection_contract_equipment WHERE contract_id = p_contract.id;
  SELECT count(*) INTO v_new FROM (
    SELECT DISTINCT x FROM unnest(COALESCE(p_equipment_ids, '{}'::uuid[])) x
    WHERE NOT EXISTS (SELECT 1 FROM protection_contract_equipment e WHERE e.contract_id = p_contract.id AND e.equipment_id = x)
  ) s;
  IF v_existing + v_new > p_contract.max_equipment THEN RAISE EXCEPTION 'too_many_equipment'; END IF;
END;
$$;

-- Creates a contract from a template-shaped record. Single place where the snapshot is written.
CREATE OR REPLACE FUNCTION public._pp_insert_contract(
  p_owner uuid,
  p_t protection_plan_templates,
  p_source text,
  p_customer_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_price_cents integer,
  p_quote_id uuid,
  p_job_id uuid,
  p_source_ref text,
  p_renewed_from uuid,
  p_template_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO protection_contracts (
    user_id, template_id, contract_number, status, source, source_ref,
    customer_id, customer_name, customer_email, customer_phone,
    plan_name, term_months, price_cents, deductible_cents, per_claim_limit_cents, aggregate_limit_cents,
    waiting_period_days, free_look_days, cancellation_fee_cents, reserve_percent, max_equipment,
    eligible_equipment_types, max_equipment_age_years, covered_items, exclusions, terms, renewable,
    quote_id, job_id, renewed_from_id
  ) VALUES (
    p_owner, p_template_id, public._pp_next_number(p_owner), 'pending_payment', p_source, p_source_ref,
    p_customer_id, p_customer_name, p_customer_email, p_customer_phone,
    p_t.name, p_t.term_months, p_price_cents, p_t.deductible_cents, p_t.per_claim_limit_cents, p_t.aggregate_limit_cents,
    p_t.waiting_period_days, p_t.free_look_days, p_t.cancellation_fee_cents, p_t.reserve_percent, p_t.max_equipment,
    p_t.eligible_equipment_types, p_t.max_equipment_age_years, p_t.covered_items, p_t.exclusions, p_t.terms, p_t.renewable,
    p_quote_id, p_job_id, p_renewed_from
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Appends the plan as an invoice line item and links the contract to the invoice.
CREATE OR REPLACE FUNCTION public._pp_attach_to_invoice(p_owner uuid, p_contract uuid, p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv invoices%ROWTYPE;
  v_c protection_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice AND user_id = p_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF v_inv.status NOT IN ('draft', 'sent', 'viewed') THEN RAISE EXCEPTION 'invoice_not_open'; END IF;

  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status <> 'pending_payment' THEN RAISE EXCEPTION 'contract_not_pending'; END IF;

  -- re-attaching: drop the plan line from a previous (open) invoice so it is never billed twice
  IF v_c.invoice_id IS NOT NULL AND v_c.invoice_id <> p_invoice THEN
    UPDATE invoices i SET line_items = COALESCE((
      SELECT jsonb_agg(e) FROM jsonb_array_elements(i.line_items) e
      WHERE e->>'protection_contract_id' IS DISTINCT FROM v_c.id::text
    ), '[]'::jsonb)
    WHERE i.id = v_c.invoice_id AND i.user_id = p_owner AND i.status IN ('draft', 'sent', 'viewed');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_inv.line_items, '[]'::jsonb)) e
    WHERE e->>'protection_contract_id' = v_c.id::text
  ) THEN
    UPDATE invoices
    SET line_items = COALESCE(line_items, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'description', v_c.plan_name || ' (' || v_c.term_months || '-month protection plan) · ' || v_c.contract_number,
      'quantity', 1,
      'unit_price_cents', v_c.price_cents,
      'protection_contract_id', v_c.id
    ))
    WHERE id = p_invoice;
  END IF;

  UPDATE protection_contracts SET invoice_id = p_invoice, activation_blocker = NULL WHERE id = v_c.id;
END;
$$;

-- Activation. Raises on problems; the invoice-paid trigger converts raises into activation_blocker.
CREATE OR REPLACE FUNCTION public._pp_activate(p_contract uuid, p_start date, p_method text, p_auto boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c protection_contracts%ROWTYPE;
  v_start date;
  v_end date;
  v_pred_end date;
  v_reserve bigint;
  v_eq uuid;
BEGIN
  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status <> 'pending_payment' THEN
    RETURN jsonb_build_object('id', v_c.id, 'status', v_c.status, 'changed', false);
  END IF;

  v_start := COALESCE(p_start, current_date);

  IF v_c.renewed_from_id IS NOT NULL THEN
    SELECT coverage_end INTO v_pred_end FROM protection_contracts WHERE id = v_c.renewed_from_id;
    IF v_pred_end IS NOT NULL THEN
      IF v_start > v_pred_end + 31 THEN RAISE EXCEPTION 'renewal_window_closed'; END IF;
      v_start := GREATEST(v_start, v_pred_end + 1);
    END IF;
  END IF;

  v_end := public.protection_coverage_end(v_start, v_c.term_months);

  FOR v_eq IN SELECT equipment_id FROM protection_contract_equipment WHERE contract_id = v_c.id LOOP
    IF EXISTS (
      SELECT 1 FROM protection_contract_equipment e
      JOIN protection_contracts o ON o.id = e.contract_id
      WHERE e.equipment_id = v_eq AND o.id <> v_c.id AND o.status = 'active'
        AND o.coverage_start <= v_end AND o.coverage_end >= v_start
    ) THEN
      RAISE EXCEPTION 'equipment_already_covered';
    END IF;
  END LOOP;

  IF p_auto AND v_c.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoices i, jsonb_array_elements(COALESCE(i.line_items, '[]'::jsonb)) e
    WHERE i.id = v_c.invoice_id
      AND (e->>'protection_contract_id' = v_c.id::text OR (e->>'description') ILIKE '%' || v_c.contract_number || '%')
  ) THEN
    RAISE EXCEPTION 'invoice_line_missing';
  END IF;

  UPDATE protection_contracts
  SET status = 'active', coverage_start = v_start, coverage_end = v_end, activated_at = now(),
      payment_method = COALESCE(p_method, payment_method), activation_blocker = NULL
  WHERE id = v_c.id;

  PERFORM public._pp_ledger(v_c.user_id, v_c.id, 'premium_written', v_c.price_cents, v_start, NULL, 'Plan activated');
  v_reserve := round(v_c.price_cents::numeric * v_c.reserve_percent / 100.0)::bigint;
  PERFORM public._pp_ledger(v_c.user_id, v_c.id, 'reserve_funded', v_reserve, v_start, NULL, v_c.reserve_percent || '% claims reserve');

  RETURN jsonb_build_object('id', v_c.id, 'status', 'active', 'changed', true,
                            'coverage_start', v_start, 'coverage_end', v_end);
END;
$$;

REVOKE ALL ON FUNCTION public._pp_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_require_billing() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_next_number(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_ledger(uuid, uuid, text, bigint, date, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_audit(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_remaining_cents(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_check_equipment(uuid, protection_contracts, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_insert_contract(uuid, protection_plan_templates, text, uuid, text, text, text, integer, uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_attach_to_invoice(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pp_activate(uuid, date, text, boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. Selling: invoice, quote checkout, manual
-- =============================================================

-- 6a. Direct sale (optionally straight onto an open invoice)
CREATE OR REPLACE FUNCTION public.sell_protection_plan(
  p_template_id uuid,
  p_customer_id uuid,
  p_equipment_ids uuid[],
  p_invoice_id uuid DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_t protection_plan_templates%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_id uuid;
  v_c protection_contracts%ROWTYPE;
  v_ids uuid[];
BEGIN
  PERFORM public._pp_require_billing();

  SELECT * INTO v_t FROM protection_plan_templates WHERE id = p_template_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  IF NOT v_t.active THEN RAISE EXCEPTION 'template_inactive'; END IF;

  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id AND user_id = v_owner AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_not_found'; END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_ids FROM unnest(COALESCE(p_equipment_ids, '{}'::uuid[])) x;
  IF cardinality(v_ids) < 1 THEN RAISE EXCEPTION 'equipment_required'; END IF;

  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  v_id := public._pp_insert_contract(
    v_owner, v_t, CASE WHEN p_invoice_id IS NULL THEN 'manual' ELSE 'invoice' END,
    v_cust.id, v_cust.name, v_cust.email, v_cust.phone, v_t.price_cents, NULL, p_job_id, NULL, NULL, v_t.id
  );
  SELECT * INTO v_c FROM protection_contracts WHERE id = v_id;

  PERFORM public._pp_check_equipment(v_owner, v_c, v_ids);
  INSERT INTO protection_contract_equipment (contract_id, equipment_id, user_id)
  SELECT v_id, x, v_owner FROM unnest(v_ids) x;

  IF p_invoice_id IS NOT NULL THEN
    PERFORM public._pp_attach_to_invoice(v_owner, v_id, p_invoice_id);
  END IF;

  PERFORM public._pp_audit(v_owner, 'protection_contract_created', v_id,
    jsonb_build_object('plan', v_t.name, 'price_cents', v_t.price_cents, 'invoice_id', p_invoice_id, 'equipment', to_jsonb(v_ids)));

  RETURN jsonb_build_object('id', v_id, 'contract_number', v_c.contract_number, 'status', 'pending_payment');
END;
$$;

-- 6b. Offer on a quote: appears as a normal add-on on the customer's accept page.
CREATE OR REPLACE FUNCTION public.offer_protection_plan_on_quote(
  p_quote_id uuid,
  p_template_id uuid,
  p_option_ids text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_q quotes%ROWTYPE;
  v_t protection_plan_templates%ROWTYPE;
  v_item_id text;
  v_desc text;
BEGIN
  PERFORM public._pp_require_billing();

  SELECT * INTO v_t FROM protection_plan_templates WHERE id = p_template_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  IF NOT v_t.active THEN RAISE EXCEPTION 'template_inactive'; END IF;

  SELECT * INTO v_q FROM quotes WHERE id = p_quote_id AND user_id = v_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'quote_not_found'; END IF;
  IF v_q.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'quote_not_open'; END IF;

  v_item_id := 'protection:' || v_t.id::text;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_q.optional_items) e WHERE e->>'id' = v_item_id) THEN
    RAISE EXCEPTION 'already_offered';
  END IF;
  IF jsonb_array_length(v_q.optional_items) >= 12 THEN RAISE EXCEPTION 'too_many_items'; END IF;

  v_desc := left(v_t.term_months || '-month protection plan'
    || CASE WHEN v_t.description <> '' THEN '. ' || v_t.description ELSE '' END, 400);

  UPDATE quotes
  SET optional_items = optional_items || jsonb_build_array(jsonb_build_object(
    'id', v_item_id,
    'name', left(v_t.name, 120),
    'description', v_desc,
    'quantity', 1,
    'unit_price_cents', v_t.price_cents,
    'option_ids', to_jsonb(COALESCE((SELECT array_agg(o) FROM unnest(COALESCE(p_option_ids, '{}'::text[])) o WHERE btrim(o) <> ''), '{}'::text[]))
  ))
  WHERE id = v_q.id;

  RETURN jsonb_build_object('quote_id', v_q.id, 'item_id', v_item_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_protection_plan_from_quote(p_quote_id uuid, p_template_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_q quotes%ROWTYPE;
  v_item_id text := 'protection:' || p_template_id::text;
BEGIN
  PERFORM public._pp_require_billing();
  SELECT * INTO v_q FROM quotes WHERE id = p_quote_id AND user_id = v_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'quote_not_found'; END IF;
  IF v_q.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'quote_not_open'; END IF;

  UPDATE quotes
  SET optional_items = COALESCE((
    SELECT jsonb_agg(e) FROM jsonb_array_elements(optional_items) e WHERE e->>'id' <> v_item_id
  ), '[]'::jsonb)
  WHERE id = v_q.id;
END;
$$;

-- 6c. Customer accepted a quote that carried a plan -> pending contract (never blocks acceptance)
CREATE OR REPLACE FUNCTION public.trg_quote_selected_item_protection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t protection_plan_templates%ROWTYPE;
  v_q quotes%ROWTYPE;
  v_cust uuid;
  v_job uuid;
  v_tid uuid;
BEGIN
  BEGIN
    v_tid := substr(NEW.item_id, length('protection:') + 1)::uuid;
    SELECT * INTO v_t FROM protection_plan_templates WHERE id = v_tid AND user_id = NEW.user_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    SELECT * INTO v_q FROM quotes WHERE id = NEW.quote_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT c.id INTO v_cust FROM customers c
    WHERE c.user_id = NEW.user_id AND c.deleted_at IS NULL
      AND (
        (v_q.customer_email IS NOT NULL AND c.email IS NOT NULL AND lower(c.email) = lower(v_q.customer_email))
        OR (v_q.customer_phone IS NOT NULL AND c.phone IS NOT NULL
            AND length(regexp_replace(v_q.customer_phone, '\D', '', 'g')) >= 7
            AND regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(v_q.customer_phone, '\D', '', 'g'))
      )
    ORDER BY c.created_at LIMIT 1;

    SELECT j.id INTO v_job FROM jobs j WHERE j.quote_id = NEW.quote_id ORDER BY j.created_at LIMIT 1;

    INSERT INTO protection_contracts (
      user_id, template_id, contract_number, status, source, source_ref,
      customer_id, customer_name, customer_email, customer_phone,
      plan_name, term_months, price_cents, deductible_cents, per_claim_limit_cents, aggregate_limit_cents,
      waiting_period_days, free_look_days, cancellation_fee_cents, reserve_percent, max_equipment,
      eligible_equipment_types, max_equipment_age_years, covered_items, exclusions, terms, renewable,
      quote_id, job_id
    )
    SELECT
      NEW.user_id, v_t.id, public._pp_next_number(NEW.user_id), 'pending_payment', 'quote', NEW.item_id,
      v_cust, v_q.customer_name, v_q.customer_email, v_q.customer_phone,
      v_t.name, v_t.term_months, NEW.unit_price_cents, v_t.deductible_cents, v_t.per_claim_limit_cents, v_t.aggregate_limit_cents,
      v_t.waiting_period_days, v_t.free_look_days, v_t.cancellation_fee_cents, v_t.reserve_percent, v_t.max_equipment,
      v_t.eligible_equipment_types, v_t.max_equipment_age_years, v_t.covered_items, v_t.exclusions, v_t.terms, v_t.renewable,
      NEW.quote_id, v_job
    WHERE NEW.unit_price_cents >= 1
    ON CONFLICT (user_id, quote_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'protection plan contract not created for quote item %: %', NEW.item_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_quote_selected_item_protection() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.quote_selected_items') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_quote_selected_items_protection ON public.quote_selected_items';
    EXECUTE 'CREATE TRIGGER trg_quote_selected_items_protection
             AFTER INSERT ON public.quote_selected_items
             FOR EACH ROW WHEN (NEW.item_id LIKE ''protection:%'')
             EXECUTE FUNCTION public.trg_quote_selected_item_protection()';
  END IF;
END $$;

-- 6d. Staff: attach a pending contract to an open invoice / activate manually / link equipment
CREATE OR REPLACE FUNCTION public.attach_protection_contract_to_invoice(p_contract_id uuid, p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
BEGIN
  PERFORM public._pp_require_billing();
  PERFORM public._pp_attach_to_invoice(v_owner, p_contract_id, p_invoice_id);
  PERFORM public._pp_audit(v_owner, 'protection_contract_invoiced', p_contract_id, jsonb_build_object('invoice_id', p_invoice_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.link_protection_equipment(p_contract_id uuid, p_equipment_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_c protection_contracts%ROWTYPE;
  v_ids uuid[];
  v_cust uuid;
  v_cust_row customers%ROWTYPE;
  v_eq uuid;
BEGIN
  PERFORM public._pp_require_billing();
  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status NOT IN ('pending_payment', 'active') THEN RAISE EXCEPTION 'contract_not_editable'; END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_ids FROM unnest(COALESCE(p_equipment_ids, '{}'::uuid[])) x;
  IF cardinality(v_ids) < 1 THEN RAISE EXCEPTION 'equipment_required'; END IF;

  IF v_c.customer_id IS NULL THEN
    SELECT DISTINCT e.customer_id INTO v_cust FROM equipment e
    WHERE e.id = ANY (v_ids) AND e.user_id = v_owner
    HAVING count(DISTINCT e.customer_id) = 1;
    IF v_cust IS NULL THEN RAISE EXCEPTION 'equipment_customer_mismatch'; END IF;
    SELECT * INTO v_cust_row FROM customers WHERE id = v_cust AND user_id = v_owner AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'customer_not_found'; END IF;
    UPDATE protection_contracts
    SET customer_id = v_cust_row.id,
        customer_email = COALESCE(customer_email, v_cust_row.email),
        customer_phone = COALESCE(customer_phone, v_cust_row.phone)
    WHERE id = v_c.id;
    v_c.customer_id := v_cust_row.id;
  END IF;

  PERFORM public._pp_check_equipment(v_owner, v_c, v_ids);

  IF v_c.status = 'active' THEN
    FOREACH v_eq IN ARRAY v_ids LOOP
      IF EXISTS (
        SELECT 1 FROM protection_contract_equipment e
        JOIN protection_contracts o ON o.id = e.contract_id
        WHERE e.equipment_id = v_eq AND o.id <> v_c.id AND o.status = 'active'
          AND o.coverage_start <= v_c.coverage_end AND o.coverage_end >= v_c.coverage_start
      ) THEN
        RAISE EXCEPTION 'equipment_already_covered';
      END IF;
    END LOOP;
  END IF;

  INSERT INTO protection_contract_equipment (contract_id, equipment_id, user_id)
  SELECT v_c.id, x, v_owner FROM unnest(v_ids) x
  ON CONFLICT (contract_id, equipment_id) DO NOTHING;

  UPDATE protection_contracts SET activation_blocker = NULL
  WHERE id = v_c.id AND activation_blocker = 'equipment_already_covered';

  PERFORM public._pp_audit(v_owner, 'protection_equipment_linked', v_c.id, jsonb_build_object('equipment', to_jsonb(v_ids)));
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_protection_equipment(p_contract_id uuid, p_equipment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_c protection_contracts%ROWTYPE;
BEGIN
  PERFORM public._pp_require_billing();
  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status <> 'pending_payment' THEN RAISE EXCEPTION 'contract_not_editable'; END IF;
  DELETE FROM protection_contract_equipment WHERE contract_id = v_c.id AND equipment_id = p_equipment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_protection_contract(
  p_contract_id uuid,
  p_payment_method text,
  p_start_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_c protection_contracts%ROWTYPE;
  v_res jsonb;
BEGIN
  PERFORM public._pp_require_billing();
  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status <> 'pending_payment' THEN RAISE EXCEPTION 'contract_not_pending'; END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash', 'check', 'card', 'bank_transfer', 'other') THEN
    RAISE EXCEPTION 'invalid_payment_method';
  END IF;
  -- A plan billed on an invoice is activated by that invoice being paid, never by hand.
  IF v_c.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = v_c.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'activate_via_invoice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM protection_contract_equipment WHERE contract_id = v_c.id) THEN
    RAISE EXCEPTION 'equipment_required';
  END IF;
  IF p_start_date IS NOT NULL AND (p_start_date < current_date - 30 OR p_start_date > current_date + 90) THEN
    RAISE EXCEPTION 'invalid_start_date';
  END IF;

  v_res := public._pp_activate(v_c.id, p_start_date, p_payment_method, false);
  PERFORM public._pp_audit(v_owner, 'protection_contract_activated', v_c.id, jsonb_build_object('method', p_payment_method));
  RETURN v_res;
END;
$$;

-- =============================================================
-- 7. Invoice triggers: paid -> activate, void -> release the plan line
-- =============================================================

CREATE OR REPLACE FUNCTION public.trg_invoice_paid_activate_protection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM protection_contracts WHERE invoice_id = NEW.id AND status = 'pending_payment' LOOP
    BEGIN
      PERFORM public._pp_activate(r.id, COALESCE(NEW.paid_at::date, current_date), NEW.payment_method, true);
    EXCEPTION WHEN OTHERS THEN
      UPDATE protection_contracts SET activation_blocker = left(SQLERRM, 120) WHERE id = r.id;
      RAISE WARNING 'protection contract % not activated: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_invoice_paid_activate_protection() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoices_paid_protection ON public.invoices;
CREATE TRIGGER trg_invoices_paid_protection
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.trg_invoice_paid_activate_protection();

CREATE OR REPLACE FUNCTION public.trg_invoice_void_release_protection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE protection_contracts SET invoice_id = NULL, activation_blocker = NULL
  WHERE invoice_id = NEW.id AND status = 'pending_payment';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_invoice_void_release_protection() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoices_void_protection ON public.invoices;
CREATE TRIGGER trg_invoices_void_protection
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void')
  EXECUTE FUNCTION public.trg_invoice_void_release_protection();

-- =============================================================
-- 8. Cancellation + renewal
-- =============================================================

CREATE OR REPLACE FUNCTION public.cancel_protection_contract(
  p_contract_id uuid,
  p_reason text,
  p_effective_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_c protection_contracts%ROWTYPE;
  v_eff date;
  v_refund bigint := 0;
  v_filed integer;
  v_reserve_left bigint;
BEGIN
  PERFORM public._pp_require_billing();
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'reason_required'; END IF;

  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status NOT IN ('pending_payment', 'active') THEN RAISE EXCEPTION 'contract_not_cancellable'; END IF;

  IF v_c.status = 'pending_payment' THEN
    UPDATE protection_contracts
    SET status = 'cancelled', cancelled_at = now(), cancelled_effective = current_date,
        cancel_reason = btrim(p_reason), activation_blocker = NULL
    WHERE id = v_c.id;
    PERFORM public._pp_audit(v_owner, 'protection_contract_cancelled', v_c.id, jsonb_build_object('reason', btrim(p_reason), 'refund_cents', 0));
    RETURN jsonb_build_object('id', v_c.id, 'status', 'cancelled', 'refund_cents', 0);
  END IF;

  IF EXISTS (SELECT 1 FROM warranty_claims w WHERE w.protection_contract_id = v_c.id
             AND w.status IN ('eligible', 'packet_pending', 'submitted', 'approved')) THEN
    RAISE EXCEPTION 'open_claims';
  END IF;

  v_eff := COALESCE(p_effective_date, current_date);
  IF v_eff > current_date + 30 OR v_eff < v_c.coverage_start OR v_eff > v_c.coverage_end + 1 THEN
    RAISE EXCEPTION 'invalid_effective_date';
  END IF;
  -- cannot back-date before a claim that was filed for a failure on/after that date
  IF EXISTS (SELECT 1 FROM warranty_claims w WHERE w.protection_contract_id = v_c.id
             AND w.status <> 'denied' AND w.failure_date >= v_eff) THEN
    RAISE EXCEPTION 'invalid_effective_date';
  END IF;

  SELECT count(*) INTO v_filed FROM warranty_claims w WHERE w.protection_contract_id = v_c.id AND w.status <> 'denied';
  v_refund := public.protection_refund_cents(
    v_c.price_cents, v_c.coverage_start, v_c.coverage_end, v_eff,
    v_c.free_look_days, v_c.cancellation_fee_cents, v_c.paid_out_cents, v_filed
  );

  UPDATE protection_contracts
  SET status = 'cancelled', cancelled_at = now(), cancelled_effective = v_eff,
      cancel_reason = btrim(p_reason), refund_cents = v_refund
  WHERE id = v_c.id;

  PERFORM public._pp_ledger(v_owner, v_c.id, 'refund_issued', v_refund, current_date, NULL, 'Cancellation refund');

  SELECT COALESCE(sum(CASE entry_type WHEN 'reserve_funded' THEN amount_cents
                                      WHEN 'claim_paid' THEN -amount_cents
                                      WHEN 'reserve_released' THEN -amount_cents ELSE 0 END), 0)
    INTO v_reserve_left FROM protection_ledger WHERE contract_id = v_c.id;
  PERFORM public._pp_ledger(v_owner, v_c.id, 'reserve_released', v_reserve_left, current_date, NULL, 'Released on cancellation');
  UPDATE protection_contracts SET reserve_released_at = now() WHERE id = v_c.id;

  PERFORM public._pp_audit(v_owner, 'protection_contract_cancelled', v_c.id,
    jsonb_build_object('reason', btrim(p_reason), 'refund_cents', v_refund, 'effective', v_eff));
  RETURN jsonb_build_object('id', v_c.id, 'status', 'cancelled', 'refund_cents', v_refund);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_protection_renewal(p_contract_id uuid, p_invoice_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_old protection_contracts%ROWTYPE;
  v_tpl protection_plan_templates%ROWTYPE;
  v_price integer;
  v_id uuid;
  v_number text;
BEGIN
  PERFORM public._pp_require_billing();

  SELECT * INTO v_old FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_old.status NOT IN ('active', 'expired') THEN RAISE EXCEPTION 'contract_not_renewable'; END IF;
  IF NOT v_old.renewable THEN RAISE EXCEPTION 'contract_not_renewable'; END IF;
  IF v_old.coverage_end + 30 < current_date THEN RAISE EXCEPTION 'renewal_window_closed'; END IF;
  IF v_old.coverage_end > current_date + 90 THEN RAISE EXCEPTION 'renewal_too_early'; END IF;
  IF EXISTS (SELECT 1 FROM protection_contracts r WHERE r.renewed_from_id = v_old.id AND r.status IN ('pending_payment', 'active')) THEN
    RAISE EXCEPTION 'already_renewed';
  END IF;

  SELECT * INTO v_tpl FROM protection_plan_templates WHERE id = v_old.template_id AND user_id = v_owner;
  v_price := COALESCE(v_tpl.renewal_price_cents, v_old.price_cents);

  -- Renewal re-uses the SOLD terms (not the catalog's current ones), continuous coverage => no new waiting period.
  v_tpl := ROW(
    v_old.template_id, v_owner, v_old.plan_name, '', v_old.term_months, v_price, NULL, v_old.deductible_cents,
    v_old.per_claim_limit_cents, v_old.aggregate_limit_cents, 0, v_old.free_look_days, v_old.cancellation_fee_cents,
    v_old.reserve_percent, v_old.max_equipment, v_old.eligible_equipment_types, v_old.max_equipment_age_years,
    v_old.covered_items, v_old.exclusions, v_old.terms, v_old.renewable, false, 0, now(), now()
  )::protection_plan_templates;

  v_id := public._pp_insert_contract(
    v_owner, v_tpl, 'renewal', v_old.customer_id, v_old.customer_name, v_old.customer_email, v_old.customer_phone,
    v_price, NULL, NULL, NULL, v_old.id, v_old.template_id
  );

  INSERT INTO protection_contract_equipment (contract_id, equipment_id, user_id, linked_at)
  SELECT v_id, e.equipment_id, v_owner, e.linked_at
  FROM protection_contract_equipment e
  JOIN equipment q ON q.id = e.equipment_id AND q.status = 'active'
  WHERE e.contract_id = v_old.id;

  UPDATE protection_contracts SET renewal_offered_at = COALESCE(renewal_offered_at, now()) WHERE id = v_old.id;

  IF p_invoice_id IS NOT NULL THEN
    PERFORM public._pp_attach_to_invoice(v_owner, v_id, p_invoice_id);
  END IF;

  SELECT contract_number INTO v_number FROM protection_contracts WHERE id = v_id;
  PERFORM public._pp_audit(v_owner, 'protection_contract_renewal_created', v_id,
    jsonb_build_object('renewed_from', v_old.id, 'price_cents', v_price, 'invoice_id', p_invoice_id));
  RETURN jsonb_build_object('id', v_id, 'contract_number', v_number, 'status', 'pending_payment');
END;
$$;

-- =============================================================
-- 9. Claims workflow (rows in warranty_claims, claim_type = 'protection_plan')
-- =============================================================

CREATE OR REPLACE FUNCTION public.file_protection_claim(
  p_contract_id uuid,
  p_equipment_id uuid,
  p_failure_date date,
  p_failure_description text,
  p_part_cost_cents integer,
  p_labor_cost_cents integer,
  p_repair_job_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_c protection_contracts%ROWTYPE;
  v_link protection_contract_equipment%ROWTYPE;
  v_eq equipment%ROWTYPE;
  v_claimed bigint;
  v_covered_from date;
  v_remaining bigint;
  v_n integer;
  v_id uuid;
BEGIN
  IF p_failure_description IS NULL OR length(btrim(p_failure_description)) = 0 OR length(p_failure_description) > 2000 THEN
    RAISE EXCEPTION 'description_required';
  END IF;
  IF p_failure_date IS NULL OR p_failure_date > current_date THEN RAISE EXCEPTION 'invalid_failure_date'; END IF;
  IF COALESCE(p_part_cost_cents, 0) < 0 OR COALESCE(p_labor_cost_cents, 0) < 0
     OR COALESCE(p_part_cost_cents, 0) > 100000000 OR COALESCE(p_labor_cost_cents, 0) > 100000000 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  v_claimed := COALESCE(p_part_cost_cents, 0)::bigint + COALESCE(p_labor_cost_cents, 0)::bigint;
  IF v_claimed <= 0 THEN RAISE EXCEPTION 'invalid_amount'; END IF;

  SELECT * INTO v_c FROM protection_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found'; END IF;
  IF v_c.status NOT IN ('active', 'expired') OR v_c.coverage_start IS NULL THEN RAISE EXCEPTION 'contract_not_active'; END IF;
  IF p_failure_date < v_c.coverage_start OR p_failure_date > v_c.coverage_end THEN RAISE EXCEPTION 'failure_outside_term'; END IF;
  IF current_date > v_c.coverage_end + 30 THEN RAISE EXCEPTION 'reporting_window_closed'; END IF;

  SELECT * INTO v_link FROM protection_contract_equipment WHERE contract_id = v_c.id AND equipment_id = p_equipment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'equipment_not_covered'; END IF;
  v_covered_from := GREATEST(v_c.coverage_start, v_link.linked_at::date) + v_c.waiting_period_days;
  IF p_failure_date < v_covered_from THEN RAISE EXCEPTION 'within_waiting_period'; END IF;

  v_remaining := public._pp_remaining_cents(v_c.id);
  IF v_remaining IS NOT NULL AND v_remaining <= 0 THEN RAISE EXCEPTION 'aggregate_limit_reached'; END IF;

  SELECT * INTO v_eq FROM equipment WHERE id = p_equipment_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'equipment_not_found'; END IF;

  IF p_repair_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_repair_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  SELECT count(*) + 1 INTO v_n FROM warranty_claims WHERE protection_contract_id = v_c.id;

  PERFORM set_config('vireek.protection_rpc', 'on', true);
  INSERT INTO warranty_claims (
    user_id, claim_type, protection_contract_id, repair_job_id, equipment_id,
    customer_name, customer_phone, manufacturer, model_number, serial_number, install_date,
    failure_description, failure_date, warranty_expires_at,
    part_cost_cents, labor_cost_cents, claimed_amount_cents, deductible_cents,
    status, submitted_at, claim_number
  ) VALUES (
    v_owner, 'protection_plan', v_c.id, p_repair_job_id, p_equipment_id,
    v_c.customer_name, v_c.customer_phone, v_eq.make, v_eq.model, v_eq.serial_number, v_eq.install_date,
    btrim(p_failure_description), p_failure_date, v_c.coverage_end,
    COALESCE(p_part_cost_cents, 0), COALESCE(p_labor_cost_cents, 0), v_claimed, v_c.deductible_cents,
    'submitted', now(), v_c.contract_number || '-C' || v_n
  )
  RETURNING id INTO v_id;
  PERFORM set_config('vireek.protection_rpc', 'off', true);

  PERFORM public._pp_audit(v_owner, 'protection_claim_filed', v_c.id,
    jsonb_build_object('claim_id', v_id, 'claimed_cents', v_claimed, 'equipment_id', p_equipment_id));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_protection_claim(
  p_claim_id uuid,
  p_action text,
  p_approved_cents bigint DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_w warranty_claims%ROWTYPE;
  v_c protection_contracts%ROWTYPE;
  v_payable bigint;
  v_final bigint;
BEGIN
  PERFORM public._pp_require_billing();
  IF p_action NOT IN ('approve', 'deny') THEN RAISE EXCEPTION 'invalid_action'; END IF;

  SELECT * INTO v_w FROM warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'protection_plan' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found'; END IF;
  IF v_w.status NOT IN ('eligible', 'packet_pending', 'submitted') THEN RAISE EXCEPTION 'claim_not_pending'; END IF;

  SELECT * INTO v_c FROM protection_contracts WHERE id = v_w.protection_contract_id FOR UPDATE;

  IF p_action = 'deny' THEN
    IF p_note IS NULL OR length(btrim(p_note)) = 0 OR length(p_note) > 1000 THEN RAISE EXCEPTION 'reason_required'; END IF;
    PERFORM set_config('vireek.protection_rpc', 'on', true);
    UPDATE warranty_claims
    SET status = 'denied', denial_reason = btrim(p_note), decided_at = now(), decided_by = auth.uid(), approved_amount_cents = 0
    WHERE id = v_w.id;
    PERFORM set_config('vireek.protection_rpc', 'off', true);
    PERFORM public._pp_audit(v_owner, 'protection_claim_denied', v_c.id, jsonb_build_object('claim_id', v_w.id, 'reason', btrim(p_note)));
    RETURN jsonb_build_object('id', v_w.id, 'status', 'denied', 'approved_cents', 0);
  END IF;

  IF v_c.status NOT IN ('active', 'expired') THEN RAISE EXCEPTION 'contract_not_active'; END IF;

  v_payable := public.protection_payable_cents(
    v_w.claimed_amount_cents, COALESCE(v_w.deductible_cents, 0), v_c.per_claim_limit_cents,
    public._pp_remaining_cents(v_c.id, v_w.id)
  );
  v_final := COALESCE(p_approved_cents, v_payable);
  IF v_final < 0 OR v_final > v_payable THEN RAISE EXCEPTION 'exceeds_coverage'; END IF;
  IF v_final = 0 THEN RAISE EXCEPTION 'nothing_payable'; END IF;
  IF v_final > 2147483647 THEN RAISE EXCEPTION 'exceeds_coverage'; END IF;

  PERFORM set_config('vireek.protection_rpc', 'on', true);
  UPDATE warranty_claims
  SET status = 'approved', approved_amount_cents = v_final::integer, decided_at = now(), decided_by = auth.uid(),
      notes = CASE WHEN p_note IS NULL OR btrim(p_note) = '' THEN notes ELSE left(btrim(p_note), 1000) END
  WHERE id = v_w.id;
  PERFORM set_config('vireek.protection_rpc', 'off', true);

  PERFORM public._pp_audit(v_owner, 'protection_claim_approved', v_c.id,
    jsonb_build_object('claim_id', v_w.id, 'approved_cents', v_final, 'payable_cents', v_payable));
  RETURN jsonb_build_object('id', v_w.id, 'status', 'approved', 'approved_cents', v_final, 'payable_cents', v_payable);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_protection_claim(
  p_claim_id uuid,
  p_method text,
  p_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_w warranty_claims%ROWTYPE;
  v_c protection_contracts%ROWTYPE;
  v_amount bigint;
BEGIN
  PERFORM public._pp_require_billing();
  IF p_method IS NULL OR p_method NOT IN ('account_credit', 'check', 'ach', 'other') THEN RAISE EXCEPTION 'invalid_payment_method'; END IF;

  SELECT * INTO v_w FROM warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'protection_plan' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found'; END IF;
  IF v_w.status <> 'approved' THEN RAISE EXCEPTION 'claim_not_approved'; END IF;

  SELECT * INTO v_c FROM protection_contracts WHERE id = v_w.protection_contract_id FOR UPDATE;
  v_amount := COALESCE(v_w.approved_amount_cents, 0);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'nothing_payable'; END IF;
  IF v_c.aggregate_limit_cents IS NOT NULL AND v_c.paid_out_cents + v_amount > v_c.aggregate_limit_cents THEN
    RAISE EXCEPTION 'aggregate_limit_reached';
  END IF;

  PERFORM set_config('vireek.protection_rpc', 'on', true);
  UPDATE warranty_claims
  SET status = 'credit_received', credit_received_cents = v_amount::integer, credit_received_at = current_date,
      credit_method = p_method,
      notes = CASE WHEN p_reference IS NULL OR btrim(p_reference) = '' THEN notes
                   ELSE left(COALESCE(notes || E'\n', '') || 'Payment ref: ' || btrim(p_reference), 1000) END
  WHERE id = v_w.id;
  PERFORM set_config('vireek.protection_rpc', 'off', true);

  UPDATE protection_contracts SET paid_out_cents = paid_out_cents + v_amount WHERE id = v_c.id;
  PERFORM public._pp_ledger(v_owner, v_c.id, 'claim_paid', v_amount, current_date, v_w.id, 'Claim ' || COALESCE(v_w.claim_number, ''));

  PERFORM public._pp_audit(v_owner, 'protection_claim_paid', v_c.id,
    jsonb_build_object('claim_id', v_w.id, 'amount_cents', v_amount, 'method', p_method));
  RETURN jsonb_build_object('id', v_w.id, 'status', 'credit_received', 'paid_cents', v_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_protection_claim(p_claim_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_w warranty_claims%ROWTYPE;
BEGIN
  PERFORM public._pp_require_billing();
  SELECT * INTO v_w FROM warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'protection_plan' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found'; END IF;
  IF v_w.status NOT IN ('denied', 'credit_received') THEN RAISE EXCEPTION 'claim_not_closable'; END IF;
  PERFORM set_config('vireek.protection_rpc', 'on', true);
  UPDATE warranty_claims SET status = 'closed' WHERE id = v_w.id;
  PERFORM set_config('vireek.protection_rpc', 'off', true);
END;
$$;

-- =============================================================
-- 10. Lifecycle (expiry + reserve release) and financials
-- =============================================================

CREATE OR REPLACE FUNCTION public._pp_lifecycle(p_user uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer := 0;
  v_released integer := 0;
  r record;
  v_left bigint;
BEGIN
  WITH x AS (
    UPDATE protection_contracts
    SET status = 'expired', expired_at = now()
    WHERE status = 'active' AND coverage_end < current_date AND (p_user IS NULL OR user_id = p_user)
    RETURNING 1
  ) SELECT count(*) INTO v_expired FROM x;

  FOR r IN
    SELECT id, user_id FROM protection_contracts
    WHERE status = 'expired' AND reserve_released_at IS NULL
      AND coverage_end + 30 < current_date
      AND (p_user IS NULL OR user_id = p_user)
      AND NOT EXISTS (SELECT 1 FROM warranty_claims w WHERE w.protection_contract_id = protection_contracts.id
                      AND w.status IN ('eligible', 'packet_pending', 'submitted', 'approved'))
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT COALESCE(sum(CASE entry_type WHEN 'reserve_funded' THEN amount_cents
                                        WHEN 'claim_paid' THEN -amount_cents
                                        WHEN 'reserve_released' THEN -amount_cents ELSE 0 END), 0)
      INTO v_left FROM protection_ledger WHERE contract_id = r.id;
    PERFORM public._pp_ledger(r.user_id, r.id, 'reserve_released', v_left, current_date, NULL, 'Released after reporting window');
    UPDATE protection_contracts SET reserve_released_at = now() WHERE id = r.id;
    v_released := v_released + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'reserve_released', v_released);
END;
$$;
REVOKE ALL ON FUNCTION public._pp_lifecycle(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_protection_lifecycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT COALESCE(public.invoice_permission('can_view_billing'), false) THEN
    RETURN jsonb_build_object('expired', 0, 'reserve_released', 0);
  END IF;
  RETURN public._pp_lifecycle(v_owner);
END;
$$;

CREATE OR REPLACE FUNCTION public._pp_lifecycle_all()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._pp_lifecycle(NULL);
END;
$$;
REVOKE ALL ON FUNCTION public._pp_lifecycle_all() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_protection_plan_financials(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._pp_owner();
  v_as_of date := COALESCE(p_as_of, current_date);
  v_written bigint; v_refunds bigint; v_paid bigint; v_funded bigint; v_released bigint;
  v_earned bigint; v_unearned bigint; v_case bigint;
  v_active integer; v_pending integer; v_expired integer; v_cancelled integer; v_open_claims integer;
  v_monthly jsonb;
BEGIN
  PERFORM public._pp_require_billing();

  SELECT COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'premium_written'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'refund_issued'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'claim_paid'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'reserve_funded'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'reserve_released'), 0)
    INTO v_written, v_refunds, v_paid, v_funded, v_released
  FROM protection_ledger WHERE user_id = v_owner;

  SELECT COALESCE(sum(CASE
           WHEN status IN ('active', 'expired') THEN public.protection_earned_cents(price_cents, coverage_start, coverage_end, v_as_of)
           WHEN status = 'cancelled' AND activated_at IS NOT NULL THEN price_cents - refund_cents
           ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN status = 'active'
           THEN price_cents - public.protection_earned_cents(price_cents, coverage_start, coverage_end, v_as_of)
           ELSE 0 END), 0),
         count(*) FILTER (WHERE status = 'active'),
         count(*) FILTER (WHERE status = 'pending_payment'),
         count(*) FILTER (WHERE status = 'expired'),
         count(*) FILTER (WHERE status = 'cancelled')
    INTO v_earned, v_unearned, v_active, v_pending, v_expired, v_cancelled
  FROM protection_contracts WHERE user_id = v_owner;

  SELECT COALESCE(sum(CASE
           WHEN w.status = 'approved' THEN COALESCE(w.approved_amount_cents, 0)
           ELSE public.protection_payable_cents(w.claimed_amount_cents, COALESCE(w.deductible_cents, 0), c.per_claim_limit_cents, NULL)
         END), 0),
         count(*)
    INTO v_case, v_open_claims
  FROM warranty_claims w JOIN protection_contracts c ON c.id = w.protection_contract_id
  WHERE w.user_id = v_owner AND w.claim_type = 'protection_plan'
    AND w.status IN ('eligible', 'packet_pending', 'submitted', 'approved');

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'month', to_char(m.month, 'YYYY-MM-DD'),
           'premium_written_cents', COALESCE(l.premium, 0),
           'claims_paid_cents', COALESCE(l.paid, 0),
           'refunds_cents', COALESCE(l.refunds, 0)
         ) ORDER BY m.month), '[]'::jsonb)
    INTO v_monthly
  FROM generate_series(date_trunc('month', v_as_of)::date - interval '11 months', date_trunc('month', v_as_of)::date, interval '1 month') AS m(month)
  LEFT JOIN (
    SELECT date_trunc('month', effective_date)::date AS month,
           sum(amount_cents) FILTER (WHERE entry_type = 'premium_written') AS premium,
           sum(amount_cents) FILTER (WHERE entry_type = 'claim_paid') AS paid,
           sum(amount_cents) FILTER (WHERE entry_type = 'refund_issued') AS refunds
    FROM protection_ledger WHERE user_id = v_owner GROUP BY 1
  ) l ON l.month = m.month::date;

  RETURN jsonb_build_object(
    'as_of', v_as_of,
    'contracts', jsonb_build_object('active', v_active, 'pending', v_pending, 'expired', v_expired, 'cancelled', v_cancelled),
    'written_premium_cents', v_written,
    'refunds_cents', v_refunds,
    'earned_cents', v_earned,
    'unearned_cents', v_unearned,
    'claims_paid_cents', v_paid,
    'open_claims', v_open_claims,
    'case_reserve_cents', v_case,
    'reserve_funded_cents', v_funded,
    'reserve_released_cents', v_released,
    'reserve_balance_cents', v_funded - v_paid - v_released,
    'reserve_shortfall_cents', GREATEST(0, v_case - (v_funded - v_paid - v_released)),
    'loss_ratio_percent', CASE WHEN v_earned > 0 THEN round((v_paid + v_case)::numeric * 100 / v_earned, 1) ELSE NULL END,
    'underwriting_result_cents', v_earned - v_paid - v_case,
    'monthly', v_monthly
  );
END;
$$;

-- =============================================================
-- 11. Public certificate (token-gated; no internal ids, no ledger, masked serials)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_protection_contract_for_token(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'business_name', p.company_name,
    'contract_number', c.contract_number,
    'plan_name', c.plan_name,
    'status', CASE WHEN c.status = 'active' AND c.coverage_end < current_date THEN 'expired' ELSE c.status END,
    'customer_name', c.customer_name,
    'coverage_start', c.coverage_start,
    'coverage_end', c.coverage_end,
    'term_months', c.term_months,
    'price_cents', c.price_cents,
    'deductible_cents', c.deductible_cents,
    'per_claim_limit_cents', c.per_claim_limit_cents,
    'aggregate_limit_cents', c.aggregate_limit_cents,
    'waiting_period_days', c.waiting_period_days,
    'free_look_days', c.free_look_days,
    'covered_items', to_jsonb(c.covered_items),
    'exclusions', to_jsonb(c.exclusions),
    'terms', c.terms,
    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
        'serial_last4', CASE WHEN e.serial_number IS NULL OR length(e.serial_number) < 4 THEN NULL ELSE right(e.serial_number, 4) END
      ))
      FROM protection_contract_equipment pe JOIN equipment e ON e.id = pe.equipment_id
      WHERE pe.contract_id = c.id
    ), '[]'::jsonb)
  )
  FROM protection_contracts c
  LEFT JOIN profiles p ON p.id = c.user_id
  WHERE c.public_token = p_token AND c.status <> 'cancelled'
  LIMIT 1;
$$;

-- =============================================================
-- 12. Grants
-- =============================================================

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.sell_protection_plan(uuid, uuid, uuid[], uuid, uuid)',
    'public.offer_protection_plan_on_quote(uuid, uuid, text[])',
    'public.remove_protection_plan_from_quote(uuid, uuid)',
    'public.attach_protection_contract_to_invoice(uuid, uuid)',
    'public.link_protection_equipment(uuid, uuid[])',
    'public.unlink_protection_equipment(uuid, uuid)',
    'public.activate_protection_contract(uuid, text, date)',
    'public.cancel_protection_contract(uuid, text, date)',
    'public.create_protection_renewal(uuid, uuid)',
    'public.file_protection_claim(uuid, uuid, date, text, integer, integer, uuid)',
    'public.decide_protection_claim(uuid, text, bigint, text)',
    'public.settle_protection_claim(uuid, text, text)',
    'public.close_protection_claim(uuid)',
    'public.run_protection_lifecycle()',
    'public.get_protection_plan_financials(date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.get_protection_contract_for_token(uuid) TO anon, authenticated;

-- =============================================================
-- 13. Optional daily job (only when pg_cron is available; never fails the migration)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('protection-plans-daily', '15 3 * * *', 'select public._pp_lifecycle_all()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'protection-plans-daily cron not scheduled: %', SQLERRM;
END $$;

COMMENT ON TABLE public.protection_contracts IS
  'Sold service protection plans. Terms are snapshotted at sale. Written only via SECURITY DEFINER RPCs.';
COMMENT ON TABLE public.protection_ledger IS
  'Append-only premium / reserve / payout / refund ledger for protection plans.';
