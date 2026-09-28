/*
  # AI Parts Market — Real-Time Supplier Intelligence

  Adds the market layer on top of Inventory + Vendor & Procurement OS:
  for any part (and its substitutes) the engine compares EVERY place it
  can come from — own van, warehouse, vendors, local distributors, nearby
  contractors — on price, ETA, availability, reliability and margin impact,
  then recommends buy vs. borrow vs. transfer.

  Internal stock is NOT duplicated here: it is read live from the existing
  `parts_availability` view. This migration only adds what was missing:

    parts_market_sources        — who else can supply parts (vendor /
                                  distributor / contractor) + logistics profile
    parts_market_offers         — the CURRENT quote per part x source
                                  (one live row, upserted; stale after expires_at)
    parts_market_price_history  — append-only trail written by trigger, powers
                                  "price vs 30-day average" signals
    parts_market_decisions      — audit ledger of every recommendation and what
                                  the user actually did (accepted / overridden)
    parts_market_live_offers    — view: offers + source + freshness flags

  Same conventions as the rest of the project:
    - user_id = auth.uid() RLS "for all"
    - views use security_invoker = true
    - money as *_cents integers
    - additive + idempotent (safe to re-run)
*/

-- =============================================================
-- SOURCES
-- =============================================================

CREATE TABLE IF NOT EXISTS parts_market_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  source_type text NOT NULL CHECK (source_type IN ('vendor', 'distributor', 'contractor')),
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  phone text,
  address text,
  distance_miles numeric(6,1) NOT NULL DEFAULT 0 CHECK (distance_miles >= 0),
  typical_response_minutes integer NOT NULL DEFAULT 30 CHECK (typical_response_minutes >= 0),
  reliability_score numeric(3,2) NOT NULL DEFAULT 0.90 CHECK (reliability_score BETWEEN 0 AND 1),
  delivery_fee_cents integer NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
  borrow_fee_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (borrow_fee_pct >= 0),
  return_in_kind boolean NOT NULL DEFAULT true,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parts_market_sources_user ON parts_market_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_parts_market_sources_active ON parts_market_sources(user_id, active) WHERE active = true;

ALTER TABLE parts_market_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own parts market sources" ON parts_market_sources;
CREATE POLICY "Users manage their own parts market sources"
  ON parts_market_sources FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- OFFERS  (one live quote per part x source)
-- =============================================================

CREATE TABLE IF NOT EXISTS parts_market_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES parts_market_sources(id) ON DELETE CASCADE,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity_available integer NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
  eta_minutes integer CHECK (eta_minutes IS NULL OR eta_minutes >= 0),
  fulfillment text NOT NULL DEFAULT 'pickup' CHECK (fulfillment IN ('pickup', 'delivery', 'handoff')),
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'rfq', 'catalog', 'api')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_parts_market_offers_user ON parts_market_offers(user_id);
CREATE INDEX IF NOT EXISTS idx_parts_market_offers_part ON parts_market_offers(part_id);
CREATE INDEX IF NOT EXISTS idx_parts_market_offers_source ON parts_market_offers(source_id);

ALTER TABLE parts_market_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own parts market offers" ON parts_market_offers;
CREATE POLICY "Users manage their own parts market offers"
  ON parts_market_offers FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- PRICE HISTORY  (append-only, trigger-written)
-- =============================================================

CREATE TABLE IF NOT EXISTS parts_market_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES parts_market_sources(id) ON DELETE CASCADE,
  unit_price_cents integer NOT NULL,
  quantity_available integer NOT NULL,
  eta_minutes integer,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parts_market_price_history_part_time
  ON parts_market_price_history(part_id, observed_at DESC);

ALTER TABLE parts_market_price_history ENABLE ROW LEVEL SECURITY;

-- Read-only for users: rows are written only by the trigger below.
DROP POLICY IF EXISTS "Users read their own price history" ON parts_market_price_history;
CREATE POLICY "Users read their own price history"
  ON parts_market_price_history FOR SELECT
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION log_parts_market_price()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.quantity_available IS DISTINCT FROM OLD.quantity_available
     OR NEW.eta_minutes IS DISTINCT FROM OLD.eta_minutes THEN
    INSERT INTO parts_market_price_history
      (user_id, part_id, source_id, unit_price_cents, quantity_available, eta_minutes, observed_at)
    VALUES
      (NEW.user_id, NEW.part_id, NEW.source_id, NEW.unit_price_cents, NEW.quantity_available, NEW.eta_minutes, NEW.observed_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS parts_market_offers_log_price ON parts_market_offers;
CREATE TRIGGER parts_market_offers_log_price
  AFTER INSERT OR UPDATE ON parts_market_offers
  FOR EACH ROW EXECUTE FUNCTION log_parts_market_price();

-- =============================================================
-- DECISIONS  (audit ledger)
-- =============================================================

CREATE TABLE IF NOT EXISTS parts_market_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  recommended_action text NOT NULL,
  recommended_label text NOT NULL,
  chosen_action text,
  chosen_label text,
  expected_total_cost_cents integer NOT NULL DEFAULT 0,
  margin_erosion_cents integer NOT NULL DEFAULT 0,
  confidence numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  verdict text NOT NULL DEFAULT 'none' CHECK (verdict IN ('buy', 'borrow', 'internal', 'none')),
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended', 'accepted', 'overridden', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parts_market_decisions_user_time ON parts_market_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_market_decisions_job ON parts_market_decisions(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE parts_market_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own parts market decisions" ON parts_market_decisions;
CREATE POLICY "Users manage their own parts market decisions"
  ON parts_market_decisions FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- updated_at maintenance (public.set_updated_at already exists)
-- =============================================================

DROP TRIGGER IF EXISTS parts_market_sources_set_updated_at ON parts_market_sources;
CREATE TRIGGER parts_market_sources_set_updated_at BEFORE UPDATE ON parts_market_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS parts_market_offers_set_updated_at ON parts_market_offers;
CREATE TRIGGER parts_market_offers_set_updated_at BEFORE UPDATE ON parts_market_offers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS parts_market_decisions_set_updated_at ON parts_market_decisions;
CREATE TRIGGER parts_market_decisions_set_updated_at BEFORE UPDATE ON parts_market_decisions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- LIVE OFFERS VIEW  (offers + source + freshness)
-- =============================================================

CREATE OR REPLACE VIEW parts_market_live_offers
WITH (security_invoker = true) AS
SELECT
  o.id AS offer_id,
  o.user_id,
  o.part_id,
  p.name AS part_name,
  p.part_number,
  o.source_id,
  s.name AS source_name,
  s.source_type,
  s.vendor_id,
  s.phone AS source_phone,
  s.distance_miles,
  s.typical_response_minutes,
  s.reliability_score,
  s.delivery_fee_cents,
  s.borrow_fee_pct,
  s.return_in_kind,
  s.active AS source_active,
  o.unit_price_cents,
  o.quantity_available,
  o.eta_minutes,
  o.fulfillment,
  o.origin,
  o.observed_at,
  o.expires_at,
  o.note,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - o.observed_at)) / 60)::integer AS age_minutes,
  (o.expires_at IS NOT NULL AND o.expires_at < now()) AS is_expired
FROM parts_market_offers o
JOIN parts_market_sources s ON s.id = o.source_id
JOIN inventory_parts p ON p.id = o.part_id;

GRANT SELECT ON parts_market_live_offers TO authenticated;

COMMENT ON VIEW parts_market_live_offers IS
  'Current quote per part x source with age/expiry flags. security_invoker=true, so it always applies the querying user''s own RLS.';

-- =============================================================
-- Realtime (safe if the publication does not exist yet)
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE parts_market_offers;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE inventory_stock_levels;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
