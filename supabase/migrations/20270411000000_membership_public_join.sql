/*
  # Membership plans — public signup page (/join/:planSlug)

  Lets a business sell a membership plan to end customers from a public
  link, paid through the same Stripe Connect Checkout + payment_requests
  flow the rest of the project already uses (no Stripe Subscriptions).

  ## What this adds
  - membership_plans.public_slug     — globally unique, URL-safe, auto-generated
                                       from the plan name (editable, validated)
  - membership_plans.public_enabled  — opt-in. Existing plans stay private
                                       until the owner switches the link on
  - memberships.signup_source        — 'public_join' for rows created by the page
  - get_public_membership_plan(slug) — anon-callable read for the page; returns
                                       NULL unless the plan is active AND public

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy membership-join-checkout --no-verify-jwt
    3. supabase functions deploy stripe-payment-webhook   (activation edit)
    4. Ship the frontend.
*/

-- =============================================================
-- 1. Columns
-- =============================================================

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS public_slug text,
  ADD COLUMN IF NOT EXISTS public_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS signup_source text;

-- =============================================================
-- 2. Slug generation (name + short random suffix, collision-safe)
-- =============================================================

CREATE OR REPLACE FUNCTION public.membership_plan_assign_public_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_base text;
  v_candidate text;
  v_attempts integer := 0;
BEGIN
  IF NEW.public_slug IS NOT NULL THEN
    NEW.public_slug := lower(btrim(NEW.public_slug));
    RETURN NEW;
  END IF;

  v_base := regexp_replace(lower(COALESCE(NEW.name, '')), '[^a-z0-9]+', '-', 'g');
  v_base := btrim(left(btrim(v_base, '-'), 40), '-');
  IF v_base = '' THEN
    v_base := 'plan';
  END IF;

  LOOP
    v_candidate := v_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM membership_plans WHERE public_slug = v_candidate);
    v_attempts := v_attempts + 1;
    IF v_attempts >= 10 THEN
      v_candidate := v_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
      EXIT;
    END IF;
  END LOOP;

  NEW.public_slug := v_candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_membership_plan_assign_public_slug ON membership_plans;
CREATE TRIGGER trg_membership_plan_assign_public_slug
  BEFORE INSERT OR UPDATE ON membership_plans
  FOR EACH ROW EXECUTE FUNCTION public.membership_plan_assign_public_slug();

-- Backfill existing plans (the no-op update fires the trigger per row).
UPDATE membership_plans SET name = name WHERE public_slug IS NULL;

ALTER TABLE membership_plans DROP CONSTRAINT IF EXISTS membership_plans_public_slug_format;
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_public_slug_format
  CHECK (public_slug IS NULL OR (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(public_slug) BETWEEN 3 AND 60));

CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_plans_public_slug
  ON membership_plans(public_slug) WHERE public_slug IS NOT NULL;

-- Used by the join function's per-plan / per-email rate limit.
CREATE INDEX IF NOT EXISTS idx_memberships_public_join
  ON memberships(plan_id, created_at) WHERE signup_source = 'public_join';

-- =============================================================
-- 3. Public read (anon) — returns only what the page needs
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_public_membership_plan(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pl membership_plans%ROWTYPE;
  v_business text;
  v_can_purchase boolean;
BEGIN
  IF p_slug IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO pl
  FROM membership_plans
  WHERE public_slug = lower(btrim(p_slug)) AND public_enabled AND active;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name INTO v_business FROM profiles p WHERE p.id = pl.user_id;

  -- Stripe's minimum charge is $0.50, and the business must have finished
  -- Stripe Connect verification before it can take money.
  SELECT (pl.price_cents >= 50 AND EXISTS (
    SELECT 1 FROM stripe_connect_accounts c
    WHERE c.user_id = pl.user_id AND c.charges_enabled AND c.stripe_account_id IS NOT NULL
  )) INTO v_can_purchase;

  RETURN jsonb_build_object(
    'slug', pl.public_slug,
    'business_name', v_business,
    'name', pl.name,
    'price_cents', pl.price_cents,
    'billing_interval', pl.billing_interval,
    'benefits', to_jsonb(pl.benefits),
    'visits_included_per_period', pl.visits_included_per_period,
    'service_type', pl.service_type,
    'can_purchase', COALESCE(v_can_purchase, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_membership_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_membership_plan(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_membership_plan(text) IS
  'Anon read of one publicly-enabled membership plan for the /join/:planSlug page. Returns NULL for unknown, inactive or non-public plans.';
