/*
# Contractor Network Hub — Job Handoffs (capacity sharing + emergency network)

## Why
Vireek already has the individual network pieces (labor marketplace, disaster
mutual aid, regional demand, benchmarks). What was missing is the piece that
moves REVENUE between contractors: when a business is at capacity — or an
emergency call cannot be answered fast enough — it can hand the job to a
trusted neighbour instead of losing the customer.

## What this migration adds (all additive, idempotent, no existing table dropped)
1. `business_profile`: network opt-in columns (`network_enabled`,
   `network_joined_at`, `network_contact_phone`).
2. `network_handoffs`           — public, anonymised job card (cross-tenant readable
                                  ONLY by opted-in members while `open`).
3. `network_handoff_contacts`   — private customer details. Readable ONLY by the
                                  poster, and by the claimer AFTER the claim.
4. `network_handoff_events`     — append-only audit trail; source of reputation.
5. RPCs (SECURITY DEFINER, explicit checks): post / claim / release / complete /
   cancel / settle fee / expire / set membership / hub summary.

## Security model
- No INSERT/UPDATE/DELETE policy exists on any of the three tables and the
  privileges are revoked: every mutation goes through an RPC that validates
  membership, ownership and state.
- Claim is a single atomic `UPDATE ... WHERE status='open'` → two contractors
  can never claim the same job.
- Public text fields are rejected if they contain a phone number or e-mail
  (customer PII must go in the private contact block).
- Reciprocity: you only see the network if you are in it (same rule as Mutual Aid).
- Per-account caps (open posts, active claims) limit abuse.

## Depends on (all already in the project)
profiles, business_profile, notifications, get_account_owner_id(),
dispatch_customer_webhook(), labor_marketplace_listings, mutual_aid_requests.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 1. Membership columns
-- ---------------------------------------------------------------------
ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS network_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS network_joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS network_contact_phone text;

CREATE INDEX IF NOT EXISTS idx_business_profile_network_region
  ON business_profile ((lower(btrim(service_area))))
  WHERE network_enabled;

CREATE OR REPLACE FUNCTION public.is_network_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM business_profile bp
    WHERE bp.user_id = public.get_account_owner_id() AND bp.network_enabled
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, -- poster (account owner)
  business_name text NOT NULL,

  kind text NOT NULL DEFAULT 'capacity_overflow'
    CHECK (kind IN ('capacity_overflow', 'emergency')),
  trade_category text NOT NULL DEFAULT 'general'
    CHECK (trade_category IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')),

  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 1000),
  region_key text NOT NULL,
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 80),
  needed_by timestamptz,
  estimated_value_cents integer CHECK (estimated_value_cents IS NULL OR estimated_value_cents >= 0),
  referral_fee_pct numeric(5,2) NOT NULL DEFAULT 10 CHECK (referral_fee_pct BETWEEN 0 AND 50),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,

  claimed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_by_name text,
  claimed_by_phone text,
  claimed_at timestamptz,
  completed_at timestamptz,

  final_amount_cents integer CHECK (final_amount_cents IS NULL OR final_amount_cents >= 0),
  referral_fee_cents integer CHECK (referral_fee_cents IS NULL OR referral_fee_cents >= 0),
  fee_status text NOT NULL DEFAULT 'none'
    CHECK (fee_status IN ('none', 'pending', 'settled', 'waived')),
  released_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_network_handoffs_open
  ON network_handoffs (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_network_handoffs_poster
  ON network_handoffs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_handoffs_claimer
  ON network_handoffs (claimed_by, status) WHERE claimed_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS network_handoff_contacts (
  handoff_id uuid PRIMARY KEY REFERENCES network_handoffs(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_phone text,
  customer_address text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network_handoff_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handoff_id uuid NOT NULL REFERENCES network_handoffs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  event text NOT NULL
    CHECK (event IN ('posted', 'claimed', 'released', 'completed', 'cancelled', 'fee_settled', 'fee_waived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_network_handoff_events_actor
  ON network_handoff_events (actor_id, event);

-- ---------------------------------------------------------------------
-- 3. RLS — read-only for clients, all writes via RPC
-- ---------------------------------------------------------------------
ALTER TABLE network_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_handoff_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_handoff_events ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_handoffs FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_handoff_contacts FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_handoff_events FROM authenticated, anon;
REVOKE SELECT ON network_handoffs, network_handoff_contacts, network_handoff_events FROM anon;

DROP POLICY IF EXISTS "select_network_handoffs" ON network_handoffs;
CREATE POLICY "select_network_handoffs" ON network_handoffs FOR SELECT TO authenticated
USING (
  user_id = (SELECT public.get_account_owner_id())
  OR claimed_by = (SELECT public.get_account_owner_id())
  OR (status = 'open' AND expires_at > now() AND (SELECT public.is_network_member()))
);

DROP POLICY IF EXISTS "select_network_handoff_contacts" ON network_handoff_contacts;
CREATE POLICY "select_network_handoff_contacts" ON network_handoff_contacts FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM network_handoffs h
    WHERE h.id = handoff_id
      AND (
        h.user_id = (SELECT public.get_account_owner_id())
        OR (h.claimed_by = (SELECT public.get_account_owner_id()) AND h.status IN ('claimed', 'completed'))
      )
  )
);

DROP POLICY IF EXISTS "select_own_network_handoff_events" ON network_handoff_events;
CREATE POLICY "select_own_network_handoff_events" ON network_handoff_events FOR SELECT TO authenticated
USING (actor_id = (SELECT public.get_account_owner_id()));

-- ---------------------------------------------------------------------
-- 4. Triggers (updated_at + customer webhooks — reuses existing function)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_touch_network_handoffs ON network_handoffs;
CREATE TRIGGER trigger_touch_network_handoffs
  BEFORE UPDATE ON network_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_webhook_network_handoff_created ON network_handoffs;
CREATE TRIGGER trigger_webhook_network_handoff_created
  AFTER INSERT ON network_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_customer_webhook('network_handoff.created');

DROP TRIGGER IF EXISTS trigger_webhook_network_handoff_claimed ON network_handoffs;
CREATE TRIGGER trigger_webhook_network_handoff_claimed
  AFTER UPDATE ON network_handoffs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'claimed')
  EXECUTE FUNCTION public.dispatch_customer_webhook('network_handoff.claimed');

DROP TRIGGER IF EXISTS trigger_webhook_network_handoff_completed ON network_handoffs;
CREATE TRIGGER trigger_webhook_network_handoff_completed
  AFTER UPDATE ON network_handoffs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed')
  EXECUTE FUNCTION public.dispatch_customer_webhook('network_handoff.completed');

-- ---------------------------------------------------------------------
-- 5. Realtime (safe if the publication does not exist yet)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE network_handoffs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------

-- Phone numbers / e-mails must not leak into PUBLIC text fields.
CREATE OR REPLACE FUNCTION public.network_text_has_contact_info(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p IS NOT NULL AND (
    p ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
    OR p ~ '(\d[\s().-]*){9,}'
  );
$$;

CREATE OR REPLACE FUNCTION public.set_network_membership(p_enabled boolean, p_contact_phone text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_phone text := btrim(coalesce(p_contact_phone, ''));
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;

  IF p_enabled THEN
    IF length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN RAISE EXCEPTION 'CONTACT_PHONE_REQUIRED'; END IF;
    UPDATE business_profile
       SET network_enabled = true,
           network_joined_at = COALESCE(network_joined_at, now()),
           network_contact_phone = v_phone
     WHERE user_id = v_owner
       AND length(btrim(coalesce(service_area, ''))) > 0;
    IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_AREA_REQUIRED'; END IF;
  ELSE
    UPDATE business_profile SET network_enabled = false WHERE user_id = v_owner;
    UPDATE network_handoffs SET status = 'cancelled' WHERE user_id = v_owner AND status = 'open';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_network_handoffs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  WITH expired AS (
    UPDATE network_handoffs
       SET status = 'expired'
     WHERE status = 'open' AND expires_at <= now()
    RETURNING user_id, title, kind
  )
  INSERT INTO notifications (user_id, type, title, message, action_url)
  SELECT user_id, 'system',
         CASE WHEN kind = 'emergency' THEN 'Emergency handoff expired unclaimed' ELSE 'Job handoff expired unclaimed' END,
         '"' || title || '" expired without being claimed by the network.',
         '/dashboard/network/handoffs?tab=posted'
    FROM expired;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_network_handoff(
  p_kind text,
  p_trade text,
  p_title text,
  p_summary text,
  p_location_label text,
  p_needed_by timestamptz,
  p_estimated_value_cents integer,
  p_referral_fee_pct numeric,
  p_customer_name text,
  p_customer_phone text,
  p_customer_address text,
  p_notes text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_region text;
  v_name text;
  v_id uuid;
  v_exp timestamptz;
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
  v_label text := nullif(btrim(coalesce(p_location_label, '')), '');
  v_cust text := btrim(coalesce(p_customer_name, ''));
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_addr text := nullif(btrim(coalesce(p_customer_address, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_network_member() THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  IF COALESCE(p_kind, '') NOT IN ('capacity_overflow', 'emergency')
     OR COALESCE(p_trade, '') NOT IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')
     OR char_length(v_title) NOT BETWEEN 3 AND 120
     OR char_length(COALESCE(v_summary, '')) > 1000
     OR char_length(COALESCE(v_label, '')) > 80
     OR COALESCE(p_estimated_value_cents, 0) < 0
     OR COALESCE(p_referral_fee_pct, 10) NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF public.network_text_has_contact_info(v_title)
     OR public.network_text_has_contact_info(v_summary)
     OR public.network_text_has_contact_info(v_label) THEN
    RAISE EXCEPTION 'PII_IN_PUBLIC_FIELDS';
  END IF;
  IF v_cust = '' OR (v_phone IS NULL AND v_addr IS NULL) THEN RAISE EXCEPTION 'CONTACT_REQUIRED'; END IF;

  SELECT lower(btrim(service_area)) INTO v_region FROM business_profile WHERE user_id = v_owner;
  IF v_region IS NULL OR v_region = '' THEN RAISE EXCEPTION 'SERVICE_AREA_REQUIRED'; END IF;

  IF (SELECT count(*) FROM network_handoffs WHERE user_id = v_owner AND status = 'open') >= 15 THEN
    RAISE EXCEPTION 'TOO_MANY_OPEN';
  END IF;

  SELECT COALESCE(NULLIF(btrim(company_name), ''), 'Vireek member') INTO v_name FROM profiles WHERE id = v_owner;

  v_exp := now() + CASE WHEN p_kind = 'emergency' THEN interval '3 hours' ELSE interval '72 hours' END;
  IF p_needed_by IS NOT NULL THEN
    IF p_needed_by < now() + interval '15 minutes' THEN RAISE EXCEPTION 'NEEDED_BY_TOO_SOON'; END IF;
    v_exp := LEAST(v_exp, p_needed_by);
  END IF;

  INSERT INTO network_handoffs (
    user_id, business_name, kind, trade_category, title, summary, region_key, location_label,
    needed_by, estimated_value_cents, referral_fee_pct, expires_at
  ) VALUES (
    v_owner, v_name, p_kind, p_trade, v_title, v_summary, v_region, v_label,
    p_needed_by, p_estimated_value_cents, COALESCE(p_referral_fee_pct, 10), v_exp
  ) RETURNING id INTO v_id;

  INSERT INTO network_handoff_contacts (handoff_id, customer_name, customer_phone, customer_address, notes)
  VALUES (v_id, v_cust, v_phone, v_addr, nullif(btrim(coalesce(p_notes, '')), ''));

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (v_id, v_owner, 'posted');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_network_handoff(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text;
  v_phone text;
  r network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_network_member() THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  IF (SELECT count(*) FROM network_handoffs WHERE claimed_by = v_owner AND status = 'claimed') >= 10 THEN
    RAISE EXCEPTION 'TOO_MANY_ACTIVE_CLAIMS';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.company_name), ''), 'Vireek member'), bp.network_contact_phone
    INTO v_name, v_phone
    FROM profiles p LEFT JOIN business_profile bp ON bp.user_id = p.id
   WHERE p.id = v_owner;

  -- Single atomic transition: only one caller can ever win this row.
  UPDATE network_handoffs
     SET status = 'claimed', claimed_by = v_owner, claimed_by_name = v_name,
         claimed_by_phone = v_phone, claimed_at = now()
   WHERE id = p_id AND status = 'open' AND expires_at > now() AND user_id <> v_owner
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (r.id, v_owner, 'claimed');
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    r.user_id, 'system',
    CASE WHEN r.kind = 'emergency' THEN 'Emergency job accepted' ELSE 'Job handoff accepted' END,
    v_name || ' accepted "' || r.title || '". Their coordination number is on the handoff card.',
    '/dashboard/network/handoffs?tab=posted'
  );
  RETURN r.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_network_handoff(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text;
  r network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  v_name := (SELECT claimed_by_name FROM network_handoffs WHERE id = p_id AND claimed_by = v_owner);

  UPDATE network_handoffs
     SET status = 'open', claimed_by = NULL, claimed_by_name = NULL, claimed_by_phone = NULL,
         claimed_at = NULL, released_count = released_count + 1,
         expires_at = now() + CASE WHEN kind = 'emergency' THEN interval '1 hour' ELSE interval '24 hours' END
   WHERE id = p_id AND status = 'claimed' AND claimed_by = v_owner
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (r.id, v_owner, 'released');
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    r.user_id, 'system', 'Handoff released back to the network',
    COALESCE(v_name, 'The contractor') || ' could not take "' || r.title || '". It is open again for other members.',
    '/dashboard/network/handoffs?tab=posted'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_network_handoff(p_id uuid, p_final_amount_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fee integer;
  r network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_final_amount_cents IS NULL OR p_final_amount_cents < 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

  UPDATE network_handoffs
     SET status = 'completed', completed_at = now(), final_amount_cents = p_final_amount_cents,
         referral_fee_cents = round(p_final_amount_cents * referral_fee_pct / 100.0)::integer,
         fee_status = CASE WHEN round(p_final_amount_cents * referral_fee_pct / 100.0) > 0 THEN 'pending' ELSE 'none' END
   WHERE id = p_id AND status = 'claimed' AND claimed_by = v_owner
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;
  v_fee := r.referral_fee_cents;

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (r.id, v_owner, 'completed');
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    r.user_id, 'system', 'Handoff completed',
    COALESCE(r.claimed_by_name, 'The contractor') || ' completed "' || r.title || '".'
      || CASE WHEN v_fee > 0 THEN ' Referral fee due to you: $' || to_char(v_fee / 100.0, 'FM999999990.00') || '.' ELSE '' END,
    '/dashboard/network/handoffs?tab=posted'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_network_handoff(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  UPDATE network_handoffs SET status = 'cancelled'
   WHERE id = p_id AND user_id = v_owner AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_NOT_CANCELLABLE'; END IF;

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (p_id, v_owner, 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_network_handoff_fee(p_id uuid, p_outcome text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_outcome NOT IN ('settled', 'waived') THEN RAISE EXCEPTION 'INVALID_OUTCOME'; END IF;

  UPDATE network_handoffs SET fee_status = p_outcome
   WHERE id = p_id AND user_id = v_owner AND status = 'completed' AND fee_status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  INSERT INTO network_handoff_events (handoff_id, actor_id, event)
  VALUES (p_id, v_owner, CASE WHEN p_outcome = 'settled' THEN 'fee_settled' ELSE 'fee_waived' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_network_hub_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_member boolean := false;
  v_region text;
  v_phone text;
  v_joined timestamptz;
  v_members_total integer;
  v_members_region integer := 0;
  v_open integer := 0;
  v_open_emergency integer := 0;
  v_labor integer := 0;
  v_aid integer := 0;
  v_posted integer;
  v_sent_done integer;
  v_active_claims integer;
  v_recv_done integer;
  v_released integer;
  v_fees_in bigint;
  v_fees_out bigint;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT COALESCE(bp.network_enabled, false), lower(btrim(bp.service_area)), bp.network_contact_phone, bp.network_joined_at
    INTO v_member, v_region, v_phone, v_joined
    FROM business_profile bp WHERE bp.user_id = v_owner;
  v_member := COALESCE(v_member, false);

  SELECT count(*) INTO v_members_total FROM business_profile WHERE network_enabled;

  IF v_member THEN
    SELECT count(*) INTO v_members_region FROM business_profile
     WHERE network_enabled AND user_id <> v_owner AND lower(btrim(service_area)) = v_region;
    SELECT count(*), count(*) FILTER (WHERE kind = 'emergency') INTO v_open, v_open_emergency
      FROM network_handoffs WHERE status = 'open' AND expires_at > now() AND user_id <> v_owner;
    SELECT count(*) INTO v_labor FROM labor_marketplace_listings WHERE status = 'open' AND user_id <> v_owner;
    SELECT count(*) INTO v_aid FROM mutual_aid_requests
     WHERE status = 'open' AND expires_at > now() AND user_id <> v_owner;
  END IF;

  SELECT count(*) INTO v_posted FROM network_handoff_events WHERE actor_id = v_owner AND event = 'posted';
  SELECT count(*) INTO v_released FROM network_handoff_events WHERE actor_id = v_owner AND event = 'released';
  SELECT count(*) FILTER (WHERE user_id = v_owner AND status = 'completed'),
         count(*) FILTER (WHERE claimed_by = v_owner AND status = 'claimed'),
         count(*) FILTER (WHERE claimed_by = v_owner AND status = 'completed'),
         COALESCE(sum(referral_fee_cents) FILTER (WHERE user_id = v_owner AND fee_status = 'pending'), 0),
         COALESCE(sum(referral_fee_cents) FILTER (WHERE claimed_by = v_owner AND fee_status = 'pending'), 0)
    INTO v_sent_done, v_active_claims, v_recv_done, v_fees_in, v_fees_out
    FROM network_handoffs WHERE user_id = v_owner OR claimed_by = v_owner;

  RETURN jsonb_build_object(
    'owner_id', v_owner,
    'is_member', v_member,
    'region_key', v_region,
    'contact_phone', v_phone,
    'joined_at', v_joined,
    'members_total', v_members_total,
    'members_in_region', v_members_region,
    'open_handoffs', v_open,
    'open_emergency', v_open_emergency,
    'open_labor_listings', v_labor,
    'open_mutual_aid', v_aid,
    'handoffs_posted', v_posted,
    'handoffs_sent_completed', v_sent_done,
    'active_claims', v_active_claims,
    'handoffs_received_completed', v_recv_done,
    'releases', v_released,
    'reliability_pct', CASE WHEN v_recv_done + v_released > 0
                            THEN round(100.0 * v_recv_done / (v_recv_done + v_released)) END,
    'fees_owed_to_me_cents', v_fees_in,
    'fees_i_owe_cents', v_fees_out
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 7. Grants — authenticated only
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.is_network_member(),
  public.set_network_membership(boolean, text),
  public.expire_network_handoffs(),
  public.post_network_handoff(text, text, text, text, text, timestamptz, integer, numeric, text, text, text, text),
  public.claim_network_handoff(uuid),
  public.release_network_handoff(uuid),
  public.complete_network_handoff(uuid, integer),
  public.cancel_network_handoff(uuid),
  public.settle_network_handoff_fee(uuid, text),
  public.get_network_hub_summary()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.is_network_member(),
  public.set_network_membership(boolean, text),
  public.expire_network_handoffs(),
  public.post_network_handoff(text, text, text, text, text, timestamptz, integer, numeric, text, text, text, text),
  public.claim_network_handoff(uuid),
  public.release_network_handoff(uuid),
  public.complete_network_handoff(uuid, integer),
  public.cancel_network_handoff(uuid),
  public.settle_network_handoff_fee(uuid, text),
  public.get_network_hub_summary()
TO authenticated;

COMMENT ON TABLE network_handoffs IS
  'Anonymised, cross-tenant-readable (members only, while open) job handoff cards. Writes via RPC only.';
COMMENT ON TABLE network_handoff_contacts IS
  'Private customer details for a handoff. Visible to the poster, and to the claimer only after claiming.';
COMMENT ON TABLE network_handoff_events IS
  'Append-only audit trail for handoffs; basis for network reliability score.';
