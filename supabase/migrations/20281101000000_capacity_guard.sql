/*
  # Capacity Guard — value-aware holds, campaign reservations, instant backfill

  Additive and idempotent. Nothing changes until the owner turns capacity_guard_settings.enabled on
  (default OFF). mode = 'shadow' (default) computes and logs but never blocks a slot or texts a customer.

  Reuses (does not replace): book_capacity_slot() as the ONLY job-write path for a claimed backfill slot
  (so jobs_no_double_booking + daily capacity + credential gates still apply), capacity_waitlist_entries
  as a backfill candidate source, sendCompliantSms() for every outbound text (done in the edge function).

  Tables (all: RLS select by get_account_owner_id(); writes ONLY through SECURITY DEFINER functions)
    capacity_guard_settings          per-account switches + trade rules
    capacity_holds                   value + campaign holds (one active hold per technician slot)
    capacity_campaign_reservations   one row per (source_type, source_id): the double-action guard
    backfill_gaps                    one row per freed slot (unique per source job = idempotent)
    backfill_offers                  one row per candidate offer; token stored as SHA-256 hash only
    capacity_guard_events            audit log (also feeds held-vs-released outcomes)
*/

-- =============================================================
-- Settings
-- =============================================================
CREATE TABLE IF NOT EXISTS capacity_guard_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  hold_share_pct integer NOT NULL DEFAULT 15 CHECK (hold_share_pct BETWEEN 0 AND 50),
  hold_horizon_days integer NOT NULL DEFAULT 3 CHECK (hold_horizon_days BETWEEN 1 AND 14),
  min_release_probability numeric(4,3) NOT NULL DEFAULT 0.250 CHECK (min_release_probability BETWEEN 0.01 AND 0.99),
  -- [{ "trade": "hvac_replacement", "hold_share_pct": 20, "skill": "hvac" }, ...]; validated in update fn
  trade_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  campaign_holds_enabled boolean NOT NULL DEFAULT true,
  campaign_max_hold_share_pct integer NOT NULL DEFAULT 30 CHECK (campaign_max_hold_share_pct BETWEEN 0 AND 60),
  campaign_default_response_rate numeric(5,4) NOT NULL DEFAULT 0.0100 CHECK (campaign_default_response_rate BETWEEN 0 AND 0.5),
  campaign_release_grace_hours integer NOT NULL DEFAULT 6 CHECK (campaign_release_grace_hours BETWEEN 0 AND 72),
  backfill_enabled boolean NOT NULL DEFAULT true,
  backfill_offer_ttl_minutes integer NOT NULL DEFAULT 20 CHECK (backfill_offer_ttl_minutes BETWEEN 5 AND 240),
  backfill_batch_size integer NOT NULL DEFAULT 3 CHECK (backfill_batch_size BETWEEN 1 AND 10),
  backfill_min_lead_minutes integer NOT NULL DEFAULT 60 CHECK (backfill_min_lead_minutes BETWEEN 15 AND 1440),
  backfill_max_offers_per_customer_7d integer NOT NULL DEFAULT 2 CHECK (backfill_max_offers_per_customer_7d BETWEEN 1 AND 10),
  backfill_max_offers_per_customer_24h integer NOT NULL DEFAULT 1 CHECK (backfill_max_offers_per_customer_24h BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE capacity_guard_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_capacity_guard_settings" ON capacity_guard_settings;
CREATE POLICY "select_own_capacity_guard_settings" ON capacity_guard_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Holds
-- =============================================================
CREATE TABLE IF NOT EXISTS capacity_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('value', 'campaign')),
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  trade text,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL CHECK (slot_end > slot_start),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  -- shadow holds are recorded for the "what would have happened" view but never block booking
  shadow boolean NOT NULL DEFAULT false,
  reservation_id uuid,
  demand_probability numeric(5,4),
  release_reason text,
  consumed_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

-- One ACTIVE hold per technician slot: concurrent planners / double clicks cannot stack holds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_capacity_holds_active_slot
  ON capacity_holds (user_id, technician_id, slot_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_capacity_holds_user_window ON capacity_holds (user_id, slot_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_capacity_holds_reservation ON capacity_holds (reservation_id) WHERE reservation_id IS NOT NULL;

ALTER TABLE capacity_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_capacity_holds" ON capacity_holds;
CREATE POLICY "select_own_capacity_holds" ON capacity_holds FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Campaign reservations (double-action guard = UNIQUE key)
-- =============================================================
CREATE TABLE IF NOT EXISTS capacity_campaign_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('marketing', 'direct_mail', 'ads')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'completed')),
  expected_responses numeric(10,2) NOT NULL CHECK (expected_responses >= 0),
  curve_source text NOT NULL CHECK (curve_source IN ('history', 'default')),
  curve_shares jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  holds_requested integer NOT NULL DEFAULT 0,
  holds_placed integer NOT NULL DEFAULT 0,
  applied_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  observed_responses integer,
  released_at timestamptz,
  UNIQUE (user_id, source_type, source_id)
);
ALTER TABLE capacity_campaign_reservations ADD COLUMN IF NOT EXISTS curve_shares jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE capacity_campaign_reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_capacity_campaign_reservations" ON capacity_campaign_reservations;
CREATE POLICY "select_own_capacity_campaign_reservations" ON capacity_campaign_reservations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

ALTER TABLE capacity_holds DROP CONSTRAINT IF EXISTS capacity_holds_reservation_fk;
ALTER TABLE capacity_holds ADD CONSTRAINT capacity_holds_reservation_fk
  FOREIGN KEY (reservation_id) REFERENCES capacity_campaign_reservations(id) ON DELETE SET NULL;

-- =============================================================
-- Backfill gaps + offers
-- =============================================================
CREATE TABLE IF NOT EXISTS backfill_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_reason text NOT NULL CHECK (source_reason IN ('cancelled', 'no_show')),
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  service_type text,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  est_value_cents integer NOT NULL DEFAULT 0 CHECK (est_value_cents >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'offered', 'filled', 'expired', 'abandoned')),
  filled_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  filled_offer_id uuid,
  filled_at timestamptz,
  -- booked value is an ESTIMATE from the candidate until the job is invoiced; realized_cents is the invoice.
  recovered_estimate_cents integer,
  realized_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_backfill_gaps_user_status ON backfill_gaps (user_id, status, slot_start);
CREATE INDEX IF NOT EXISTS idx_backfill_gaps_filled_job ON backfill_gaps (filled_job_id) WHERE filled_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backfill_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gap_id uuid NOT NULL REFERENCES backfill_gaps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_type text NOT NULL CHECK (candidate_type IN ('waitlist', 'open_estimate', 'same_area', 'agreement_due', 'missed_call')),
  candidate_ref text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  phone_norm text NOT NULL,
  rank integer NOT NULL,
  score numeric(8,3) NOT NULL DEFAULT 0,
  est_value_cents integer NOT NULL DEFAULT 0 CHECK (est_value_cents >= 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'claimed', 'expired', 'superseded', 'blocked', 'failed')),
  blocked_reason text,
  token_hash text,
  expires_at timestamptz,
  sent_at timestamptz,
  claimed_at timestamptz,
  claimed_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gap_id, candidate_type, candidate_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_backfill_offers_token ON backfill_offers (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_backfill_offers_gap ON backfill_offers (gap_id, status, rank);
-- frequency caps count offers actually sent to a phone
CREATE INDEX IF NOT EXISTS idx_backfill_offers_phone_sent ON backfill_offers (user_id, phone_norm, sent_at) WHERE sent_at IS NOT NULL;

ALTER TABLE backfill_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE backfill_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_backfill_gaps" ON backfill_gaps;
CREATE POLICY "select_own_backfill_gaps" ON backfill_gaps FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_backfill_offers" ON backfill_offers;
-- token_hash is never needed by the browser: expose offers through a view without it
CREATE POLICY "select_own_backfill_offers" ON backfill_offers FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Column-level REVOKE does not undo a table-level GRANT (Supabase grants table-level by default), so drop the
-- table grant and re-grant every column EXCEPT token_hash.
REVOKE ALL ON backfill_offers FROM anon, authenticated;
GRANT SELECT (id, gap_id, user_id, candidate_type, candidate_ref, customer_id, customer_name, phone_norm, rank, score,
              est_value_cents, status, blocked_reason, expires_at, sent_at, claimed_at, claimed_job_id, created_at)
  ON backfill_offers TO authenticated;

CREATE TABLE IF NOT EXISTS capacity_guard_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event text NOT NULL,
  actor uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capacity_guard_events_user ON capacity_guard_events (user_id, created_at DESC);
ALTER TABLE capacity_guard_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_capacity_guard_events" ON capacity_guard_events;
CREATE POLICY "select_own_capacity_guard_events" ON capacity_guard_events FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Settings RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_capacity_guard_settings()
RETURNS capacity_guard_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row capacity_guard_settings;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO capacity_guard_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM capacity_guard_settings WHERE user_id = v_owner;
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.update_capacity_guard_settings(p jsonb)
RETURNS capacity_guard_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row capacity_guard_settings;
  v_rule jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF auth.uid() IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'owner_only'; END IF;
  IF p ? 'trade_rules' THEN
    IF jsonb_typeof(p->'trade_rules') <> 'array' OR jsonb_array_length(p->'trade_rules') > 20 THEN RAISE EXCEPTION 'invalid_trade_rules'; END IF;
    FOR v_rule IN SELECT * FROM jsonb_array_elements(p->'trade_rules') LOOP
      IF jsonb_typeof(v_rule) <> 'object'
         OR coalesce(char_length(v_rule->>'trade'), 0) NOT BETWEEN 1 AND 60
         OR coalesce((v_rule->>'hold_share_pct')::int, -1) NOT BETWEEN 0 AND 50 THEN
        RAISE EXCEPTION 'invalid_trade_rules';
      END IF;
    END LOOP;
  END IF;
  INSERT INTO capacity_guard_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  UPDATE capacity_guard_settings SET
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    mode = coalesce(p->>'mode', mode),
    hold_share_pct = coalesce((p->>'hold_share_pct')::int, hold_share_pct),
    hold_horizon_days = coalesce((p->>'hold_horizon_days')::int, hold_horizon_days),
    min_release_probability = coalesce((p->>'min_release_probability')::numeric, min_release_probability),
    trade_rules = coalesce(p->'trade_rules', trade_rules),
    campaign_holds_enabled = coalesce((p->>'campaign_holds_enabled')::boolean, campaign_holds_enabled),
    campaign_max_hold_share_pct = coalesce((p->>'campaign_max_hold_share_pct')::int, campaign_max_hold_share_pct),
    campaign_default_response_rate = coalesce((p->>'campaign_default_response_rate')::numeric, campaign_default_response_rate),
    campaign_release_grace_hours = coalesce((p->>'campaign_release_grace_hours')::int, campaign_release_grace_hours),
    backfill_enabled = coalesce((p->>'backfill_enabled')::boolean, backfill_enabled),
    backfill_offer_ttl_minutes = coalesce((p->>'backfill_offer_ttl_minutes')::int, backfill_offer_ttl_minutes),
    backfill_batch_size = coalesce((p->>'backfill_batch_size')::int, backfill_batch_size),
    backfill_min_lead_minutes = coalesce((p->>'backfill_min_lead_minutes')::int, backfill_min_lead_minutes),
    backfill_max_offers_per_customer_7d = coalesce((p->>'backfill_max_offers_per_customer_7d')::int, backfill_max_offers_per_customer_7d),
    backfill_max_offers_per_customer_24h = coalesce((p->>'backfill_max_offers_per_customer_24h')::int, backfill_max_offers_per_customer_24h),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;
  INSERT INTO capacity_guard_events (user_id, event, actor, detail) VALUES (v_owner, 'settings_updated', auth.uid(), p - 'trade_rules');
  RETURN v_row;
END $$;

-- =============================================================
-- Campaign reservation: atomic + idempotent (double-action guard)
-- p_holds: [{ "technician_id": uuid, "slot_start": ts, "slot_end": ts, "trade": text, "demand_probability": num }]
-- =============================================================
CREATE OR REPLACE FUNCTION public.apply_campaign_reservation(
  p_source_type text, p_source_id text, p_expected_responses numeric, p_curve_source text,
  p_window_start timestamptz, p_window_end timestamptz, p_holds jsonb, p_curve_shares jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_actor uuid := auth.uid();
  v_res capacity_campaign_reservations;
  v_h jsonb; v_placed integer := 0; v_n integer; v_mode text; v_inserted integer;
BEGIN
  IF v_owner IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF jsonb_typeof(p_holds) <> 'array' OR jsonb_array_length(p_holds) > 200 THEN RAISE EXCEPTION 'invalid_holds'; END IF;
  IF jsonb_typeof(p_curve_shares) <> 'array' OR jsonb_array_length(p_curve_shares) > 14 THEN RAISE EXCEPTION 'invalid_curve'; END IF;
  SELECT mode INTO v_mode FROM capacity_guard_settings WHERE user_id = v_owner AND enabled = true;
  IF v_mode IS NULL THEN RETURN jsonb_build_object('status', 'disabled'); END IF;

  INSERT INTO capacity_campaign_reservations
    (user_id, source_type, source_id, expected_responses, curve_source, curve_shares, window_start, window_end, holds_requested, applied_by)
  VALUES (v_owner, p_source_type, p_source_id, p_expected_responses, p_curve_source, p_curve_shares, p_window_start, p_window_end, jsonb_array_length(p_holds), v_actor)
  ON CONFLICT (user_id, source_type, source_id) DO NOTHING
  RETURNING * INTO v_res;

  IF NOT FOUND THEN
    -- Second team member / double click: no new holds, tell the caller who applied it first.
    SELECT * INTO v_res FROM capacity_campaign_reservations WHERE user_id = v_owner AND source_type = p_source_type AND source_id = p_source_id;
    RETURN jsonb_build_object('status', 'already_applied', 'reservation_id', v_res.id, 'applied_by', v_res.applied_by,
                              'applied_at', v_res.applied_at, 'holds_placed', v_res.holds_placed);
  END IF;

  FOR v_h IN SELECT * FROM jsonb_array_elements(p_holds) LOOP
    INSERT INTO capacity_holds (user_id, kind, technician_id, trade, slot_start, slot_end, shadow, reservation_id, demand_probability)
    SELECT v_owner, 'campaign', t.id, nullif(v_h->>'trade', ''), (v_h->>'slot_start')::timestamptz, (v_h->>'slot_end')::timestamptz,
           v_mode = 'shadow', v_res.id, nullif(v_h->>'demand_probability', '')::numeric
    FROM team_members t
    WHERE t.id = (v_h->>'technician_id')::uuid AND t.account_owner_id = v_owner   -- tenant check: tech must belong to this account
    ON CONFLICT (user_id, technician_id, slot_start) WHERE status = 'active' DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_placed := v_placed + v_n;
  END LOOP;

  UPDATE capacity_campaign_reservations SET holds_placed = v_placed WHERE id = v_res.id;
  INSERT INTO capacity_guard_events (user_id, event, actor, detail)
  VALUES (v_owner, 'campaign_reserved', v_actor, jsonb_build_object('source_type', p_source_type, 'source_id', p_source_id, 'holds_placed', v_placed, 'shadow', v_mode = 'shadow'));
  RETURN jsonb_build_object('status', 'applied', 'reservation_id', v_res.id, 'holds_placed', v_placed, 'shadow', v_mode = 'shadow');
END $$;

-- =============================================================
-- Service-role functions (called by capacity-guard-tick / backfill-claim edge functions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.capacity_guard_place_holds(p_user_id uuid, p_kind text, p_holds jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text; v_h jsonb; v_n integer; v_total integer := 0;
BEGIN
  SELECT mode INTO v_mode FROM capacity_guard_settings WHERE user_id = p_user_id AND enabled = true;
  IF v_mode IS NULL OR p_kind <> 'value' THEN RETURN 0; END IF;
  IF jsonb_typeof(p_holds) <> 'array' OR jsonb_array_length(p_holds) > 500 THEN RAISE EXCEPTION 'invalid_holds'; END IF;
  FOR v_h IN SELECT * FROM jsonb_array_elements(p_holds) LOOP
    INSERT INTO capacity_holds (user_id, kind, technician_id, trade, slot_start, slot_end, shadow, demand_probability)
    SELECT p_user_id, 'value', t.id, nullif(v_h->>'trade', ''), (v_h->>'slot_start')::timestamptz, (v_h->>'slot_end')::timestamptz,
           v_mode = 'shadow', nullif(v_h->>'demand_probability', '')::numeric
    FROM team_members t WHERE t.id = (v_h->>'technician_id')::uuid AND t.account_owner_id = p_user_id
    ON CONFLICT (user_id, technician_id, slot_start) WHERE status = 'active' DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  END LOOP;
  IF v_total > 0 THEN
    INSERT INTO capacity_guard_events (user_id, event, detail) VALUES (p_user_id, 'value_holds_placed', jsonb_build_object('count', v_total, 'shadow', v_mode = 'shadow'));
  END IF;
  RETURN v_total;
END $$;

CREATE OR REPLACE FUNCTION public.capacity_guard_release_holds(p_user_id uuid, p_ids uuid[], p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE capacity_holds SET status = 'released', release_reason = left(p_reason, 80), released_at = now()
  WHERE user_id = p_user_id AND status = 'active' AND id = ANY (p_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO capacity_guard_events (user_id, event, detail) VALUES (p_user_id, 'holds_released', jsonb_build_object('count', v_n, 'reason', left(p_reason, 80)));
  END IF;
  RETURN v_n;
END $$;

-- Marks a hold consumed by a booking that was allowed to use it (emergency / VIP / agreement / replacement).
CREATE OR REPLACE FUNCTION public.capacity_guard_consume_hold(p_user_id uuid, p_hold_id uuid, p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE capacity_holds SET status = 'consumed', consumed_job_id = p_job_id, released_at = now(), release_reason = 'consumed'
  WHERE id = p_hold_id AND user_id = p_user_id AND status = 'active';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

-- Gap creation: idempotent per source job. Called by the jobs trigger below.
CREATE OR REPLACE FUNCTION public.capacity_guard_open_gap(p_job jsonb, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := (p_job->>'user_id')::uuid;
  v_start timestamptz := (p_job->>'scheduled_datetime')::timestamptz;
  v_dur integer := LEAST(480, GREATEST(15, coalesce((p_job->>'duration_minutes')::int, 60)));
  v_min integer; v_id uuid;
BEGIN
  SELECT backfill_min_lead_minutes INTO v_min FROM capacity_guard_settings WHERE user_id = v_user AND enabled = true AND backfill_enabled = true;
  IF v_min IS NULL OR v_start IS NULL THEN RETURN NULL; END IF;
  -- The whole original slot must still be refillable with the required lead time; otherwise there is nothing to sell.
  IF v_start < now() + make_interval(mins => v_min) THEN RETURN NULL; END IF;
  INSERT INTO backfill_gaps (user_id, source_job_id, source_reason, technician_id, service_type, slot_start, slot_end, duration_minutes, est_value_cents)
  VALUES (v_user, (p_job->>'id')::uuid, p_reason, nullif(p_job->>'assigned_technician_id', '')::uuid, p_job->>'service_type', v_start,
          v_start + make_interval(mins => v_dur), v_dur, coalesce(round(((p_job->>'invoice_amount')::numeric) * 100)::int, 0))
  ON CONFLICT (user_id, source_job_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO capacity_guard_events (user_id, event, detail) VALUES (v_user, 'gap_opened', jsonb_build_object('gap_id', v_id, 'reason', p_reason));
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.capacity_guard_jobs_status_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.job_status IN ('scheduled', 'en_route') AND NEW.job_status IN ('cancelled', 'no_show')
     AND OLD.scheduled_datetime IS NOT NULL THEN
    BEGIN
      PERFORM public.capacity_guard_open_gap(to_jsonb(OLD), NEW.job_status);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the guard must NEVER block a cancellation / no-show write
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_capacity_guard_jobs_status ON jobs;
CREATE TRIGGER trg_capacity_guard_jobs_status AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW WHEN (OLD.job_status IS DISTINCT FROM NEW.job_status)
  EXECUTE FUNCTION public.capacity_guard_jobs_status_trigger();

-- Realized revenue: when the job that filled a gap gets invoiced.
CREATE OR REPLACE FUNCTION public.capacity_guard_realized_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.invoice_amount IS NOT NULL AND NEW.invoice_amount IS DISTINCT FROM OLD.invoice_amount THEN
    UPDATE backfill_gaps SET realized_cents = round(NEW.invoice_amount * 100)::int WHERE filled_job_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_capacity_guard_realized ON jobs;
CREATE TRIGGER trg_capacity_guard_realized AFTER UPDATE OF invoice_amount ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.capacity_guard_realized_trigger();

-- First valid claim wins. Lock order: gap row -> technician row (inside book_capacity_slot). No other path locks a gap.
-- Idempotent: the same token claimed twice returns the same job.
CREATE OR REPLACE FUNCTION public.claim_backfill_offer(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer backfill_offers; v_gap backfill_gaps; v_book jsonb; v_job uuid; v_cust jsonb;
BEGIN
  SELECT * INTO v_offer FROM backfill_offers WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'invalid'); END IF;

  SELECT * INTO v_gap FROM backfill_gaps WHERE id = v_offer.gap_id FOR UPDATE;   -- serializes every claimant of this gap
  SELECT * INTO v_offer FROM backfill_offers WHERE id = v_offer.id;              -- re-read under the lock

  IF v_offer.status = 'claimed' THEN
    RETURN jsonb_build_object('status', 'claimed', 'job_id', v_offer.claimed_job_id, 'idempotent', true, 'slot_start', v_gap.slot_start);
  END IF;
  IF v_gap.status = 'filled' THEN RETURN jsonb_build_object('status', 'already_filled'); END IF;
  IF v_gap.status NOT IN ('open', 'offered') OR v_offer.status <> 'sent' THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;
  IF v_offer.expires_at IS NULL OR v_offer.expires_at <= now() OR v_gap.slot_start <= now() THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;
  IF v_gap.technician_id IS NULL THEN RETURN jsonb_build_object('status', 'unavailable'); END IF;

  BEGIN
    v_book := public.book_capacity_slot(
      v_gap.user_id, v_gap.technician_id, v_gap.slot_start, v_gap.duration_minutes,
      v_offer.customer_name, v_offer.phone_norm, NULL, v_gap.service_type, NULL, NULL, NULL,
      'Booked via instant backfill', 'backfill', NULL, '[]'::jsonb, 0, 0,
      'Instant backfill: slot freed by ' || v_gap.source_reason, jsonb_build_object('gap_id', v_gap.id, 'offer_id', v_offer.id));
  EXCEPTION WHEN exclusion_violation THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END;

  IF coalesce(v_book->>'status', '') <> 'booked' OR (v_book->>'job_id') IS NULL THEN
    RETURN jsonb_build_object('status', 'unavailable', 'detail', v_book->>'status');
  END IF;
  v_job := (v_book->>'job_id')::uuid;

  IF v_offer.customer_id IS NOT NULL THEN
    UPDATE jobs SET customer_id = v_offer.customer_id WHERE id = v_job AND user_id = v_gap.user_id AND customer_id IS NULL;
  END IF;
  UPDATE backfill_gaps SET status = 'filled', filled_job_id = v_job, filled_offer_id = v_offer.id, filled_at = now(),
         recovered_estimate_cents = v_offer.est_value_cents WHERE id = v_gap.id;
  UPDATE backfill_offers SET status = 'claimed', claimed_at = now(), claimed_job_id = v_job WHERE id = v_offer.id;
  UPDATE backfill_offers SET status = 'superseded' WHERE gap_id = v_gap.id AND id <> v_offer.id AND status IN ('queued', 'sent');
  INSERT INTO capacity_guard_events (user_id, event, detail)
  VALUES (v_gap.user_id, 'backfill_claimed', jsonb_build_object('gap_id', v_gap.id, 'offer_id', v_offer.id, 'job_id', v_job, 'candidate_type', v_offer.candidate_type, 'estimate_cents', v_offer.est_value_cents));
  RETURN jsonb_build_object('status', 'claimed', 'job_id', v_job, 'slot_start', v_gap.slot_start, 'technician_id', v_gap.technician_id);
END $$;

-- Lock down: service-role-only functions are not callable by browsers.
REVOKE ALL ON FUNCTION public.get_capacity_guard_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_capacity_guard_settings(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_campaign_reservation(text, text, numeric, text, timestamptz, timestamptz, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_capacity_guard_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_capacity_guard_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_campaign_reservation(text, text, numeric, text, timestamptz, timestamptz, jsonb, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.capacity_guard_place_holds(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capacity_guard_release_holds(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capacity_guard_consume_hold(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capacity_guard_open_gap(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_backfill_offer(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capacity_guard_jobs_status_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capacity_guard_realized_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_guard_place_holds(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.capacity_guard_release_holds(uuid, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.capacity_guard_consume_hold(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.capacity_guard_open_gap(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_backfill_offer(text) TO service_role;

-- =============================================================
-- Demand signals (weather / regional) read by capacity-guard-tick.
-- weather-surge-check writes here when it triggers (see install notes).
-- =============================================================
CREATE TABLE IF NOT EXISTS capacity_guard_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('weather', 'regional')),
  factor numeric(4,2) NOT NULL CHECK (factor BETWEEN 0.5 AND 3),
  active_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capacity_guard_signals_active ON capacity_guard_signals (user_id, active_until DESC);
ALTER TABLE capacity_guard_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_capacity_guard_signals" ON capacity_guard_signals;
CREATE POLICY "select_own_capacity_guard_signals" ON capacity_guard_signals FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.capacity_guard_record_signal(p_user_id uuid, p_source text, p_factor numeric, p_hours integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO capacity_guard_signals (user_id, source, factor, active_until)
  VALUES (p_user_id, p_source, LEAST(3, GREATEST(0.5, p_factor)), now() + make_interval(hours => LEAST(72, GREATEST(1, p_hours))));
END $$;
REVOKE ALL ON FUNCTION public.capacity_guard_record_signal(uuid, text, numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_guard_record_signal(uuid, text, numeric, integer) TO service_role;

-- Hourly-ish scheduling (requires pg_cron + pg_net, same as other Vireek crons). Uncomment and fill the URL/secret:
-- select cron.schedule('capacity-guard-backfill', '* * * * *', $$ select net.http_post(url:='https://<project>.functions.supabase.co/capacity-guard-tick?phase=backfill', headers:='{"X-Cron-Secret":"<secret>"}'::jsonb) $$);
-- select cron.schedule('capacity-guard-holds', '*/15 * * * *', $$ select net.http_post(url:='https://<project>.functions.supabase.co/capacity-guard-tick?phase=holds', headers:='{"X-Cron-Secret":"<secret>"}'::jsonb) $$);
