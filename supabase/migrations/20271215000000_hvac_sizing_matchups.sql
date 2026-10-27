/*
  # HVAC equipment matchups (AHRI) + load / duct sizing on quotes

  ## What
  - hvac_ahri_matchups : the account's own catalog of AHRI-certified combinations
                         (outdoor + indoor [+ furnace]), with capacities, SEER2 /
                         EER2 / HSPF2, price, and a "verified against the AHRI
                         Directory" stamp. Vireek never ships AHRI data: the
                         contractor enters or imports it from their certificates.
  - quote_hvac_sizing  : one row per quote - the saved load-calculation and duct
                         inputs/results, plus the equipment matchup chosen for the
                         quote (frozen as a snapshot so later catalog edits never
                         rewrite what the customer was quoted).

  ## Additive only
  New tables, indexes, policies and functions. No existing table, column, policy
  or function is altered (quotes.line_items is only appended to by
  apply_hvac_matchup_to_quote, through the same UPDATE path the quote builder uses).

  ## Security (same model as the quote workspace / tool crib)
  - Every row carries user_id = the ACCOUNT OWNER's id (get_account_owner_id()).
  - RLS: SELECT only, scoped to the account AND quote_workspace_caller_can_view()
    (owner, or a team member with can_view_billing). No client INSERT/UPDATE/DELETE.
  - All writes go through SECURITY DEFINER functions that re-check authentication,
    the permission, and that the quote / matchup belongs to the caller's account.
  - EXECUTE is revoked from PUBLIC/anon and granted to authenticated only.
*/

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS hvac_ahri_matchups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ahri_ref_number text NOT NULL CHECK (ahri_ref_number ~ '^[A-Za-z0-9-]{1,20}$'),
  manufacturer text NOT NULL CHECK (char_length(btrim(manufacturer)) BETWEEN 1 AND 80),
  brand text CHECK (brand IS NULL OR char_length(btrim(brand)) BETWEEN 1 AND 80),
  system_type text NOT NULL
    CHECK (system_type IN ('split_ac', 'split_hp', 'packaged_ac', 'packaged_hp', 'ac_furnace')),
  staging text NOT NULL DEFAULT 'single' CHECK (staging IN ('single', 'two_stage', 'variable')),
  outdoor_model text NOT NULL CHECK (char_length(btrim(outdoor_model)) BETWEEN 1 AND 80),
  indoor_model text CHECK (indoor_model IS NULL OR char_length(btrim(indoor_model)) BETWEEN 1 AND 80),
  furnace_model text CHECK (furnace_model IS NULL OR char_length(btrim(furnace_model)) BETWEEN 1 AND 80),
  cooling_btuh integer NOT NULL CHECK (cooling_btuh BETWEEN 6000 AND 120000),
  seer2 numeric(5,2) NOT NULL CHECK (seer2 BETWEEN 8 AND 40),
  eer2 numeric(5,2) CHECK (eer2 IS NULL OR eer2 BETWEEN 5 AND 30),
  hspf2 numeric(4,2) CHECK (hspf2 IS NULL OR hspf2 BETWEEN 4 AND 15),
  heating_47_btuh integer CHECK (heating_47_btuh IS NULL OR heating_47_btuh BETWEEN 3000 AND 200000),
  heating_17_btuh integer CHECK (heating_17_btuh IS NULL OR heating_17_btuh BETWEEN 3000 AND 200000),
  furnace_output_btuh integer CHECK (furnace_output_btuh IS NULL OR furnace_output_btuh BETWEEN 3000 AND 200000),
  shr numeric(3,2) CHECK (shr IS NULL OR shr BETWEEN 0.5 AND 1),
  airflow_cfm integer CHECK (airflow_cfm IS NULL OR airflow_cfm BETWEEN 200 AND 6000),
  refrigerant text CHECK (refrigerant IS NULL OR char_length(btrim(refrigerant)) BETWEEN 1 AND 20),
  sell_price_cents integer CHECK (sell_price_cents IS NULL OR sell_price_cents BETWEEN 0 AND 100000000),
  ahri_status text NOT NULL DEFAULT 'unverified' CHECK (ahri_status IN ('unverified', 'verified')),
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ahri_ref_number),
  CONSTRAINT hvac_matchups_hp_needs_hspf
    CHECK (system_type NOT IN ('split_hp', 'packaged_hp') OR hspf2 IS NOT NULL),
  CONSTRAINT hvac_matchups_verified_stamp
    CHECK (ahri_status = 'unverified' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_hvac_matchups_user_active
  ON hvac_ahri_matchups (user_id, active, cooling_btuh);

CREATE TABLE IF NOT EXISTS quote_hvac_sizing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  load_inputs jsonb CHECK (load_inputs IS NULL OR jsonb_typeof(load_inputs) = 'object'),
  load_result jsonb CHECK (load_result IS NULL OR jsonb_typeof(load_result) = 'object'),
  duct_inputs jsonb CHECK (duct_inputs IS NULL OR jsonb_typeof(duct_inputs) = 'object'),
  duct_result jsonb CHECK (duct_result IS NULL OR jsonb_typeof(duct_result) = 'object'),
  region text CHECK (region IS NULL OR region IN ('north', 'south', 'southwest')),
  selected_matchup_id uuid REFERENCES hvac_ahri_matchups(id) ON DELETE SET NULL,
  selection_snapshot jsonb CHECK (selection_snapshot IS NULL OR jsonb_typeof(selection_snapshot) = 'object'),
  calc_version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_hvac_sizing_user ON quote_hvac_sizing (user_id);
CREATE INDEX IF NOT EXISTS idx_quote_hvac_sizing_matchup ON quote_hvac_sizing (selected_matchup_id);

-- =============================================================
-- 2. RLS - read-only for account members with quote access
-- =============================================================

ALTER TABLE hvac_ahri_matchups ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_hvac_sizing ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON hvac_ahri_matchups FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON quote_hvac_sizing FROM authenticated, anon;

DROP POLICY IF EXISTS "Account members view hvac matchups" ON hvac_ahri_matchups;
CREATE POLICY "Account members view hvac matchups"
  ON hvac_ahri_matchups FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

DROP POLICY IF EXISTS "Account members view quote hvac sizing" ON quote_hvac_sizing;
CREATE POLICY "Account members view quote hvac sizing"
  ON quote_hvac_sizing FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

-- =============================================================
-- 3. CATALOG FUNCTIONS
-- =============================================================

-- Bulk create-or-update by AHRI reference number. Each row is validated by the
-- table constraints in its own subtransaction, so one bad row never blocks the
-- rest. Editing a spec that AHRI certifies (models, capacity, efficiency) resets
-- the "verified" stamp.
CREATE OR REPLACE FUNCTION public.hvac_upsert_matchups(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rec record;
  v_new hvac_ahri_matchups;
  v_existing hvac_ahri_matchups;
  v_ref text;
  v_changed boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_rejected jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'invalid_rows' USING ERRCODE = '22023';
  END IF;

  FOR v_rec IN
    SELECT t.value AS r, (t.ord - 1)::integer AS idx
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(value, ord)
  LOOP
    BEGIN
      IF jsonb_typeof(v_rec.r) <> 'object' THEN
        RAISE EXCEPTION 'row_not_object' USING ERRCODE = '22023';
      END IF;

      v_new := jsonb_populate_record(NULL::hvac_ahri_matchups, v_rec.r);
      v_ref := NULLIF(btrim(v_new.ahri_ref_number), '');

      SELECT * INTO v_existing
      FROM hvac_ahri_matchups m
      WHERE m.user_id = v_owner AND m.ahri_ref_number = v_ref;

      IF FOUND THEN
        v_changed := (
          v_existing.manufacturer, v_existing.system_type, v_existing.outdoor_model,
          v_existing.indoor_model, v_existing.furnace_model, v_existing.cooling_btuh,
          v_existing.seer2, v_existing.eer2, v_existing.hspf2
        ) IS DISTINCT FROM (
          btrim(v_new.manufacturer), v_new.system_type, btrim(v_new.outdoor_model),
          NULLIF(btrim(v_new.indoor_model), ''), NULLIF(btrim(v_new.furnace_model), ''),
          v_new.cooling_btuh, v_new.seer2, v_new.eer2, v_new.hspf2
        );

        UPDATE hvac_ahri_matchups m
        SET manufacturer = btrim(v_new.manufacturer),
            brand = NULLIF(btrim(v_new.brand), ''),
            system_type = v_new.system_type,
            staging = COALESCE(v_new.staging, 'single'),
            outdoor_model = btrim(v_new.outdoor_model),
            indoor_model = NULLIF(btrim(v_new.indoor_model), ''),
            furnace_model = NULLIF(btrim(v_new.furnace_model), ''),
            cooling_btuh = v_new.cooling_btuh,
            seer2 = v_new.seer2,
            eer2 = v_new.eer2,
            hspf2 = v_new.hspf2,
            heating_47_btuh = v_new.heating_47_btuh,
            heating_17_btuh = v_new.heating_17_btuh,
            furnace_output_btuh = v_new.furnace_output_btuh,
            shr = v_new.shr,
            airflow_cfm = v_new.airflow_cfm,
            refrigerant = NULLIF(btrim(v_new.refrigerant), ''),
            sell_price_cents = v_new.sell_price_cents,
            notes = NULLIF(btrim(v_new.notes), ''),
            ahri_status = CASE WHEN v_changed THEN 'unverified' ELSE m.ahri_status END,
            verified_at = CASE WHEN v_changed THEN NULL ELSE m.verified_at END,
            verified_by = CASE WHEN v_changed THEN NULL ELSE m.verified_by END,
            updated_at = now()
        WHERE m.id = v_existing.id AND m.user_id = v_owner;
        v_updated := v_updated + 1;
      ELSE
        INSERT INTO hvac_ahri_matchups (
          user_id, ahri_ref_number, manufacturer, brand, system_type, staging,
          outdoor_model, indoor_model, furnace_model, cooling_btuh, seer2, eer2, hspf2,
          heating_47_btuh, heating_17_btuh, furnace_output_btuh, shr, airflow_cfm,
          refrigerant, sell_price_cents, notes, created_by
        )
        VALUES (
          v_owner, v_ref, btrim(v_new.manufacturer), NULLIF(btrim(v_new.brand), ''),
          v_new.system_type, COALESCE(v_new.staging, 'single'),
          btrim(v_new.outdoor_model), NULLIF(btrim(v_new.indoor_model), ''),
          NULLIF(btrim(v_new.furnace_model), ''), v_new.cooling_btuh, v_new.seer2,
          v_new.eer2, v_new.hspf2, v_new.heating_47_btuh, v_new.heating_17_btuh,
          v_new.furnace_output_btuh, v_new.shr, v_new.airflow_cfm,
          NULLIF(btrim(v_new.refrigerant), ''), v_new.sell_price_cents,
          NULLIF(btrim(v_new.notes), ''), auth.uid()
        );
        v_inserted := v_inserted + 1;
      END IF;
    EXCEPTION
      WHEN check_violation OR not_null_violation OR invalid_text_representation
        OR numeric_value_out_of_range OR string_data_right_truncation
        OR datatype_mismatch OR unique_violation OR invalid_parameter_value THEN
        v_rejected := v_rejected || jsonb_build_array(jsonb_build_object(
          'index', v_rec.idx,
          'reason', CASE SQLSTATE
            WHEN '23514' THEN 'A value is outside the allowed range.'
            WHEN '23502' THEN 'A required field is missing.'
            WHEN '22P02' THEN 'A number or text value is invalid.'
            WHEN '22003' THEN 'A number is too large.'
            WHEN '22001' THEN 'A text value is too long.'
            WHEN '23505' THEN 'Duplicate AHRI number.'
            ELSE 'The row could not be saved.'
          END
        ));
    END;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'rejected', v_rejected);
END;
$$;

CREATE OR REPLACE FUNCTION public.hvac_set_matchup_verified(p_id uuid, p_verified boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_on boolean := COALESCE(p_verified, false);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE hvac_ahri_matchups m
  SET ahri_status = CASE WHEN v_on THEN 'verified' ELSE 'unverified' END,
      verified_at = CASE WHEN v_on THEN now() ELSE NULL END,
      verified_by = CASE WHEN v_on THEN auth.uid() ELSE NULL END,
      updated_at = now()
  WHERE m.id = p_id AND m.user_id = v_owner;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.hvac_set_matchup_active(p_id uuid, p_active boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE hvac_ahri_matchups m
  SET active = COALESCE(p_active, true), updated_at = now()
  WHERE m.id = p_id AND m.user_id = v_owner;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.hvac_delete_matchup(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Quotes that already chose this matchup keep their frozen snapshot.
  DELETE FROM hvac_ahri_matchups m WHERE m.id = p_id AND m.user_id = v_owner;

  RETURN FOUND;
END;
$$;

-- =============================================================
-- 4. PER-QUOTE SIZING FUNCTIONS
-- =============================================================

-- NULL when the quote is not in the caller's account.
CREATE OR REPLACE FUNCTION public.get_quote_hvac_sizing(p_quote_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_quote quotes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote FROM quotes q WHERE q.id = p_quote_id AND q.user_id = v_owner;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'quote_status', v_quote.status,
    'tiered', COALESCE(jsonb_typeof(v_quote.options) = 'array' AND jsonb_array_length(v_quote.options) > 0, false),
    'sizing', (
      SELECT to_jsonb(s) - 'user_id' - 'updated_by'
      FROM quote_hvac_sizing s
      WHERE s.quote_id = v_quote.id AND s.user_id = v_owner
    )
  );
END;
$$;

-- NULL for a payload argument keeps what is already saved.
CREATE OR REPLACE FUNCTION public.save_quote_hvac_sizing(
  p_quote_id uuid,
  p_load_inputs jsonb,
  p_load_result jsonb,
  p_duct_inputs jsonb,
  p_duct_result jsonb,
  p_region text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id = p_quote_id AND q.user_id = v_owner) THEN
    RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF (p_load_inputs IS NOT NULL AND jsonb_typeof(p_load_inputs) <> 'object')
     OR (p_load_result IS NOT NULL AND jsonb_typeof(p_load_result) <> 'object')
     OR (p_duct_inputs IS NOT NULL AND jsonb_typeof(p_duct_inputs) <> 'object')
     OR (p_duct_result IS NOT NULL AND jsonb_typeof(p_duct_result) <> 'object') THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;
  IF p_region IS NOT NULL AND p_region NOT IN ('north', 'south', 'southwest') THEN
    RAISE EXCEPTION 'invalid_region' USING ERRCODE = '22023';
  END IF;
  IF octet_length(COALESCE(p_load_inputs::text, '')) + octet_length(COALESCE(p_load_result::text, ''))
     + octet_length(COALESCE(p_duct_inputs::text, '')) + octet_length(COALESCE(p_duct_result::text, '')) > 200000 THEN
    RAISE EXCEPTION 'payload_too_large' USING ERRCODE = '22023';
  END IF;

  INSERT INTO quote_hvac_sizing AS s (
    user_id, quote_id, load_inputs, load_result, duct_inputs, duct_result, region, updated_by
  )
  VALUES (
    v_owner, p_quote_id, p_load_inputs, p_load_result, p_duct_inputs, p_duct_result, p_region, auth.uid()
  )
  ON CONFLICT (quote_id) DO UPDATE
  SET load_inputs = COALESCE(EXCLUDED.load_inputs, s.load_inputs),
      load_result = COALESCE(EXCLUDED.load_result, s.load_result),
      duct_inputs = COALESCE(EXCLUDED.duct_inputs, s.duct_inputs),
      duct_result = COALESCE(EXCLUDED.duct_result, s.duct_result),
      region = COALESCE(EXCLUDED.region, s.region),
      updated_by = auth.uid(),
      updated_at = now()
  WHERE s.user_id = v_owner
  RETURNING s.updated_at INTO v_at;

  RETURN v_at;
END;
$$;

-- p_matchup_id NULL clears the selection.
CREATE OR REPLACE FUNCTION public.select_quote_hvac_matchup(p_quote_id uuid, p_matchup_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_match hvac_ahri_matchups;
  v_snapshot jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id = p_quote_id AND q.user_id = v_owner) THEN
    RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_matchup_id IS NOT NULL THEN
    SELECT * INTO v_match
    FROM hvac_ahri_matchups m
    WHERE m.id = p_matchup_id AND m.user_id = v_owner AND m.active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matchup_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_snapshot := to_jsonb(v_match) - 'user_id' - 'created_by' - 'verified_by';
  END IF;

  INSERT INTO quote_hvac_sizing AS s (user_id, quote_id, selected_matchup_id, selection_snapshot, updated_by)
  VALUES (v_owner, p_quote_id, p_matchup_id, v_snapshot, auth.uid())
  ON CONFLICT (quote_id) DO UPDATE
  SET selected_matchup_id = EXCLUDED.selected_matchup_id,
      selection_snapshot = EXCLUDED.selection_snapshot,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE s.user_id = v_owner;

  RETURN true;
END;
$$;

-- Appends the selected system as ONE line item to a draft, non-tiered quote.
-- Idempotent: a second call for the same AHRI number adds nothing.
CREATE OR REPLACE FUNCTION public.apply_hvac_matchup_to_quote(p_quote_id uuid, p_unit_price_cents integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_quote quotes%ROWTYPE;
  v_snap jsonb;
  v_price integer;
  v_ref text;
  v_desc text;
  v_type_label text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote FROM quotes q WHERE q.id = p_quote_id AND q.user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION 'quote_not_editable' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(v_quote.options) = 'array' AND jsonb_array_length(v_quote.options) > 0 THEN
    RAISE EXCEPTION 'quote_is_tiered' USING ERRCODE = '55000';
  END IF;

  SELECT s.selection_snapshot INTO v_snap
  FROM quote_hvac_sizing s
  WHERE s.quote_id = p_quote_id AND s.user_id = v_owner;
  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'no_selection' USING ERRCODE = '55000';
  END IF;

  v_price := COALESCE(p_unit_price_cents, NULLIF(v_snap ->> 'sell_price_cents', '')::integer);
  IF v_price IS NULL OR v_price < 0 OR v_price > 100000000 THEN
    RAISE EXCEPTION 'price_required' USING ERRCODE = '22023';
  END IF;

  v_ref := v_snap ->> 'ahri_ref_number';
  IF jsonb_typeof(v_quote.line_items) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_quote.line_items) li
    WHERE (li ->> 'description') LIKE '%AHRI ref ' || v_ref || ',%'
  ) THEN
    RETURN jsonb_build_object('added', false, 'reason', 'already_present');
  END IF;

  v_type_label := CASE v_snap ->> 'system_type'
    WHEN 'split_ac' THEN 'split air conditioner'
    WHEN 'split_hp' THEN 'split heat pump'
    WHEN 'packaged_ac' THEN 'packaged air conditioner'
    WHEN 'packaged_hp' THEN 'packaged heat pump'
    WHEN 'ac_furnace' THEN 'AC and furnace'
    ELSE 'HVAC'
  END;

  v_desc := left(
    (v_snap ->> 'manufacturer') || ' '
    || to_char(round(((v_snap ->> 'cooling_btuh')::numeric) / 12000, 1), 'FM990.0') || '-ton '
    || v_type_label || ' system: outdoor ' || (v_snap ->> 'outdoor_model')
    || COALESCE(', indoor ' || NULLIF(v_snap ->> 'indoor_model', ''), '')
    || COALESCE(', furnace ' || NULLIF(v_snap ->> 'furnace_model', ''), '')
    || '. AHRI ref ' || v_ref || ', '
    || to_char((v_snap ->> 'seer2')::numeric, 'FM990.0#') || ' SEER2',
    500
  );

  UPDATE quotes q
  SET line_items = COALESCE(q.line_items, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('description', v_desc, 'quantity', 1, 'unit_price_cents', v_price)
      ),
      updated_at = now()
  WHERE q.id = v_quote.id AND q.user_id = v_owner;

  RETURN jsonb_build_object('added', true, 'description', v_desc, 'unit_price_cents', v_price);
END;
$$;

-- =============================================================
-- 5. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.hvac_upsert_matchups(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hvac_set_matchup_verified(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hvac_set_matchup_active(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hvac_delete_matchup(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_quote_hvac_sizing(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_quote_hvac_sizing(uuid, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.select_quote_hvac_matchup(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_hvac_matchup_to_quote(uuid, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.hvac_upsert_matchups(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hvac_set_matchup_verified(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hvac_set_matchup_active(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hvac_delete_matchup(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_quote_hvac_sizing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_quote_hvac_sizing(uuid, jsonb, jsonb, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.select_quote_hvac_matchup(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_hvac_matchup_to_quote(uuid, integer) TO authenticated;
