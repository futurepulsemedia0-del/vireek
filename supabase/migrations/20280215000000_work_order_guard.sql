/*
  # Work-Order Guard (minimal pilot slice)

  Commercial contractors who receive jobs through FM portals (ServiceChannel-type)
  lose money to portal rules: missed accept windows, over-NTE invoices, late
  invoices, 90-day expiry. This adds the smallest slice that proves value:

    - wog_portal_profiles : editable rule set per portal (defaults live in the app, NOT here)
    - wog_import_batches  : one row per CSV / forwarded-email import (undo = delete batch)
    - wog_work_orders     : imported portal work orders (+ invoice breakout + outcome)
    - wog_deposit_matches : approved work-order invoice <-> bank deposit (via _shared/bank/matching.ts)

  No portal login, scraping or auto-submit exists or is implied.

  Security model (same as Direct Mail):
    - RLS SELECT only; clients have NO direct INSERT/UPDATE/DELETE grants.
    - All writes go through SECURITY DEFINER RPCs that resolve the ACCOUNT OWNER id server-side
      (never from the request) and require owner/admin or can_view_billing.
    - Every row carries user_id = account owner id.

  Rollback (manual, destructive — run only if you want the feature gone):
    DROP TABLE wog_deposit_matches, wog_work_orders, wog_import_batches, wog_portal_profiles CASCADE;
    DROP FUNCTION wog_ctx(), wog_require_manager(), wog_touch_updated_at(), wog_profile_save(uuid,text,text,text,jsonb,boolean),
      wog_profile_delete(uuid), wog_import_orders(uuid,text,text,jsonb), wog_import_delete(uuid),
      wog_deposit_match_apply(uuid[],uuid,text,numeric,text), wog_deposit_match_remove(uuid);
*/

-- =============================================================
-- AUTHORIZATION HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.wog_ctx(OUT owner_id uuid, OUT can_manage boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tm record;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT t.account_owner_id, t.role, t.permissions, cr.permissions AS role_permissions
    INTO tm
  FROM public.team_members t
  LEFT JOIN public.custom_roles cr ON cr.id = t.custom_role_id
  WHERE t.user_id = auth.uid()
  LIMIT 1;

  IF FOUND THEN
    owner_id := tm.account_owner_id;
    can_manage :=
      tm.role IN ('admin', 'owner')
      OR COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
      OR COALESCE(tm.role_permissions ->> 'can_view_billing', 'false') = 'true';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()) THEN
    owner_id := auth.uid();
    can_manage := true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.wog_ctx() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wog_ctx() TO authenticated;

-- Raises 42501 unless the caller may manage; returns the account owner id.
CREATE OR REPLACE FUNCTION public.wog_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.wog_ctx();
  IF c.owner_id IS NULL OR NOT COALESCE(c.can_manage, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN c.owner_id;
END;
$$;

REVOKE ALL ON FUNCTION public.wog_require_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wog_require_manager() TO authenticated;

CREATE OR REPLACE FUNCTION public.wog_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.wog_portal_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  payer_name text CHECK (payer_name IS NULL OR char_length(payer_name) <= 120),
  timezone text NOT NULL DEFAULT 'America/New_York',
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wog_profiles_one_default ON public.wog_portal_profiles (user_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.wog_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.wog_portal_profiles(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('csv', 'email')),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 200),
  row_count integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wog_batches_user ON public.wog_import_batches (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.wog_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.wog_portal_profiles(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.wog_import_batches(id) ON DELETE SET NULL,
  wo_number text NOT NULL CHECK (char_length(btrim(wo_number)) BETWEEN 1 AND 80),
  location text,
  trade text,
  priority text NOT NULL DEFAULT 'normal',
  nte_cents bigint CHECK (nte_cents IS NULL OR nte_cents >= 0),
  estimate_cents bigint CHECK (estimate_cents IS NULL OR estimate_cents >= 0),
  received_at timestamptz NOT NULL,
  accepted_at timestamptz,
  declined_at timestamptz,
  checked_in_at timestamptz,
  checkin_distance_miles numeric(8, 3) CHECK (checkin_distance_miles IS NULL OR checkin_distance_miles >= 0),
  proposal_status text NOT NULL DEFAULT 'none' CHECK (proposal_status IN ('none', 'pending', 'approved', 'rejected')),
  proposal_amount_cents bigint CHECK (proposal_amount_cents IS NULL OR proposal_amount_cents >= 0),
  proposal_approved_at timestamptz,
  completed_at timestamptz,
  invoice_number text,
  invoice_submitted_at timestamptz,
  invoice_count integer NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
  invoice_labor_cents bigint CHECK (invoice_labor_cents IS NULL OR invoice_labor_cents >= 0),
  invoice_technicians integer CHECK (invoice_technicians IS NULL OR invoice_technicians >= 0),
  invoice_materials_cents bigint CHECK (invoice_materials_cents IS NULL OR invoice_materials_cents >= 0),
  invoice_trip_cents bigint CHECK (invoice_trip_cents IS NULL OR invoice_trip_cents >= 0),
  invoice_freight_cents bigint CHECK (invoice_freight_cents IS NULL OR invoice_freight_cents >= 0),
  invoice_tax_cents bigint CHECK (invoice_tax_cents IS NULL OR invoice_tax_cents >= 0),
  invoice_mgmt_fee_cents bigint CHECK (invoice_mgmt_fee_cents IS NULL OR invoice_mgmt_fee_cents >= 0),
  invoice_total_cents bigint CHECK (invoice_total_cents IS NULL OR invoice_total_cents >= 0),
  outcome text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'approved', 'paid', 'rejected', 'voided', 'expired', 'cancelled')),
  outcome_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, profile_id, wo_number)
);
CREATE INDEX IF NOT EXISTS idx_wog_orders_user_received ON public.wog_work_orders (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_wog_orders_user_outcome ON public.wog_work_orders (user_id, outcome);
CREATE INDEX IF NOT EXISTS idx_wog_orders_batch ON public.wog_work_orders (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.wog_deposit_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  work_order_id uuid NOT NULL REFERENCES public.wog_work_orders(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  matched_cents bigint NOT NULL CHECK (matched_cents > 0),
  method text NOT NULL,
  confidence numeric(4, 3) NOT NULL DEFAULT 0,
  explanation text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id)
);
CREATE INDEX IF NOT EXISTS idx_wog_matches_txn ON public.wog_deposit_matches (bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_wog_matches_user ON public.wog_deposit_matches (user_id);

DROP TRIGGER IF EXISTS trg_wog_profiles_touch ON public.wog_portal_profiles;
CREATE TRIGGER trg_wog_profiles_touch BEFORE UPDATE ON public.wog_portal_profiles
  FOR EACH ROW EXECUTE FUNCTION public.wog_touch_updated_at();
DROP TRIGGER IF EXISTS trg_wog_orders_touch ON public.wog_work_orders;
CREATE TRIGGER trg_wog_orders_touch BEFORE UPDATE ON public.wog_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wog_touch_updated_at();

-- =============================================================
-- RLS + GRANTS (read-only for clients)
-- =============================================================
ALTER TABLE public.wog_portal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wog_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wog_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wog_deposit_matches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wog_portal_profiles, public.wog_import_batches, public.wog_work_orders, public.wog_deposit_matches
  FROM anon, authenticated;
GRANT SELECT ON public.wog_portal_profiles, public.wog_import_batches, public.wog_work_orders, public.wog_deposit_matches
  TO authenticated;

DROP POLICY IF EXISTS "wog_profiles_select" ON public.wog_portal_profiles;
CREATE POLICY "wog_profiles_select" ON public.wog_portal_profiles FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_portal_profiles.user_id AND c.can_manage));

DROP POLICY IF EXISTS "wog_batches_select" ON public.wog_import_batches;
CREATE POLICY "wog_batches_select" ON public.wog_import_batches FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_import_batches.user_id AND c.can_manage));

DROP POLICY IF EXISTS "wog_orders_select" ON public.wog_work_orders;
CREATE POLICY "wog_orders_select" ON public.wog_work_orders FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_work_orders.user_id AND c.can_manage));

DROP POLICY IF EXISTS "wog_matches_select" ON public.wog_deposit_matches;
CREATE POLICY "wog_matches_select" ON public.wog_deposit_matches FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_deposit_matches.user_id AND c.can_manage));

-- =============================================================
-- RPCs
-- =============================================================

-- Create / update a portal profile. Rules JSON is validated in the app (workOrderGuard.validateRules);
-- the DB only guarantees it is an object. Defaults are NOT stored here.
CREATE OR REPLACE FUNCTION public.wog_profile_save(
  p_id uuid, p_name text, p_payer_name text, p_timezone text, p_rules jsonb, p_make_default boolean
)
RETURNS public.wog_portal_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  r public.wog_portal_profiles%ROWTYPE;
  v_default boolean := COALESCE(p_make_default, false);
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object' THEN
    RAISE EXCEPTION 'rules_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM now() AT TIME ZONE COALESCE(NULLIF(btrim(p_timezone), ''), 'America/New_York');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'timezone_invalid' USING ERRCODE = '22023';
  END;

  -- First profile of an account becomes the default automatically.
  IF NOT EXISTS (SELECT 1 FROM public.wog_portal_profiles WHERE user_id = v_owner AND id IS DISTINCT FROM p_id) THEN
    v_default := true;
  END IF;
  IF v_default THEN
    UPDATE public.wog_portal_profiles SET is_default = false WHERE user_id = v_owner AND is_default AND id IS DISTINCT FROM p_id;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.wog_portal_profiles (user_id, name, payer_name, timezone, rules, is_default)
    VALUES (v_owner, btrim(p_name), NULLIF(btrim(COALESCE(p_payer_name, '')), ''),
            COALESCE(NULLIF(btrim(p_timezone), ''), 'America/New_York'), p_rules, v_default)
    RETURNING * INTO r;
    RETURN r;
  END IF;

  UPDATE public.wog_portal_profiles SET
    name = btrim(p_name),
    payer_name = NULLIF(btrim(COALESCE(p_payer_name, '')), ''),
    timezone = COALESCE(NULLIF(btrim(p_timezone), ''), 'America/New_York'),
    rules = p_rules,
    is_default = CASE WHEN v_default THEN true ELSE is_default END
  WHERE id = p_id AND user_id = v_owner
  RETURNING * INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN r;
END;
$$;

-- Deleting a profile cascades to its work orders and batches (the UI asks for confirmation).
CREATE OR REPLACE FUNCTION public.wog_profile_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
BEGIN
  DELETE FROM public.wog_portal_profiles WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- Idempotent bulk upsert keyed by (owner, profile, wo_number). Max 1000 rows per call.
-- Returns { batch_id, created, updated }.
CREATE OR REPLACE FUNCTION public.wog_import_orders(p_profile_id uuid, p_source text, p_file_name text, p_orders jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  v_batch uuid;
  v_total integer;
  v_created integer := 0;
  v_updated integer := 0;
BEGIN
  IF p_source NOT IN ('csv', 'email') THEN
    RAISE EXCEPTION 'source_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wog_portal_profiles WHERE id = p_profile_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_orders IS NULL OR jsonb_typeof(p_orders) <> 'array' THEN
    RAISE EXCEPTION 'orders_invalid' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_orders);
  IF v_total = 0 OR v_total > 1000 THEN
    RAISE EXCEPTION 'orders_count_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.wog_import_batches (user_id, profile_id, source, file_name, row_count, created_by)
  VALUES (v_owner, p_profile_id, p_source, left(p_file_name, 200), v_total, auth.uid())
  RETURNING id INTO v_batch;

  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_orders) AS x(
      wo_number text, location text, trade text, priority text, nte_cents bigint, estimate_cents bigint,
      received_at timestamptz, accepted_at timestamptz, declined_at timestamptz, checked_in_at timestamptz,
      checkin_distance_miles numeric, proposal_status text, proposal_amount_cents bigint, proposal_approved_at timestamptz,
      completed_at timestamptz, invoice_number text, invoice_submitted_at timestamptz, invoice_count integer,
      invoice_labor_cents bigint, invoice_technicians integer, invoice_materials_cents bigint, invoice_trip_cents bigint,
      invoice_freight_cents bigint, invoice_tax_cents bigint, invoice_mgmt_fee_cents bigint, invoice_total_cents bigint,
      outcome text, outcome_reason text
    )
  ), up AS (
    INSERT INTO public.wog_work_orders (
      user_id, profile_id, batch_id, wo_number, location, trade, priority, nte_cents, estimate_cents, received_at,
      accepted_at, declined_at, checked_in_at, checkin_distance_miles, proposal_status, proposal_amount_cents,
      proposal_approved_at, completed_at, invoice_number, invoice_submitted_at, invoice_count, invoice_labor_cents,
      invoice_technicians, invoice_materials_cents, invoice_trip_cents, invoice_freight_cents, invoice_tax_cents,
      invoice_mgmt_fee_cents, invoice_total_cents, outcome, outcome_reason
    )
    SELECT DISTINCT ON (btrim(i.wo_number))
      v_owner, p_profile_id, v_batch, btrim(i.wo_number), i.location, i.trade, COALESCE(NULLIF(btrim(i.priority), ''), 'normal'),
      i.nte_cents, i.estimate_cents, i.received_at, i.accepted_at, i.declined_at, i.checked_in_at, i.checkin_distance_miles,
      COALESCE(NULLIF(i.proposal_status, ''), 'none'), i.proposal_amount_cents, i.proposal_approved_at, i.completed_at,
      i.invoice_number, i.invoice_submitted_at, COALESCE(i.invoice_count, 0), i.invoice_labor_cents, i.invoice_technicians,
      i.invoice_materials_cents, i.invoice_trip_cents, i.invoice_freight_cents, i.invoice_tax_cents, i.invoice_mgmt_fee_cents,
      i.invoice_total_cents, COALESCE(NULLIF(i.outcome, ''), 'open'), i.outcome_reason
    FROM incoming i
    WHERE i.wo_number IS NOT NULL AND btrim(i.wo_number) <> '' AND i.received_at IS NOT NULL
    ORDER BY btrim(i.wo_number)
    ON CONFLICT (user_id, profile_id, wo_number) DO UPDATE SET
      batch_id = EXCLUDED.batch_id, location = EXCLUDED.location, trade = EXCLUDED.trade, priority = EXCLUDED.priority,
      nte_cents = EXCLUDED.nte_cents, estimate_cents = EXCLUDED.estimate_cents, received_at = EXCLUDED.received_at,
      accepted_at = EXCLUDED.accepted_at, declined_at = EXCLUDED.declined_at, checked_in_at = EXCLUDED.checked_in_at,
      checkin_distance_miles = EXCLUDED.checkin_distance_miles, proposal_status = EXCLUDED.proposal_status,
      proposal_amount_cents = EXCLUDED.proposal_amount_cents, proposal_approved_at = EXCLUDED.proposal_approved_at,
      completed_at = EXCLUDED.completed_at, invoice_number = EXCLUDED.invoice_number,
      invoice_submitted_at = EXCLUDED.invoice_submitted_at, invoice_count = EXCLUDED.invoice_count,
      invoice_labor_cents = EXCLUDED.invoice_labor_cents, invoice_technicians = EXCLUDED.invoice_technicians,
      invoice_materials_cents = EXCLUDED.invoice_materials_cents, invoice_trip_cents = EXCLUDED.invoice_trip_cents,
      invoice_freight_cents = EXCLUDED.invoice_freight_cents, invoice_tax_cents = EXCLUDED.invoice_tax_cents,
      invoice_mgmt_fee_cents = EXCLUDED.invoice_mgmt_fee_cents, invoice_total_cents = EXCLUDED.invoice_total_cents,
      outcome = EXCLUDED.outcome, outcome_reason = EXCLUDED.outcome_reason
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_created, v_updated FROM up;

  UPDATE public.wog_import_batches SET created_count = v_created, updated_count = v_updated WHERE id = v_batch;
  RETURN jsonb_build_object('batch_id', v_batch, 'created', v_created, 'updated', v_updated);
END;
$$;

-- Undo an import: removes the work orders last written by that batch (and their deposit matches via cascade).
CREATE OR REPLACE FUNCTION public.wog_import_delete(p_batch_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.wog_import_batches WHERE id = p_batch_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public.wog_work_orders WHERE batch_id = p_batch_id AND user_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.wog_import_batches WHERE id = p_batch_id AND user_id = v_owner;
  RETURN v_n;
END;
$$;

-- Apply a deposit match: one bank deposit -> one or more APPROVED work-order invoices.
-- Safe against double-apply: UNIQUE(work_order_id) + row locks; total may not exceed the deposit.
CREATE OR REPLACE FUNCTION public.wog_deposit_match_apply(
  p_work_order_ids uuid[], p_bank_transaction_id uuid, p_method text, p_confidence numeric, p_explanation text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  v_txn_cents bigint;
  v_sum bigint;
  v_found integer;
  v_inserted integer;
BEGIN
  IF p_work_order_ids IS NULL OR cardinality(p_work_order_ids) = 0 OR cardinality(p_work_order_ids) > 25 THEN
    RAISE EXCEPTION 'orders_count_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT amount_cents INTO v_txn_cents FROM public.bank_transactions
  WHERE id = p_bank_transaction_id AND user_id = v_owner AND amount_cents > 0 AND status <> 'removed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*), COALESCE(sum(invoice_total_cents), 0) INTO v_found, v_sum
  FROM (
    SELECT invoice_total_cents FROM public.wog_work_orders
    WHERE id = ANY (p_work_order_ids) AND user_id = v_owner AND outcome = 'approved' AND invoice_total_cents > 0
    FOR UPDATE
  ) s;
  IF v_found <> cardinality(p_work_order_ids) THEN
    RAISE EXCEPTION 'order_not_matchable' USING ERRCODE = 'P0002';
  END IF;
  -- Net-of-fee processor payouts are smaller than the invoices, so only "more than the deposit" is rejected.
  IF v_sum > v_txn_cents + GREATEST(100, v_txn_cents / 10) THEN
    RAISE EXCEPTION 'amount_exceeds_deposit' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.wog_deposit_matches (user_id, work_order_id, bank_transaction_id, matched_cents, method, confidence, explanation, created_by)
  SELECT v_owner, w.id, p_bank_transaction_id, w.invoice_total_cents, left(COALESCE(p_method, 'manual'), 40),
         LEAST(0.999, GREATEST(0, COALESCE(p_confidence, 0))), left(p_explanation, 600), auth.uid()
  FROM public.wog_work_orders w
  WHERE w.id = ANY (p_work_order_ids) AND w.user_id = v_owner
  ON CONFLICT (work_order_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> cardinality(p_work_order_ids) THEN
    RAISE EXCEPTION 'already_matched' USING ERRCODE = '23505';
  END IF;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.wog_deposit_match_remove(p_work_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
BEGIN
  DELETE FROM public.wog_deposit_matches WHERE work_order_id = p_work_order_id AND user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public.wog_profile_save(uuid, text, text, text, jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_profile_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_import_orders(uuid, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_import_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_deposit_match_apply(uuid[], uuid, text, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_deposit_match_remove(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wog_profile_save(uuid, text, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_profile_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_import_orders(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_import_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_deposit_match_apply(uuid[], uuid, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_deposit_match_remove(uuid) TO authenticated;
