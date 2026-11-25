/*
  # Territory exclusivity (trade x ZIP / polygon), waiting list, contract terms, audit

  A Vireek-staff-managed commercial entitlement: at most ONE account holds a trade in a ZIP/postal area (or polygon) during a term.
  Distinct from `service_areas` (where an account is willing to work) and `territories` (circular routing zones): those are untouched.

  ## Objects
  - territory_exclusivities   : the grant. status draft | active | suspended | ended. Active AND suspended grants BLOCK others
                                (a suspension pauses the holder, it does not release the territory). Draft and ended never block.
  - territory_waitlist        : FIFO queue per trade; waiting -> offered (72 h hold, reserves the area) -> accepted -> fulfilled
                                (or declined / expired / cancelled). No notification is sent except an in-app one.
  - territory_audit_events    : append-only (UPDATE / DELETE / TRUNCATE blocked by triggers). Also mirrored to audit_log.
  - territory_find_conflicts  : overlap detection (internal). ZIP: exact code or Canadian FSA prefix. Polygon: PostgreSQL native
                                polygon && (touching borders count as overlap = conservative). ZIP-vs-polygon CANNOT be decided
                                without ZIP geometry, so it is reported as 'unverifiable_mixed' and blocks activation unless staff
                                explicitly acknowledges it (audited).
  - staff RPCs                : territory_staff_check / _create / _set_status / _update_terms / _waitlist_offer / _activate_from_waitlist
                                / _overview / _audit
  - account RPCs              : territory_waitlist_join / _cancel / _respond, territory_marketing_guard
  - service RPC               : territory_lead_decision  (for a FUTURE cross-account lead router; nothing calls it yet)

  ## Security
  Writes happen only through SECURITY DEFINER functions. Staff functions require public.is_vireek_staff(auth.uid()).
  Accounts read only their own rows (owner / admin / billing-permission via identity_is_manager()). Internal staff notes are not
  granted to accounts. Every mutating path takes pg_advisory_xact_lock('territory:<trade>') so two staff cannot both activate
  overlapping grants.

  ## Not decided here (see docs/territory/exclusivity-terms-template.md)
  Legal terms, fees, renewal mechanics: TODO(counsel) / TODO(owner). auto_renew is RECORDED but never executed; a grant past its
  term_end stops blocking and is closed by territory_expire_due().

  Requires: profiles, notifications, audit_log, public.get_account_owner_id(), public.identity_is_manager() (20270106000000),
            public.is_vireek_staff(uuid), public.log_audit_event().
  Rollback : DROP the territory_* functions, then territory_waitlist, territory_exclusivities, territory_audit_events (in that order).
*/

-- 1) Pure helpers ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.territory_norm_zip(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN x ~ '^[0-9]{9}$' THEN left(x, 5) ELSE x END
    FROM (SELECT upper(regexp_replace(btrim(coalesce(p, '')), '[ -]', '', 'g')) AS x) s;
$$;

CREATE OR REPLACE FUNCTION public.territory_zips_valid(p text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(p) z WHERE z !~ '^([0-9]{5}|[A-Z][0-9][A-Z]([0-9][A-Z][0-9])?)$');
$$;

/** A 3-character Canadian FSA covers every code under it. */
CREATE OR REPLACE FUNCTION public.territory_zip_overlap(a text, b text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT a = b OR (length(a) = 3 AND b LIKE a || '%') OR (length(b) = 3 AND a LIKE b || '%');
$$;

CREATE OR REPLACE FUNCTION public.territory_polygon_valid(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'array' AND jsonb_array_length(p) BETWEEN 3 AND 500
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p) e
        WHERE CASE
          WHEN jsonb_typeof(e) <> 'array' OR jsonb_array_length(e) <> 2 THEN true
          WHEN jsonb_typeof(e -> 0) <> 'number' OR jsonb_typeof(e -> 1) <> 'number' THEN true
          ELSE NOT ((e ->> 0)::numeric BETWEEN -90 AND 90 AND (e ->> 1)::numeric BETWEEN -180 AND 180)
        END);
$$;

/** [[lat,lng],...] -> native polygon (x = lat, y = lng). Only call with territory_polygon_valid input. */
CREATE OR REPLACE FUNCTION public.territory_polygon_from_json(p jsonb)
RETURNS polygon LANGUAGE sql IMMUTABLE AS $$
  SELECT ('(' || string_agg('(' || (e ->> 0) || ',' || (e ->> 1) || ')', ',' ORDER BY o) || ')')::polygon
    FROM jsonb_array_elements(p) WITH ORDINALITY AS t(e, o);
$$;

/** NULL = no overlap; else 'zip_overlap' | 'polygon_overlap' | 'unverifiable_mixed'. */
CREATE OR REPLACE FUNCTION public.territory_shape_overlap(
  t1 text, z1 text[], g1 jsonb, t2 text, z2 text[], g2 jsonb
) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t1 = 'zip' AND t2 = 'zip' THEN
    RETURN CASE WHEN EXISTS (SELECT 1 FROM unnest(z1) a(z) JOIN unnest(z2) b(z) ON public.territory_zip_overlap(a.z, b.z)) THEN 'zip_overlap' END;
  ELSIF t1 = 'polygon' AND t2 = 'polygon' THEN
    RETURN CASE WHEN public.territory_polygon_from_json(g1) && public.territory_polygon_from_json(g2) THEN 'polygon_overlap' END;
  END IF;
  RETURN 'unverifiable_mixed';
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_offer_hold_hours()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 72 $$; -- TODO(owner): confirm the waiting-list offer hold (hours)

-- 2) Tables ----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.territory_exclusivities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  trade text NOT NULL,
  label text NOT NULL,
  zone_type text NOT NULL,
  zip_codes text[] NOT NULL DEFAULT '{}',
  polygon jsonb,
  status text NOT NULL DEFAULT 'draft',
  term_start date NOT NULL,
  term_end date NOT NULL,
  auto_renew boolean NOT NULL DEFAULT false,
  renewal_notice_days integer,
  renewal_term_months integer,
  contract_reference text,
  fee_cents bigint,
  fee_currency text,
  legal_terms_ref text,            -- TODO(counsel): reference to the approved agreement version
  notes text,                      -- internal (staff only)
  ended_at timestamptz,
  ended_reason text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT te_trade CHECK (trade ~ '^[a-z][a-z0-9-]{1,40}$'),
  CONSTRAINT te_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  CONSTRAINT te_zone CHECK (zone_type IN ('zip', 'polygon')),
  CONSTRAINT te_zip_shape CHECK (zone_type <> 'zip' OR (cardinality(zip_codes) BETWEEN 1 AND 2000 AND public.territory_zips_valid(zip_codes) AND polygon IS NULL)),
  CONSTRAINT te_poly_shape CHECK (zone_type <> 'polygon' OR (cardinality(zip_codes) = 0 AND public.territory_polygon_valid(polygon))),
  CONSTRAINT te_status CHECK (status IN ('draft', 'active', 'suspended', 'ended')),
  CONSTRAINT te_term CHECK (term_end >= term_start AND term_start >= DATE '2020-01-01' AND term_end <= term_start + 3660),
  CONSTRAINT te_renewal CHECK ((renewal_notice_days IS NULL OR renewal_notice_days BETWEEN 0 AND 365) AND (renewal_term_months IS NULL OR renewal_term_months BETWEEN 1 AND 120)),
  CONSTRAINT te_fee CHECK ((fee_cents IS NULL OR fee_cents >= 0) AND (fee_currency IS NULL OR fee_currency ~ '^[A-Z]{3}$') AND ((fee_cents IS NULL) = (fee_currency IS NULL))),
  CONSTRAINT te_text CHECK ((contract_reference IS NULL OR char_length(contract_reference) <= 80) AND (legal_terms_ref IS NULL OR char_length(legal_terms_ref) <= 80)
                            AND (notes IS NULL OR char_length(notes) <= 1000) AND (ended_reason IS NULL OR char_length(ended_reason) <= 200)),
  CONSTRAINT te_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_te_blocking ON public.territory_exclusivities (trade, term_start, term_end) WHERE status IN ('active', 'suspended');
CREATE INDEX IF NOT EXISTS idx_te_account ON public.territory_exclusivities (account_owner_id, status);
CREATE INDEX IF NOT EXISTS idx_te_zip_codes ON public.territory_exclusivities USING gin (zip_codes);

CREATE TABLE IF NOT EXISTS public.territory_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trade text NOT NULL,
  label text NOT NULL,
  zone_type text NOT NULL,
  zip_codes text[] NOT NULL DEFAULT '{}',
  polygon jsonb,
  status text NOT NULL DEFAULT 'waiting',
  offered_at timestamptz,
  offer_expires_at timestamptz,
  decided_at timestamptz,
  exclusivity_id uuid REFERENCES public.territory_exclusivities(id) ON DELETE SET NULL,
  requested_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tw_trade CHECK (trade ~ '^[a-z][a-z0-9-]{1,40}$'),
  CONSTRAINT tw_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  CONSTRAINT tw_zone CHECK (zone_type IN ('zip', 'polygon')),
  CONSTRAINT tw_zip_shape CHECK (zone_type <> 'zip' OR (cardinality(zip_codes) BETWEEN 1 AND 2000 AND public.territory_zips_valid(zip_codes) AND polygon IS NULL)),
  CONSTRAINT tw_poly_shape CHECK (zone_type <> 'polygon' OR (cardinality(zip_codes) = 0 AND public.territory_polygon_valid(polygon))),
  CONSTRAINT tw_status CHECK (status IN ('waiting', 'offered', 'accepted', 'declined', 'expired', 'cancelled', 'fulfilled'))
);
CREATE INDEX IF NOT EXISTS idx_tw_queue ON public.territory_waitlist (trade, created_at) WHERE status IN ('waiting', 'offered');
CREATE INDEX IF NOT EXISTS idx_tw_account ON public.territory_waitlist (account_owner_id, status);

CREATE TABLE IF NOT EXISTS public.territory_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_email text,
  actor_kind text NOT NULL,
  account_owner_id uuid,
  exclusivity_id uuid,
  waitlist_id uuid,
  action text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tae_kind CHECK (actor_kind IN ('staff', 'account', 'system'))
);
CREATE INDEX IF NOT EXISTS idx_tae_time ON public.territory_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tae_account ON public.territory_audit_events (account_owner_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.territory_audit_block()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'territory_audit_events is append-only' USING ERRCODE = '42501'; END;
$$;
DROP TRIGGER IF EXISTS trg_tae_no_update ON public.territory_audit_events;
CREATE TRIGGER trg_tae_no_update BEFORE UPDATE OR DELETE ON public.territory_audit_events FOR EACH ROW EXECUTE FUNCTION public.territory_audit_block();
DROP TRIGGER IF EXISTS trg_tae_no_truncate ON public.territory_audit_events;
CREATE TRIGGER trg_tae_no_truncate BEFORE TRUNCATE ON public.territory_audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.territory_audit_block();

CREATE OR REPLACE FUNCTION public.territory_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_te_updated_at ON public.territory_exclusivities;
CREATE TRIGGER trg_te_updated_at BEFORE UPDATE ON public.territory_exclusivities FOR EACH ROW EXECUTE FUNCTION public.territory_touch_updated_at();

-- 3) RLS: read-only for clients ---------------------------------------------------------------------------------------
ALTER TABLE public.territory_exclusivities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.territory_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.territory_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS te_select ON public.territory_exclusivities;
CREATE POLICY te_select ON public.territory_exclusivities FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS tw_select ON public.territory_waitlist;
CREATE POLICY tw_select ON public.territory_waitlist FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS tae_select ON public.territory_audit_events;
CREATE POLICY tae_select ON public.territory_audit_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON public.territory_exclusivities, public.territory_waitlist, public.territory_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, account_owner_id, trade, label, zone_type, zip_codes, polygon, status, term_start, term_end, auto_renew, renewal_notice_days,
              renewal_term_months, contract_reference, fee_cents, fee_currency, legal_terms_ref, ended_at, ended_reason, created_at)
  ON public.territory_exclusivities TO authenticated;   -- NOT notes (internal)
GRANT SELECT (id, account_owner_id, trade, label, zone_type, zip_codes, polygon, status, offered_at, offer_expires_at, decided_at, exclusivity_id, created_at)
  ON public.territory_waitlist TO authenticated;
GRANT SELECT (id, occurred_at, actor_kind, account_owner_id, exclusivity_id, waitlist_id, action, reason)
  ON public.territory_audit_events TO authenticated;

-- 4) Internals --------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.territory_require_staff()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_lock(p_trade text)
RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('territory:' || p_trade, 0)); $$;

CREATE OR REPLACE FUNCTION public.territory_audit(p_account uuid, p_excl uuid, p_wait uuid, p_action text, p_reason text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO territory_audit_events (actor_id, actor_email, actor_kind, account_owner_id, exclusivity_id, waitlist_id, action, reason, details)
  VALUES (auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          CASE WHEN auth.uid() IS NULL THEN 'system' WHEN public.is_vireek_staff(auth.uid()) THEN 'staff' ELSE 'account' END,
          p_account, p_excl, p_wait, p_action, left(p_reason, 200), coalesce(p_details, '{}'::jsonb));
  IF p_account IS NOT NULL THEN
    PERFORM public.log_audit_event(p_account, 'territory.' || p_action, 'territory_exclusivities', coalesce(p_excl::text, p_wait::text),
      jsonb_build_object('reason', left(p_reason, 200)) || coalesce(p_details, '{}'::jsonb));
  END IF;
END;
$$;

/** Blocking grants (active + suspended) that overlap the candidate in space AND time. */
CREATE OR REPLACE FUNCTION public.territory_find_conflicts(
  p_trade text, p_zone_type text, p_zips text[], p_polygon jsonb, p_start date, p_end date, p_exclude uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_kind text;
  v_out jsonb := '[]'::jsonb;
  v_shared text[];
BEGIN
  FOR r IN
    SELECT e.id, e.account_owner_id, e.label, e.zone_type, e.zip_codes, e.polygon, e.status, e.term_start, e.term_end
      FROM territory_exclusivities e
     WHERE e.trade = p_trade AND e.status IN ('active', 'suspended') AND e.id IS DISTINCT FROM p_exclude
       AND daterange(e.term_start, e.term_end, '[]') && daterange(p_start, p_end, '[]')
  LOOP
    v_kind := public.territory_shape_overlap(p_zone_type, p_zips, p_polygon, r.zone_type, r.zip_codes, r.polygon);
    CONTINUE WHEN v_kind IS NULL;
    v_shared := NULL;
    IF v_kind = 'zip_overlap' THEN
      SELECT array_agg(DISTINCT a.z ORDER BY a.z) INTO v_shared FROM unnest(p_zips) a(z) JOIN unnest(r.zip_codes) b(z) ON public.territory_zip_overlap(a.z, b.z);
    END IF;
    v_out := v_out || jsonb_build_object('id', r.id, 'account_owner_id', r.account_owner_id, 'label', r.label, 'status', r.status,
      'term_start', r.term_start, 'term_end', r.term_end, 'kind', v_kind, 'shared_zips', to_jsonb(coalesce(v_shared, ARRAY[]::text[])));
  END LOOP;
  RETURN v_out;
END;
$$;

/** Normalises + validates a candidate from client JSON. Returns jsonb {trade, zone_type, zips, polygon}. */
CREATE OR REPLACE FUNCTION public.territory_parse_shape(p jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_trade text := lower(btrim(coalesce(p ->> 'trade', '')));
  v_type text := coalesce(p ->> 'zone_type', '');
  v_zips text[];
BEGIN
  IF v_trade !~ '^[a-z][a-z0-9-]{1,40}$' THEN RAISE EXCEPTION 'Invalid trade' USING ERRCODE = '22023'; END IF;
  IF v_type NOT IN ('zip', 'polygon') THEN RAISE EXCEPTION 'zone_type must be zip or polygon' USING ERRCODE = '22023'; END IF;
  IF v_type = 'zip' THEN
    IF jsonb_typeof(p -> 'zip_codes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'zip_codes must be a list' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(array_agg(DISTINCT public.territory_norm_zip(z) ORDER BY public.territory_norm_zip(z)), ARRAY[]::text[]) INTO v_zips FROM jsonb_array_elements_text(p -> 'zip_codes') z;
    IF cardinality(v_zips) NOT BETWEEN 1 AND 2000 OR NOT public.territory_zips_valid(v_zips) THEN
      RAISE EXCEPTION 'Enter 1-2000 valid US ZIP codes or Canadian postal codes / FSAs.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('trade', v_trade, 'zone_type', 'zip', 'zips', to_jsonb(v_zips), 'polygon', NULL);
  END IF;
  IF NOT public.territory_polygon_valid(p -> 'polygon') THEN RAISE EXCEPTION 'Invalid polygon (3-500 [lat,lng] points)' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object('trade', v_trade, 'zone_type', 'polygon', 'zips', '[]'::jsonb, 'polygon', p -> 'polygon');
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_jsonb_text_array(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) FROM jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) x;
$$;

-- 5) Waiting list engine ----------------------------------------------------------------------------------------------
/** Expires stale offers, then offers the FIRST waiting request (FIFO) that is free of blockers AND of other offers' reservations. */
CREATE OR REPLACE FUNCTION public.territory_offer_next(p_trade text)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w territory_waitlist%ROWTYPE;
  o territory_waitlist%ROWTYPE;
  v_blocked boolean;
  v_offered uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM public.territory_lock(p_trade);
  FOR w IN SELECT * FROM territory_waitlist WHERE trade = p_trade AND status = 'offered' AND offer_expires_at < now() ORDER BY created_at FOR UPDATE LOOP
    UPDATE territory_waitlist SET status = 'expired', decided_at = now() WHERE id = w.id;
    PERFORM public.territory_audit(w.account_owner_id, NULL, w.id, 'waitlist_offer_expired', 'offer hold elapsed');
  END LOOP;
  FOR w IN SELECT * FROM territory_waitlist WHERE trade = p_trade AND status = 'waiting' ORDER BY created_at, id FOR UPDATE LOOP
    v_blocked := jsonb_array_length(public.territory_find_conflicts(w.trade, w.zone_type, w.zip_codes, w.polygon, current_date, current_date + 364)) > 0;
    IF NOT v_blocked THEN
      FOR o IN SELECT * FROM territory_waitlist WHERE trade = p_trade AND status IN ('offered', 'accepted') LOOP
        IF public.territory_shape_overlap(w.zone_type, w.zip_codes, w.polygon, o.zone_type, o.zip_codes, o.polygon) IS NOT NULL THEN v_blocked := true; EXIT; END IF;
      END LOOP;
    END IF;
    CONTINUE WHEN v_blocked;
    UPDATE territory_waitlist SET status = 'offered', offered_at = now(), offer_expires_at = now() + make_interval(hours => public.territory_offer_hold_hours()) WHERE id = w.id;
    v_offered := v_offered || w.id;
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (w.account_owner_id, 'system', 'Your requested territory is available',
            'The territory you joined the waiting list for (' || w.label || ') is available. Accept or decline within ' || public.territory_offer_hold_hours() || ' hours.', '/dashboard/territories');
    PERFORM public.territory_audit(w.account_owner_id, NULL, w.id, 'waitlist_offered', 'territory became available', jsonb_build_object('hold_hours', public.territory_offer_hold_hours()));
  END LOOP;
  RETURN v_offered;
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_expire_due()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT id, account_owner_id, trade FROM territory_exclusivities WHERE status IN ('active', 'suspended') AND term_end < current_date ORDER BY trade LOOP
    PERFORM public.territory_lock(r.trade);
    UPDATE territory_exclusivities SET status = 'ended', ended_at = now(), ended_reason = 'term_expired' WHERE id = r.id AND status IN ('active', 'suspended');
    IF FOUND THEN
      n := n + 1;
      PERFORM public.territory_audit(r.account_owner_id, r.id, NULL, 'ended', 'term_expired');
      PERFORM public.territory_offer_next(r.trade);
    END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- 6) Staff RPCs -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.territory_staff_check(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shape jsonb;
  v_start date := (p ->> 'term_start')::date;
  v_end date := (p ->> 'term_end')::date;
BEGIN
  PERFORM public.territory_require_staff();
  v_shape := public.territory_parse_shape(p);
  IF v_start IS NULL OR v_end IS NULL OR v_end < v_start THEN RAISE EXCEPTION 'Invalid term' USING ERRCODE = '22023'; END IF;
  RETURN public.territory_find_conflicts(v_shape ->> 'trade', v_shape ->> 'zone_type', public.territory_jsonb_text_array(v_shape -> 'zips'),
           v_shape -> 'polygon', v_start, v_end, NULLIF(p ->> 'exclude_id', '')::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_set_status(p_id uuid, p_status text, p_reason text, p_acknowledge_unverifiable boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e territory_exclusivities%ROWTYPE;
  v_conf jsonb;
  v_hard integer := 0;
  v_mixed integer := 0;
  v_offered uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM public.territory_require_staff();
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 200 THEN RAISE EXCEPTION 'A reason of 5-200 characters is required.' USING ERRCODE = '22023'; END IF;
  IF p_status NOT IN ('active', 'suspended', 'ended') THEN RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023'; END IF;
  SELECT * INTO e FROM territory_exclusivities WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Territory not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.territory_lock(e.trade);
  SELECT * INTO e FROM territory_exclusivities WHERE id = p_id FOR UPDATE;

  IF NOT ((e.status = 'draft' AND p_status IN ('active', 'ended')) OR (e.status = 'active' AND p_status IN ('suspended', 'ended'))
       OR (e.status = 'suspended' AND p_status IN ('active', 'ended'))) THEN
    RAISE EXCEPTION 'Cannot change a % territory to %.', e.status, p_status USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'active' AND e.status = 'draft' THEN
    IF e.term_end < current_date THEN RAISE EXCEPTION 'The term has already ended.' USING ERRCODE = 'P0001'; END IF;
    v_conf := public.territory_find_conflicts(e.trade, e.zone_type, e.zip_codes, e.polygon, e.term_start, e.term_end, e.id);
    SELECT count(*) FILTER (WHERE c ->> 'kind' <> 'unverifiable_mixed'), count(*) FILTER (WHERE c ->> 'kind' = 'unverifiable_mixed')
      INTO v_hard, v_mixed FROM jsonb_array_elements(v_conf) c;
    IF v_hard > 0 THEN RAISE EXCEPTION 'Overlaps % existing exclusive territor%.', v_hard, CASE WHEN v_hard = 1 THEN 'y' ELSE 'ies' END USING ERRCODE = 'P0001', DETAIL = v_conf::text; END IF;
    IF v_mixed > 0 AND NOT p_acknowledge_unverifiable THEN
      RAISE EXCEPTION 'A ZIP territory and a polygon territory cannot be compared automatically. Review them and confirm to continue.' USING ERRCODE = 'P0001', DETAIL = v_conf::text;
    END IF;
  END IF;

  UPDATE territory_exclusivities
     SET status = p_status,
         ended_at = CASE WHEN p_status = 'ended' THEN now() END,
         ended_reason = CASE WHEN p_status = 'ended' THEN left(btrim(p_reason), 200) END
   WHERE id = p_id;
  PERFORM public.territory_audit(e.account_owner_id, e.id, NULL, 'status_' || p_status, btrim(p_reason),
    jsonb_build_object('from', e.status, 'to', p_status, 'acknowledged_unverifiable', coalesce(p_acknowledge_unverifiable, false) AND v_mixed > 0));
  IF p_status = 'ended' THEN v_offered := public.territory_offer_next(e.trade); END IF;
  RETURN jsonb_build_object('id', e.id, 'status', p_status, 'waitlist_offered', to_jsonb(v_offered));
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_create(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shape jsonb;
  v_id uuid := gen_random_uuid();
  v_account uuid := (p ->> 'account_owner_id')::uuid;
  v_reason text := btrim(coalesce(p ->> 'reason', ''));
  v_res jsonb;
BEGIN
  PERFORM public.territory_require_staff();
  IF char_length(v_reason) < 5 OR char_length(v_reason) > 200 THEN RAISE EXCEPTION 'A reason of 5-200 characters is required.' USING ERRCODE = '22023'; END IF;
  IF v_account IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_account) THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002'; END IF;
  v_shape := public.territory_parse_shape(p);
  PERFORM public.territory_lock(v_shape ->> 'trade');
  INSERT INTO territory_exclusivities (id, account_owner_id, trade, label, zone_type, zip_codes, polygon, term_start, term_end, auto_renew, renewal_notice_days,
      renewal_term_months, contract_reference, fee_cents, fee_currency, legal_terms_ref, notes)
  VALUES (v_id, v_account, v_shape ->> 'trade', btrim(coalesce(p ->> 'label', '')), v_shape ->> 'zone_type', public.territory_jsonb_text_array(v_shape -> 'zips'),
      v_shape -> 'polygon', (p ->> 'term_start')::date, (p ->> 'term_end')::date, coalesce((p ->> 'auto_renew')::boolean, false),
      NULLIF(p ->> 'renewal_notice_days', '')::integer, NULLIF(p ->> 'renewal_term_months', '')::integer, NULLIF(btrim(p ->> 'contract_reference'), ''),
      NULLIF(p ->> 'fee_cents', '')::bigint, NULLIF(upper(btrim(coalesce(p ->> 'fee_currency', ''))), ''), NULLIF(btrim(p ->> 'legal_terms_ref'), ''), NULLIF(btrim(p ->> 'notes'), ''));
  PERFORM public.territory_audit(v_account, v_id, NULL, 'created', v_reason, jsonb_build_object('trade', v_shape ->> 'trade', 'zone_type', v_shape ->> 'zone_type'));
  IF coalesce((p ->> 'activate')::boolean, false) THEN
    v_res := public.territory_staff_set_status(v_id, 'active', v_reason, coalesce((p ->> 'acknowledge_unverifiable')::boolean, false));
  END IF;
  RETURN jsonb_build_object('id', v_id, 'status', coalesce(v_res ->> 'status', 'draft'));
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_update_terms(p_id uuid, p jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e territory_exclusivities%ROWTYPE;
  v_end date;
  v_conf jsonb;
BEGIN
  PERFORM public.territory_require_staff();
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 OR char_length(p_reason) > 200 THEN RAISE EXCEPTION 'A reason of 5-200 characters is required.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO e FROM territory_exclusivities WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Territory not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.territory_lock(e.trade);
  SELECT * INTO e FROM territory_exclusivities WHERE id = p_id FOR UPDATE;
  IF e.status = 'ended' THEN RAISE EXCEPTION 'An ended territory cannot be edited.' USING ERRCODE = 'P0001'; END IF;
  v_end := coalesce(NULLIF(p ->> 'term_end', '')::date, e.term_end);
  IF e.status <> 'draft' AND v_end < current_date THEN RAISE EXCEPTION 'Use "end" to close a territory early.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'draft' AND v_end > e.term_end THEN
    v_conf := public.territory_find_conflicts(e.trade, e.zone_type, e.zip_codes, e.polygon, e.term_end + 1, v_end, e.id);
    IF jsonb_array_length(v_conf) > 0 THEN RAISE EXCEPTION 'Extending the term would overlap another exclusive territory.' USING ERRCODE = 'P0001', DETAIL = v_conf::text; END IF;
  END IF;
  UPDATE territory_exclusivities SET
    term_start = CASE WHEN e.status = 'draft' THEN coalesce(NULLIF(p ->> 'term_start', '')::date, term_start) ELSE term_start END,
    term_end = v_end,
    auto_renew = coalesce((p ->> 'auto_renew')::boolean, auto_renew),
    renewal_notice_days = CASE WHEN p ? 'renewal_notice_days' THEN NULLIF(p ->> 'renewal_notice_days', '')::integer ELSE renewal_notice_days END,
    renewal_term_months = CASE WHEN p ? 'renewal_term_months' THEN NULLIF(p ->> 'renewal_term_months', '')::integer ELSE renewal_term_months END,
    contract_reference = CASE WHEN p ? 'contract_reference' THEN NULLIF(btrim(p ->> 'contract_reference'), '') ELSE contract_reference END,
    fee_cents = CASE WHEN p ? 'fee_cents' THEN NULLIF(p ->> 'fee_cents', '')::bigint ELSE fee_cents END,
    fee_currency = CASE WHEN p ? 'fee_currency' THEN NULLIF(upper(btrim(p ->> 'fee_currency')), '') ELSE fee_currency END,
    legal_terms_ref = CASE WHEN p ? 'legal_terms_ref' THEN NULLIF(btrim(p ->> 'legal_terms_ref'), '') ELSE legal_terms_ref END,
    notes = CASE WHEN p ? 'notes' THEN NULLIF(btrim(p ->> 'notes'), '') ELSE notes END
  WHERE id = p_id;
  PERFORM public.territory_audit(e.account_owner_id, e.id, NULL, 'terms_updated', btrim(p_reason),
    jsonb_build_object('before', jsonb_build_object('term_end', e.term_end, 'auto_renew', e.auto_renew, 'fee_cents', e.fee_cents, 'contract_reference', e.contract_reference),
                       'after', jsonb_build_object('term_end', v_end)));
  RETURN jsonb_build_object('id', p_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_waitlist_offer(p_trade text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_expired integer; v_offered uuid[];
BEGIN
  PERFORM public.territory_require_staff();
  IF p_trade IS NULL OR p_trade !~ '^[a-z][a-z0-9-]{1,40}$' THEN RAISE EXCEPTION 'Invalid trade' USING ERRCODE = '22023'; END IF;
  v_expired := public.territory_expire_due();
  v_offered := public.territory_offer_next(p_trade);
  RETURN jsonb_build_object('expired_terms', v_expired, 'offered', to_jsonb(v_offered));
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_activate_from_waitlist(p_waitlist_id uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w territory_waitlist%ROWTYPE;
  v_res jsonb;
BEGIN
  PERFORM public.territory_require_staff();
  SELECT * INTO w FROM territory_waitlist WHERE id = p_waitlist_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Waiting-list entry not found' USING ERRCODE = 'P0002'; END IF;
  IF w.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted offer can become a territory.' USING ERRCODE = 'P0001'; END IF;
  v_res := public.territory_staff_create(coalesce(p, '{}'::jsonb) || jsonb_build_object(
    'account_owner_id', w.account_owner_id, 'trade', w.trade, 'label', w.label, 'zone_type', w.zone_type,
    'zip_codes', to_jsonb(w.zip_codes), 'polygon', w.polygon, 'activate', true));
  UPDATE territory_waitlist SET status = 'fulfilled', exclusivity_id = (v_res ->> 'id')::uuid, decided_at = now() WHERE id = w.id;
  PERFORM public.territory_audit(w.account_owner_id, (v_res ->> 'id')::uuid, w.id, 'waitlist_fulfilled', coalesce(p ->> 'reason', 'waiting-list offer accepted'));
  RETURN v_res;
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_overview()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.territory_require_staff();
  PERFORM public.territory_expire_due();
  RETURN jsonb_build_object(
    'exclusivities', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.trade, x.term_start DESC) FROM (
        SELECT e.id, e.account_owner_id, coalesce(nullif(btrim(p.company_name), ''), 'Unnamed account') AS account_name, e.trade, e.label, e.zone_type, e.zip_codes,
               e.status, e.term_start, e.term_end, e.auto_renew, e.renewal_notice_days, e.renewal_term_months, e.contract_reference, e.fee_cents, e.fee_currency,
               e.legal_terms_ref, e.notes, e.ended_at, e.ended_reason, (e.term_end - current_date) AS days_left,
               CASE WHEN e.polygon IS NULL THEN NULL ELSE jsonb_array_length(e.polygon) END AS polygon_points
          FROM territory_exclusivities e JOIN profiles p ON p.id = e.account_owner_id
         ORDER BY e.created_at DESC LIMIT 500) x), '[]'::jsonb),
    'waitlist', coalesce((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.trade, y.created_at) FROM (
        SELECT w.id, w.account_owner_id, coalesce(nullif(btrim(p.company_name), ''), 'Unnamed account') AS account_name, w.trade, w.label, w.zone_type, w.zip_codes,
               w.status, w.offered_at, w.offer_expires_at, w.created_at,
               (w.status = 'waiting' AND jsonb_array_length(public.territory_find_conflicts(w.trade, w.zone_type, w.zip_codes, w.polygon, current_date, current_date + 364)) = 0) AS available_now
          FROM territory_waitlist w JOIN profiles p ON p.id = w.account_owner_id
         WHERE w.status IN ('waiting', 'offered', 'accepted')
         ORDER BY w.created_at LIMIT 500) y), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_staff_audit(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.territory_require_staff();
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.occurred_at DESC) FROM (
    SELECT t.id, t.occurred_at, t.actor_kind, t.actor_email, t.account_owner_id, coalesce(nullif(btrim(p.company_name), ''), 'Unnamed account') AS account_name,
           t.exclusivity_id, t.waitlist_id, t.action, t.reason, t.details
      FROM territory_audit_events t LEFT JOIN profiles p ON p.id = t.account_owner_id
     ORDER BY t.occurred_at DESC LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) a), '[]'::jsonb);
END;
$$;

-- 7) Account RPCs -----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.territory_waitlist_join(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_shape jsonb;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'Only an owner or admin can join the waiting list.' USING ERRCODE = '42501'; END IF;
  v_shape := public.territory_parse_shape(p);
  IF char_length(btrim(coalesce(p ->> 'label', ''))) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Give the request a short name.' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) FROM territory_waitlist WHERE account_owner_id = v_owner AND status IN ('waiting', 'offered', 'accepted')) >= 10 THEN
    RAISE EXCEPTION 'You can have at most 10 open waiting-list requests.' USING ERRCODE = '54000';
  END IF;
  PERFORM public.territory_lock(v_shape ->> 'trade');
  INSERT INTO territory_waitlist (account_owner_id, trade, label, zone_type, zip_codes, polygon)
  VALUES (v_owner, v_shape ->> 'trade', btrim(p ->> 'label'), v_shape ->> 'zone_type', public.territory_jsonb_text_array(v_shape -> 'zips'), v_shape -> 'polygon')
  RETURNING id INTO v_id;
  PERFORM public.territory_audit(v_owner, NULL, v_id, 'waitlist_joined', 'requested by account');
  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_waitlist_cancel(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w territory_waitlist%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'Only an owner or admin can change the waiting list.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO w FROM territory_waitlist WHERE id = p_id AND account_owner_id = v_owner AND status IN ('waiting', 'offered') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.territory_lock(w.trade);
  UPDATE territory_waitlist SET status = 'cancelled', decided_at = now() WHERE id = p_id;
  PERFORM public.territory_audit(v_owner, NULL, p_id, 'waitlist_cancelled', 'cancelled by account');
  IF w.status = 'offered' THEN PERFORM public.territory_offer_next(w.trade); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.territory_waitlist_respond(p_id uuid, p_accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w territory_waitlist%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'Only an owner or admin can respond.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO w FROM territory_waitlist WHERE id = p_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR w.status <> 'offered' THEN RAISE EXCEPTION 'There is no open offer to respond to.' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.territory_lock(w.trade);
  IF w.offer_expires_at < now() THEN
    UPDATE territory_waitlist SET status = 'expired', decided_at = now() WHERE id = p_id;
    PERFORM public.territory_audit(v_owner, NULL, p_id, 'waitlist_offer_expired', 'response after the hold elapsed');
    PERFORM public.territory_offer_next(w.trade);
    RAISE EXCEPTION 'This offer has expired.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE territory_waitlist SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, decided_at = now() WHERE id = p_id;
  PERFORM public.territory_audit(v_owner, NULL, p_id, CASE WHEN p_accept THEN 'waitlist_accepted' ELSE 'waitlist_declined' END, 'responded by account');
  IF NOT p_accept THEN PERFORM public.territory_offer_next(w.trade); END IF;
  RETURN jsonb_build_object('id', p_id, 'status', CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END);
END;
$$;

-- 8) Effect on lead routing / marketing -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.territory_holder_for(p_trade text, p_zip text, p_lat double precision, p_lng double precision, p_on date DEFAULT current_date)
RETURNS TABLE (id uuid, account_owner_id uuid, status text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.account_owner_id, e.status
    FROM territory_exclusivities e
   WHERE e.trade = p_trade AND e.status IN ('active', 'suspended') AND p_on BETWEEN e.term_start AND e.term_end
     AND ((e.zone_type = 'zip' AND p_zip IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(e.zip_codes) z WHERE public.territory_zip_overlap(z, public.territory_norm_zip(p_zip))))
       OR (e.zone_type = 'polygon' AND p_lat IS NOT NULL AND p_lng IS NOT NULL AND point(p_lat, p_lng) <@ public.territory_polygon_from_json(e.polygon)))
   ORDER BY e.term_start, e.id LIMIT 1;
$$;

/** For a future cross-account lead router (service role). allow | allow_holder | blocked_other_holder | hold_suspended_holder. */
CREATE OR REPLACE FUNCTION public.territory_lead_decision(p_account uuid, p_trade text, p_zip text, p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE h record;
BEGIN
  SELECT * INTO h FROM public.territory_holder_for(p_trade, p_zip, p_lat, p_lng);
  IF NOT FOUND THEN RETURN jsonb_build_object('decision', 'allow', 'reason', 'no_exclusive_holder'); END IF;
  IF h.account_owner_id = p_account THEN
    RETURN jsonb_build_object('decision', CASE WHEN h.status = 'suspended' THEN 'hold_suspended_holder' ELSE 'allow_holder' END, 'reason', 'holder', 'exclusivity_id', h.id);
  END IF;
  RETURN jsonb_build_object('decision', 'blocked_other_holder', 'reason', 'territory_reserved', 'holder_account_id', h.account_owner_id, 'exclusivity_id', h.id);
END;
$$;

/** An account asks which of its marketing ZIPs are exclusively held by SOMEONE ELSE. Never reveals who. */
CREATE OR REPLACE FUNCTION public.territory_marketing_guard(p_trade text, p_zips text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_norm text[];
  v_blocked text[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF p_trade IS NULL OR p_trade !~ '^[a-z][a-z0-9-]{1,40}$' THEN RAISE EXCEPTION 'Invalid trade' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(array_agg(DISTINCT public.territory_norm_zip(z)), ARRAY[]::text[]) INTO v_norm FROM unnest(coalesce(p_zips, ARRAY[]::text[])) z;
  IF cardinality(v_norm) > 500 OR NOT public.territory_zips_valid(v_norm) THEN RAISE EXCEPTION 'Enter up to 500 valid ZIP / postal codes.' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(array_agg(z ORDER BY z), ARRAY[]::text[]) INTO v_blocked
    FROM unnest(v_norm) z
   WHERE EXISTS (SELECT 1 FROM public.territory_holder_for(p_trade, z, NULL, NULL) h WHERE h.account_owner_id <> v_owner);
  RETURN jsonb_build_object('checked', cardinality(v_norm), 'blocked_zips', to_jsonb(v_blocked));
END;
$$;

-- 9) Grants -----------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.territory_require_staff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_lock(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_audit(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_find_conflicts(text, text, text[], jsonb, date, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_offer_next(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_expire_due() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_holder_for(text, text, double precision, double precision, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.territory_lead_decision(uuid, text, text, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.territory_expire_due() TO service_role;
GRANT EXECUTE ON FUNCTION public.territory_lead_decision(uuid, text, text, double precision, double precision) TO service_role;

REVOKE ALL ON FUNCTION public.territory_staff_check(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_set_status(uuid, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_create(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_update_terms(uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_waitlist_offer(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_activate_from_waitlist(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_staff_audit(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_waitlist_join(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_waitlist_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_waitlist_respond(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.territory_marketing_guard(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.territory_staff_check(jsonb), public.territory_staff_set_status(uuid, text, text, boolean), public.territory_staff_create(jsonb),
  public.territory_staff_update_terms(uuid, jsonb, text), public.territory_staff_waitlist_offer(text), public.territory_staff_activate_from_waitlist(uuid, jsonb),
  public.territory_staff_overview(), public.territory_staff_audit(integer), public.territory_waitlist_join(jsonb), public.territory_waitlist_cancel(uuid),
  public.territory_waitlist_respond(uuid, boolean), public.territory_marketing_guard(text, text[]) TO authenticated;
