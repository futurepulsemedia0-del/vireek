/*
  # Visual + Tiered Estimates

  ## Why
  The `quotes` table (20260912080000_quotes.sql) can only express ONE flat
  list of line items. Every serious home-services estimate in the field is
  presented as two or three priced options — Good / Better / Best — with
  photos of the actual problem attached, because that is what closes jobs:
  the customer chooses *which* yes instead of yes-or-no, and the photos
  remove the "are they inventing this repair?" doubt that kills conversion
  on a text-only number.

  ## What this adds
  1. `quotes.options` jsonb — an ordered array of priced options. Shape:
       [{
          id: text (stable, client-generated uuid),
          tier: 'good' | 'better' | 'best',
          name: text, summary: text,
          line_items: [{ description, quantity, unit_price_cents }],
          highlights: text[],
          warranty_label: text | null,
          photo_ids: text[],          -- subset of quotes.photos shown here
          recommended: boolean
        }]
     Empty array = classic single-price quote. Nothing about the existing
     flow changes; `line_items` stays the source of truth for flat quotes
     and is mirrored from the recommended option for tiered ones, so the
     old public page, the follow-up tracker and any report that reads
     `line_items` keep working untouched.
  2. `quotes.photos` jsonb — [{ id, path, url, caption, kind, created_at }]
     backed by the new public `quote-photos` storage bucket.
  3. Read receipts — `first_viewed_at`, `last_viewed_at`, `view_count`, and
     a per-event `quote_events` trail, so a business can see "she opened it
     three times and never replied" and follow up on a real signal.
  4. `estimate_templates` — reusable Good/Better/Best packages so a tech
     doesn't rebuild the same water-heater ladder for the 40th time.

  ## Security
  Same posture as the original quotes migration: RLS stays fully closed to
  anon; the public estimate page only ever reaches the data through
  SECURITY DEFINER, token-scoped functions. Totals for an accepted option
  are recomputed server-side from the stored jsonb — the client never gets
  to tell us what it owes. `quote_events` has no client INSERT policy at
  all; rows are written only by the definer functions below.

  Storage note: `quote-photos` is a PUBLIC bucket (the customer opening the
  estimate is anonymous, so a signed URL would expire out from under a link
  that has to live for weeks). Object paths are
  `{user_id}/{quote_id}/{uuid}.jpg` — unguessable, and writes are still
  locked to the owner's own folder.
*/

-- =============================================================
-- 1. QUOTES: options, photos, presentation + read receipts
-- =============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS recommended_option_id text,
  ADD COLUMN IF NOT EXISTS selected_option_id text,
  ADD COLUMN IF NOT EXISTS accepted_total_cents integer,
  ADD COLUMN IF NOT EXISTS presentation_note text,
  ADD COLUMN IF NOT EXISTS deposit_percent numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_options_is_array') THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_options_is_array CHECK (jsonb_typeof(options) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_photos_is_array') THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_photos_is_array CHECK (jsonb_typeof(photos) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_deposit_percent_range') THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_deposit_percent_range
      CHECK (deposit_percent >= 0 AND deposit_percent <= 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quotes_user_status_created
  ON quotes(user_id, status, created_at DESC);

-- keep updated_at honest (the original migration never wired a trigger)
CREATE OR REPLACE FUNCTION public.set_quotes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_quotes_updated_at();

-- =============================================================
-- 2. QUOTE EVENTS — what the customer actually did with the link
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('viewed', 'option_selected', 'accepted', 'declined')),
  option_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_events_quote ON quote_events(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_events_user ON quote_events(user_id, created_at DESC);

ALTER TABLE quote_events ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner. No INSERT/UPDATE/DELETE policy on purpose: the
-- trail is written exclusively by the SECURITY DEFINER functions below, so
-- a client session can neither forge nor erase engagement history.
DROP POLICY IF EXISTS "select_own_quote_events" ON quote_events;
CREATE POLICY "select_own_quote_events" ON quote_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- =============================================================
-- 3. ESTIMATE TEMPLATES — reusable Good/Better/Best packages
-- =============================================================

CREATE TABLE IF NOT EXISTS estimate_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  category text,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  tax_percent numeric NOT NULL DEFAULT 0,
  deposit_percent numeric NOT NULL DEFAULT 0,
  presentation_note text,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT estimate_templates_options_is_array CHECK (jsonb_typeof(options) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_estimate_templates_user ON estimate_templates(user_id, created_at DESC);

ALTER TABLE estimate_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_estimate_templates" ON estimate_templates;
CREATE POLICY "select_own_estimate_templates" ON estimate_templates
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_estimate_templates" ON estimate_templates;
CREATE POLICY "insert_own_estimate_templates" ON estimate_templates
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_estimate_templates" ON estimate_templates;
CREATE POLICY "update_own_estimate_templates" ON estimate_templates
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_estimate_templates" ON estimate_templates;
CREATE POLICY "delete_own_estimate_templates" ON estimate_templates
  FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS trg_estimate_templates_updated_at ON estimate_templates;
CREATE TRIGGER trg_estimate_templates_updated_at
  BEFORE UPDATE ON estimate_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_quotes_updated_at();

-- =============================================================
-- 4. STORAGE — quote photos
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'quote-photos',
  'quote-photos',
  true,
  10485760, -- 10 MB; the client downscales before upload anyway
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Writes locked to the uploader's own top-level folder; reads are public
-- because the estimate link is opened by an anonymous customer.
DROP POLICY IF EXISTS "users_manage_own_quote_photos" ON storage.objects;
CREATE POLICY "users_manage_own_quote_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'quote-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'quote-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "public_read_quote_photos" ON storage.objects;
CREATE POLICY "public_read_quote_photos"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'quote-photos');

-- =============================================================
-- 5. SERVER-SIDE MONEY — never trust the client for a total
-- =============================================================

CREATE OR REPLACE FUNCTION public.quote_line_items_subtotal_cents(p_line_items jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(SUM(
    GREATEST(COALESCE((li->>'quantity')::numeric, 0), 0)
    * GREATEST(COALESCE((li->>'unit_price_cents')::numeric, 0), 0)
  ), 0)::bigint
  FROM jsonb_array_elements(COALESCE(p_line_items, '[]'::jsonb)) AS li
  WHERE jsonb_typeof(p_line_items) = 'array';
$$;

/* Total for one option id, tax included. NULL when the id isn't in the array. */
CREATE OR REPLACE FUNCTION public.quote_option_total_cents(
  p_options jsonb,
  p_option_id text,
  p_tax_percent numeric
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_option jsonb;
  v_subtotal bigint;
BEGIN
  IF p_option_id IS NULL OR jsonb_typeof(COALESCE(p_options, 'null'::jsonb)) <> 'array' THEN
    RETURN NULL;
  END IF;

  SELECT opt INTO v_option
  FROM jsonb_array_elements(p_options) AS opt
  WHERE opt->>'id' = p_option_id
  LIMIT 1;

  IF v_option IS NULL THEN
    RETURN NULL;
  END IF;

  v_subtotal := public.quote_line_items_subtotal_cents(v_option->'line_items');
  RETURN v_subtotal + round(v_subtotal * COALESCE(p_tax_percent, 0) / 100.0);
END;
$$;

-- =============================================================
-- 6. PUBLIC, TOKEN-GATED READ (replaces the 7-column version)
-- =============================================================

DROP FUNCTION IF EXISTS public.get_quote_for_token(uuid);

CREATE FUNCTION public.get_quote_for_token(p_token uuid)
RETURNS TABLE (
  quote_id uuid,
  customer_name text,
  line_items jsonb,
  options jsonb,
  photos jsonb,
  recommended_option_id text,
  selected_option_id text,
  presentation_note text,
  deposit_percent numeric,
  tax_percent numeric,
  status text,
  valid_until date,
  business_name text,
  financing_partner_name text,
  financing_note text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id,
    q.customer_name,
    q.line_items,
    q.options,
    q.photos,
    q.recommended_option_id,
    q.selected_option_id,
    q.presentation_note,
    q.deposit_percent,
    q.tax_percent,
    q.status,
    q.valid_until,
    p.company_name,
    bp.financing_partner_name,
    bp.financing_note
  FROM quotes q
  JOIN profiles p ON p.id = q.user_id
  LEFT JOIN business_profile bp ON bp.user_id = q.user_id
  WHERE q.quote_token = p_token AND q.status <> 'draft'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_quote_for_token(uuid) TO anon, authenticated;

-- =============================================================
-- 7. READ RECEIPT — "your customer opened the estimate"
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_quote_view(p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_is_first boolean;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE quote_token = p_token;

  IF v_quote.id IS NULL OR v_quote.status = 'draft' THEN
    RETURN false;
  END IF;

  v_is_first := v_quote.first_viewed_at IS NULL;

  UPDATE quotes
  SET first_viewed_at = COALESCE(first_viewed_at, now()),
      last_viewed_at = now(),
      view_count = view_count + 1
  WHERE id = v_quote.id;

  INSERT INTO quote_events (quote_id, user_id, event_type, metadata)
  VALUES (v_quote.id, v_quote.user_id, 'viewed', jsonb_build_object('first_view', v_is_first));

  -- One notification on the first open only. Re-opens are visible in the
  -- event trail and on the quote card; they don't deserve a bell each.
  IF v_is_first THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      v_quote.user_id,
      'quote_viewed',
      'Estimate opened',
      v_quote.customer_name || ' just opened the estimate you sent. Good moment to follow up.',
      '/dashboard/quotes'
    );
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_quote_view(uuid) TO anon, authenticated;

-- =============================================================
-- 8. RESPOND — now carries the chosen option (replaces 2-arg version)
-- =============================================================

DROP FUNCTION IF EXISTS public.respond_to_quote_by_token(uuid, text);

CREATE FUNCTION public.respond_to_quote_by_token(
  p_token uuid,
  p_response text,
  p_option_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_total bigint;
  v_has_options boolean;
BEGIN
  IF p_response NOT IN ('accepted', 'declined') THEN
    RETURN false;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE quote_token = p_token;

  IF v_quote.id IS NULL OR v_quote.status <> 'sent' THEN
    RETURN false;
  END IF;

  v_has_options := jsonb_typeof(v_quote.options) = 'array' AND jsonb_array_length(v_quote.options) > 0;

  IF p_response = 'accepted' THEN
    IF v_has_options THEN
      -- A tiered estimate must be accepted *as* one of its options.
      v_total := public.quote_option_total_cents(v_quote.options, p_option_id, v_quote.tax_percent);
      IF v_total IS NULL THEN
        RETURN false;
      END IF;
    ELSE
      v_total := public.quote_line_items_subtotal_cents(v_quote.line_items);
      v_total := v_total + round(v_total * COALESCE(v_quote.tax_percent, 0) / 100.0);
    END IF;
  END IF;

  UPDATE quotes
  SET status = p_response,
      responded_at = now(),
      selected_option_id = CASE WHEN p_response = 'accepted' AND v_has_options THEN p_option_id ELSE selected_option_id END,
      accepted_total_cents = CASE WHEN p_response = 'accepted' THEN v_total::integer ELSE accepted_total_cents END
  WHERE id = v_quote.id;

  INSERT INTO quote_events (quote_id, user_id, event_type, option_id, metadata)
  VALUES (
    v_quote.id,
    v_quote.user_id,
    p_response,
    CASE WHEN v_has_options THEN p_option_id ELSE NULL END,
    jsonb_build_object('total_cents', v_total)
  );

  IF p_response = 'accepted' AND v_quote.lead_id IS NOT NULL THEN
    UPDATE leads
    SET stage = 'won',
        quote_amount = COALESCE(round(v_total / 100.0), quote_amount)
    WHERE id = v_quote.lead_id;
  END IF;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    v_quote.user_id,
    'quote_viewed',
    CASE WHEN p_response = 'accepted' THEN 'Estimate accepted' ELSE 'Estimate declined' END,
    v_quote.customer_name ||
      CASE
        WHEN p_response = 'accepted'
          THEN ' accepted an estimate worth $' || to_char(round(v_total / 100.0), 'FM999,999,990') || '.'
        ELSE ' declined the estimate you sent.'
      END,
    '/dashboard/quotes'
  );

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_quote_by_token(uuid, text, text) TO anon, authenticated;
