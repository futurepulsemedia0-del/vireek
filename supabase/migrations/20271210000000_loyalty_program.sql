/*
  # Loyalty program: points, tiers, earn rules, rewards, redemptions

  Customers earn points when an invoice is paid. Points raise a lifetime total that unlocks tiers (earn
  multipliers + perks). Points are spent on rewards from a catalog. Staff fulfil redemptions; customers see
  everything in the portal.

  ## Tables (all RLS on, scoped by user_id = get_account_owner_id())
  - loyalty_settings ...... one row per account: on/off, program name, points label, portal redemption switch
  - loyalty_tiers ......... name, lifetime-points threshold, earn multiplier, perks (max 8)
  - loyalty_earn_rules .... per_dollar | flat_per_job, optional service filter, min invoice (max 20)
  - loyalty_rewards ....... catalog: credit | discount_percent | free_service | custom (max 30)
  - loyalty_accounts ...... balance + lifetime per customer (written ONLY by internal functions)
  - loyalty_ledger ........ append-only points history (written ONLY by internal functions)
  - loyalty_redemptions ... pending -> fulfilled | cancelled (written ONLY by RPCs)

  ## Security
  - Config tables: any team member can read, only managers (identity_is_manager()) can write.
  - Accounts / ledger / redemptions: read-only for clients; all writes go through SECURITY DEFINER functions.
  - The jobs trigger NEVER blocks the invoice write (exceptions are swallowed with a WARNING);
    loyalty_backfill_paid_jobs() is the safety net for anything missed.
  - Portal RPCs are token-validated (customers.portal_token) and never expose staff notes.

  Requires: get_account_owner_id(), identity_is_manager(), profiles, customers (portal_token), jobs, business_profile
  Additive + idempotent.
*/

-- ============================================================
-- 1) CONFIG TABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL DEFAULT false,
  program_name text NOT NULL DEFAULT 'Rewards',
  points_label text NOT NULL DEFAULT 'points',
  portal_redemption_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ls_name_check CHECK (char_length(btrim(program_name)) BETWEEN 2 AND 40),
  CONSTRAINT ls_label_check CHECK (char_length(btrim(points_label)) BETWEEN 2 AND 20)
);

CREATE TABLE IF NOT EXISTS public.loyalty_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  min_lifetime_points integer NOT NULL DEFAULT 0,
  earn_multiplier numeric(4,2) NOT NULL DEFAULT 1,
  perks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lt_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 40),
  CONSTRAINT lt_min_check CHECK (min_lifetime_points BETWEEN 0 AND 10000000),
  CONSTRAINT lt_mult_check CHECK (earn_multiplier BETWEEN 1 AND 10),
  CONSTRAINT lt_perks_check CHECK (perks IS NULL OR char_length(perks) <= 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_tiers_threshold ON public.loyalty_tiers (user_id, min_lifetime_points);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_tiers_name ON public.loyalty_tiers (user_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.loyalty_earn_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'per_dollar',
  points_value numeric(10,2) NOT NULL,
  service_type text,
  min_invoice_amount numeric(10,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ler_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT ler_kind_check CHECK (kind IN ('per_dollar', 'flat_per_job')),
  CONSTRAINT ler_value_check CHECK (points_value > 0 AND points_value <= 100000),
  CONSTRAINT ler_service_check CHECK (service_type IS NULL OR char_length(btrim(service_type)) BETWEEN 1 AND 80),
  CONSTRAINT ler_min_check CHECK (min_invoice_amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_earn_rules_user ON public.loyalty_earn_rules (user_id, is_active);

CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  points_cost integer NOT NULL,
  reward_type text NOT NULL DEFAULT 'credit',
  reward_value numeric(10,2),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lrw_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT lrw_desc_check CHECK (description IS NULL OR char_length(description) <= 300),
  CONSTRAINT lrw_cost_check CHECK (points_cost BETWEEN 1 AND 10000000),
  CONSTRAINT lrw_type_check CHECK (reward_type IN ('credit', 'discount_percent', 'free_service', 'custom')),
  CONSTRAINT lrw_value_check CHECK (
    (reward_type = 'credit' AND reward_value IS NOT NULL AND reward_value > 0)
    OR (reward_type = 'discount_percent' AND reward_value IS NOT NULL AND reward_value BETWEEN 1 AND 100)
    OR (reward_type IN ('free_service', 'custom') AND (reward_value IS NULL OR reward_value >= 0))
  )
);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_user ON public.loyalty_rewards (user_id, is_active);

-- Guard: caps, immutable owner, updated_at.
CREATE OR REPLACE FUNCTION public.loyalty_config_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cap integer;
  v_label text;
  v_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_cap := CASE TG_TABLE_NAME
      WHEN 'loyalty_tiers' THEN 8
      WHEN 'loyalty_earn_rules' THEN 20
      WHEN 'loyalty_rewards' THEN 30
      ELSE NULL END;
    v_label := CASE TG_TABLE_NAME
      WHEN 'loyalty_tiers' THEN 'tiers'
      WHEN 'loyalty_earn_rules' THEN 'earn rules'
      WHEN 'loyalty_rewards' THEN 'rewards'
      ELSE NULL END;
    IF v_cap IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', TG_TABLE_NAME)
        INTO v_count USING NEW.user_id;
      IF v_count >= v_cap THEN
        RAISE EXCEPTION 'You can have at most % %.', v_cap, v_label USING ERRCODE = '54000';
      END IF;
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'This item cannot move to another account' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_loyalty_settings_guard ON public.loyalty_settings;
CREATE TRIGGER trg_loyalty_settings_guard BEFORE INSERT OR UPDATE ON public.loyalty_settings
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_config_guard();
DROP TRIGGER IF EXISTS trg_loyalty_tiers_guard ON public.loyalty_tiers;
CREATE TRIGGER trg_loyalty_tiers_guard BEFORE INSERT OR UPDATE ON public.loyalty_tiers
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_config_guard();
DROP TRIGGER IF EXISTS trg_loyalty_earn_rules_guard ON public.loyalty_earn_rules;
CREATE TRIGGER trg_loyalty_earn_rules_guard BEFORE INSERT OR UPDATE ON public.loyalty_earn_rules
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_config_guard();
DROP TRIGGER IF EXISTS trg_loyalty_rewards_guard ON public.loyalty_rewards;
CREATE TRIGGER trg_loyalty_rewards_guard BEFORE INSERT OR UPDATE ON public.loyalty_rewards
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_config_guard();

-- ============================================================
-- 2) STATE TABLES (server-written only)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.loyalty_accounts (
  customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  points_balance integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT la_lifetime_check CHECK (lifetime_points >= 0)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_user ON public.loyalty_accounts (user_id, points_balance DESC);

CREATE TABLE IF NOT EXISTS public.loyalty_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reward_id uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  reward_name text NOT NULL,
  reward_type text NOT NULL,
  reward_value numeric(10,2),
  points_cost integer NOT NULL CHECK (points_cost > 0),
  code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  requested_via text NOT NULL DEFAULT 'dashboard' CHECK (requested_via IN ('portal', 'dashboard')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  fulfilled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_redemptions_code ON public.loyalty_redemptions (user_id, code);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_status ON public.loyalty_redemptions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_customer ON public.loyalty_redemptions (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  entry_type text NOT NULL,
  points integer NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  redemption_id uuid REFERENCES public.loyalty_redemptions(id) ON DELETE SET NULL,
  breakdown jsonb,
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ll_type_check CHECK (entry_type IN ('earn', 'reinstate', 'reversal', 'redeem', 'refund', 'adjust')),
  CONSTRAINT ll_sign_check CHECK (
    points <> 0 AND (
      (entry_type IN ('earn', 'reinstate', 'refund') AND points > 0)
      OR (entry_type IN ('reversal', 'redeem') AND points < 0)
      OR entry_type = 'adjust'
    )
  ),
  CONSTRAINT ll_note_check CHECK (note IS NULL OR char_length(note) <= 300)
);
-- A job can be earned once; later reversals / reinstatements are separate entries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_ledger_job_earn ON public.loyalty_ledger (job_id)
  WHERE entry_type = 'earn' AND job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_customer ON public.loyalty_ledger (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_user ON public.loyalty_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_job ON public.loyalty_ledger (job_id) WHERE job_id IS NOT NULL;

-- ============================================================
-- 3) RLS + GRANTS
-- ============================================================
ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_earn_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.loyalty_settings, public.loyalty_tiers, public.loyalty_earn_rules, public.loyalty_rewards,
  public.loyalty_accounts, public.loyalty_redemptions, public.loyalty_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.loyalty_accounts, public.loyalty_redemptions, public.loyalty_ledger FROM authenticated;

DROP POLICY IF EXISTS "loyalty_settings_select" ON public.loyalty_settings;
CREATE POLICY "loyalty_settings_select" ON public.loyalty_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_settings_insert" ON public.loyalty_settings;
CREATE POLICY "loyalty_settings_insert" ON public.loyalty_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_settings_update" ON public.loyalty_settings;
CREATE POLICY "loyalty_settings_update" ON public.loyalty_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "loyalty_tiers_select" ON public.loyalty_tiers;
CREATE POLICY "loyalty_tiers_select" ON public.loyalty_tiers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_tiers_insert" ON public.loyalty_tiers;
CREATE POLICY "loyalty_tiers_insert" ON public.loyalty_tiers FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_tiers_update" ON public.loyalty_tiers;
CREATE POLICY "loyalty_tiers_update" ON public.loyalty_tiers FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_tiers_delete" ON public.loyalty_tiers;
CREATE POLICY "loyalty_tiers_delete" ON public.loyalty_tiers FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "loyalty_earn_rules_select" ON public.loyalty_earn_rules;
CREATE POLICY "loyalty_earn_rules_select" ON public.loyalty_earn_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_earn_rules_insert" ON public.loyalty_earn_rules;
CREATE POLICY "loyalty_earn_rules_insert" ON public.loyalty_earn_rules FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_earn_rules_update" ON public.loyalty_earn_rules;
CREATE POLICY "loyalty_earn_rules_update" ON public.loyalty_earn_rules FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_earn_rules_delete" ON public.loyalty_earn_rules;
CREATE POLICY "loyalty_earn_rules_delete" ON public.loyalty_earn_rules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "loyalty_rewards_select" ON public.loyalty_rewards;
CREATE POLICY "loyalty_rewards_select" ON public.loyalty_rewards FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_rewards_insert" ON public.loyalty_rewards;
CREATE POLICY "loyalty_rewards_insert" ON public.loyalty_rewards FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_rewards_update" ON public.loyalty_rewards;
CREATE POLICY "loyalty_rewards_update" ON public.loyalty_rewards FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "loyalty_rewards_delete" ON public.loyalty_rewards;
CREATE POLICY "loyalty_rewards_delete" ON public.loyalty_rewards FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "loyalty_accounts_select" ON public.loyalty_accounts;
CREATE POLICY "loyalty_accounts_select" ON public.loyalty_accounts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_redemptions_select" ON public.loyalty_redemptions;
CREATE POLICY "loyalty_redemptions_select" ON public.loyalty_redemptions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "loyalty_ledger_select" ON public.loyalty_ledger;
CREATE POLICY "loyalty_ledger_select" ON public.loyalty_ledger FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- ============================================================
-- 4) EARN MATH (shared by the trigger, backfill and previews)
-- ============================================================
CREATE OR REPLACE FUNCTION public.loyalty_tier_for(p_user uuid, p_lifetime integer)
RETURNS TABLE (id uuid, name text, earn_multiplier numeric, min_lifetime_points integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT t.id, t.name, t.earn_multiplier, t.min_lifetime_points
    FROM public.loyalty_tiers t
   WHERE t.user_id = p_user AND t.min_lifetime_points <= COALESCE(p_lifetime, 0)
   ORDER BY t.min_lifetime_points DESC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.loyalty_tier_for(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_tier_for(uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.loyalty_base_points(p_user uuid, p_service text, p_amount numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE r.kind WHEN 'per_dollar' THEN p_amount * r.points_value ELSE r.points_value END), 0)
    FROM public.loyalty_earn_rules r
   WHERE r.user_id = p_user
     AND r.is_active
     AND r.min_invoice_amount <= p_amount
     AND (r.service_type IS NULL OR lower(btrim(r.service_type)) = lower(btrim(COALESCE(p_service, ''))));
$$;
REVOKE ALL ON FUNCTION public.loyalty_base_points(uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_base_points(uuid, text, numeric) TO authenticated, service_role;

-- ============================================================
-- 5) INTERNAL LEDGER WRITERS (service_role / other definer functions only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.loyalty_lock_account(p_user uuid, p_customer uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.loyalty_accounts (customer_id, user_id)
  VALUES (p_customer, p_user)
  ON CONFLICT (customer_id) DO NOTHING;

  PERFORM 1 FROM public.loyalty_accounts WHERE customer_id = p_customer FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_lock_account(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_lock_account(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.loyalty_apply_entry(
  p_user uuid, p_customer uuid, p_type text, p_points integer,
  p_job uuid, p_redemption uuid, p_breakdown jsonb, p_note text, p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.loyalty_lock_account(p_user, p_customer);

  INSERT INTO public.loyalty_ledger (user_id, customer_id, entry_type, points, job_id, redemption_id, breakdown, note, created_by)
  VALUES (p_user, p_customer, p_type, p_points, p_job, p_redemption, p_breakdown, NULLIF(btrim(COALESCE(p_note, '')), ''), p_actor)
  RETURNING id INTO v_id;

  UPDATE public.loyalty_accounts
     SET points_balance = points_balance + p_points,
         lifetime_points = GREATEST(0, lifetime_points + CASE WHEN p_type IN ('earn', 'reinstate', 'reversal', 'adjust') THEN p_points ELSE 0 END),
         last_activity_at = now()
   WHERE customer_id = p_customer;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_apply_entry(uuid, uuid, text, integer, uuid, uuid, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_apply_entry(uuid, uuid, text, integer, uuid, uuid, jsonb, text, uuid) TO service_role;

-- Award points for one paid job. Idempotent: returns false when nothing was (or needed to be) awarded.
CREATE OR REPLACE FUNCTION public.loyalty_award_job(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
  v_enabled boolean;
  v_life integer;
  v_mult numeric;
  v_net bigint;
  v_base numeric;
  v_pts integer;
  v_type text;
  v_rules jsonb;
BEGIN
  SELECT jb.id, jb.user_id, jb.customer_id, jb.invoice_amount, jb.service_type
    INTO j
    FROM public.jobs jb
   WHERE jb.id = p_job_id;
  IF NOT FOUND OR j.customer_id IS NULL OR COALESCE(j.invoice_amount, 0) <= 0 THEN
    RETURN false;
  END IF;

  SELECT s.is_enabled INTO v_enabled FROM public.loyalty_settings s WHERE s.user_id = j.user_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM public.customers c WHERE c.id = j.customer_id AND c.user_id = j.user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.loyalty_lock_account(j.user_id, j.customer_id);

  SELECT COALESCE(sum(l.points), 0) INTO v_net
    FROM public.loyalty_ledger l
   WHERE l.job_id = p_job_id AND l.entry_type IN ('earn', 'reinstate', 'reversal');
  IF v_net > 0 THEN
    RETURN false; -- already awarded
  END IF;

  SELECT a.lifetime_points INTO v_life FROM public.loyalty_accounts a WHERE a.customer_id = j.customer_id;
  SELECT x.earn_multiplier INTO v_mult FROM public.loyalty_tier_for(j.user_id, COALESCE(v_life, 0)) x;
  v_mult := COALESCE(v_mult, 1);

  v_base := public.loyalty_base_points(j.user_id, j.service_type, j.invoice_amount);
  v_pts := LEAST(floor(v_base * v_mult), 1000000::numeric)::integer;
  IF v_pts <= 0 THEN
    RETURN false;
  END IF;

  SELECT COALESCE(jsonb_agg(r.name ORDER BY r.created_at), '[]'::jsonb) INTO v_rules
    FROM public.loyalty_earn_rules r
   WHERE r.user_id = j.user_id AND r.is_active AND r.min_invoice_amount <= j.invoice_amount
     AND (r.service_type IS NULL OR lower(btrim(r.service_type)) = lower(btrim(COALESCE(j.service_type, ''))));

  v_type := CASE WHEN EXISTS (SELECT 1 FROM public.loyalty_ledger l WHERE l.job_id = p_job_id AND l.entry_type = 'earn')
                 THEN 'reinstate' ELSE 'earn' END;

  PERFORM public.loyalty_apply_entry(
    j.user_id, j.customer_id, v_type, v_pts, p_job_id, NULL,
    jsonb_build_object('base', round(v_base, 2), 'multiplier', v_mult, 'invoice_amount', j.invoice_amount, 'rules', v_rules),
    NULL, NULL
  );
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_award_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_award_job(uuid) TO service_role;

-- Take points back when a paid invoice stops being paid.
CREATE OR REPLACE FUNCTION public.loyalty_reverse_job(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_customer uuid;
  v_net bigint;
BEGIN
  SELECT l.user_id, l.customer_id INTO v_user, v_customer
    FROM public.loyalty_ledger l
   WHERE l.job_id = p_job_id AND l.entry_type = 'earn';
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM public.loyalty_lock_account(v_user, v_customer);

  SELECT COALESCE(sum(l.points), 0) INTO v_net
    FROM public.loyalty_ledger l
   WHERE l.job_id = p_job_id AND l.entry_type IN ('earn', 'reinstate', 'reversal');
  IF v_net <= 0 THEN
    RETURN false;
  END IF;

  PERFORM public.loyalty_apply_entry(
    v_user, v_customer, 'reversal', -v_net::integer, p_job_id, NULL,
    jsonb_build_object('reason', 'invoice_no_longer_paid'), 'Invoice is no longer paid', NULL
  );
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_reverse_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_reverse_job(uuid) TO service_role;

-- Create a pending redemption and spend the points (one transaction, account row locked).
CREATE OR REPLACE FUNCTION public.loyalty_create_redemption(
  p_user uuid, p_customer uuid, p_reward uuid, p_via text, p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  rw public.loyalty_rewards%ROWTYPE;
  v_balance integer;
  v_code text;
  v_id uuid;
  v_new integer;
  i integer;
BEGIN
  SELECT s.is_enabled INTO v_enabled FROM public.loyalty_settings s WHERE s.user_id = p_user;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'The rewards program is turned off.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rw FROM public.loyalty_rewards r WHERE r.id = p_reward AND r.user_id = p_user AND r.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That reward is not available.' USING ERRCODE = '22023';
  END IF;

  PERFORM public.loyalty_lock_account(p_user, p_customer);
  SELECT a.points_balance INTO v_balance FROM public.loyalty_accounts a WHERE a.customer_id = p_customer;
  IF COALESCE(v_balance, 0) < rw.points_cost THEN
    RAISE EXCEPTION 'Not enough points for this reward.' USING ERRCODE = '22023';
  END IF;

  FOR i IN 1..5 LOOP
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    BEGIN
      INSERT INTO public.loyalty_redemptions
        (user_id, customer_id, reward_id, reward_name, reward_type, reward_value, points_cost, code, requested_via)
      VALUES
        (p_user, p_customer, rw.id, rw.name, rw.reward_type, rw.reward_value, rw.points_cost, v_code,
         CASE WHEN p_via = 'portal' THEN 'portal' ELSE 'dashboard' END)
      RETURNING id INTO v_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_id := NULL;
    END;
  END LOOP;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Could not create the redemption. Please try again.' USING ERRCODE = '54000';
  END IF;

  PERFORM public.loyalty_apply_entry(
    p_user, p_customer, 'redeem', -rw.points_cost, NULL, v_id, jsonb_build_object('reward', rw.name), NULL, p_actor
  );
  SELECT a.points_balance INTO v_new FROM public.loyalty_accounts a WHERE a.customer_id = p_customer;

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code, 'status', 'pending', 'reward_name', rw.name,
    'points_cost', rw.points_cost, 'balance', v_new
  );
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_create_redemption(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_create_redemption(uuid, uuid, uuid, text, uuid) TO service_role;

-- ============================================================
-- 6) TRIGGERS on jobs: paid -> earn, unpaid -> reversal (never blocks the invoice write)
-- ============================================================
CREATE OR REPLACE FUNCTION public.loyalty_on_job_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.invoice_status = 'paid' AND (TG_OP = 'INSERT' OR OLD.invoice_status IS DISTINCT FROM 'paid') THEN
    PERFORM public.loyalty_award_job(NEW.id);
  ELSIF TG_OP = 'UPDATE' AND OLD.invoice_status = 'paid' AND NEW.invoice_status IS DISTINCT FROM 'paid' THEN
    PERFORM public.loyalty_reverse_job(NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'loyalty_on_job_paid failed for job %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_on_job_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_loyalty_job_paid_ins ON public.jobs;
CREATE TRIGGER trg_loyalty_job_paid_ins
  AFTER INSERT ON public.jobs
  FOR EACH ROW WHEN (NEW.invoice_status = 'paid')
  EXECUTE FUNCTION public.loyalty_on_job_paid();

DROP TRIGGER IF EXISTS trg_loyalty_job_paid_upd ON public.jobs;
CREATE TRIGGER trg_loyalty_job_paid_upd
  AFTER UPDATE OF invoice_status ON public.jobs
  FOR EACH ROW WHEN (OLD.invoice_status IS DISTINCT FROM NEW.invoice_status)
  EXECUTE FUNCTION public.loyalty_on_job_paid();

-- ============================================================
-- 7) STAFF RPCs (managers write; messages are user-safe)
-- ============================================================
CREATE OR REPLACE FUNCTION public.loyalty_adjust_points(p_customer_id uuid, p_points integer, p_note text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_balance integer;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can adjust points.' USING ERRCODE = '42501';
  END IF;
  IF p_points IS NULL OR p_points = 0 OR abs(p_points) > 100000 THEN
    RAISE EXCEPTION 'Enter a point amount between 1 and 100,000 (use a minus sign to remove points).' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 2 OR char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'Add a short reason (2-300 characters).' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.customers c WHERE c.id = p_customer_id AND c.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found.' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.loyalty_lock_account(v_owner, p_customer_id);
  SELECT a.points_balance INTO v_balance FROM public.loyalty_accounts a WHERE a.customer_id = p_customer_id;
  IF v_balance + p_points < 0 THEN
    RAISE EXCEPTION 'This would take the balance below zero.' USING ERRCODE = '22023';
  END IF;

  PERFORM public.loyalty_apply_entry(v_owner, p_customer_id, 'adjust', p_points, NULL, NULL, NULL, v_note, auth.uid());
  RETURN v_balance + p_points;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_adjust_points(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_adjust_points(uuid, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.loyalty_redeem_for_customer(p_customer_id uuid, p_reward_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can redeem rewards for customers.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.customers c WHERE c.id = p_customer_id AND c.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.loyalty_create_redemption(v_owner, p_customer_id, p_reward_id, 'dashboard', auth.uid());
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_redeem_for_customer(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_redeem_for_customer(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.loyalty_set_redemption_status(p_redemption_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r public.loyalty_redemptions%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can update redemptions.' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('fulfilled', 'cancelled') THEN
    RAISE EXCEPTION 'Choose fulfilled or cancelled.' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Notes can be at most 500 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.loyalty_redemptions x WHERE x.id = p_redemption_id AND x.user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Redemption not found.' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'This redemption is already closed.' USING ERRCODE = '22023';
  END IF;

  IF p_status = 'fulfilled' THEN
    UPDATE public.loyalty_redemptions
       SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by = auth.uid(), note = COALESCE(v_note, note)
     WHERE id = r.id;
  ELSE
    PERFORM public.loyalty_lock_account(v_owner, r.customer_id);
    UPDATE public.loyalty_redemptions
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), note = COALESCE(v_note, note)
     WHERE id = r.id;
    PERFORM public.loyalty_apply_entry(
      v_owner, r.customer_id, 'refund', r.points_cost, NULL, r.id,
      jsonb_build_object('reward', r.reward_name), v_note, auth.uid()
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_set_redemption_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_set_redemption_status(uuid, text, text) TO authenticated;

-- Award points for paid invoices that existed before the program was switched on.
CREATE OR REPLACE FUNCTION public.loyalty_backfill_paid_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_enabled boolean;
  v_count integer := 0;
  r record;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can award points for past jobs.' USING ERRCODE = '42501';
  END IF;
  SELECT s.is_enabled INTO v_enabled FROM public.loyalty_settings s WHERE s.user_id = v_owner;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'Turn the program on first.' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT jb.id
      FROM public.jobs jb
     WHERE jb.user_id = v_owner
       AND jb.invoice_status = 'paid'
       AND jb.customer_id IS NOT NULL
       AND COALESCE(jb.invoice_amount, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM public.loyalty_ledger l WHERE l.job_id = jb.id AND l.entry_type = 'earn')
     ORDER BY jb.created_at
     LIMIT 5000
  LOOP
    IF public.loyalty_award_job(r.id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.loyalty_backfill_paid_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_backfill_paid_jobs() TO authenticated;

-- ============================================================
-- 8) READ MODELS (caller's RLS applies)
-- ============================================================
CREATE OR REPLACE VIEW public.loyalty_member_summary WITH (security_invoker = true) AS
SELECT
  a.customer_id,
  a.user_id,
  c.name,
  c.phone,
  c.email,
  a.points_balance,
  a.lifetime_points,
  t.id AS tier_id,
  t.name AS tier_name,
  t.earn_multiplier,
  a.last_activity_at
FROM public.loyalty_accounts a
JOIN public.customers c ON c.id = a.customer_id
LEFT JOIN LATERAL public.loyalty_tier_for(a.user_id, a.lifetime_points) t ON true;
GRANT SELECT ON public.loyalty_member_summary TO authenticated;
REVOKE ALL ON public.loyalty_member_summary FROM anon;

CREATE OR REPLACE VIEW public.loyalty_redemption_details WITH (security_invoker = true) AS
SELECT
  r.id, r.user_id, r.customer_id, c.name AS customer_name, c.phone AS customer_phone,
  r.reward_id, r.reward_name, r.reward_type, r.reward_value, r.points_cost, r.code, r.status,
  r.requested_via, r.note, r.created_at, r.fulfilled_at, r.cancelled_at
FROM public.loyalty_redemptions r
JOIN public.customers c ON c.id = r.customer_id;
GRANT SELECT ON public.loyalty_redemption_details TO authenticated;
REVOKE ALL ON public.loyalty_redemption_details FROM anon;

CREATE OR REPLACE FUNCTION public.loyalty_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'members', (SELECT count(*) FROM public.loyalty_accounts a WHERE a.user_id = public.get_account_owner_id()),
    'outstanding_points', (SELECT COALESCE(sum(GREATEST(a.points_balance, 0)), 0) FROM public.loyalty_accounts a WHERE a.user_id = public.get_account_owner_id()),
    'issued_30d', (SELECT COALESCE(sum(l.points), 0) FROM public.loyalty_ledger l
                    WHERE l.user_id = public.get_account_owner_id() AND l.entry_type IN ('earn', 'reinstate')
                      AND l.created_at >= now() - interval '30 days'),
    'redeemed_30d', (SELECT COALESCE(-sum(l.points), 0) FROM public.loyalty_ledger l
                      WHERE l.user_id = public.get_account_owner_id() AND l.entry_type = 'redeem'
                        AND l.created_at >= now() - interval '30 days'),
    'pending_redemptions', (SELECT count(*) FROM public.loyalty_redemptions r
                             WHERE r.user_id = public.get_account_owner_id() AND r.status = 'pending')
  );
$$;
REVOKE ALL ON FUNCTION public.loyalty_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_overview() TO authenticated;

-- ============================================================
-- 9) CUSTOMER PORTAL RPCs (token-validated; no staff notes are exposed)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_portal_loyalty(p_portal_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.customers%ROWTYPE;
  s public.loyalty_settings%ROWTYPE;
  v_portal boolean;
  v_balance integer := 0;
  v_life integer := 0;
  v_tier jsonb;
  v_next jsonb;
BEGIN
  SELECT * INTO c FROM public.customers x WHERE x.portal_token = p_portal_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(bp.allow_customer_portal, false) INTO v_portal
    FROM public.profiles p
    LEFT JOIN public.business_profile bp ON bp.user_id = p.id
   WHERE p.id = c.user_id;
  IF NOT COALESCE(v_portal, false) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO s FROM public.loyalty_settings x WHERE x.user_id = c.user_id;
  IF NOT FOUND OR NOT s.is_enabled THEN
    RETURN NULL;
  END IF;

  SELECT a.points_balance, a.lifetime_points INTO v_balance, v_life
    FROM public.loyalty_accounts a WHERE a.customer_id = c.id;
  v_balance := COALESCE(v_balance, 0);
  v_life := COALESCE(v_life, 0);

  SELECT jsonb_build_object('name', t.name, 'earn_multiplier', t.earn_multiplier, 'perks', tt.perks, 'min_lifetime_points', t.min_lifetime_points)
    INTO v_tier
    FROM public.loyalty_tier_for(c.user_id, v_life) t
    JOIN public.loyalty_tiers tt ON tt.id = t.id;

  SELECT jsonb_build_object('name', n.name, 'min_lifetime_points', n.min_lifetime_points, 'points_needed', n.min_lifetime_points - v_life)
    INTO v_next
    FROM public.loyalty_tiers n
   WHERE n.user_id = c.user_id AND n.min_lifetime_points > v_life
   ORDER BY n.min_lifetime_points
   LIMIT 1;

  RETURN jsonb_build_object(
    'program', jsonb_build_object('name', s.program_name, 'points_label', s.points_label, 'redemption_enabled', s.portal_redemption_enabled),
    'balance', v_balance,
    'lifetime', v_life,
    'tier', v_tier,
    'next_tier', v_next,
    'tiers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', t.name, 'min_lifetime_points', t.min_lifetime_points, 'earn_multiplier', t.earn_multiplier, 'perks', t.perks)
                       ORDER BY t.min_lifetime_points)
        FROM public.loyalty_tiers t WHERE t.user_id = c.user_id
    ), '[]'::jsonb),
    'rewards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'description', w.description, 'points_cost', w.points_cost,
                                          'reward_type', w.reward_type, 'reward_value', w.reward_value)
                       ORDER BY w.points_cost, w.name)
        FROM public.loyalty_rewards w WHERE w.user_id = c.user_id AND w.is_active
    ), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC)
        FROM (
          SELECT l.id, l.entry_type, l.points, l.created_at,
                 CASE l.entry_type
                   WHEN 'earn' THEN 'Points earned'
                   WHEN 'reinstate' THEN 'Points restored'
                   WHEN 'reversal' THEN 'Points reversed'
                   WHEN 'redeem' THEN 'Redeemed: ' || COALESCE(rd.reward_name, 'reward')
                   WHEN 'refund' THEN 'Redemption cancelled, points returned'
                   ELSE 'Adjustment'
                 END AS label
            FROM public.loyalty_ledger l
            LEFT JOIN public.loyalty_redemptions rd ON rd.id = l.redemption_id
           WHERE l.customer_id = c.id
           ORDER BY l.created_at DESC
           LIMIT 20
        ) h
    ), '[]'::jsonb),
    'redemptions', COALESCE((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC)
        FROM (
          SELECT r.id, r.reward_name, r.points_cost, r.status, r.code, r.created_at
            FROM public.loyalty_redemptions r
           WHERE r.customer_id = c.id
           ORDER BY r.created_at DESC
           LIMIT 10
        ) q
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_portal_loyalty(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portal_loyalty(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_redeem_loyalty(p_portal_token uuid, p_reward_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.customers%ROWTYPE;
  s public.loyalty_settings%ROWTYPE;
  v_portal boolean;
BEGIN
  SELECT * INTO c FROM public.customers x WHERE x.portal_token = p_portal_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This link is not valid.' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(bp.allow_customer_portal, false) INTO v_portal
    FROM public.profiles p
    LEFT JOIN public.business_profile bp ON bp.user_id = p.id
   WHERE p.id = c.user_id;
  IF NOT COALESCE(v_portal, false) THEN
    RAISE EXCEPTION 'This link is not valid.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO s FROM public.loyalty_settings x WHERE x.user_id = c.user_id;
  IF NOT FOUND OR NOT s.is_enabled OR NOT s.portal_redemption_enabled THEN
    RAISE EXCEPTION 'Rewards cannot be redeemed online right now. Please contact the business.' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) FROM public.loyalty_redemptions r WHERE r.customer_id = c.id AND r.status = 'pending') >= 3 THEN
    RAISE EXCEPTION 'You already have 3 rewards waiting to be fulfilled. Please wait for them to be completed.' USING ERRCODE = '22023';
  END IF;

  RETURN public.loyalty_create_redemption(c.user_id, c.id, p_reward_id, 'portal', NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.portal_redeem_loyalty(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_redeem_loyalty(uuid, uuid) TO anon, authenticated;
