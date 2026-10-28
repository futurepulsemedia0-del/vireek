/*
  # Pool & spa water chemistry — dosing recommendations

  ## Why
  The Pool Service trade pack already records chemistry readings and chemical dosing.
  The water-chemistry panel adds pool vs spa targets, bromine, per-visit volume / sanitizer
  context and dose recommendations that can be logged in one tap against the tenant's own
  registered products. This migration is the database half of that feature.

  ## What this changes (all additive, safe to re-run)
  1. trade_regulated_products gets two optional columns:
       chem_key      which chemical the product is (liquid chlorine, muriatic acid, ...)
       strength_pct  its strength in percent, so doses are calculated for the real product
     A second, separate trigger validates them; the existing trade_product_guard() is NOT
     replaced.
  2. trade_log_types.spec for pool_service / chemistry_reading and / dosing is refreshed so the
     server accepts the new fields (bromine, water body, sanitizer system, volume, "from
     recommendation", two extra dosing purposes). The JSON is generated from
     src/lib/tradePacks/poolService.ts and a unit test fails if the two ever drift apart.
  3. A partial index speeds up the per-customer reading history.

  ## Safety
  - No table, column or row is dropped or rewritten; existing log entries stay valid because
    every new field is optional.
  - Nothing here changes who can read or write: RLS and the append-only ledger guards from
    20271201000000_trade_packs.sql are untouched.

  ## Depends on
  20271201000000_trade_packs.sql
*/

-- =============================================================
-- 1. PRODUCT → CHEMICAL MAPPING
-- =============================================================

ALTER TABLE trade_regulated_products
  ADD COLUMN IF NOT EXISTS chem_key text
    CONSTRAINT trade_products_chem_key_valid CHECK (chem_key IS NULL OR chem_key IN (
      'liquid_chlorine','calcium_hypochlorite','dichlor','trichlor','muriatic_acid','sodium_bisulfate',
      'soda_ash','baking_soda','cyanuric_acid','calcium_chloride','pool_salt'));

ALTER TABLE trade_regulated_products
  ADD COLUMN IF NOT EXISTS strength_pct numeric(6,3)
    CONSTRAINT trade_products_strength_valid CHECK (strength_pct IS NULL OR (strength_pct > 0 AND strength_pct <= 100));

CREATE OR REPLACE FUNCTION public.trade_product_chem_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lo numeric;
  v_hi numeric;
BEGIN
  IF NEW.chem_key IS NULL THEN
    NEW.strength_pct := NULL;
    RETURN NEW;
  END IF;

  IF NEW.pack_key <> 'pool_service' THEN
    RAISE EXCEPTION 'trade_product_invalid: a chemical type can only be set on pool service products' USING ERRCODE = '23514';
  END IF;
  IF NEW.strength_pct IS NULL THEN
    RAISE EXCEPTION 'trade_product_invalid: enter the strength (%%) of the chemical' USING ERRCODE = '23514';
  END IF;

  -- Plausible strength per chemical (mirrors CHEMICALS in src/lib/tradePacks/poolChemistry.ts).
  SELECT b.lo, b.hi INTO v_lo, v_hi
  FROM (VALUES
    ('liquid_chlorine', 5::numeric, 15::numeric),
    ('calcium_hypochlorite', 50, 75),
    ('dichlor', 50, 65),
    ('trichlor', 85, 95),
    ('muriatic_acid', 10, 37),
    ('sodium_bisulfate', 80, 100),
    ('soda_ash', 90, 100),
    ('baking_soda', 90, 100),
    ('cyanuric_acid', 90, 100),
    ('calcium_chloride', 70, 100),
    ('pool_salt', 90, 100)
  ) AS b(k, lo, hi)
  WHERE b.k = NEW.chem_key;

  IF NEW.strength_pct < v_lo OR NEW.strength_pct > v_hi THEN
    RAISE EXCEPTION 'trade_product_invalid: strength for % must be between % and % percent', NEW.chem_key, v_lo, v_hi USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_product_chem_guard ON trade_regulated_products;
CREATE TRIGGER trg_trade_product_chem_guard BEFORE INSERT OR UPDATE ON trade_regulated_products
  FOR EACH ROW EXECUTE FUNCTION public.trade_product_chem_guard();

-- =============================================================
-- 2. LOG-TYPE SPECS (generated from src/lib/tradePacks/poolService.ts)
-- =============================================================

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pool_service', 'chemistry_reading', 'Chemistry reading', true, true, false, false, ARRAY[]::text[], ARRAY[]::text[], 2,
  '{"fields":[{"key":"fc","type":"number","required":false,"min":0,"max":100},{"key":"tc","type":"number","required":false,"min":0,"max":100},{"key":"ph","type":"number","required":false,"min":5,"max":9.5},{"key":"ta","type":"number","required":false,"min":0,"max":600},{"key":"cya","type":"number","required":false,"min":0,"max":400},{"key":"ch","type":"number","required":false,"min":0,"max":2000},{"key":"salt","type":"number","required":false,"min":0,"max":10000},{"key":"temp_f","type":"number","required":false,"min":32,"max":120},{"key":"filter_psi","type":"number","required":false,"min":0,"max":100},{"key":"clarity","type":"select","required":false,"options":["Clear","Hazy","Cloudy","Green","Black spot / mustard"]},{"key":"br","type":"number","required":false,"min":0,"max":50},{"key":"water_body","type":"select","required":false,"options":["Pool","Spa / hot tub"]},{"key":"sanitizer","type":"select","required":false,"options":["Liquid chlorine","Trichlor tablets","Salt (SWG)","Bromine","Mineral / ozone","Other"]},{"key":"volume_gal","type":"number","required":false,"min":20,"max":5000000}],"at_least_one_of":["fc","tc","br","ph","ta","cya","ch","salt"]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pool_service', 'dosing', 'Chemical dosing', true, true, false, true, ARRAY[]::text[], ARRAY[]::text[], 2,
  '{"fields":[{"key":"amount","type":"number","required":true,"min":0.0001,"max":100000},{"key":"amount_unit","type":"select","required":true,"options":["oz","fl_oz","lb","gal","qt","g","kg","ml","l","each"]},{"key":"target","type":"select","required":true,"options":["Raise chlorine","Raise bromine","Lower pH","Raise pH","Raise alkalinity","Lower alkalinity","Raise stabilizer","Raise calcium","Add salt","Shock / oxidize","Algae treatment","Clarify","Other"]},{"key":"method","type":"select","required":false,"options":["Broadcast","Pre-dissolved","Feeder / floater","Through skimmer","Automated dosing"]},{"key":"from_recommendation","type":"boolean","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

-- =============================================================
-- 3. READING-HISTORY INDEX
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_trade_log_pool_readings
  ON trade_log_entries (customer_id, performed_at DESC)
  WHERE pack_key = 'pool_service' AND entry_type = 'chemistry_reading' AND voided_at IS NULL;
