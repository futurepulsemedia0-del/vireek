/*
  # Vireek Physical Economy Network (PEN)

  Six rails: Identity, Protocol, Trust, Outcome, Marketplace, Financial.
  - No browser write access to any pen_* table; every write is a SECURITY DEFINER function that
    re-derives the caller's account (get_account_owner_id) and manager right.
  - Cross-business visibility only through functions returning sanitized columns.
  - Outcomes, ledger lines and events are immutable. Settlement needs two-sided confirmation
    (or 14-day auto-confirm) and is blocked while disputed.
  - Referral fees are RECORDED (receivable/payable); this migration never moves money or touches Stripe.

  Requires: get_account_owner_id(), profiles, team_members(user_id, account_owner_id, permissions, role, invite_status),
  jobs(user_id, job_status, is_rework, customer_disputed, completed_at), customer_sites(user_id),
  verification_checks, technician_insurance_policies, stripe_connect_accounts.
*/

-- 0) Helpers ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pen_is_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.get_account_owner_id() IS NOT NULL
    AND (
      auth.uid() = public.get_account_owner_id()
      OR EXISTS (
        SELECT 1 FROM team_members m
        WHERE m.user_id = auth.uid()
          AND m.account_owner_id = public.get_account_owner_id()
          AND coalesce((m.permissions ->> 'can_manage_team')::boolean, false)
      )
    );
$$;
REVOKE ALL ON FUNCTION public.pen_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_is_manager() TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_require_manager()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.pen_is_manager() THEN
    RAISE EXCEPTION 'Only account owners and team managers can do this' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_require_manager() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pen_contains_pii(p_text text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
    OR p_text ~ '(\d[\s().-]{0,2}){9,}',
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.pen_valid_region(p_region text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(p_region ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$', false); $$;

CREATE OR REPLACE FUNCTION public.pen_region_match(p_request_region text, p_node_regions text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_request_region = ANY (p_node_regions)
      OR split_part(p_request_region, '-', 1) = ANY (p_node_regions);
$$;

-- Integer cents, round half up. Mirrored exactly by referralFeeCents() in physicalEconomyNetwork.ts.
CREATE OR REPLACE FUNCTION public.pen_fee_cents(p_price_cents bigint, p_bps integer)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT ((p_price_cents * p_bps::bigint) + 5000) / 10000; $$;

CREATE OR REPLACE FUNCTION public.pen_guard_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Cascades from account deletion run nested (depth > 1) and must still work.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- 1) Trade registry -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pen_trades (
  trade_key text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  protocol_version integer NOT NULL DEFAULT 1,
  categories text[] NOT NULL DEFAULT '{}',
  required_evidence text[] NOT NULL DEFAULT '{}',
  outcome_metrics text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_trades_key_check CHECK (trade_key ~ '^[a-z][a-z0-9_]{2,40}$')
);
ALTER TABLE pen_trades ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pen_trades_select" ON pen_trades;
CREATE POLICY "pen_trades_select" ON pen_trades FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON pen_trades FROM anon, authenticated;

INSERT INTO pen_trades (trade_key, label, description, sort_order, categories, required_evidence, outcome_metrics) VALUES
 ('hvac', 'HVAC', 'Heating, cooling, ventilation and indoor air quality', 10,
  ARRAY['no_cooling','no_heat','repair','maintenance','installation','duct_work','thermostat_controls','refrigerant','indoor_air_quality'],
  ARRAY['before_after_photos','equipment_nameplate','refrigerant_log'], ARRAY['first_time_fix','callback_30d','csat']),
 ('plumbing', 'Plumbing', 'Water, drains, gas lines and water heaters', 20,
  ARRAY['leak','clog_drain','water_heater','fixture','repipe','sewer','gas_line','water_treatment'],
  ARRAY['before_after_photos','pressure_test'], ARRAY['first_time_fix','callback_30d','csat']),
 ('electrical', 'Electrical', 'Wiring, panels, lighting, EV chargers and generators', 30,
  ARRAY['outage','panel_upgrade','wiring','lighting','ev_charger','generator','safety_inspection','surge_protection'],
  ARRAY['before_after_photos','permit_reference'], ARRAY['first_time_fix','callback_30d','csat']),
 ('roofing', 'Roofing', 'Roof repair, replacement, gutters and storm damage', 40,
  ARRAY['leak_repair','replacement','storm_damage','inspection','gutters','flashing','skylight'],
  ARRAY['before_after_photos','material_receipt'], ARRAY['first_time_fix','callback_30d','csat']),
 ('solar', 'Solar', 'Solar PV, battery storage and monitoring', 50,
  ARRAY['installation','inverter_fault','panel_cleaning','battery_storage','monitoring','inspection'],
  ARRAY['before_after_photos','commissioning_report'], ARRAY['first_time_fix','callback_30d','csat']),
 ('appliances', 'Appliances', 'Residential and light-commercial appliance repair', 60,
  ARRAY['refrigeration','laundry','cooking','dishwasher','installation','diagnostic'],
  ARRAY['before_after_photos','model_serial'], ARRAY['first_time_fix','callback_30d','csat']),
 ('security', 'Security', 'Alarm, access control, cameras and smart-home security', 70,
  ARRAY['alarm','cameras','access_control','smart_lock','monitoring','installation'],
  ARRAY['before_after_photos','commissioning_report'], ARRAY['first_time_fix','callback_30d','csat']),
 ('property_maintenance', 'Property Maintenance', 'Recurring upkeep, turnovers, handyman and facilities work', 80,
  ARRAY['handyman','turnover','painting','landscaping','pest_control','cleaning','facilities'],
  ARRAY['before_after_photos'], ARRAY['first_time_fix','callback_30d','csat']),
 ('other', 'Other Physical Services', 'Any other on-site physical service', 999,
  ARRAY['general'], ARRAY['before_after_photos'], ARRAY['first_time_fix','callback_30d','csat'])
ON CONFLICT (trade_key) DO NOTHING;

-- 2) Identity rail ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pen_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  node_handle text NOT NULL UNIQUE,
  trades text[] NOT NULL DEFAULT '{}',
  regions text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  accepts_referrals boolean NOT NULL DEFAULT true,
  referral_fee_bps integer NOT NULL DEFAULT 0,
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  consented_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_nodes_status_check CHECK (status IN ('active', 'paused')),
  CONSTRAINT pen_nodes_fee_check CHECK (referral_fee_bps BETWEEN 0 AND 2500),
  CONSTRAINT pen_nodes_trades_check CHECK (cardinality(trades) BETWEEN 1 AND 12),
  CONSTRAINT pen_nodes_regions_check CHECK (cardinality(regions) BETWEEN 1 AND 60)
);
CREATE INDEX IF NOT EXISTS idx_pen_nodes_trades ON pen_nodes USING gin (trades) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS pen_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id text NOT NULL UNIQUE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_ident_kind_check CHECK (entity_kind IN ('business', 'technician', 'site')),
  CONSTRAINT pen_ident_unique UNIQUE (entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_pen_ident_owner ON pen_identifiers(account_owner_id, entity_kind);

-- 3) Protocol + Marketplace rails -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pen_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  origin_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  trade_key text NOT NULL REFERENCES pen_trades(trade_key),
  protocol_version integer NOT NULL,
  category text NOT NULL,
  urgency text NOT NULL DEFAULT 'standard',
  region text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_cents bigint,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_req_urgency_check CHECK (urgency IN ('emergency', 'urgent', 'standard', 'scheduled')),
  CONSTRAINT pen_req_status_check CHECK (status IN ('open', 'accepted', 'completed', 'cancelled', 'expired')),
  CONSTRAINT pen_req_currency_check CHECK (currency IN ('usd', 'eur', 'gbp', 'cad', 'aud')),
  CONSTRAINT pen_req_summary_check CHECK (char_length(summary) BETWEEN 10 AND 500),
  CONSTRAINT pen_req_budget_check CHECK (budget_cents IS NULL OR budget_cents BETWEEN 1 AND 100000000),
  CONSTRAINT pen_req_payload_check CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  CONSTRAINT pen_req_region_check CHECK (public.pen_valid_region(region))
);
CREATE INDEX IF NOT EXISTS idx_pen_req_open ON pen_requests(trade_key, region, expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_pen_req_origin ON pen_requests(origin_owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pen_req_job_live ON pen_requests(origin_job_id)
  WHERE origin_job_id IS NOT NULL AND status IN ('open', 'accepted');

CREATE TABLE IF NOT EXISTS pen_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES pen_requests(id) ON DELETE CASCADE,
  provider_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  price_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  eta_hours integer NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_offer_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  CONSTRAINT pen_offer_price_check CHECK (price_cents BETWEEN 1 AND 100000000),
  CONSTRAINT pen_offer_eta_check CHECK (eta_hours BETWEEN 0 AND 720),
  CONSTRAINT pen_offer_currency_check CHECK (currency IN ('usd', 'eur', 'gbp', 'cad', 'aud')),
  CONSTRAINT pen_offer_msg_check CHECK (message IS NULL OR char_length(message) <= 500),
  CONSTRAINT pen_offer_unique UNIQUE (request_id, provider_owner_id)
);
CREATE INDEX IF NOT EXISTS idx_pen_offers_provider ON pen_offers(provider_owner_id, status);

CREATE TABLE IF NOT EXISTS pen_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES pen_requests(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL UNIQUE REFERENCES pen_offers(id) ON DELETE CASCADE,
  origin_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trade_key text NOT NULL REFERENCES pen_trades(trade_key),
  agreed_price_cents bigint NOT NULL,
  currency text NOT NULL,
  referral_fee_bps integer NOT NULL,
  referral_fee_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  fee_status text NOT NULL DEFAULT 'none',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  provider_confirmed_at timestamptz,
  origin_confirmed_at timestamptz,
  completed_at timestamptz,
  settled_at timestamptz,
  settlement_reference text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_eng_status_check CHECK (status IN ('active', 'completed', 'disputed', 'cancelled')),
  CONSTRAINT pen_eng_fee_status_check CHECK (fee_status IN ('none', 'accrued', 'settled')),
  CONSTRAINT pen_eng_parties_check CHECK (origin_owner_id <> provider_owner_id)
);
CREATE INDEX IF NOT EXISTS idx_pen_eng_origin ON pen_engagements(origin_owner_id, status);
CREATE INDEX IF NOT EXISTS idx_pen_eng_provider ON pen_engagements(provider_owner_id, status);

-- 4) Outcome rail (immutable) ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pen_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES pen_engagements(id) ON DELETE CASCADE,
  reporter_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reporter_role text NOT NULL,
  resolved boolean NOT NULL,
  rework_needed boolean NOT NULL DEFAULT false,
  satisfaction smallint,
  notes text,
  evidence_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_out_role_check CHECK (reporter_role IN ('origin', 'provider')),
  CONSTRAINT pen_out_csat_check CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5),
  CONSTRAINT pen_out_notes_check CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT pen_out_hash_check CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pen_out_unique UNIQUE (engagement_id, reporter_role)
);
DROP TRIGGER IF EXISTS trg_pen_outcomes_immutable ON pen_outcomes;
CREATE TRIGGER trg_pen_outcomes_immutable BEFORE UPDATE OR DELETE ON pen_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.pen_guard_immutable();

-- 5) Financial rail: append-only double-entry ledger -----------------------------------------
CREATE TABLE IF NOT EXISTS pen_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  engagement_id uuid REFERENCES pen_engagements(id) ON DELETE SET NULL,
  kind text NOT NULL,
  account text NOT NULL,
  direction text NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  memo text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pen_led_kind_check CHECK (kind IN ('fee_accrual', 'fee_settlement', 'fee_reversal')),
  CONSTRAINT pen_led_account_check CHECK (account IN ('fee_receivable', 'referral_income', 'fee_payable', 'referral_expense', 'cash')),
  CONSTRAINT pen_led_dir_check CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT pen_led_amount_check CHECK (amount_cents > 0)
);
CREATE INDEX IF NOT EXISTS idx_pen_led_owner ON pen_ledger_entries(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pen_led_group ON pen_ledger_entries(group_id);
DROP TRIGGER IF EXISTS trg_pen_ledger_immutable ON pen_ledger_entries;
CREATE TRIGGER trg_pen_ledger_immutable BEFORE UPDATE OR DELETE ON pen_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.pen_guard_immutable();

-- 6) Audit events ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pen_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_id uuid,
  kind text NOT NULL,
  entity_id uuid,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pen_events_owner ON pen_events(owner_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_pen_events_immutable ON pen_events;
CREATE TRIGGER trg_pen_events_immutable BEFORE UPDATE OR DELETE ON pen_events
  FOR EACH ROW EXECUTE FUNCTION public.pen_guard_immutable();

CREATE OR REPLACE FUNCTION public.pen_log(p_owner uuid, p_kind text, p_entity uuid, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO pen_events (owner_id, actor_id, kind, entity_id, meta)
  VALUES (p_owner, auth.uid(), p_kind, p_entity, coalesce(p_meta, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.pen_log(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- 7) RLS: own rows only, read-only for browsers ----------------------------------------------
ALTER TABLE pen_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pen_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pen_nodes_select" ON pen_nodes;
CREATE POLICY "pen_nodes_select" ON pen_nodes FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_ident_select" ON pen_identifiers;
CREATE POLICY "pen_ident_select" ON pen_identifiers FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_req_select" ON pen_requests;
CREATE POLICY "pen_req_select" ON pen_requests FOR SELECT TO authenticated USING (origin_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_offers_select" ON pen_offers;
CREATE POLICY "pen_offers_select" ON pen_offers FOR SELECT TO authenticated USING (provider_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_eng_select" ON pen_engagements;
CREATE POLICY "pen_eng_select" ON pen_engagements FOR SELECT TO authenticated
  USING (origin_owner_id = public.get_account_owner_id() OR provider_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_out_select" ON pen_outcomes;
CREATE POLICY "pen_out_select" ON pen_outcomes FOR SELECT TO authenticated USING (reporter_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pen_led_select" ON pen_ledger_entries;
CREATE POLICY "pen_led_select" ON pen_ledger_entries FOR SELECT TO authenticated
  USING (owner_id = public.get_account_owner_id() AND public.pen_is_manager());
DROP POLICY IF EXISTS "pen_events_select" ON pen_events;
CREATE POLICY "pen_events_select" ON pen_events FOR SELECT TO authenticated
  USING (owner_id = public.get_account_owner_id() AND public.pen_is_manager());

REVOKE INSERT, UPDATE, DELETE ON pen_nodes, pen_identifiers, pen_requests, pen_offers,
  pen_engagements, pen_outcomes, pen_ledger_entries, pen_events FROM anon, authenticated;
REVOKE ALL ON pen_nodes, pen_identifiers, pen_requests, pen_offers,
  pen_engagements, pen_outcomes, pen_ledger_entries, pen_events, pen_trades FROM anon;

-- 8) Trust rail ------------------------------------------------------------------------------
-- Score = 35% verification + 15% insurance + 35% job outcomes + 15% network reliability.
-- Rates are Bayesian-shrunk toward 0.80 with 10 pseudo-observations: 2 jobs never beat 200.
CREATE OR REPLACE FUNCTION public.pen_node_trust(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k constant numeric := 10;
  prior constant numeric := 0.80;
  v_techs integer; v_verified integer; v_adverse integer; v_insured integer;
  v_jobs integer; v_good integer; v_net integer; v_net_good integer;
  v_ver numeric; v_ins numeric; v_job numeric; v_netr numeric;
  v_score integer; v_samples integer; v_conf text; v_tier text;
BEGIN
  SELECT count(*) INTO v_techs
  FROM team_members m
  WHERE m.account_owner_id = p_owner AND m.role = 'technician' AND m.invite_status <> 'removed';

  WITH latest AS (
    SELECT DISTINCT ON (c.technician_id, c.subject_key)
      c.technician_id, c.status, c.expires_on
    FROM verification_checks c
    WHERE c.account_owner_id = p_owner AND c.status <> 'pending'
    ORDER BY c.technician_id, c.subject_key, c.created_at DESC
  )
  SELECT
    count(DISTINCT technician_id) FILTER (
      WHERE status IN ('verified_primary', 'verified_document') AND (expires_on IS NULL OR expires_on >= current_date)),
    count(DISTINCT technician_id) FILTER (WHERE status = 'adverse')
  INTO v_verified, v_adverse
  FROM latest;

  SELECT count(DISTINCT p.technician_id) INTO v_insured
  FROM technician_insurance_policies p
  JOIN team_members m ON m.id = p.technician_id AND m.account_owner_id = p_owner
  WHERE p.status = 'active' AND p.expires_at >= current_date;

  SELECT count(*), count(*) FILTER (WHERE NOT coalesce(j.is_rework, false) AND NOT coalesce(j.customer_disputed, false))
  INTO v_jobs, v_good
  FROM jobs j
  WHERE j.user_id = p_owner AND j.job_status = 'completed'
    AND coalesce(j.completed_at, j.created_at) >= now() - interval '365 days';

  SELECT count(*), count(*) FILTER (WHERE o.resolved AND NOT o.rework_needed)
  INTO v_net, v_net_good
  FROM pen_outcomes o
  JOIN pen_engagements e ON e.id = o.engagement_id
  WHERE o.reporter_role = 'provider' AND e.provider_owner_id = p_owner AND o.created_at >= now() - interval '365 days';

  v_ver := CASE WHEN v_techs = 0 THEN 0 ELSE least(1, v_verified::numeric / v_techs) END;
  v_ins := CASE WHEN v_techs = 0 THEN 0 ELSE least(1, v_insured::numeric / v_techs) END;
  v_job := (v_good + prior * k) / (v_jobs + k);
  v_netr := (v_net_good + prior * k) / (v_net + k);
  v_score := round(100 * (0.35 * v_ver + 0.15 * v_ins + 0.35 * v_job + 0.15 * v_netr));
  v_samples := v_jobs + v_net;
  v_conf := CASE WHEN v_samples >= 50 THEN 'high' WHEN v_samples >= 10 THEN 'medium' ELSE 'low' END;
  v_tier := CASE
    WHEN v_adverse > 0 THEN 'attention'
    WHEN v_score >= 85 AND v_ver >= 0.8 AND v_conf <> 'low' THEN 'trusted'
    WHEN v_score >= 70 THEN 'established'
    WHEN v_score >= 50 THEN 'emerging'
    ELSE 'unproven'
  END;

  RETURN jsonb_build_object(
    'score', v_score, 'tier', v_tier, 'confidence', v_conf, 'samples', v_samples,
    'components', jsonb_build_object(
      'verification', round(100 * v_ver), 'insurance', round(100 * v_ins),
      'job_outcomes', round(100 * v_job), 'network_reliability', round(100 * v_netr)),
    'technicians', v_techs, 'verified_technicians', v_verified, 'adverse_technicians', v_adverse,
    'jobs_365d', v_jobs, 'network_engagements_365d', v_net);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_node_trust(uuid) FROM PUBLIC, anon, authenticated;

-- 9) Identity RPCs ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pen_join_network(
  p_trades text[], p_regions text[], p_accepts_referrals boolean, p_fee_bps integer, p_consent_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_trades text[]; v_regions text[]; v_node pen_nodes;
BEGIN
  SELECT coalesce(array_agg(DISTINCT lower(btrim(t))), '{}') INTO v_trades FROM unnest(coalesce(p_trades, '{}')) t;
  SELECT coalesce(array_agg(DISTINCT upper(btrim(r))), '{}') INTO v_regions FROM unnest(coalesce(p_regions, '{}')) r;
  IF cardinality(v_trades) = 0 THEN RAISE EXCEPTION 'Select at least one trade'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_trades) t WHERE NOT EXISTS (SELECT 1 FROM pen_trades x WHERE x.trade_key = t AND x.active)) THEN
    RAISE EXCEPTION 'Unknown or inactive trade';
  END IF;
  IF cardinality(v_regions) = 0 OR cardinality(v_regions) > 60 THEN RAISE EXCEPTION 'Select between 1 and 60 service regions'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_regions) r WHERE NOT public.pen_valid_region(r)) THEN
    RAISE EXCEPTION 'Regions must look like US or US-TX';
  END IF;
  IF p_fee_bps IS NULL OR p_fee_bps < 0 OR p_fee_bps > 2500 THEN RAISE EXCEPTION 'Referral fee must be between 0 and 25 percent'; END IF;
  IF coalesce(btrim(p_consent_version), '') = '' THEN RAISE EXCEPTION 'Network terms must be accepted'; END IF;

  INSERT INTO pen_nodes (account_owner_id, node_handle, trades, regions, accepts_referrals, referral_fee_bps, consent_version, consented_by)
  VALUES (v_owner, 'vrk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), v_trades, v_regions,
          coalesce(p_accepts_referrals, true), p_fee_bps, btrim(p_consent_version), auth.uid())
  ON CONFLICT (account_owner_id) DO UPDATE SET
    trades = EXCLUDED.trades, regions = EXCLUDED.regions, accepts_referrals = EXCLUDED.accepts_referrals,
    referral_fee_bps = EXCLUDED.referral_fee_bps, consent_version = EXCLUDED.consent_version,
    consented_by = EXCLUDED.consented_by, consented_at = now(), updated_at = now()
  RETURNING * INTO v_node;

  INSERT INTO pen_identifiers (network_id, account_owner_id, entity_kind, entity_id)
  VALUES ('vrk:biz:' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), v_owner, 'business', v_owner)
  ON CONFLICT (entity_kind, entity_id) DO NOTHING;

  PERFORM public.pen_log(v_owner, 'node_updated', v_node.id,
    jsonb_build_object('trades', v_trades, 'regions', v_regions, 'fee_bps', p_fee_bps));
  RETURN to_jsonb(v_node) - 'consented_by';
END;
$$;
REVOKE ALL ON FUNCTION public.pen_join_network(text[], text[], boolean, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_join_network(text[], text[], boolean, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_set_node_status(p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager();
BEGIN
  IF p_status NOT IN ('active', 'paused') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE pen_nodes SET status = p_status, updated_at = now() WHERE account_owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Join the network first'; END IF;
  PERFORM public.pen_log(v_owner, 'node_status', NULL, jsonb_build_object('status', p_status));
END;
$$;
REVOKE ALL ON FUNCTION public.pen_set_node_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_set_node_status(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_sync_identifiers()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_biz integer; v_tech integer; v_site integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pen_nodes WHERE account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Join the network first';
  END IF;

  INSERT INTO pen_identifiers (network_id, account_owner_id, entity_kind, entity_id)
  VALUES ('vrk:biz:' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), v_owner, 'business', v_owner)
  ON CONFLICT (entity_kind, entity_id) DO NOTHING;
  GET DIAGNOSTICS v_biz = ROW_COUNT;

  INSERT INTO pen_identifiers (network_id, account_owner_id, entity_kind, entity_id)
  SELECT 'vrk:tech:' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), v_owner, 'technician', m.id
  FROM team_members m
  WHERE m.account_owner_id = v_owner AND m.role = 'technician' AND m.invite_status <> 'removed'
  ON CONFLICT (entity_kind, entity_id) DO NOTHING;
  GET DIAGNOSTICS v_tech = ROW_COUNT;

  INSERT INTO pen_identifiers (network_id, account_owner_id, entity_kind, entity_id)
  SELECT 'vrk:site:' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), v_owner, 'site', s.id
  FROM customer_sites s
  WHERE s.user_id = v_owner
  ON CONFLICT (entity_kind, entity_id) DO NOTHING;
  GET DIAGNOSTICS v_site = ROW_COUNT;

  PERFORM public.pen_log(v_owner, 'identifiers_synced', NULL,
    jsonb_build_object('business', v_biz, 'technicians', v_tech, 'sites', v_site));
  RETURN jsonb_build_object('business', v_biz, 'technicians', v_tech, 'sites', v_site);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_sync_identifiers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_sync_identifiers() TO authenticated;

-- 10) Protocol + Marketplace RPCs ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pen_create_request(
  p_trade text, p_category text, p_urgency text, p_region text, p_summary text,
  p_payload jsonb DEFAULT '{}'::jsonb, p_budget_cents bigint DEFAULT NULL,
  p_currency text DEFAULT 'usd', p_job_id uuid DEFAULT NULL, p_expires_hours integer DEFAULT 72
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_trade pen_trades;
  v_summary text := btrim(coalesce(p_summary, ''));
  v_region text := upper(btrim(coalesce(p_region, '')));
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pen_nodes WHERE account_owner_id = v_owner AND status = 'active') THEN
    RAISE EXCEPTION 'Your network node must be active to publish requests';
  END IF;
  SELECT * INTO v_trade FROM pen_trades WHERE trade_key = lower(btrim(coalesce(p_trade, ''))) AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown trade'; END IF;
  IF NOT (btrim(coalesce(p_category, '')) = ANY (v_trade.categories)) THEN
    RAISE EXCEPTION 'Category is not part of the % protocol', v_trade.label;
  END IF;
  IF p_urgency NOT IN ('emergency', 'urgent', 'standard', 'scheduled') THEN RAISE EXCEPTION 'Invalid urgency'; END IF;
  IF NOT public.pen_valid_region(v_region) THEN RAISE EXCEPTION 'Region must look like US or US-TX'; END IF;
  IF char_length(v_summary) < 10 OR char_length(v_summary) > 500 THEN RAISE EXCEPTION 'Summary must be 10-500 characters'; END IF;
  IF jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' OR octet_length(coalesce(p_payload, '{}'::jsonb)::text) > 8192 THEN
    RAISE EXCEPTION 'Payload must be a JSON object under 8 KB';
  END IF;
  IF public.pen_contains_pii(v_summary) OR public.pen_contains_pii(coalesce(p_payload, '{}'::jsonb)::text) THEN
    RAISE EXCEPTION 'Remove phone numbers and e-mail addresses - contact details are shared only after an offer is accepted';
  END IF;
  IF p_budget_cents IS NOT NULL AND (p_budget_cents < 1 OR p_budget_cents > 100000000) THEN RAISE EXCEPTION 'Invalid budget'; END IF;
  IF lower(coalesce(p_currency, 'usd')) NOT IN ('usd', 'eur', 'gbp', 'cad', 'aud') THEN RAISE EXCEPTION 'Unsupported currency'; END IF;
  IF p_expires_hours IS NULL OR p_expires_hours < 1 OR p_expires_hours > 720 THEN RAISE EXCEPTION 'Expiry must be 1-720 hours'; END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found';
  END IF;
  IF (SELECT count(*) FROM pen_requests q WHERE q.origin_owner_id = v_owner AND q.status = 'open' AND q.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'You already have 25 open requests - close some first';
  END IF;

  INSERT INTO pen_requests (origin_owner_id, origin_job_id, trade_key, protocol_version, category, urgency, region,
                            summary, payload, budget_cents, currency, expires_at)
  VALUES (v_owner, p_job_id, v_trade.trade_key, v_trade.protocol_version, btrim(p_category), p_urgency, v_region,
          v_summary, coalesce(p_payload, '{}'::jsonb), p_budget_cents, lower(coalesce(p_currency, 'usd')),
          now() + make_interval(hours => p_expires_hours))
  RETURNING id INTO v_id;

  PERFORM public.pen_log(v_owner, 'request_created', v_id, jsonb_build_object('trade', v_trade.trade_key, 'region', v_region));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_create_request(text, text, text, text, text, jsonb, bigint, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_create_request(text, text, text, text, text, jsonb, bigint, text, uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_cancel_request(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager(); v_req pen_requests;
BEGIN
  SELECT * INTO v_req FROM pen_requests WHERE id = p_request_id AND origin_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.status <> 'open' THEN RAISE EXCEPTION 'Only open requests can be cancelled'; END IF;
  UPDATE pen_requests SET status = 'cancelled', updated_at = now() WHERE id = p_request_id;
  UPDATE pen_offers SET status = 'declined', updated_at = now() WHERE request_id = p_request_id AND status = 'pending';
  PERFORM public.pen_log(v_owner, 'request_cancelled', p_request_id);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_cancel_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_cancel_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_list_open_requests(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid, trade_key text, category text, urgency text, region text, summary text, payload jsonb,
  budget_cents bigint, currency text, expires_at timestamptz, created_at timestamptz,
  origin_handle text, origin_trust jsonb, my_offer_status text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_node pen_nodes;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  UPDATE pen_requests r SET status = 'expired', updated_at = now() WHERE r.status = 'open' AND r.expires_at <= now();
  SELECT * INTO v_node FROM pen_nodes n0 WHERE n0.account_owner_id = v_owner AND n0.status = 'active' AND n0.accepts_referrals;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.id, r.trade_key, r.category, r.urgency, r.region, r.summary, r.payload, r.budget_cents, r.currency,
         r.expires_at, r.created_at, n.node_handle,
         public.pen_node_trust(r.origin_owner_id) - 'technicians' - 'verified_technicians' - 'adverse_technicians' - 'jobs_365d' - 'network_engagements_365d',
         o.status
  FROM pen_requests r
  JOIN pen_nodes n ON n.account_owner_id = r.origin_owner_id
  LEFT JOIN pen_offers o ON o.request_id = r.id AND o.provider_owner_id = v_owner
  WHERE r.status = 'open' AND r.expires_at > now()
    AND r.origin_owner_id <> v_owner
    AND r.trade_key = ANY (v_node.trades)
    AND public.pen_region_match(r.region, v_node.regions)
  ORDER BY CASE r.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END, r.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 50), 100));
END;
$$;
REVOKE ALL ON FUNCTION public.pen_list_open_requests(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_list_open_requests(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_submit_offer(
  p_request_id uuid, p_price_cents bigint, p_eta_hours integer, p_message text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_node pen_nodes; v_req pen_requests;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
  v_id uuid;
BEGIN
  SELECT * INTO v_node FROM pen_nodes n0 WHERE n0.account_owner_id = v_owner AND n0.status = 'active' AND n0.accepts_referrals;
  IF NOT FOUND THEN RAISE EXCEPTION 'Your node must be active and accepting referrals'; END IF;
  SELECT * INTO v_req FROM pen_requests WHERE id = p_request_id FOR SHARE;
  IF NOT FOUND OR v_req.status <> 'open' OR v_req.expires_at <= now() THEN RAISE EXCEPTION 'This request is no longer open'; END IF;
  IF v_req.origin_owner_id = v_owner THEN RAISE EXCEPTION 'You cannot offer on your own request'; END IF;
  IF NOT (v_req.trade_key = ANY (v_node.trades)) OR NOT public.pen_region_match(v_req.region, v_node.regions) THEN
    RAISE EXCEPTION 'This request is outside your trades or regions';
  END IF;
  IF p_price_cents IS NULL OR p_price_cents < 1 OR p_price_cents > 100000000 THEN RAISE EXCEPTION 'Invalid price'; END IF;
  IF p_eta_hours IS NULL OR p_eta_hours < 0 OR p_eta_hours > 720 THEN RAISE EXCEPTION 'ETA must be 0-720 hours'; END IF;
  IF v_msg IS NOT NULL AND (char_length(v_msg) > 500 OR public.pen_contains_pii(v_msg)) THEN
    RAISE EXCEPTION 'Message must be under 500 characters and contain no phone numbers or e-mail addresses';
  END IF;
  IF (SELECT count(*) FROM pen_offers f WHERE f.provider_owner_id = v_owner AND f.status = 'pending') >= 100 THEN
    RAISE EXCEPTION 'Too many pending offers';
  END IF;

  INSERT INTO pen_offers (request_id, provider_owner_id, price_cents, currency, eta_hours, message)
  VALUES (p_request_id, v_owner, p_price_cents, v_req.currency, p_eta_hours, v_msg)
  ON CONFLICT (request_id, provider_owner_id) DO UPDATE SET
    price_cents = EXCLUDED.price_cents, eta_hours = EXCLUDED.eta_hours, message = EXCLUDED.message,
    status = 'pending', updated_at = now()
  WHERE pen_offers.status IN ('pending', 'withdrawn')
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'This offer can no longer be changed'; END IF;

  PERFORM public.pen_log(v_owner, 'offer_submitted', v_id, jsonb_build_object('request', p_request_id, 'price_cents', p_price_cents));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_submit_offer(uuid, bigint, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_submit_offer(uuid, bigint, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_withdraw_offer(p_offer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager();
BEGIN
  UPDATE pen_offers SET status = 'withdrawn', updated_at = now()
  WHERE id = p_offer_id AND provider_owner_id = v_owner AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found or already decided'; END IF;
  PERFORM public.pen_log(v_owner, 'offer_withdrawn', p_offer_id);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_withdraw_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_withdraw_offer(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_list_my_requests()
RETURNS TABLE (
  id uuid, trade_key text, category text, urgency text, region text, summary text, budget_cents bigint,
  currency text, status text, expires_at timestamptz, created_at timestamptz, offers_pending bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  UPDATE pen_requests r SET status = 'expired', updated_at = now()
  WHERE r.origin_owner_id = v_owner AND r.status = 'open' AND r.expires_at <= now();
  RETURN QUERY
  SELECT r.id, r.trade_key, r.category, r.urgency, r.region, r.summary, r.budget_cents, r.currency, r.status,
         r.expires_at, r.created_at,
         (SELECT count(*) FROM pen_offers o WHERE o.request_id = r.id AND o.status = 'pending')
  FROM pen_requests r
  WHERE r.origin_owner_id = v_owner
  ORDER BY r.created_at DESC
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_list_my_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_list_my_requests() TO authenticated;

-- Pending offers on my request (UI ranks by price, ETA, trust). Provider stays a handle until acceptance.
CREATE OR REPLACE FUNCTION public.pen_list_offers(p_request_id uuid)
RETURNS TABLE (
  id uuid, price_cents bigint, currency text, eta_hours integer, message text, created_at timestamptz,
  provider_handle text, provider_trust jsonb, referral_fee_bps integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pen_requests pr WHERE pr.id = p_request_id AND pr.origin_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  RETURN QUERY
  SELECT o.id, o.price_cents, o.currency, o.eta_hours, o.message, o.created_at, n.node_handle,
         public.pen_node_trust(o.provider_owner_id) - 'technicians' - 'verified_technicians' - 'adverse_technicians' - 'jobs_365d' - 'network_engagements_365d',
         n.referral_fee_bps
  FROM pen_offers o
  JOIN pen_nodes n ON n.account_owner_id = o.provider_owner_id
  WHERE o.request_id = p_request_id AND o.status = 'pending'
  ORDER BY o.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_list_offers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_list_offers(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_accept_offer(p_offer_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_offer pen_offers; v_req pen_requests; v_bps integer; v_id uuid;
BEGIN
  SELECT * INTO v_offer FROM pen_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found'; END IF;
  SELECT * INTO v_req FROM pen_requests WHERE id = v_offer.request_id AND origin_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found'; END IF;
  IF v_req.status <> 'open' OR v_req.expires_at <= now() THEN RAISE EXCEPTION 'This request is no longer open'; END IF;
  SELECT * INTO v_offer FROM pen_offers WHERE id = p_offer_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This offer is no longer available'; END IF;
  SELECT n.referral_fee_bps INTO v_bps FROM pen_nodes n WHERE n.account_owner_id = v_offer.provider_owner_id AND n.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'The provider is no longer active on the network'; END IF;

  UPDATE pen_offers SET status = 'accepted', updated_at = now() WHERE id = p_offer_id;
  UPDATE pen_offers SET status = 'declined', updated_at = now() WHERE request_id = v_req.id AND id <> p_offer_id AND status = 'pending';
  UPDATE pen_requests SET status = 'accepted', updated_at = now() WHERE id = v_req.id;

  INSERT INTO pen_engagements (request_id, offer_id, origin_owner_id, provider_owner_id, trade_key,
                               agreed_price_cents, currency, referral_fee_bps, referral_fee_cents)
  VALUES (v_req.id, p_offer_id, v_owner, v_offer.provider_owner_id, v_req.trade_key,
          v_offer.price_cents, v_offer.currency, v_bps, public.pen_fee_cents(v_offer.price_cents, v_bps))
  RETURNING id INTO v_id;

  PERFORM public.pen_log(v_owner, 'offer_accepted', v_id, jsonb_build_object('offer', p_offer_id));
  PERFORM public.pen_log(v_offer.provider_owner_id, 'offer_won', v_id, jsonb_build_object('offer', p_offer_id));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_accept_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_accept_offer(uuid) TO authenticated;

-- Business name + phone of the other side are visible only once an engagement exists.
CREATE OR REPLACE FUNCTION public.pen_list_engagements()
RETURNS TABLE (
  id uuid, my_role text, trade_key text, category text, region text, summary text,
  agreed_price_cents bigint, currency text, referral_fee_bps integer, referral_fee_cents bigint,
  status text, fee_status text, accepted_at timestamptz, provider_confirmed_at timestamptz,
  origin_confirmed_at timestamptz, completed_at timestamptz, settled_at timestamptz, settlement_reference text,
  counterparty_name text, counterparty_phone text, counterparty_handle text,
  my_outcome_reported boolean, can_settle boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  RETURN QUERY
  SELECT e.id,
         CASE WHEN e.origin_owner_id = v_owner THEN 'origin' ELSE 'provider' END,
         e.trade_key, r.category, r.region, r.summary,
         e.agreed_price_cents, e.currency, e.referral_fee_bps, e.referral_fee_cents,
         e.status, e.fee_status, e.accepted_at, e.provider_confirmed_at, e.origin_confirmed_at,
         e.completed_at, e.settled_at, e.settlement_reference,
         p.company_name, p.phone, n.node_handle,
         EXISTS (SELECT 1 FROM pen_outcomes o WHERE o.engagement_id = e.id AND o.reporter_owner_id = v_owner),
         (e.origin_owner_id = v_owner AND e.status = 'completed' AND e.fee_status = 'accrued'
           AND (e.origin_confirmed_at IS NOT NULL OR e.provider_confirmed_at < now() - interval '14 days'))
  FROM pen_engagements e
  JOIN pen_requests r ON r.id = e.request_id
  JOIN profiles p ON p.id = CASE WHEN e.origin_owner_id = v_owner THEN e.provider_owner_id ELSE e.origin_owner_id END
  JOIN pen_nodes n ON n.account_owner_id = p.id
  WHERE e.origin_owner_id = v_owner OR e.provider_owner_id = v_owner
  ORDER BY e.accepted_at DESC
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.pen_list_engagements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_list_engagements() TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_cancel_engagement(p_engagement_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager(); v_eng pen_engagements;
BEGIN
  SELECT * INTO v_eng FROM pen_engagements
  WHERE id = p_engagement_id AND (origin_owner_id = v_owner OR provider_owner_id = v_owner) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF v_eng.status <> 'active' THEN RAISE EXCEPTION 'Only active engagements can be cancelled'; END IF;
  UPDATE pen_engagements SET status = 'cancelled', updated_at = now() WHERE id = p_engagement_id;
  UPDATE pen_requests SET status = 'cancelled', updated_at = now() WHERE id = v_eng.request_id;
  PERFORM public.pen_log(v_eng.origin_owner_id, 'engagement_cancelled', p_engagement_id, jsonb_build_object('by', v_owner));
  PERFORM public.pen_log(v_eng.provider_owner_id, 'engagement_cancelled', p_engagement_id, jsonb_build_object('by', v_owner));
END;
$$;
REVOKE ALL ON FUNCTION public.pen_cancel_engagement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_cancel_engagement(uuid) TO authenticated;

-- 11) Outcome + Financial RPCs ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pen_record_outcome(
  p_engagement_id uuid, p_resolved boolean, p_rework boolean DEFAULT false,
  p_satisfaction integer DEFAULT NULL, p_notes text DEFAULT NULL, p_evidence_sha256 text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_eng pen_engagements; v_role text;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text := nullif(lower(btrim(coalesce(p_evidence_sha256, ''))), '');
  v_disputed boolean; v_group_o uuid; v_group_p uuid;
BEGIN
  IF p_resolved IS NULL THEN RAISE EXCEPTION 'State whether the issue was resolved'; END IF;
  IF p_satisfaction IS NOT NULL AND p_satisfaction NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Satisfaction must be 1-5'; END IF;
  IF v_notes IS NOT NULL AND (char_length(v_notes) > 500 OR public.pen_contains_pii(v_notes)) THEN
    RAISE EXCEPTION 'Notes must be under 500 characters and contain no phone numbers or e-mail addresses';
  END IF;
  IF v_hash IS NOT NULL AND v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Evidence hash must be a SHA-256 hex digest'; END IF;

  SELECT * INTO v_eng FROM pen_engagements
  WHERE id = p_engagement_id AND (origin_owner_id = v_owner OR provider_owner_id = v_owner) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  v_role := CASE WHEN v_eng.provider_owner_id = v_owner THEN 'provider' ELSE 'origin' END;
  IF v_eng.status NOT IN ('active', 'completed', 'disputed') THEN RAISE EXCEPTION 'This engagement is closed'; END IF;
  IF EXISTS (SELECT 1 FROM pen_outcomes x WHERE x.engagement_id = p_engagement_id AND x.reporter_role = v_role) THEN
    RAISE EXCEPTION 'You already reported the outcome for this engagement';
  END IF;
  IF v_role = 'origin' AND v_eng.provider_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'The provider has not reported completion yet';
  END IF;

  INSERT INTO pen_outcomes (engagement_id, reporter_owner_id, reporter_role, resolved, rework_needed, satisfaction, notes, evidence_sha256)
  VALUES (p_engagement_id, v_owner, v_role, p_resolved, coalesce(p_rework, false), p_satisfaction, v_notes, v_hash);

  IF v_role = 'provider' THEN
    UPDATE pen_engagements SET provider_confirmed_at = now(), completed_at = now(),
      status = 'completed', updated_at = now() WHERE id = p_engagement_id;
    UPDATE pen_requests SET status = 'completed', updated_at = now() WHERE id = v_eng.request_id;
    IF v_eng.referral_fee_cents > 0 THEN
      v_group_o := gen_random_uuid(); v_group_p := gen_random_uuid();
      INSERT INTO pen_ledger_entries (owner_id, group_id, engagement_id, kind, account, direction, amount_cents, currency, memo, idempotency_key)
      VALUES
        (v_eng.origin_owner_id, v_group_o, p_engagement_id, 'fee_accrual', 'fee_receivable', 'debit', v_eng.referral_fee_cents, v_eng.currency, 'Referral fee earned', 'accr:' || p_engagement_id || ':o:dr'),
        (v_eng.origin_owner_id, v_group_o, p_engagement_id, 'fee_accrual', 'referral_income', 'credit', v_eng.referral_fee_cents, v_eng.currency, 'Referral fee earned', 'accr:' || p_engagement_id || ':o:cr'),
        (v_eng.provider_owner_id, v_group_p, p_engagement_id, 'fee_accrual', 'referral_expense', 'debit', v_eng.referral_fee_cents, v_eng.currency, 'Referral fee owed', 'accr:' || p_engagement_id || ':p:dr'),
        (v_eng.provider_owner_id, v_group_p, p_engagement_id, 'fee_accrual', 'fee_payable', 'credit', v_eng.referral_fee_cents, v_eng.currency, 'Referral fee owed', 'accr:' || p_engagement_id || ':p:cr');
      UPDATE pen_engagements SET fee_status = 'accrued' WHERE id = p_engagement_id;
    END IF;
  ELSE
    UPDATE pen_engagements SET origin_confirmed_at = now(), updated_at = now() WHERE id = p_engagement_id;
  END IF;

  -- Reports that disagree freeze settlement until reviewed.
  SELECT EXISTS (
    SELECT 1 FROM pen_outcomes a JOIN pen_outcomes b ON b.engagement_id = a.engagement_id AND b.reporter_role = 'origin'
    WHERE a.engagement_id = p_engagement_id AND a.reporter_role = 'provider'
      AND ((a.resolved AND NOT b.resolved) OR (b.rework_needed AND NOT a.rework_needed))
  ) INTO v_disputed;
  IF v_disputed THEN
    UPDATE pen_engagements SET status = 'disputed', updated_at = now() WHERE id = p_engagement_id;
  END IF;

  PERFORM public.pen_log(v_owner, 'outcome_recorded', p_engagement_id, jsonb_build_object('role', v_role, 'resolved', p_resolved));
  RETURN jsonb_build_object('role', v_role, 'disputed', v_disputed);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_record_outcome(uuid, boolean, boolean, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_record_outcome(uuid, boolean, boolean, integer, text, text) TO authenticated;

-- The business that EARNS the fee confirms it received the money.
CREATE OR REPLACE FUNCTION public.pen_settle_engagement(p_engagement_id uuid, p_reference text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.pen_require_manager();
  v_eng pen_engagements;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_go uuid := gen_random_uuid(); v_gp uuid := gen_random_uuid();
BEGIN
  IF char_length(v_ref) < 3 OR char_length(v_ref) > 120 THEN RAISE EXCEPTION 'Enter a payment reference (3-120 characters)'; END IF;
  SELECT * INTO v_eng FROM pen_engagements WHERE id = p_engagement_id AND origin_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF v_eng.status <> 'completed' OR v_eng.fee_status <> 'accrued' THEN
    RAISE EXCEPTION 'Nothing to settle (engagement must be completed with an unsettled fee, and not disputed)';
  END IF;
  IF v_eng.origin_confirmed_at IS NULL AND v_eng.provider_confirmed_at >= now() - interval '14 days' THEN
    RAISE EXCEPTION 'Confirm the outcome first (or wait 14 days for auto-confirmation)';
  END IF;

  INSERT INTO pen_ledger_entries (owner_id, group_id, engagement_id, kind, account, direction, amount_cents, currency, memo, idempotency_key)
  VALUES
    (v_eng.origin_owner_id, v_go, p_engagement_id, 'fee_settlement', 'cash', 'debit', v_eng.referral_fee_cents, v_eng.currency, v_ref, 'sett:' || p_engagement_id || ':o:dr'),
    (v_eng.origin_owner_id, v_go, p_engagement_id, 'fee_settlement', 'fee_receivable', 'credit', v_eng.referral_fee_cents, v_eng.currency, v_ref, 'sett:' || p_engagement_id || ':o:cr'),
    (v_eng.provider_owner_id, v_gp, p_engagement_id, 'fee_settlement', 'fee_payable', 'debit', v_eng.referral_fee_cents, v_eng.currency, v_ref, 'sett:' || p_engagement_id || ':p:dr'),
    (v_eng.provider_owner_id, v_gp, p_engagement_id, 'fee_settlement', 'cash', 'credit', v_eng.referral_fee_cents, v_eng.currency, v_ref, 'sett:' || p_engagement_id || ':p:cr');

  UPDATE pen_engagements SET fee_status = 'settled', settled_at = now(), settlement_reference = v_ref, updated_at = now()
  WHERE id = p_engagement_id;
  PERFORM public.pen_log(v_eng.origin_owner_id, 'fee_settled', p_engagement_id, jsonb_build_object('reference', v_ref));
  PERFORM public.pen_log(v_eng.provider_owner_id, 'fee_settled', p_engagement_id, jsonb_build_object('reference', v_ref));
END;
$$;
REVOKE ALL ON FUNCTION public.pen_settle_engagement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_settle_engagement(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pen_ledger_integrity()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.pen_require_manager(); v_groups integer; v_bad integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE d <> c) INTO v_groups, v_bad
  FROM (
    SELECT l.group_id,
           sum(l.amount_cents) FILTER (WHERE l.direction = 'debit') AS d,
           sum(l.amount_cents) FILTER (WHERE l.direction = 'credit') AS c
    FROM pen_ledger_entries l WHERE l.owner_id = v_owner GROUP BY l.group_id
  ) g;
  RETURN jsonb_build_object('groups', v_groups, 'unbalanced', v_bad, 'balanced', v_bad = 0);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_ledger_integrity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_ledger_integrity() TO authenticated;

-- Staff-only dispute resolution (SQL editor / service role). Not callable from the browser.
--   select public.pen_admin_resolve_dispute('<engagement id>', 'confirm');  -- fee stands, settlement unlocked
--   select public.pen_admin_resolve_dispute('<engagement id>', 'void');     -- fee reversed in both ledgers
CREATE OR REPLACE FUNCTION public.pen_admin_resolve_dispute(p_engagement_id uuid, p_decision text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_eng pen_engagements; v_go uuid := gen_random_uuid(); v_gp uuid := gen_random_uuid();
BEGIN
  IF p_decision NOT IN ('confirm', 'void') THEN RAISE EXCEPTION 'Decision must be confirm or void'; END IF;
  SELECT * INTO v_eng FROM pen_engagements WHERE id = p_engagement_id AND status = 'disputed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No disputed engagement with that id'; END IF;
  IF p_decision = 'confirm' THEN
    UPDATE pen_engagements SET status = 'completed', origin_confirmed_at = coalesce(origin_confirmed_at, now()), updated_at = now()
    WHERE id = p_engagement_id;
  ELSE
    IF v_eng.fee_status = 'accrued' THEN
      INSERT INTO pen_ledger_entries (owner_id, group_id, engagement_id, kind, account, direction, amount_cents, currency, memo, idempotency_key)
      VALUES
        (v_eng.origin_owner_id, v_go, p_engagement_id, 'fee_reversal', 'referral_income', 'debit', v_eng.referral_fee_cents, v_eng.currency, 'Dispute: fee voided', 'rev:' || p_engagement_id || ':o:dr'),
        (v_eng.origin_owner_id, v_go, p_engagement_id, 'fee_reversal', 'fee_receivable', 'credit', v_eng.referral_fee_cents, v_eng.currency, 'Dispute: fee voided', 'rev:' || p_engagement_id || ':o:cr'),
        (v_eng.provider_owner_id, v_gp, p_engagement_id, 'fee_reversal', 'fee_payable', 'debit', v_eng.referral_fee_cents, v_eng.currency, 'Dispute: fee voided', 'rev:' || p_engagement_id || ':p:dr'),
        (v_eng.provider_owner_id, v_gp, p_engagement_id, 'fee_reversal', 'referral_expense', 'credit', v_eng.referral_fee_cents, v_eng.currency, 'Dispute: fee voided', 'rev:' || p_engagement_id || ':p:cr');
    END IF;
    UPDATE pen_engagements SET status = 'cancelled', fee_status = 'none', updated_at = now() WHERE id = p_engagement_id;
  END IF;
  PERFORM public.pen_log(v_eng.origin_owner_id, 'dispute_resolved', p_engagement_id, jsonb_build_object('decision', p_decision));
  PERFORM public.pen_log(v_eng.provider_owner_id, 'dispute_resolved', p_engagement_id, jsonb_build_object('decision', p_decision));
END;
$$;
REVOKE ALL ON FUNCTION public.pen_admin_resolve_dispute(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pen_admin_resolve_dispute(uuid, text) TO service_role;

-- 12) Overview: one call that powers the dashboard --------------------------------------------
CREATE OR REPLACE FUNCTION public.pen_get_overview()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean := public.pen_is_manager();
  v_node pen_nodes;
  v_ident jsonb; v_proto jsonb; v_out jsonb; v_mkt jsonb; v_fin jsonb; v_trust jsonb;
  v_recv bigint := 0; v_pay bigint := 0; v_settled bigint := 0; v_payouts boolean := false; v_currency text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_node FROM pen_nodes n0 WHERE n0.account_owner_id = v_owner;

  SELECT jsonb_build_object(
    'technicians', (SELECT count(*) FROM team_members m WHERE m.account_owner_id = v_owner AND m.role = 'technician' AND m.invite_status <> 'removed'),
    'technicians_identified', (SELECT count(*) FROM pen_identifiers i WHERE i.account_owner_id = v_owner AND i.entity_kind = 'technician'),
    'sites', (SELECT count(*) FROM customer_sites s WHERE s.user_id = v_owner),
    'sites_identified', (SELECT count(*) FROM pen_identifiers i WHERE i.account_owner_id = v_owner AND i.entity_kind = 'site'),
    'business_network_id', (SELECT i.network_id FROM pen_identifiers i WHERE i.account_owner_id = v_owner AND i.entity_kind = 'business' LIMIT 1)
  ) INTO v_ident;

  SELECT jsonb_build_object(
    'trades_active', coalesce(cardinality(v_node.trades), 0),
    'requests_total', (SELECT count(*) FROM pen_requests r WHERE r.origin_owner_id = v_owner),
    'requests_open', (SELECT count(*) FROM pen_requests r WHERE r.origin_owner_id = v_owner AND r.status = 'open' AND r.expires_at > now()),
    'offers_waiting', (SELECT count(*) FROM pen_offers o JOIN pen_requests r ON r.id = o.request_id
                       WHERE r.origin_owner_id = v_owner AND r.status = 'open' AND r.expires_at > now() AND o.status = 'pending')
  ) INTO v_proto;

  SELECT jsonb_build_object(
    'completed', count(*) FILTER (WHERE o.reporter_role = 'provider'),
    'first_time_resolved', count(*) FILTER (WHERE o.reporter_role = 'provider' AND o.resolved AND NOT o.rework_needed),
    'avg_satisfaction', round(avg(o.satisfaction) FILTER (WHERE o.reporter_role = 'origin'), 2),
    'disputed', (SELECT count(*) FROM pen_engagements e WHERE (e.origin_owner_id = v_owner OR e.provider_owner_id = v_owner) AND e.status = 'disputed')
  ) INTO v_out
  FROM pen_outcomes o JOIN pen_engagements e2 ON e2.id = o.engagement_id
  WHERE e2.provider_owner_id = v_owner;

  SELECT jsonb_build_object(
    'matching_open', CASE WHEN v_node.id IS NULL OR v_node.status <> 'active' OR NOT v_node.accepts_referrals THEN 0 ELSE
      (SELECT count(*) FROM pen_requests r WHERE r.status = 'open' AND r.expires_at > now() AND r.origin_owner_id <> v_owner
         AND r.trade_key = ANY (v_node.trades) AND public.pen_region_match(r.region, v_node.regions)) END,
    'my_offers_pending', (SELECT count(*) FROM pen_offers o WHERE o.provider_owner_id = v_owner AND o.status = 'pending'),
    'active_engagements', (SELECT count(*) FROM pen_engagements e WHERE (e.origin_owner_id = v_owner OR e.provider_owner_id = v_owner) AND e.status = 'active')
  ) INTO v_mkt;

  IF v_manager THEN
    SELECT coalesce(sum(CASE WHEN l.account = 'fee_receivable' THEN CASE l.direction WHEN 'debit' THEN l.amount_cents ELSE -l.amount_cents END END), 0),
           coalesce(sum(CASE WHEN l.account = 'fee_payable' THEN CASE l.direction WHEN 'credit' THEN l.amount_cents ELSE -l.amount_cents END END), 0),
           coalesce(sum(CASE WHEN l.account = 'cash' AND l.direction = 'debit' THEN l.amount_cents END), 0),
           min(l.currency)
    INTO v_recv, v_pay, v_settled, v_currency
    FROM pen_ledger_entries l WHERE l.owner_id = v_owner;
  END IF;
  SELECT coalesce(bool_or(s.payouts_enabled), false) INTO v_payouts FROM stripe_connect_accounts s WHERE s.user_id = v_owner;
  v_fin := jsonb_build_object(
    'receivable_cents', v_recv, 'payable_cents', v_pay, 'received_cents', v_settled,
    'currency', coalesce(v_currency, 'usd'), 'payouts_enabled', v_payouts, 'visible', v_manager);

  v_trust := public.pen_node_trust(v_owner);

  RETURN jsonb_build_object(
    'node', CASE WHEN v_node.id IS NULL THEN NULL ELSE to_jsonb(v_node) - 'consented_by' END,
    'can_manage', v_manager,
    'identity', v_ident, 'protocol', v_proto, 'trust', v_trust, 'outcome', v_out, 'marketplace', v_mkt, 'financial', v_fin);
END;
$$;
REVOKE ALL ON FUNCTION public.pen_get_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pen_get_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
