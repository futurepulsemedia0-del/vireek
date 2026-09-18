/*
# Labor-Sharing Marketplace

## Why
Every trade covered by this project (HVAC, plumbing, electrical, roofing,
restoration, locksmith) deals with the same seasonal problem: one business
is slammed and turning away work while another, nearby, has idle
technicians that week. There was no schema anywhere for businesses to
post spare capacity or a labor need and connect with each other.

## What this does
- New table `labor_marketplace_listings`: a business posts either
  'offering' (spare technician capacity available to lend out) or
  'requesting' (needs extra hands for a stretch of dates). Business/contact
  details are captured directly on the row (denormalized) rather than
  joined from `profiles`, because `profiles` RLS only allows a user to
  read their own row (20260821101104_create_profiles_and_team_members.sql)
  — a cross-tenant marketplace can't join through it, same reasoning
  `insurance_claims` already applies to `customer_name` etc.
- New table `labor_marketplace_matches`: one row per business that
  responds to a listing with an offer/acceptance. Also denormalizes the
  responder's business/contact details for the same reason.
- Reuses the EXISTING `public.dispatch_customer_webhook()` function (same
  pattern as insurance_claims / commercial_contracts) for both tables —
  any webhook already connected under Integrations picks up
  `labor_listing.created` and `labor_match.created` automatically. This
  requires a `user_id` column on both tables (the function reads
  `NEW.user_id`), so on matches that column holds the RESPONDING
  business, not the original poster.
- `updated_at` auto-touch trigger on both tables, reusing
  `public.set_updated_at()` (already created by
  20261002000000_commercial_contract_sla_management.sql; CREATE OR
  REPLACE here too so this migration is not order-dependent on that one).

## RLS — this table is intentionally cross-tenant readable
Unlike every other per-tenant table in this project, a marketplace only
works if OTHER businesses can see it:
- `labor_marketplace_listings`: any authenticated user can SELECT a row
  that is `status = 'open'`, in addition to all of their OWN rows
  regardless of status. Insert/update/delete remain restricted to the
  posting business via `public.get_account_owner_id()`, same as every
  other table in this project.
- `labor_marketplace_matches`: visible to the responding business AND to
  the owner of the listing being responded to (checked via a scoped
  EXISTS against `labor_marketplace_listings`, which is safe to read
  because RLS on that table already permits it for open listings, and
  for the owner's own listings regardless of status). No cross-tenant
  table is granted blanket access — only exactly the rows a match links
  the two accounts to.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS labor_marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  listing_type text NOT NULL DEFAULT 'offering'
    CHECK (listing_type IN ('offering', 'requesting')),
  trade_category text NOT NULL DEFAULT 'general'
    CHECK (trade_category IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')),

  title text NOT NULL,
  description text,
  technicians_count integer NOT NULL DEFAULT 1 CHECK (technicians_count > 0),
  start_date date,
  end_date date,
  hourly_rate_cents integer,

  location_city text,
  location_region text,

  business_name text NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'matched', 'closed', 'expired')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_labor_listings_status_type
  ON labor_marketplace_listings(status, listing_type, trade_category);
CREATE INDEX IF NOT EXISTS idx_labor_listings_user
  ON labor_marketplace_listings(user_id, created_at DESC);

ALTER TABLE labor_marketplace_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_open_or_own_labor_listings" ON labor_marketplace_listings;
CREATE POLICY "select_open_or_own_labor_listings"
ON labor_marketplace_listings FOR SELECT
TO authenticated
USING (status = 'open' OR user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_labor_listings" ON labor_marketplace_listings;
CREATE POLICY "insert_own_labor_listings"
ON labor_marketplace_listings FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_labor_listings" ON labor_marketplace_listings;
CREATE POLICY "update_own_labor_listings"
ON labor_marketplace_listings FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_labor_listings" ON labor_marketplace_listings;
CREATE POLICY "delete_own_labor_listings"
ON labor_marketplace_listings FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_labor_listings ON labor_marketplace_listings;
CREATE TRIGGER trigger_touch_labor_listings
  BEFORE UPDATE ON labor_marketplace_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_webhook_new_labor_listing ON labor_marketplace_listings;
CREATE TRIGGER trigger_webhook_new_labor_listing
  AFTER INSERT ON labor_marketplace_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('labor_listing.created');

-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS labor_marketplace_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES labor_marketplace_listings(id) ON DELETE CASCADE,

  -- The RESPONDING business. Named user_id (not responder_user_id) so
  -- the existing dispatch_customer_webhook() trigger function — which
  -- always reads NEW.user_id — works unmodified.
  user_id uuid NOT NULL DEFAULT auth.uid(),

  business_name text NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,

  agreed_technicians_count integer,
  agreed_rate_cents integer,
  message text,

  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'declined', 'completed', 'cancelled')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_labor_matches_listing
  ON labor_marketplace_matches(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labor_matches_user
  ON labor_marketplace_matches(user_id, created_at DESC);

ALTER TABLE labor_marketplace_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_labor_matches_responder_or_listing_owner" ON labor_marketplace_matches;
CREATE POLICY "select_labor_matches_responder_or_listing_owner"
ON labor_marketplace_matches FOR SELECT
TO authenticated
USING (
  user_id = public.get_account_owner_id()
  OR EXISTS (
    SELECT 1 FROM labor_marketplace_listings l
    WHERE l.id = listing_id AND l.user_id = public.get_account_owner_id()
  )
);

DROP POLICY IF EXISTS "insert_own_labor_matches" ON labor_marketplace_matches;
CREATE POLICY "insert_own_labor_matches"
ON labor_marketplace_matches FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_labor_matches_responder_or_listing_owner" ON labor_marketplace_matches;
CREATE POLICY "update_labor_matches_responder_or_listing_owner"
ON labor_marketplace_matches FOR UPDATE
TO authenticated
USING (
  user_id = public.get_account_owner_id()
  OR EXISTS (
    SELECT 1 FROM labor_marketplace_listings l
    WHERE l.id = listing_id AND l.user_id = public.get_account_owner_id()
  )
)
WITH CHECK (
  user_id = public.get_account_owner_id()
  OR EXISTS (
    SELECT 1 FROM labor_marketplace_listings l
    WHERE l.id = listing_id AND l.user_id = public.get_account_owner_id()
  )
);

DROP POLICY IF EXISTS "delete_own_labor_matches" ON labor_marketplace_matches;
CREATE POLICY "delete_own_labor_matches"
ON labor_marketplace_matches FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_labor_matches ON labor_marketplace_matches;
CREATE TRIGGER trigger_touch_labor_matches
  BEFORE UPDATE ON labor_marketplace_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_webhook_new_labor_match ON labor_marketplace_matches;
CREATE TRIGGER trigger_webhook_new_labor_match
  AFTER INSERT ON labor_marketplace_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('labor_match.created');
