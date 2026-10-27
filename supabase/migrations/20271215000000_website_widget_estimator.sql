/*
  # Instant price estimator — 4th Website Widget type ("estimator")

  Lets an account embed an instant-price estimator on its OWN website with the same one-line <script> as the
  booking / quote / reviews widgets. Visitors pick a published service, adjust quantity / urgency, see a price
  immediately (or after leaving contact details when `gate_price` is on) and can request the exact quote, which lands
  in `leads` (source = 'website_estimator_widget') together with the estimate they were shown.

  Prices come LIVE from the price book (`price_book_items`), so website prices can never drift from the price book
  (including rows synced from ServiceTitan / Jobber / Housecall Pro). Only services the account explicitly published in
  the widget options are exposed, and only: name, description, pricing model, price, unit. Cost basis, margin, tax class
  and external ids never leave the database.

  Reuses (does not modify) the website_widgets tables, RLS, stats, host/domain checks, honeypot and rate-limit design
  of 20271021000000_website_widgets.sql. Requires that migration plus: profiles, price_book_items, leads.

  ## Objects
  - ww_type_check                         : widened to allow 'estimator' (keeps every existing allowed value).
  - website_widget_money()                : internal - cents -> '$1,234.50' for lead notes.
  - website_widget_estimate()             : internal - THE price maths (mirrored in public/website-widgets.js and
                                            src/lib/websiteEstimator.ts - keep all three identical).
  - website_widget_estimator_rules()      : internal - normalises estimator options (bounds, booleans).
  - website_widget_payload_base()         : the previous website_widget_payload (renamed, untouched).
  - website_widget_payload()              : wrapper - 'estimator' handled here, every other type delegates to _base.
  - submit_website_widget_estimate        : anon - validated, rate-limited lead + SERVER-side recomputed estimate.
  - preview_website_widget_data           : replaced only to accept the 'estimator' type (same behaviour otherwise).

  ## Security notes
  - The visitor never supplies a price: the RPC receives only the service id, quantity and urgent flag and recomputes
    the estimate from the price book. The id must also be in the widget's published list.
  - Anonymous users still get NO table access; only SECURITY DEFINER RPCs. Same domain allow-list, honeypot and
    30-requests-per-10-minutes cap as the quote widget. Conversions are counted server-side.
  - Idempotent: safe to run more than once.
*/

-- 1) Allow the new widget type (keeps every value the constraint already allows) ------------------------
DO $$
DECLARE
  v_def text;
  v_types text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.website_widgets'::regclass AND c.conname = 'ww_type_check';

  IF v_def IS NULL OR position('''estimator''' IN v_def) = 0 THEN
    SELECT coalesce(array_agg(DISTINCT s.t), '{}'::text[]) INTO v_types
    FROM (
      SELECT (regexp_matches(coalesce(v_def, ''), '''([a-z_]+)''', 'g'))[1] AS t
      UNION
      SELECT unnest(ARRAY['booking', 'quote', 'reviews', 'estimator']) AS t
      UNION
      SELECT widget_type AS t FROM public.website_widgets
    ) s;

    ALTER TABLE public.website_widgets DROP CONSTRAINT IF EXISTS ww_type_check;
    EXECUTE format(
      'ALTER TABLE public.website_widgets ADD CONSTRAINT ww_type_check CHECK (widget_type IN (%s))',
      (SELECT string_agg(quote_literal(x), ', ' ORDER BY x) FROM unnest(v_types) AS x)
    );
  END IF;
END
$$;

-- 2) Internal helpers ------------------------------------------------------------------------------------
-- 12345 -> '$123.45', 45000 -> '$450'. Comma / period in to_char patterns are locale independent.
CREATE OR REPLACE FUNCTION public.website_widget_money(p_cents bigint)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT '$' || CASE
    WHEN coalesce(p_cents, 0) % 100 = 0 THEN to_char(coalesce(p_cents, 0) / 100, 'FM999,999,999,990')
    ELSE to_char(p_cents / 100.0, 'FM999,999,999,990.00')
  END;
$$;
REVOKE ALL ON FUNCTION public.website_widget_money(bigint) FROM PUBLIC, anon, authenticated;

-- The one source of truth for the number a visitor sees. Integer cents, round-half-up.
--   starting_at -> open-ended 'from'   range -> low..high   flat / hourly -> exact or +/-spread%
--   urgency surcharge multiplies both ends.
CREATE OR REPLACE FUNCTION public.website_widget_estimate(
  p_model text,
  p_price bigint,
  p_price_max bigint,
  p_qty integer,
  p_urgent boolean,
  p_urgency_pct integer,
  p_spread_pct integer
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_price bigint := least(greatest(coalesce(p_price, 0), 0), 100000000);
  v_max bigint := least(greatest(coalesce(p_price_max, p_price, 0), 0), 100000000);
  v_qty bigint := least(greatest(coalesce(p_qty, 1), 1), 20);
  v_spread bigint := least(greatest(coalesce(p_spread_pct, 0), 0), 40);
  v_pct bigint := CASE WHEN coalesce(p_urgent, false) THEN least(greatest(coalesce(p_urgency_pct, 0), 0), 100) ELSE 0 END;
  v_low bigint;
  v_high bigint;
  v_kind text;
BEGIN
  IF p_model = 'starting_at' THEN
    v_low := v_price * v_qty;
    v_high := NULL;
    v_kind := 'from';
  ELSIF p_model = 'range' THEN
    v_low := v_price * v_qty;
    v_high := greatest(v_max, v_price) * v_qty;
    v_kind := 'range';
  ELSE
    v_low := (v_price * v_qty * (100 - v_spread) + 50) / 100;
    v_high := (v_price * v_qty * (100 + v_spread) + 50) / 100;
    v_kind := 'range';
  END IF;

  IF v_pct > 0 THEN
    v_low := (v_low * (100 + v_pct) + 50) / 100;
    IF v_high IS NOT NULL THEN v_high := (v_high * (100 + v_pct) + 50) / 100; END IF;
  END IF;

  IF v_kind <> 'from' THEN
    v_kind := CASE WHEN v_high = v_low THEN 'exact' ELSE 'range' END;
  END IF;

  RETURN jsonb_build_object('kind', v_kind, 'low_cents', v_low, 'high_cents', v_high);
END;
$$;
REVOKE ALL ON FUNCTION public.website_widget_estimate(text, bigint, bigint, integer, boolean, integer, integer) FROM PUBLIC, anon, authenticated;

-- Normalised estimator settings, shared by the public payload and the submit RPC (never raises on junk).
CREATE OR REPLACE FUNCTION public.website_widget_estimator_rules(p_opts jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'spread_pct', public.website_widget_opt_int(p_opts, 'flat_spread_pct', 0, 0, 40),
    'urgency_pct', CASE WHEN (p_opts ->> 'show_urgency') = 'true'
                        THEN public.website_widget_opt_int(p_opts, 'urgency_pct', 25, 0, 100) ELSE 0 END,
    'gate_price', coalesce((p_opts ->> 'gate_price') = 'true', false),
    'ask_zip', coalesce((p_opts ->> 'ask_zip') <> 'false', true),
    'contact_required', CASE WHEN (p_opts ->> 'contact_required') IN ('email', 'phone', 'either')
                             THEN p_opts ->> 'contact_required' ELSE 'either' END,
    'disclaimer', left(btrim(coalesce(p_opts ->> 'disclaimer', '')), 240)
  );
$$;
REVOKE ALL ON FUNCTION public.website_widget_estimator_rules(jsonb) FROM PUBLIC, anon, authenticated;

-- 3) Payload: keep the existing function as _base, put a thin wrapper in front of it ----------------------
DO $$
BEGIN
  IF to_regprocedure('public.website_widget_payload_base(public.website_widgets)') IS NULL THEN
    ALTER FUNCTION public.website_widget_payload(public.website_widgets) RENAME TO website_widget_payload_base;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.website_widget_payload(w website_widgets)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opts jsonb := CASE WHEN jsonb_typeof(w.options) = 'object' THEN w.options ELSE '{}'::jsonb END;
  v_name text;
  v_items jsonb;
BEGIN
  IF w.widget_type IS DISTINCT FROM 'estimator' THEN
    RETURN public.website_widget_payload_base(w);
  END IF;

  v_name := (SELECT company_name FROM profiles WHERE id = w.account_owner_id);

  -- Published services, in the owner's order. Only live (active, priced) price-book rows of THIS account.
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', t.id,
             'label', coalesce(nullif(left(btrim(coalesce(t.elem ->> 'label', '')), 60), ''), left(btrim(t.service_name), 60)),
             'description', nullif(left(btrim(coalesce(t.description, '')), 200), ''),
             'pricing_model', t.pricing_model,
             'price_cents', t.price_cents,
             'price_max_cents', t.price_max_cents,
             'unit_label', nullif(left(btrim(coalesce(t.unit_label, '')), 40), '')
           ) ORDER BY t.ord
         ), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT DISTINCT ON (pb.id)
           pb.id, pb.service_name, pb.description, pb.pricing_model, pb.price_cents, pb.price_max_cents, pb.unit_label,
           e.elem, e.ord
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(v_opts -> 'items') = 'array' THEN v_opts -> 'items' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS e(elem, ord)
    JOIN price_book_items pb ON pb.id::text = lower(coalesce(e.elem ->> 'id', ''))
    WHERE pb.user_id = w.account_owner_id
      AND pb.active
      AND pb.price_cents > 0
      AND e.ord <= 30
    ORDER BY pb.id, e.ord
  ) t;

  RETURN jsonb_build_object(
    'type', w.widget_type,
    'settings', jsonb_build_object(
      'brand_color', w.brand_color,
      'theme', w.theme,
      'display_mode', w.display_mode,
      'position', w.position,
      'radius', w.radius,
      'title', w.title,
      'subtitle', w.subtitle,
      'button_label', w.button_label,
      'success_message', w.success_message,
      'options', v_opts
    ),
    'data', jsonb_build_object(
      'business_name', v_name,
      'show', jsonb_array_length(v_items) > 0,
      'items', v_items,
      'rules', public.website_widget_estimator_rules(v_opts)
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.website_widget_payload(website_widgets) FROM PUBLIC, anon, authenticated;

-- 4) Lead + server-side estimate (anon) ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_website_widget_estimate(
  p_key text, p_host text, p_name text, p_email text, p_phone text, p_item text,
  p_quantity integer DEFAULT 1, p_urgent boolean DEFAULT false, p_message text DEFAULT NULL,
  p_zip text DEFAULT NULL, p_page_url text DEFAULT NULL, p_website text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets := public.website_widget_lookup(p_key, p_host);
  v_opts jsonb;
  v_rules jsonb;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
  v_phone text := nullif(left(btrim(coalesce(p_phone, '')), 40), '');
  v_message text := left(btrim(coalesce(p_message, '')), 2000);
  v_zip text := nullif(left(btrim(coalesce(p_zip, '')), 12), '');
  v_page text := nullif(left(coalesce(p_page_url, ''), 500), '');
  v_contact text;
  v_item record;
  v_label text;
  v_qty integer;
  v_urgent boolean;
  v_est jsonb;
  v_est_text text;
  v_notes text;
BEGIN
  IF w.id IS NULL OR w.widget_type <> 'estimator' THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;

  -- Honeypot: bots fill the hidden field. Pretend success, store nothing.
  IF btrim(coalesce(p_website, '')) <> '' THEN
    RETURN jsonb_build_object('kind', 'exact', 'low_cents', 0, 'high_cents', 0);
  END IF;

  v_opts := CASE WHEN jsonb_typeof(w.options) = 'object' THEN w.options ELSE '{}'::jsonb END;
  v_rules := public.website_widget_estimator_rules(v_opts);
  v_contact := v_rules ->> 'contact_required';

  IF char_length(v_name) < 2 THEN RAISE EXCEPTION 'WIDGET_BAD_NAME'; END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'WIDGET_BAD_EMAIL'; END IF;
  IF v_phone IS NOT NULL AND char_length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN RAISE EXCEPTION 'WIDGET_BAD_PHONE'; END IF;
  IF v_contact = 'email' AND v_email IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;
  IF v_contact = 'phone' AND v_phone IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;
  IF v_contact = 'either' AND v_email IS NULL AND v_phone IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;

  -- The service must be one the account PUBLISHED in this widget and still be live in the price book.
  SELECT pb.service_name, pb.pricing_model, pb.price_cents, pb.price_max_cents, pb.unit_label, i.elem
  INTO v_item
  FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(v_opts -> 'items') = 'array' THEN v_opts -> 'items' ELSE '[]'::jsonb END
       ) WITH ORDINALITY AS i(elem, ord)
  JOIN price_book_items pb ON pb.id::text = lower(coalesce(i.elem ->> 'id', ''))
  WHERE pb.id::text = lower(btrim(coalesce(p_item, '')))
    AND pb.user_id = w.account_owner_id
    AND pb.active
    AND pb.price_cents > 0
    AND i.ord <= 30
  ORDER BY i.ord
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'WIDGET_BAD_ITEM'; END IF;

  IF (SELECT count(*) FROM leads
      WHERE user_id = w.account_owner_id AND source = 'website_estimator_widget' AND created_at > now() - interval '10 minutes') >= 30 THEN
    RAISE EXCEPTION 'WIDGET_RATE_LIMITED';
  END IF;

  v_label := coalesce(nullif(left(btrim(coalesce(v_item.elem ->> 'label', '')), 60), ''), left(btrim(v_item.service_name), 60));
  v_qty := CASE
    WHEN v_item.pricing_model = 'hourly' OR nullif(btrim(coalesce(v_item.unit_label, '')), '') IS NOT NULL
      THEN least(greatest(coalesce(p_quantity, 1), 1), 20)
    ELSE 1 END;
  v_urgent := coalesce(p_urgent, false) AND (v_rules ->> 'urgency_pct')::integer > 0;

  v_est := public.website_widget_estimate(
    v_item.pricing_model, v_item.price_cents, v_item.price_max_cents, v_qty, v_urgent,
    (v_rules ->> 'urgency_pct')::integer, (v_rules ->> 'spread_pct')::integer
  );

  v_est_text := CASE v_est ->> 'kind'
    WHEN 'from' THEN 'From ' || public.website_widget_money((v_est ->> 'low_cents')::bigint)
    WHEN 'range' THEN public.website_widget_money((v_est ->> 'low_cents')::bigint) || ' – ' || public.website_widget_money((v_est ->> 'high_cents')::bigint)
    ELSE public.website_widget_money((v_est ->> 'low_cents')::bigint)
  END;

  v_notes := nullif(btrim(
    'Instant estimate shown: ' || v_est_text || ' (' || v_label
      || CASE WHEN v_qty > 1 THEN ' × ' || v_qty::text ELSE '' END
      || CASE WHEN v_urgent THEN ', urgent service' ELSE '' END || ')'
    || CASE WHEN v_message <> '' THEN E'\n\n' || v_message ELSE '' END
    || CASE WHEN v_zip IS NOT NULL THEN E'\n\nZIP: ' || v_zip ELSE '' END
    || CASE WHEN v_page IS NOT NULL THEN E'\nSubmitted from: ' || v_page ELSE '' END
  ), '');

  INSERT INTO leads (user_id, name, phone, email, service_interested, notes, source)
  VALUES (w.account_owner_id, v_name, v_phone, v_email, left(v_label, 80), v_notes, 'website_estimator_widget');

  PERFORM public.website_widget_bump(w.id, w.account_owner_id, 'convert');
  RETURN v_est;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_website_widget_estimate(text, text, text, text, text, text, integer, boolean, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_website_widget_estimate(text, text, text, text, text, text, integer, boolean, text, text, text, text) TO anon, authenticated;

-- 5) Dashboard live preview: identical to the original, except it also accepts 'estimator' ----------------
CREATE OR REPLACE FUNCTION public.preview_website_widget_data(p_type text, p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w website_widgets;
BEGIN
  IF v_owner IS NULL OR NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'WIDGET_FORBIDDEN'; END IF;
  IF p_type IS NULL OR p_type NOT IN ('booking', 'quote', 'reviews', 'estimator') THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;
  w.account_owner_id := v_owner;
  w.widget_type := p_type;
  w.options := CASE WHEN jsonb_typeof(p_options) = 'object' THEN p_options ELSE '{}'::jsonb END;
  w.brand_color := '#3448E8'; w.theme := 'auto'; w.display_mode := 'floating'; w.position := 'right'; w.radius := 14;
  w.title := ''; w.subtitle := ''; w.button_label := ''; w.success_message := '';
  RETURN public.website_widget_payload(w) -> 'data';
END;
$$;
REVOKE ALL ON FUNCTION public.preview_website_widget_data(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_website_widget_data(text, jsonb) TO authenticated;
