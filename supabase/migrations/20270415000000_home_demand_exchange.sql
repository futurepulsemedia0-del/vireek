-- Home Demand Exchange
--
-- Turns signals Vireek already collects (equipment health, predicted failures,
-- weather surges, warranties, permits, rebates, prediction-mesh events,
-- property condition) into qualified, ranked service demand, and hands each
-- opportunity to the EXISTING systems — Leads, Quotes, Jobs, Dispatch
-- (assign_technician_to_job) and Capacity Exchange (post_network_handoff).
-- Nothing here duplicates those systems: this migration only adds the
-- opportunity ledger and three transactional RPCs.
--
-- Additive only: no existing table, column or policy is modified.
-- Clients can READ their opportunities; every write goes through an RPC.

-- =============================================================
-- OPPORTUNITIES
-- =============================================================
CREATE TABLE IF NOT EXISTS home_demand_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  source_kind text NOT NULL CHECK (source_kind IN (
    'property_condition', 'equipment_health', 'predicted_failure', 'weather',
    'warranty', 'permit', 'rebate', 'event'
  )),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 120),
  scope text NOT NULL DEFAULT 'property' CHECK (scope IN ('property', 'market')),

  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,

  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 1000),
  trade_category text NOT NULL CHECK (trade_category IN (
    'hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general'
  )),
  service_label text NOT NULL CHECK (char_length(service_label) BETWEEN 2 AND 80),
  skill text CHECK (skill IS NULL OR skill ~ '^[a-z0-9_]{2,40}$'),
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 120),
  address text CHECK (address IS NULL OR char_length(address) <= 300),

  urgency text NOT NULL CHECK (urgency IN ('low', 'medium', 'high', 'critical')),
  demand_score smallint NOT NULL CHECK (demand_score BETWEEN 0 AND 100),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  est_value_cents integer NOT NULL DEFAULT 0 CHECK (est_value_cents >= 0),
  est_margin_pct numeric(5,2) CHECK (est_margin_pct IS NULL OR est_margin_pct BETWEEN -100 AND 100),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,

  qualified boolean NOT NULL DEFAULT false,
  qualification jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification) = 'array'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  best_match jsonb CHECK (best_match IS NULL OR jsonb_typeof(best_match) = 'object'),

  status text NOT NULL DEFAULT 'detected' CHECK (status IN (
    'detected', 'qualified', 'matched', 'converted', 'dismissed', 'expired'
  )),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  handoff_id uuid REFERENCES network_handoffs(id) ON DELETE SET NULL,
  dismissed_reason text CHECK (dismissed_reason IS NULL OR char_length(dismissed_reason) <= 300),
  converted_at timestamptz,

  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT home_demand_opportunities_window CHECK (window_end >= window_start),
  CONSTRAINT home_demand_opportunities_unique_key UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_hdo_user_status_score
  ON home_demand_opportunities (user_id, status, demand_score DESC);
CREATE INDEX IF NOT EXISTS idx_hdo_user_customer
  ON home_demand_opportunities (user_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hdo_lead ON home_demand_opportunities (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hdo_job ON home_demand_opportunities (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE home_demand_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_demand_opportunities" ON home_demand_opportunities;
CREATE POLICY "select_own_home_demand_opportunities" ON home_demand_opportunities
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE ALL ON home_demand_opportunities FROM anon, authenticated;
GRANT SELECT ON home_demand_opportunities TO authenticated;

CREATE OR REPLACE FUNCTION public.hde_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hdo_touch ON home_demand_opportunities;
CREATE TRIGGER trg_hdo_touch BEFORE UPDATE ON home_demand_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.hde_touch_updated_at();

-- =============================================================
-- EVENT LEDGER (audit trail of every state change)
-- =============================================================
CREATE TABLE IF NOT EXISTS home_demand_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES home_demand_opportunities(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'detected', 'matched', 'converted', 'dismissed', 'reopened', 'handoff_linked', 'expired'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  actor_id uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hde_opportunity ON home_demand_events (opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hde_user_created ON home_demand_events (user_id, created_at DESC);

ALTER TABLE home_demand_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_demand_events" ON home_demand_events;
CREATE POLICY "select_own_home_demand_events" ON home_demand_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE ALL ON home_demand_events FROM anon, authenticated;
GRANT SELECT ON home_demand_events TO authenticated;

-- =============================================================
-- RPC 1 — sync a scan's candidates (idempotent)
--   * inserts new opportunities, refreshes OPEN ones
--   * never touches converted / dismissed rows
--   * expires open rows whose source was scanned but no longer detects them
-- =============================================================
CREATE OR REPLACE FUNCTION public.sync_home_demand_opportunities(
  p_items jsonb,
  p_scanned_sources text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_expired integer := 0;
  v_seen text[] := '{}';
  v_key text;
  v_customer uuid;
  v_site uuid;
  v_equipment uuid;
  v_qualified boolean;
  v_id uuid;
  v_inserted boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_ITEMS'; END IF;
  IF jsonb_array_length(p_items) > 300 THEN RAISE EXCEPTION 'TOO_MANY_ITEMS'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_key := left(btrim(coalesce(v_item->>'dedupe_key', '')), 200);
      IF char_length(v_key) < 3 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      v_seen := array_append(v_seen, v_key);

      v_customer := NULLIF(v_item->>'customer_id', '')::uuid;
      v_site := NULLIF(v_item->>'site_id', '')::uuid;
      v_equipment := NULLIF(v_item->>'equipment_id', '')::uuid;

      -- Never trust ids from the client: they must belong to this account.
      IF v_customer IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM customers c WHERE c.id = v_customer AND c.user_id = v_owner
      ) THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      IF v_site IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM customer_sites s WHERE s.id = v_site AND s.user_id = v_owner
      ) THEN v_site := NULL; END IF;
      IF v_equipment IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM equipment e WHERE e.id = v_equipment AND e.user_id = v_owner
      ) THEN v_equipment := NULL; END IF;

      v_qualified := coalesce((v_item->>'qualified')::boolean, false)
                     AND coalesce(v_item->>'scope', 'property') = 'property';
      v_inserted := NULL;
      v_id := NULL;

      INSERT INTO home_demand_opportunities AS o (
        user_id, dedupe_key, source_kind, source_ref, scope,
        customer_id, customer_name, site_id, equipment_id,
        title, summary, trade_category, service_label, skill, location_label, address,
        urgency, demand_score, confidence, est_value_cents, est_margin_pct,
        window_start, window_end, qualified, qualification, evidence, status
      ) VALUES (
        v_owner, v_key, v_item->>'source_kind', left(v_item->>'source_ref', 120),
        coalesce(v_item->>'scope', 'property'),
        v_customer, left(v_item->>'customer_name', 200), v_site, v_equipment,
        left(btrim(v_item->>'title'), 160), left(v_item->>'summary', 1000),
        v_item->>'trade_category', left(btrim(v_item->>'service_label'), 80),
        NULLIF(v_item->>'skill', ''), left(v_item->>'location_label', 120), left(v_item->>'address', 300),
        v_item->>'urgency',
        GREATEST(0, LEAST(100, round((v_item->>'demand_score')::numeric)))::smallint,
        GREATEST(0, LEAST(1, (v_item->>'confidence')::numeric)),
        GREATEST(0, LEAST(2000000000, round((v_item->>'est_value_cents')::numeric)))::integer,
        CASE WHEN v_item->>'est_margin_pct' IS NULL THEN NULL
             ELSE GREATEST(-100, LEAST(100, (v_item->>'est_margin_pct')::numeric)) END,
        (v_item->>'window_start')::timestamptz, (v_item->>'window_end')::timestamptz,
        v_qualified,
        CASE WHEN jsonb_typeof(v_item->'qualification') = 'array' THEN v_item->'qualification' ELSE '[]'::jsonb END,
        CASE WHEN jsonb_typeof(v_item->'evidence') = 'array' THEN v_item->'evidence' ELSE '[]'::jsonb END,
        CASE WHEN v_qualified THEN 'qualified' ELSE 'detected' END
      )
      ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        location_label = EXCLUDED.location_label,
        address = EXCLUDED.address,
        urgency = EXCLUDED.urgency,
        demand_score = EXCLUDED.demand_score,
        confidence = EXCLUDED.confidence,
        est_value_cents = EXCLUDED.est_value_cents,
        est_margin_pct = EXCLUDED.est_margin_pct,
        window_start = EXCLUDED.window_start,
        window_end = EXCLUDED.window_end,
        qualified = EXCLUDED.qualified,
        qualification = EXCLUDED.qualification,
        evidence = EXCLUDED.evidence,
        status = CASE
          WHEN o.status = 'matched' AND EXCLUDED.qualified THEN 'matched'
          WHEN EXCLUDED.qualified THEN 'qualified'
          ELSE 'detected' END
      WHERE o.status IN ('detected', 'qualified', 'matched')
      RETURNING o.id, (xmax = 0) INTO v_id, v_inserted;

      IF v_id IS NULL THEN
        NULL; -- row exists but is converted / dismissed / expired: left untouched
      ELSIF v_inserted THEN
        v_created := v_created + 1;
        INSERT INTO home_demand_events (user_id, opportunity_id, action, detail)
        VALUES (v_owner, v_id, 'detected', jsonb_build_object('source_kind', v_item->>'source_kind'));
      ELSE
        v_updated := v_updated + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  UPDATE home_demand_opportunities o
     SET status = 'expired'
   WHERE o.user_id = v_owner
     AND o.status IN ('detected', 'qualified', 'matched')
     AND (
       o.window_end < now()
       OR (o.source_kind = ANY (coalesce(p_scanned_sources, '{}')) AND NOT (o.dedupe_key = ANY (v_seen)))
     );
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'expired', v_expired);
END;
$$;

-- =============================================================
-- RPC 2 — state changes (match snapshot, dismiss, reopen, handoff link)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_home_demand_status(
  p_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_handoff_id uuid DEFAULT NULL,
  p_best_match jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_opp home_demand_opportunities%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF coalesce(p_action, '') NOT IN ('match', 'dismiss', 'reopen', 'link_handoff') THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  SELECT * INTO v_opp FROM home_demand_opportunities WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;

  IF p_action = 'reopen' THEN
    IF v_opp.status <> 'dismissed' THEN RAISE EXCEPTION 'NOT_DISMISSED'; END IF;
    UPDATE home_demand_opportunities
       SET status = CASE WHEN qualified THEN 'qualified' ELSE 'detected' END, dismissed_reason = NULL
     WHERE id = p_id;
    INSERT INTO home_demand_events (user_id, opportunity_id, action) VALUES (v_owner, p_id, 'reopened');
    RETURN;
  END IF;

  IF v_opp.status NOT IN ('detected', 'qualified', 'matched') THEN RAISE EXCEPTION 'NOT_OPEN'; END IF;

  IF p_action = 'dismiss' THEN
    UPDATE home_demand_opportunities
       SET status = 'dismissed', dismissed_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     WHERE id = p_id;
    INSERT INTO home_demand_events (user_id, opportunity_id, action, detail)
    VALUES (v_owner, p_id, 'dismissed', jsonb_build_object('reason', left(coalesce(p_reason, ''), 300)));

  ELSIF p_action = 'match' THEN
    IF p_best_match IS NULL OR jsonb_typeof(p_best_match) <> 'object' OR length(p_best_match::text) > 4000 THEN
      RAISE EXCEPTION 'INVALID_MATCH';
    END IF;
    UPDATE home_demand_opportunities
       SET best_match = p_best_match,
           status = CASE WHEN qualified THEN 'matched' ELSE status END
     WHERE id = p_id;
    INSERT INTO home_demand_events (user_id, opportunity_id, action, detail)
    VALUES (v_owner, p_id, 'matched', jsonb_build_object('route', p_best_match->>'route'));

  ELSE -- link_handoff
    IF p_handoff_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM network_handoffs h WHERE h.id = p_handoff_id AND h.user_id = v_owner
    ) THEN RAISE EXCEPTION 'HANDOFF_NOT_FOUND'; END IF;
    UPDATE home_demand_opportunities SET handoff_id = p_handoff_id WHERE id = p_id;
    INSERT INTO home_demand_events (user_id, opportunity_id, action, detail)
    VALUES (v_owner, p_id, 'handoff_linked', jsonb_build_object('handoff_id', p_handoff_id));
  END IF;
END;
$$;

-- =============================================================
-- RPC 3 — convert into the existing Leads / Quotes / Jobs (one transaction)
--   Idempotent: re-running reuses the lead / quote / job already linked.
--   Technician assignment stays with the existing assign_technician_to_job
--   RPC so capacity locking is not re-implemented here.
-- =============================================================
CREATE OR REPLACE FUNCTION public.convert_home_demand_opportunity(
  p_id uuid,
  p_create_quote boolean DEFAULT false,
  p_create_job boolean DEFAULT false,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_duration_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_opp home_demand_opportunities%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_lead uuid;
  v_quote uuid;
  v_job uuid;
  v_duration integer := GREATEST(15, LEAST(1440, coalesce(p_duration_minutes, 60)));
  v_note text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO v_opp FROM home_demand_opportunities WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_opp.status IN ('dismissed', 'expired') THEN RAISE EXCEPTION 'NOT_OPEN'; END IF;
  IF v_opp.scope <> 'property' OR v_opp.customer_id IS NULL THEN RAISE EXCEPTION 'NOT_CONVERTIBLE'; END IF;

  SELECT * INTO v_cust FROM customers WHERE id = v_opp.customer_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;

  IF p_create_job AND p_scheduled_at IS NULL AND v_opp.job_id IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_REQUIRED';
  END IF;

  v_note := left('Detected by Home Demand Exchange: ' || v_opp.title ||
                 CASE WHEN v_opp.summary IS NOT NULL THEN '. ' || v_opp.summary ELSE '' END, 1000);

  -- Lead
  v_lead := v_opp.lead_id;
  IF v_lead IS NULL OR NOT EXISTS (SELECT 1 FROM leads WHERE id = v_lead AND user_id = v_owner) THEN
    INSERT INTO leads (user_id, customer_id, name, phone, email, service_interested, notes, stage)
    VALUES (v_owner, v_cust.id, v_cust.name, v_cust.phone, v_cust.email, v_opp.service_label, v_note, 'new')
    RETURNING id INTO v_lead;
  END IF;

  -- Quote (draft only — the owner reviews and sends it from Quotes)
  v_quote := v_opp.quote_id;
  IF p_create_quote AND (v_quote IS NULL OR NOT EXISTS (SELECT 1 FROM quotes WHERE id = v_quote AND user_id = v_owner)) THEN
    INSERT INTO quotes (user_id, lead_id, customer_id, customer_name, customer_phone, customer_email,
                        line_items, tax_percent, status, valid_until, source)
    VALUES (v_owner, v_lead, v_cust.id, v_cust.name, v_cust.phone, v_cust.email,
            jsonb_build_array(jsonb_build_object(
              'description', v_opp.service_label, 'quantity', 1, 'unit_price_cents', v_opp.est_value_cents)),
            0, 'draft', (CURRENT_DATE + 30), 'home_demand_exchange')
    RETURNING id INTO v_quote;
  END IF;

  -- Job
  v_job := v_opp.job_id;
  IF p_create_job AND (v_job IS NULL OR NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = v_owner)) THEN
    INSERT INTO jobs (user_id, lead_id, customer_id, site_id, customer_name, customer_phone,
                      service_type, address, scheduled_datetime, duration_minutes, job_status)
    VALUES (v_owner, v_lead, v_cust.id, v_opp.site_id, v_cust.name, v_cust.phone,
            v_opp.service_label, coalesce(v_opp.address, v_cust.address), p_scheduled_at, v_duration, 'scheduled')
    RETURNING id INTO v_job;
  END IF;

  UPDATE home_demand_opportunities
     SET lead_id = v_lead, quote_id = v_quote, job_id = v_job,
         status = 'converted', converted_at = coalesce(converted_at, now())
   WHERE id = p_id;

  INSERT INTO home_demand_events (user_id, opportunity_id, action, detail)
  VALUES (v_owner, p_id, 'converted',
          jsonb_build_object('lead_id', v_lead, 'quote_id', v_quote, 'job_id', v_job));

  RETURN jsonb_build_object('lead_id', v_lead, 'quote_id', v_quote, 'job_id', v_job);
END;
$$;

REVOKE ALL ON FUNCTION
  public.sync_home_demand_opportunities(jsonb, text[]),
  public.set_home_demand_status(uuid, text, text, uuid, jsonb),
  public.convert_home_demand_opportunity(uuid, boolean, boolean, timestamptz, integer)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.sync_home_demand_opportunities(jsonb, text[]),
  public.set_home_demand_status(uuid, text, text, uuid, jsonb),
  public.convert_home_demand_opportunity(uuid, boolean, boolean, timestamptz, integer)
TO authenticated;

COMMENT ON TABLE home_demand_opportunities IS
  'Home Demand Exchange ledger: qualified service demand detected from existing signals. Read-only for clients; written only by sync/set/convert RPCs.';
COMMENT ON TABLE home_demand_events IS
  'Append-only audit trail for home_demand_opportunities state changes.';
