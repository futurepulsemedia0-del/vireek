/*
  # Optional quote line items (customer-toggled add-ons)
  Money mirror: src/lib/quoteAddons.ts `addonTotals()`. Change one, change the other.
*/

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS optional_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_optional_items_is_array;
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_optional_items_is_array
  CHECK (jsonb_typeof(optional_items) = 'array' AND jsonb_array_length(optional_items) <= 12);

CREATE OR REPLACE FUNCTION public.validate_quote_optional_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_ids text[] := '{}';
  v_id text;
  v_part text;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.optional_items) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'invalid_optional_items: item must be an object' USING ERRCODE = '22023';
    END IF;

    v_id := v_item->>'id';
    IF v_id IS NULL OR btrim(v_id) = '' OR length(v_id) > 64 THEN
      RAISE EXCEPTION 'invalid_optional_items: id' USING ERRCODE = '22023';
    END IF;
    IF v_id = ANY (v_ids) THEN
      RAISE EXCEPTION 'invalid_optional_items: duplicate id' USING ERRCODE = '22023';
    END IF;
    v_ids := v_ids || v_id;

    IF jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string' OR btrim(v_item->>'name') = '' OR length(v_item->>'name') > 120 THEN
      RAISE EXCEPTION 'invalid_optional_items: name' USING ERRCODE = '22023';
    END IF;
    IF v_item ? 'description' AND jsonb_typeof(v_item->'description') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_optional_items: description' USING ERRCODE = '22023';
    END IF;
    IF length(COALESCE(v_item->>'description', '')) > 400 THEN
      RAISE EXCEPTION 'invalid_optional_items: description too long' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'
       OR (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric)
       OR (v_item->>'quantity')::numeric NOT BETWEEN 1 AND 99 THEN
      RAISE EXCEPTION 'invalid_optional_items: quantity' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item->'unit_price_cents') IS DISTINCT FROM 'number'
       OR (v_item->>'unit_price_cents')::numeric <> trunc((v_item->>'unit_price_cents')::numeric)
       OR (v_item->>'unit_price_cents')::numeric NOT BETWEEN 0 AND 10000000 THEN
      RAISE EXCEPTION 'invalid_optional_items: unit_price_cents' USING ERRCODE = '22023';
    END IF;

    IF v_item ? 'option_ids' AND jsonb_typeof(v_item->'option_ids') <> 'array' THEN
      RAISE EXCEPTION 'invalid_optional_items: option_ids' USING ERRCODE = '22023';
    END IF;

    v_part := v_item->>'part_id';
    IF v_part IS NOT NULL AND jsonb_typeof(v_item->'part_id') <> 'null' THEN
      IF v_part !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR NOT EXISTS (
           SELECT 1 FROM inventory_parts ip WHERE ip.id = v_part::uuid AND ip.user_id = NEW.user_id
         ) THEN
        RAISE EXCEPTION 'invalid_optional_items: part_id' USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotes_validate_optional_items ON public.quotes;
CREATE TRIGGER trg_quotes_validate_optional_items
  BEFORE INSERT OR UPDATE OF optional_items ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.validate_quote_optional_items();

-- What the customer actually chose (written only by the RPC below)
CREATE TABLE IF NOT EXISTS public.quote_selected_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  name text NOT NULL,
  description text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  part_id uuid REFERENCES public.inventory_parts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_selected_items_quote ON public.quote_selected_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_selected_items_user ON public.quote_selected_items(user_id);
ALTER TABLE public.quote_selected_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_own_quote_selected_items" ON public.quote_selected_items;
CREATE POLICY "read_own_quote_selected_items"
  ON public.quote_selected_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Add-ons carried onto the job
CREATE TABLE IF NOT EXISTS public.job_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'quote_addon' CHECK (source IN ('quote_addon', 'manual')),
  source_item_id text,
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  part_id uuid REFERENCES public.inventory_parts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_job_line_items_job ON public.job_line_items(job_id);
CREATE INDEX IF NOT EXISTS idx_job_line_items_user ON public.job_line_items(user_id);
ALTER TABLE public.job_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_job_line_items" ON public.job_line_items;
CREATE POLICY "read_job_line_items"
  ON public.job_line_items FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_line_items.job_id)
  );

DROP POLICY IF EXISTS "write_job_line_items" ON public.job_line_items;
CREATE POLICY "write_job_line_items"
  ON public.job_line_items FOR ALL TO authenticated
  USING (
    user_id = public.get_account_owner_id() AND source = 'manual'
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_line_items.job_id)
  )
  WITH CHECK (
    user_id = public.get_account_owner_id() AND source = 'manual'
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_line_items.job_id)
  );

-- Idempotent: selections -> job line items (+ required parts)
CREATE OR REPLACE FUNCTION public.materialize_quote_addons(p_job_id uuid, p_quote_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  r record;
  v_added integer := 0;
  v_part_ok boolean;
BEGIN
  SELECT id, user_id, quote_id INTO v_job FROM jobs WHERE id = p_job_id;
  IF NOT FOUND OR v_job.quote_id IS DISTINCT FROM p_quote_id THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT * FROM quote_selected_items
    WHERE quote_id = p_quote_id AND user_id = v_job.user_id
    ORDER BY created_at, item_id
  LOOP
    INSERT INTO job_line_items (user_id, job_id, quote_id, source, source_item_id, description, quantity, unit_price_cents, part_id)
    VALUES (v_job.user_id, v_job.id, p_quote_id, 'quote_addon', r.item_id, r.name, r.quantity, r.unit_price_cents, r.part_id)
    ON CONFLICT (job_id, source_item_id) DO NOTHING;

    IF FOUND THEN
      v_added := v_added + 1;

      IF r.part_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM inventory_parts ip
          WHERE ip.id = r.part_id AND ip.user_id = v_job.user_id AND ip.active
        ) INTO v_part_ok;

        IF v_part_ok THEN
          INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required, status)
          VALUES (v_job.user_id, v_job.id, r.part_id, r.quantity, 'needed')
          ON CONFLICT (job_id, part_id)
          DO UPDATE SET quantity_required = job_parts_required.quantity_required + EXCLUDED.quantity_required,
                        updated_at = now();
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN v_added;
END;
$$;
REVOKE ALL ON FUNCTION public.materialize_quote_addons(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_jobs_materialize_quote_addons()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.materialize_quote_addons(NEW.id, NEW.quote_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_jobs_materialize_quote_addons() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_jobs_quote_addons ON public.jobs;
CREATE TRIGGER trg_jobs_quote_addons
  AFTER INSERT ON public.jobs
  FOR EACH ROW
  WHEN (NEW.quote_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_jobs_materialize_quote_addons();

-- Public, token-gated read (no part_id exposed)
CREATE OR REPLACE FUNCTION public.get_quote_optional_items_for_token(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', i.item->>'id',
        'name', i.item->>'name',
        'description', COALESCE(i.item->>'description', ''),
        'quantity', (i.item->>'quantity')::numeric::int,
        'unit_price_cents', (i.item->>'unit_price_cents')::numeric::int,
        'option_ids', COALESCE(i.item->'option_ids', '[]'::jsonb)
      )
      ORDER BY i.ord
    ),
    '[]'::jsonb
  )
  FROM public.quotes q
  CROSS JOIN LATERAL jsonb_array_elements(q.optional_items) WITH ORDINALITY AS i(item, ord)
  WHERE q.quote_token = p_token AND q.status <> 'draft';
$$;
GRANT EXECUTE ON FUNCTION public.get_quote_optional_items_for_token(uuid) TO anon, authenticated;

-- Accept quote + add-ons in ONE transaction
CREATE OR REPLACE FUNCTION public.accept_quote_with_addons_by_token(
  p_token uuid,
  p_option_id text DEFAULT NULL,
  p_item_ids text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_ids text[];
  v_id text;
  v_item jsonb;
  v_has_options boolean;
  v_addon_sub bigint := 0;
  v_addon_tax bigint;
  v_addon_total bigint;
  v_new_total bigint;
  v_ok boolean;
  v_job record;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_ids FROM unnest(COALESCE(p_item_ids, '{}')) AS x;

  IF cardinality(v_ids) = 0 OR cardinality(v_ids) > 12 THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_items');
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE quote_token = p_token FOR UPDATE;
  IF NOT FOUND OR v_quote.status <> 'sent' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'unavailable');
  END IF;

  v_has_options := jsonb_typeof(v_quote.options) = 'array' AND jsonb_array_length(v_quote.options) > 0;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT i INTO v_item
    FROM jsonb_array_elements(v_quote.optional_items) AS i
    WHERE i->>'id' = v_id
    LIMIT 1;

    IF v_item IS NULL THEN
      RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_items');
    END IF;

    IF jsonb_typeof(v_item->'option_ids') = 'array' AND jsonb_array_length(v_item->'option_ids') > 0 THEN
      IF NOT v_has_options OR p_option_id IS NULL OR NOT (v_item->'option_ids') ? p_option_id THEN
        RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_items');
      END IF;
    END IF;

    v_addon_sub := v_addon_sub
      + (v_item->>'quantity')::numeric::bigint * (v_item->>'unit_price_cents')::numeric::bigint;
  END LOOP;

  v_addon_tax := round(v_addon_sub * COALESCE(v_quote.tax_percent, 0) / 100.0);
  v_addon_total := v_addon_sub + v_addon_tax;

  v_ok := public.respond_to_quote_by_token(p_token, 'accepted', p_option_id);
  IF NOT v_ok THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'unavailable');
  END IF;

  INSERT INTO quote_selected_items (quote_id, user_id, item_id, name, description, quantity, unit_price_cents, part_id)
  SELECT
    v_quote.id, v_quote.user_id, i->>'id', i->>'name', NULLIF(i->>'description', ''),
    (i->>'quantity')::numeric::int,
    (i->>'unit_price_cents')::numeric::int,
    CASE WHEN jsonb_typeof(i->'part_id') = 'string' THEN (i->>'part_id')::uuid ELSE NULL END
  FROM jsonb_array_elements(v_quote.optional_items) AS i
  WHERE i->>'id' = ANY (v_ids)
  ON CONFLICT (quote_id, item_id) DO NOTHING;

  UPDATE quotes
  SET accepted_total_cents = COALESCE(accepted_total_cents, 0) + v_addon_total
  WHERE id = v_quote.id
  RETURNING accepted_total_cents INTO v_new_total;

  UPDATE quote_events
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'addon_item_ids', to_jsonb(v_ids),
    'addons_total_cents', v_addon_total,
    'total_cents', v_new_total
  )
  WHERE id = (
    SELECT id FROM quote_events
    WHERE quote_id = v_quote.id AND event_type = 'accepted'
    ORDER BY created_at DESC LIMIT 1
  );

  IF v_quote.lead_id IS NOT NULL THEN
    UPDATE leads SET quote_amount = round(v_new_total / 100.0) WHERE id = v_quote.lead_id;
  END IF;

  BEGIN
    UPDATE notifications
    SET message = message || ' Includes ' || cardinality(v_ids) || ' add-on'
      || CASE WHEN cardinality(v_ids) = 1 THEN '' ELSE 's' END
      || ' (+$' || to_char(round(v_addon_total / 100.0), 'FM999,999,990') || ').'
    WHERE id = (
      SELECT id FROM notifications
      WHERE user_id = v_quote.user_id AND type = 'quote_viewed' AND title = 'Estimate accepted'
        AND created_at = now()
      ORDER BY created_at DESC LIMIT 1
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  FOR v_job IN SELECT id FROM jobs WHERE quote_id = v_quote.id LOOP
    PERFORM public.materialize_quote_addons(v_job.id, v_quote.id);
  END LOOP;

  RETURN jsonb_build_object('accepted', true, 'addons_total_cents', v_addon_total, 'total_cents', v_new_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.accept_quote_with_addons_by_token(uuid, text, text[]) TO anon, authenticated;
