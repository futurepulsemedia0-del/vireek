/*
# Sales pipeline: stages, forecast weights and deal-desk discount approvals

## Why
`crm_deals` (migration 20270503000000_crm_sync.sql) already stores deals, either synced from Salesforce / Pipedrive /
Zoho or entered in Vireek. It has only a free-text `stage` and `status`: no stage definitions, no way to weight a stage
for a forecast, and no control over discounts. This migration EXTENDS that module; it does not add a second deals table.

Vireek tracks its own sales in an ordinary Vireek-owned account that uses this module (the same account-scoped
model every tenant uses). Nothing here is hard-coded to Vireek, and no other tenant's behaviour changes unless an
owner turns the deal desk on.

## What this adds (additive)
- crm_deals.discount_pct          applied discount in percent, default 0 (0-100).
- crm_pipeline_stages             per-account stage list: label, order, win probability, forecast category and the
                                  names the stage may carry in the connected CRM (`match_names`).
- crm_deal_desk_settings          one row per account: switch + two discount thresholds.
- crm_deal_discount_requests      approval requests. The required approval level is computed IN THE DATABASE:
                                    pct <= auto_approve_max_pct  -> auto (approved at insert)
                                    pct <= manager_max_pct       -> manager (can_manage_crm(), never the requester)
                                    above                        -> owner (account owner only)
- crm_seed_default_pipeline_stages()  idempotent: inserts default stages that are missing.
- crm_deals_discount_guard()      BEFORE trigger on crm_deals: an interactive user cannot raise discount_pct above the
                                  auto-approve limit unless an approved request covers it.

## Security model
1. Tenant scoping: every row carries `user_id` = ACCOUNT OWNER id (get_account_owner_id()), like crm_deals.
2. Stages: members read; writes need can_manage_crm().
3. Settings: members read; only the account owner writes (it defines who may discount).
4. Requests: members of the account insert (as themselves) and read. Status changes only through the guard trigger
   (immutable fields, allowed transitions, level checks, no self-approval at manager level). No DELETE policy:
   requests are an audit trail. They disappear only when their deal is deleted (FK cascade).
5. Discount guard is a PREVENTIVE control for signed-in users (auth.uid() is not null). The CRM sync runs with the
   service role (auth.uid() is null) and is not affected; it does not write discount_pct.
6. The guard only applies when the deal desk is enabled for the account. Default is OFF.

## Known limits (deliberate)
- An approval is a ceiling for the deal (max approved pct); it does not expire and is not per-quote.
- A user with direct service-role/SQL access can bypass triggers. That is outside this model.
- The owner may approve an owner-level request they raised themselves (nobody is above them); the row records it.
- Threshold defaults (10 / 20) are PROPOSED placeholders [VERIFY with the sales lead]; nothing is enforced until the
  owner enables the deal desk and confirms them.

## Requires
crm_deals, get_account_owner_id(), can_manage_crm(), has_account_permission(text), crm_touch_updated_at(), auth.users.

## Rollback (manual, destructive; export the requests first)
DROP TRIGGER IF EXISTS trg_crm_deals_discount_guard ON public.crm_deals;
DROP FUNCTION IF EXISTS public.crm_deals_discount_guard();
DROP TABLE IF EXISTS public.crm_deal_discount_requests;
DROP FUNCTION IF EXISTS public.crm_discount_request_before_insert();
DROP FUNCTION IF EXISTS public.crm_discount_request_guard();
DROP TABLE IF EXISTS public.crm_deal_desk_settings;
DROP FUNCTION IF EXISTS public.crm_seed_default_pipeline_stages();
DROP TABLE IF EXISTS public.crm_pipeline_stages;
ALTER TABLE public.crm_deals DROP CONSTRAINT IF EXISTS crm_deals_discount_pct_range;
ALTER TABLE public.crm_deals DROP COLUMN IF EXISTS discount_pct;
*/

DO $$
BEGIN
  IF to_regclass('public.crm_deals') IS NULL
     OR to_regprocedure('public.get_account_owner_id()') IS NULL
     OR to_regprocedure('public.can_manage_crm()') IS NULL
     OR to_regprocedure('public.crm_touch_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'sales_pipeline: prerequisites missing (crm_deals, get_account_owner_id, can_manage_crm, crm_touch_updated_at); run 20270503000000_crm_sync.sql first';
  END IF;
END $$;

-- =============================================================
-- 1. crm_deals: applied discount
-- =============================================================

ALTER TABLE public.crm_deals
  ADD COLUMN IF NOT EXISTS discount_pct numeric(5, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_deals_discount_pct_range' AND conrelid = 'public.crm_deals'::regclass
  ) THEN
    ALTER TABLE public.crm_deals
      ADD CONSTRAINT crm_deals_discount_pct_range CHECK (discount_pct >= 0 AND discount_pct <= 100);
  END IF;
END $$;

-- =============================================================
-- 2. Pipeline stages
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  stage_key text NOT NULL CHECK (stage_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  win_probability_pct numeric(5, 2) NOT NULL CHECK (win_probability_pct >= 0 AND win_probability_pct <= 100),
  forecast_category text NOT NULL CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'omitted')),
  -- Names this stage carries in the connected CRM (case-insensitive match against crm_deals.stage).
  match_names text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(match_names) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_pipeline_stages_unique_key UNIQUE (user_id, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_pipeline_stages_user_pos ON public.crm_pipeline_stages (user_id, position);

DROP TRIGGER IF EXISTS trg_crm_touch_pipeline_stages ON public.crm_pipeline_stages;
CREATE TRIGGER trg_crm_touch_pipeline_stages BEFORE UPDATE ON public.crm_pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

ALTER TABLE public.crm_pipeline_stages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_pipeline_stages_select ON public.crm_pipeline_stages;
CREATE POLICY crm_pipeline_stages_select ON public.crm_pipeline_stages FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS crm_pipeline_stages_insert ON public.crm_pipeline_stages;
CREATE POLICY crm_pipeline_stages_insert ON public.crm_pipeline_stages FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_crm());
DROP POLICY IF EXISTS crm_pipeline_stages_update ON public.crm_pipeline_stages;
CREATE POLICY crm_pipeline_stages_update ON public.crm_pipeline_stages FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_crm());
DROP POLICY IF EXISTS crm_pipeline_stages_delete ON public.crm_pipeline_stages;
CREATE POLICY crm_pipeline_stages_delete ON public.crm_pipeline_stages FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_crm());

REVOKE ALL ON TABLE public.crm_pipeline_stages FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_pipeline_stages TO authenticated;

-- Default stages. Weights are PROPOSED starting points [VERIFY]: calibrate against your own win rates.
CREATE OR REPLACE FUNCTION public.crm_seed_default_pipeline_stages()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF NOT public.can_manage_crm() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.crm_pipeline_stages (stage_key, label, position, win_probability_pct, forecast_category, match_names)
  VALUES
    ('qualified',      'Qualified',      10, 10, 'pipeline',  ARRAY['qualified', 'qualification']),
    ('discovery_demo', 'Discovery / demo', 20, 25, 'pipeline',  ARRAY['discovery', 'demo', 'demo scheduled']),
    ('proposal',       'Proposal',       30, 50, 'best_case', ARRAY['proposal', 'proposal sent', 'quote sent']),
    ('negotiation',    'Negotiation',    40, 75, 'commit',    ARRAY['negotiation', 'negotiating']),
    ('contract_sent',  'Contract sent',  50, 90, 'commit',    ARRAY['contract sent', 'contracting', 'closing'])
  ON CONFLICT (user_id, stage_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_seed_default_pipeline_stages() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_seed_default_pipeline_stages() TO authenticated;

-- =============================================================
-- 3. Deal desk settings (one row per account)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_deal_desk_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_pct numeric(5, 2) NOT NULL DEFAULT 10 CHECK (auto_approve_max_pct >= 0 AND auto_approve_max_pct <= 100),
  manager_max_pct numeric(5, 2) NOT NULL DEFAULT 20 CHECK (manager_max_pct >= 0 AND manager_max_pct <= 100),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_deal_desk_thresholds_ordered CHECK (manager_max_pct >= auto_approve_max_pct)
);

CREATE OR REPLACE FUNCTION public.crm_deal_desk_settings_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.user_id := OLD.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_deal_desk_settings_write ON public.crm_deal_desk_settings;
CREATE TRIGGER trg_crm_deal_desk_settings_write BEFORE INSERT OR UPDATE ON public.crm_deal_desk_settings
  FOR EACH ROW EXECUTE FUNCTION public.crm_deal_desk_settings_before_write();

ALTER TABLE public.crm_deal_desk_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_deal_desk_settings_select ON public.crm_deal_desk_settings;
CREATE POLICY crm_deal_desk_settings_select ON public.crm_deal_desk_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Only the account owner changes who may discount.
DROP POLICY IF EXISTS crm_deal_desk_settings_insert ON public.crm_deal_desk_settings;
CREATE POLICY crm_deal_desk_settings_insert ON public.crm_deal_desk_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS crm_deal_desk_settings_update ON public.crm_deal_desk_settings;
CREATE POLICY crm_deal_desk_settings_update ON public.crm_deal_desk_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = public.get_account_owner_id() AND user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.crm_deal_desk_settings FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_deal_desk_settings_before_write() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crm_deal_desk_settings TO authenticated;

-- =============================================================
-- 4. Discount requests
-- =============================================================

CREATE TABLE IF NOT EXISTS public.crm_deal_discount_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  deal_id uuid NOT NULL REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  requested_pct numeric(5, 2) NOT NULL CHECK (requested_pct > 0 AND requested_pct <= 100),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  -- Computed by the insert trigger; whatever the client sends is overwritten.
  required_level text NOT NULL DEFAULT 'manager' CHECK (required_level IN ('auto', 'manager', 'owner')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_discount_requests_decided CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CONSTRAINT crm_discount_requests_reject_note CHECK (status <> 'rejected' OR (decision_note IS NOT NULL AND btrim(decision_note) <> ''))
);

-- At most one open request per deal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_discount_requests_one_pending
  ON public.crm_deal_discount_requests (deal_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crm_discount_requests_user_status
  ON public.crm_deal_discount_requests (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_discount_requests_deal
  ON public.crm_deal_discount_requests (deal_id, created_at DESC);

-- 4a. Insert: derive account, requester and approval level on the server.
CREATE OR REPLACE FUNCTION public.crm_discount_request_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deal_owner uuid;
  v_enabled boolean;
  v_auto numeric;
  v_mgr numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- Runs with the caller's rights, so RLS hides deals of other accounts.
  SELECT user_id INTO v_deal_owner FROM public.crm_deals WHERE id = NEW.deal_id;
  IF v_deal_owner IS NULL THEN
    RAISE EXCEPTION 'deal_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT enabled, auto_approve_max_pct, manager_max_pct
    INTO v_enabled, v_auto, v_mgr
  FROM public.crm_deal_desk_settings WHERE user_id = v_deal_owner;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'deal_desk_disabled' USING ERRCODE = '22023';
  END IF;

  NEW.user_id := v_deal_owner;
  NEW.requested_by := auth.uid();
  NEW.reason := btrim(NEW.reason);
  NEW.decided_by := NULL;
  NEW.decision_note := NULL;
  NEW.created_at := now();
  NEW.updated_at := now();

  IF NEW.requested_pct <= v_auto THEN
    NEW.required_level := 'auto';
    NEW.status := 'approved';
    NEW.decided_at := now();
  ELSE
    NEW.required_level := CASE WHEN NEW.requested_pct <= v_mgr THEN 'manager' ELSE 'owner' END;
    NEW.status := 'pending';
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_discount_request_before_insert ON public.crm_deal_discount_requests;
CREATE TRIGGER trg_crm_discount_request_before_insert BEFORE INSERT ON public.crm_deal_discount_requests
  FOR EACH ROW EXECUTE FUNCTION public.crm_discount_request_before_insert();

-- 4b. Update: immutable facts, allowed transitions, who may decide.
CREATE OR REPLACE FUNCTION public.crm_discount_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
     OR NEW.requested_pct IS DISTINCT FROM OLD.requested_pct
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.required_level IS DISTINCT FROM OLD.required_level
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'discount_request_immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'discount_request_immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'discount_request_closed' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  v_owner := public.get_account_owner_id();

  IF NEW.status = 'withdrawn' THEN
    IF v_uid IS DISTINCT FROM OLD.requested_by AND v_uid IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status IN ('approved', 'rejected') THEN
    IF OLD.required_level = 'owner' THEN
      IF v_uid IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'owner_approval_required' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT public.can_manage_crm() THEN
        RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
      END IF;
      IF v_uid IS NOT DISTINCT FROM OLD.requested_by AND v_uid IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'self_approval_not_allowed' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.status = 'rejected' AND char_length(btrim(coalesce(NEW.decision_note, ''))) = 0 THEN
      RAISE EXCEPTION 'decision_note_required' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  NEW.decided_by := v_uid;
  NEW.decided_at := now();
  NEW.decision_note := nullif(btrim(coalesce(NEW.decision_note, '')), '');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_discount_request_guard ON public.crm_deal_discount_requests;
CREATE TRIGGER trg_crm_discount_request_guard BEFORE UPDATE ON public.crm_deal_discount_requests
  FOR EACH ROW EXECUTE FUNCTION public.crm_discount_request_guard();

ALTER TABLE public.crm_deal_discount_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_discount_requests_select ON public.crm_deal_discount_requests;
CREATE POLICY crm_discount_requests_select ON public.crm_deal_discount_requests FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS crm_discount_requests_insert ON public.crm_deal_discount_requests;
CREATE POLICY crm_discount_requests_insert ON public.crm_deal_discount_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND requested_by = (SELECT auth.uid()));
-- Deciders (can_manage_crm / owner) and the requester (to withdraw) may update; the trigger enforces the rest.
DROP POLICY IF EXISTS crm_discount_requests_update ON public.crm_deal_discount_requests;
CREATE POLICY crm_discount_requests_update ON public.crm_deal_discount_requests FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.can_manage_crm() OR requested_by = (SELECT auth.uid()))
  )
  WITH CHECK (user_id = public.get_account_owner_id());
-- No DELETE policy: the table is an audit trail.

REVOKE ALL ON TABLE public.crm_deal_discount_requests FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_discount_request_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_discount_request_guard() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crm_deal_discount_requests TO authenticated;

-- =============================================================
-- 5. Preventive control on crm_deals.discount_pct
-- =============================================================

CREATE OR REPLACE FUNCTION public.crm_deals_discount_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_auto numeric;
  v_approved numeric;
BEGIN
  -- Service role / CRM sync (no end user): not an interactive discount decision.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.discount_pct <= 0 THEN
    RETURN NEW;
  END IF;
  -- Lowering or keeping a discount is always allowed.
  IF TG_OP = 'UPDATE' AND NEW.discount_pct <= OLD.discount_pct THEN
    RETURN NEW;
  END IF;

  SELECT enabled, auto_approve_max_pct INTO v_enabled, v_auto
  FROM public.crm_deal_desk_settings WHERE user_id = NEW.user_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;
  IF NEW.discount_pct <= v_auto THEN
    RETURN NEW;
  END IF;

  SELECT max(requested_pct) INTO v_approved
  FROM public.crm_deal_discount_requests
  WHERE deal_id = NEW.id AND status = 'approved';
  IF NEW.discount_pct <= COALESCE(v_approved, 0) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'discount_requires_approval' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.crm_deals_discount_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_crm_deals_discount_guard ON public.crm_deals;
CREATE TRIGGER trg_crm_deals_discount_guard
  BEFORE INSERT OR UPDATE OF discount_pct ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.crm_deals_discount_guard();
