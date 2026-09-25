/*
  # Partner Portal

  A real, self-serve portal for Vireek's own Affiliate/Agency partners
  (people referring NEW businesses to Vireek), distinct from every other
  "referral"-shaped feature already in this codebase:
    - /referral            -> existing Vireek CUSTOMERS referring another
                               contractor, rewarded with account credit
                               (table: whatever backs track_referral_click()).
    - /affiliate, /partners -> marketing pages only, mailto "apply" CTA.
    - THIS migration        -> the logged-in portal behind those two pages:
                               application, referral link + click tracking,
                               conversion + commission tracking, and a
                               certification course.

  Tables (all prefixed partner_ / partners to avoid any collision with the
  existing referral system):
    1. partners                 one row per partner account (1:1 auth.users)
    2. partner_link_clicks      raw click events on /r/:code
    3. partner_referrals        one row per person who signed up through a
                                 partner's link; tracks conversion + $ owed
    4. partner_academy_progress lesson completions (mirrors academy_progress)
    5. partner_certifications   one row once a partner passes the quiz

  RPCs (all SECURITY DEFINER, all the ONLY way to write the tables above —
  there are no client-facing INSERT/UPDATE policies, so a client can never
  fabricate a click, a referral, a commission amount, or a passing score):
    - apply_for_partner_program()        creates the `partners` row + code
    - record_partner_click(code)         anon-callable, logs a click
    - attribute_partner_referral(...)    called right after signup if a
                                          partner code is present
    - record_partner_certification(score) inserts a passing certificate row
    - approve_partner_application(id)    staff only
    - reject_partner_application(id, reason) staff only
    - set_partner_referral_commission_status(id, status) staff only
    - get_partner_dashboard_stats()      aggregated read for the dashboard

  Conversion + commission are computed automatically by a trigger on
  profiles(subscription_status, plan) — never client-supplied — using the
  same monthly prices as src/lib/pricing.ts. Keep the CASE below in sync if
  those prices ever change.

  Uses the existing is_vireek_staff() helper from
  20260913020000_live_chat_and_academy.sql for every staff-only check.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) partners ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_phone text,
  channel text,
  tier text NOT NULL DEFAULT 'affiliate' CHECK (tier IN ('affiliate', 'agency')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  referral_code text NOT NULL UNIQUE,
  commission_rate numeric NOT NULL DEFAULT 20 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  payout_method text,
  payout_details text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);

ALTER TABLE partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_or_staff_partners" ON partners;
CREATE POLICY "select_own_or_staff_partners" ON partners
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_vireek_staff(auth.uid()));
-- No client INSERT/UPDATE policy on purpose — every write goes through the
-- RPCs below so status, referral_code and commission_rate can never be
-- set directly by a client.

-- 2) partner_link_clicks ------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_link_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  landing_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_clicks_partner ON partner_link_clicks(partner_id, created_at DESC);

ALTER TABLE partner_link_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_or_staff_partner_clicks" ON partner_link_clicks;
CREATE POLICY "select_own_or_staff_partner_clicks" ON partner_link_clicks
  FOR SELECT TO authenticated
  USING (
    partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
    OR is_vireek_staff(auth.uid())
  );

-- 3) partner_referrals ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  referred_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  referred_email text,
  status text NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up', 'converted', 'churned', 'rejected')),
  mrr_cents integer NOT NULL DEFAULT 0,
  commission_cents integer NOT NULL DEFAULT 0,
  commission_status text NOT NULL DEFAULT 'pending' CHECK (commission_status IN ('pending', 'approved', 'paid', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz
);

-- One referral credit per signed-up user, ever.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_referrals_referred_user
  ON partner_referrals(referred_user_id) WHERE referred_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_referrals_partner ON partner_referrals(partner_id, created_at DESC);

ALTER TABLE partner_referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_or_staff_partner_referrals" ON partner_referrals;
CREATE POLICY "select_own_or_staff_partner_referrals" ON partner_referrals
  FOR SELECT TO authenticated
  USING (
    partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
    OR is_vireek_staff(auth.uid())
  );

-- 4) partner_academy_progress (mirrors academy_progress) ----------------------
CREATE TABLE IF NOT EXISTS partner_academy_progress (
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lesson_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

ALTER TABLE partner_academy_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_partner_academy_progress" ON partner_academy_progress;
CREATE POLICY "select_own_partner_academy_progress" ON partner_academy_progress
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_partner_academy_progress" ON partner_academy_progress;
CREATE POLICY "insert_own_partner_academy_progress" ON partner_academy_progress
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_partner_academy_progress" ON partner_academy_progress;
CREATE POLICY "delete_own_partner_academy_progress" ON partner_academy_progress
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- 5) partner_certifications ----------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_certifications (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE partner_certifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_or_staff_partner_certifications" ON partner_certifications;
CREATE POLICY "select_own_or_staff_partner_certifications" ON partner_certifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_vireek_staff(auth.uid()));

-- 6) apply_for_partner_program -------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_for_partner_program(
  p_company_name text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_tier text DEFAULT 'affiliate'
)
RETURNS partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_row partners;
BEGIN
  IF EXISTS (SELECT 1 FROM partners WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You already have a partner application on file.';
  END IF;

  IF p_tier NOT IN ('affiliate', 'agency') THEN
    p_tier := 'affiliate';
  END IF;

  LOOP
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM partners WHERE referral_code = v_code);
  END LOOP;

  INSERT INTO partners (user_id, company_name, contact_name, contact_email, contact_phone, channel, tier, referral_code, commission_rate)
  VALUES (
    auth.uid(),
    NULLIF(TRIM(p_company_name), ''),
    NULLIF(TRIM(p_contact_name), ''),
    NULLIF(TRIM(p_contact_email), ''),
    NULLIF(TRIM(COALESCE(p_contact_phone, '')), ''),
    NULLIF(TRIM(COALESCE(p_channel, '')), ''),
    p_tier,
    v_code,
    CASE WHEN p_tier = 'agency' THEN 25 ELSE 20 END
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_for_partner_program(text, text, text, text, text, text) TO authenticated;

-- 7) record_partner_click — anon-callable from the public /r/:code redirect ---
CREATE OR REPLACE FUNCTION public.record_partner_click(p_code text, p_landing_path text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner_id uuid;
BEGIN
  SELECT id INTO v_partner_id FROM partners WHERE referral_code = upper(TRIM(p_code)) AND status = 'approved';
  IF v_partner_id IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  INSERT INTO partner_link_clicks (partner_id, landing_path) VALUES (v_partner_id, p_landing_path);
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_partner_click(text, text) TO anon, authenticated;

-- 8) attribute_partner_referral — called right after supabase.auth.signUp ----
CREATE OR REPLACE FUNCTION public.attribute_partner_referral(p_code text, p_user_id uuid, p_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner_id uuid;
  v_partner_user_id uuid;
BEGIN
  SELECT id, user_id INTO v_partner_id, v_partner_user_id
  FROM partners WHERE referral_code = upper(TRIM(p_code)) AND status = 'approved';

  IF v_partner_id IS NULL OR p_user_id IS NULL OR v_partner_user_id = p_user_id THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  INSERT INTO partner_referrals (partner_id, referred_user_id, referred_email)
  VALUES (v_partner_id, p_user_id, NULLIF(TRIM(COALESCE(p_email, '')), ''))
  ON CONFLICT (referred_user_id) WHERE referred_user_id IS NOT NULL DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attribute_partner_referral(text, uuid, text) TO anon, authenticated;

-- 9) auto conversion / churn from the referred account's own subscription ----
-- Mirrors src/lib/pricing.ts PLANS[].monthly — update both together.
CREATE OR REPLACE FUNCTION public.sync_partner_referral_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral partner_referrals;
  v_partner partners;
  v_mrr_cents integer;
BEGIN
  SELECT * INTO v_referral FROM partner_referrals WHERE referred_user_id = NEW.id;
  IF v_referral.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_referral.partner_id;

  v_mrr_cents := CASE NEW.plan
    WHEN 'starter' THEN 7900
    WHEN 'professional' THEN 19900
    WHEN 'business' THEN 39900
    ELSE 0
  END;

  IF NEW.subscription_status = 'active' AND v_mrr_cents > 0 AND v_referral.status IN ('signed_up', 'churned') THEN
    UPDATE partner_referrals SET
      status = 'converted',
      mrr_cents = v_mrr_cents,
      commission_cents = round(v_mrr_cents * v_partner.commission_rate / 100.0),
      converted_at = COALESCE(converted_at, now())
    WHERE id = v_referral.id;
  ELSIF NEW.subscription_status IN ('suspended') AND v_referral.status = 'converted' THEN
    UPDATE partner_referrals SET
      status = 'churned',
      commission_status = CASE WHEN commission_status = 'pending' THEN 'void' ELSE commission_status END
    WHERE id = v_referral.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_partner_referral ON profiles;
CREATE TRIGGER trg_sync_partner_referral
  AFTER UPDATE OF subscription_status, plan ON profiles
  FOR EACH ROW
  WHEN (NEW.subscription_status IS DISTINCT FROM OLD.subscription_status OR NEW.plan IS DISTINCT FROM OLD.plan)
  EXECUTE FUNCTION public.sync_partner_referral_from_profile();

-- 10) record_partner_certification — server enforces the passing bar ---------
CREATE OR REPLACE FUNCTION public.record_partner_certification(p_score integer)
RETURNS partner_certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_certifications;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partners WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'No partner application on file.';
  END IF;
  IF p_score < 80 THEN
    RAISE EXCEPTION 'Score below the 80%% passing bar.';
  END IF;

  INSERT INTO partner_certifications (user_id, score)
  VALUES (auth.uid(), LEAST(p_score, 100))
  ON CONFLICT (user_id) DO UPDATE SET score = GREATEST(partner_certifications.score, EXCLUDED.score)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_partner_certification(integer) TO authenticated;

-- 11) staff moderation ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_partner_application(p_partner_id uuid)
RETURNS partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partners;
BEGIN
  IF NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.';
  END IF;
  UPDATE partners SET status = 'approved', approved_at = now()
  WHERE id = p_partner_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_partner_application(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_partner_application(p_partner_id uuid)
RETURNS partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partners;
BEGIN
  IF NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.';
  END IF;
  UPDATE partners SET status = 'rejected'
  WHERE id = p_partner_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_partner_application(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_partner_referral_commission_status(p_referral_id uuid, p_status text)
RETURNS partner_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_referrals;
BEGIN
  IF NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.';
  END IF;
  IF p_status NOT IN ('pending', 'approved', 'paid', 'void') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;
  UPDATE partner_referrals SET commission_status = p_status
  WHERE id = p_referral_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_partner_referral_commission_status(uuid, text) TO authenticated;

-- 12) dashboard read — one round trip for the whole Overview page -------------
CREATE OR REPLACE FUNCTION public.get_partner_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner partners;
  v_result jsonb;
BEGIN
  SELECT * INTO v_partner FROM partners WHERE user_id = auth.uid();
  IF v_partner.id IS NULL THEN
    RETURN jsonb_build_object('has_application', false);
  END IF;

  SELECT jsonb_build_object(
    'has_application', true,
    'partner', to_jsonb(v_partner),
    'total_clicks', (SELECT count(*) FROM partner_link_clicks WHERE partner_id = v_partner.id),
    'total_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id),
    'converted_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id AND status = 'converted'),
    'churned_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id AND status = 'churned'),
    'pending_commission_cents', (SELECT COALESCE(SUM(commission_cents), 0) FROM partner_referrals WHERE partner_id = v_partner.id AND commission_status IN ('pending', 'approved')),
    'paid_commission_cents', (SELECT COALESCE(SUM(commission_cents), 0) FROM partner_referrals WHERE partner_id = v_partner.id AND commission_status = 'paid'),
    'is_certified', (SELECT EXISTS(SELECT 1 FROM partner_certifications WHERE user_id = auth.uid()))
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_partner_dashboard_stats() TO authenticated;
