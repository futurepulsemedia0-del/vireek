-- =============================================================
-- Customer identity resolution (ingestion-time)
--
-- * Identity keys: every phone / email / address a customer has ever been seen
--   with, so one person is recognised across several numbers, emails, addresses
-- * Deterministic, explainable confidence score (0-100, noisy-OR of signals)
--   with hard conflict rules (different names / Jr-Sr never auto-merge)
-- * identity_lookup(): read-only, indexed, safe to call mid-call
-- * identity_ingest(): called by triggers on calls / leads; links the row,
--   registers new identifiers, queues or auto-merges bridged customers
-- * Auto-merge reuses merge_records() (ledger + 7-day undo); anything
--   uncertain goes to identity_match_candidates (review queue)
-- * Household graph (address / phone sharing) with confirm / reject
-- * Coordinates with the Duplicates feature: same normalisers, shared
--   dismissals, manual merges + unmerges keep the queue in sync
--
-- Depends on: 20270403000000_duplicate_detection_merge.sql
-- Additive only. No existing table is altered; nothing is dropped.
-- =============================================================

-- 0. Compatibility: make sure every column these features read exists ---------
-- (some databases have an older customers / leads / calls table without them; adding is harmless)
DO $$
BEGIN
  IF to_regclass('public.customers') IS NULL OR to_regclass('public.leads') IS NULL OR to_regclass('public.calls') IS NULL THEN
    RAISE EXCEPTION 'Tables customers / leads / calls must exist first.';
  END IF;
END $$;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'residential';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'lead';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS service_interested text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'new';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS caller_phone text;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS caller_name text;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF to_regprocedure('public.merge_records(text,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.dup_norm_phone(text)') IS NULL
     OR to_regclass('public.record_merges') IS NULL
     OR to_regclass('public.duplicate_dismissals') IS NULL THEN
    RAISE EXCEPTION 'Run the duplicate detection migration (20270403000000) first.';
  END IF;
END $$;

-- 1. Tables ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customer_identity_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  key_type      text NOT NULL CHECK (key_type IN ('phone', 'email', 'address')),
  key_value     text NOT NULL,
  raw_value     text,
  source        text NOT NULL DEFAULT 'system',
  is_primary    boolean NOT NULL DEFAULT false,
  seen_count    integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id, key_type, key_value)
);
CREATE INDEX IF NOT EXISTS idx_identity_keys_lookup ON public.customer_identity_keys (user_id, key_type, key_value);
CREATE INDEX IF NOT EXISTS idx_identity_keys_customer ON public.customer_identity_keys (customer_id);

CREATE TABLE IF NOT EXISTS public.customer_households (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  name       text NOT NULL DEFAULT 'Household',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_households_user ON public.customer_households (user_id);

CREATE TABLE IF NOT EXISTS public.customer_household_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.customer_households(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  customer_id  uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member',
  source       text NOT NULL DEFAULT 'address' CHECK (source IN ('address', 'phone', 'manual')),
  confidence   integer NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  status       text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_household_members_customer ON public.customer_household_members (customer_id);

CREATE TABLE IF NOT EXISTS public.identity_match_candidates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  a_id        uuid NOT NULL,
  b_id        uuid NOT NULL,
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  band        text NOT NULL CHECK (band IN ('auto_merge', 'review')),
  signals     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'merged', 'auto_merged', 'dismissed', 'superseded')),
  source      text NOT NULL DEFAULT 'system',
  source_ref  text,
  merge_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  CHECK (a_id < b_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_candidates_pending
  ON public.identity_match_candidates (user_id, a_id, b_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_identity_candidates_queue
  ON public.identity_match_candidates (user_id, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_identity_candidates_a ON public.identity_match_candidates (a_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_identity_candidates_b ON public.identity_match_candidates (b_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.identity_settings (
  user_id              uuid PRIMARY KEY,
  auto_merge_enabled   boolean NOT NULL DEFAULT true,
  auto_merge_threshold integer NOT NULL DEFAULT 95 CHECK (auto_merge_threshold BETWEEN 90 AND 100),
  review_threshold     integer NOT NULL DEFAULT 60 CHECK (review_threshold BETWEEN 40 AND 89),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_identity_keys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_households         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_household_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_match_candidates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_settings           ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_identity_keys', 'customer_households', 'customer_household_members',
                           'identity_match_candidates', 'identity_settings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS select_own_%1$s ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY select_own_%1$s ON public.%1$I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
-- No client write policies: every write goes through the SECURITY DEFINER functions below.

-- 2. Pure helpers ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_name_tokens(p text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(t ORDER BY t), '{}'::text[])
  FROM unnest(regexp_split_to_array(btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alpha:]]+', ' ', 'g')), '\s+')) AS t
  WHERE t <> '' AND t NOT IN ('mr', 'mrs', 'ms', 'miss', 'dr')
$$;

-- 0..1, NULL when either side has no usable name. "J Smith" ~ "John Smith".
CREATE OR REPLACE FUNCTION public.identity_name_similarity(p_a text, p_b text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ta text[] := public.identity_name_tokens(p_a);
  tb text[] := public.identity_name_tokens(p_b);
  m  integer;
BEGIN
  IF cardinality(ta) = 0 OR cardinality(tb) = 0 THEN RETURN NULL; END IF;
  IF ta = tb THEN RETURN 1.00; END IF;
  SELECT count(*) INTO m
  FROM unnest(ta) x
  WHERE EXISTS (SELECT 1 FROM unnest(tb) y
                WHERE x = y
                   OR (length(x) = 1 AND y LIKE x || '%')
                   OR (length(y) = 1 AND x LIKE y || '%'));
  RETURN round(m::numeric / GREATEST(cardinality(ta), cardinality(tb)), 2);
END $$;

-- "John Smith" vs "John Smith Jr" must never be treated as the same person automatically.
CREATE OR REPLACE FUNCTION public.identity_name_suffix_conflict(p_a text, p_b text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ta text[] := public.identity_name_tokens(p_a);
  tb text[] := public.identity_name_tokens(p_b);
  sa text;
  sb text;
BEGIN
  IF cardinality(ta) = 0 OR cardinality(tb) = 0 THEN RETURN false; END IF;
  SELECT x INTO sa FROM unnest(ta) x WHERE x IN ('jr', 'sr', 'ii', 'iii', 'iv') LIMIT 1;
  SELECT x INTO sb FROM unnest(tb) x WHERE x IN ('jr', 'sr', 'ii', 'iii', 'iv') LIMIT 1;
  RETURN (sa IS NOT NULL OR sb IS NOT NULL) AND sa IS DISTINCT FROM sb;
END $$;

-- Single source of truth for the score. Noisy-OR: score = 1 - prod(1 - weight).
--   email 92 · phone 78 · address 45 · name exact 45 · name close (>=0.7) 25
-- Conflict (names clearly differ, or Jr/Sr mismatch) caps the score at 74:
-- a shared phone/address with different names is a household, not a duplicate.
CREATE OR REPLACE FUNCTION public.identity_combine_signals(
  p_phone boolean, p_email boolean, p_address boolean, p_name_sim numeric, p_suffix_conflict boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_miss     numeric := 1;
  v_sig      jsonb := '[]'::jsonb;
  v_n        integer := 0;
  v_conflict boolean;
  v_score    integer;
BEGIN
  IF COALESCE(p_email, false) THEN
    v_miss := v_miss * 0.08; v_n := v_n + 1;
    v_sig := v_sig || jsonb_build_array(jsonb_build_object('type', 'email', 'weight', 92));
  END IF;
  IF COALESCE(p_phone, false) THEN
    v_miss := v_miss * 0.22; v_n := v_n + 1;
    v_sig := v_sig || jsonb_build_array(jsonb_build_object('type', 'phone', 'weight', 78));
  END IF;
  IF COALESCE(p_address, false) THEN
    v_miss := v_miss * 0.55; v_n := v_n + 1;
    v_sig := v_sig || jsonb_build_array(jsonb_build_object('type', 'address', 'weight', 45));
  END IF;
  IF p_name_sim IS NOT NULL THEN
    IF p_name_sim >= 0.99 THEN
      v_miss := v_miss * 0.55; v_n := v_n + 1;
      v_sig := v_sig || jsonb_build_array(jsonb_build_object('type', 'name', 'weight', 45));
    ELSIF p_name_sim >= 0.7 THEN
      v_miss := v_miss * 0.75; v_n := v_n + 1;
      v_sig := v_sig || jsonb_build_array(jsonb_build_object('type', 'name', 'weight', 25));
    END IF;
  END IF;

  v_conflict := COALESCE(p_suffix_conflict, false) OR (p_name_sim IS NOT NULL AND p_name_sim < 0.34);
  v_score := round((1 - v_miss) * 100)::integer;
  IF v_conflict AND v_score > 74 THEN v_score := 74; END IF;

  RETURN jsonb_build_object(
    'score', v_score, 'signals', v_sig, 'conflict', v_conflict, 'signal_count', v_n,
    'has_strong', COALESCE(p_email, false) OR COALESCE(p_phone, false), 'name_similarity', p_name_sim);
END $$;

CREATE OR REPLACE FUNCTION public.identity_settings_for(p_owner uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'auto_enabled', COALESCE((SELECT s.auto_merge_enabled   FROM public.identity_settings s WHERE s.user_id = p_owner), true),
    'auto',         COALESCE((SELECT s.auto_merge_threshold FROM public.identity_settings s WHERE s.user_id = p_owner), 95),
    'review',       COALESCE((SELECT s.review_threshold     FROM public.identity_settings s WHERE s.user_id = p_owner), 60));
$$;

-- 3. Keys --------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_register_keys(
  p_owner uuid, p_customer uuid, p_phone text, p_email text, p_address text, p_source text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0;
BEGIN
  IF p_owner IS NULL OR p_customer IS NULL THEN RETURN 0; END IF;
  INSERT INTO public.customer_identity_keys (user_id, customer_id, key_type, key_value, raw_value, source, is_primary)
  SELECT p_owner, p_customer, v.t, v.k, v.raw, COALESCE(p_source, 'system'),
         NOT EXISTS (SELECT 1 FROM public.customer_identity_keys e WHERE e.customer_id = p_customer AND e.key_type = v.t)
  FROM (VALUES ('phone',   public.dup_norm_phone(p_phone),     p_phone),
               ('email',   public.dup_norm_email(p_email),     p_email),
               ('address', public.dup_norm_address(p_address), p_address)) AS v(t, k, raw)
  WHERE v.k IS NOT NULL
  ON CONFLICT (user_id, customer_id, key_type, key_value)
  DO UPDATE SET last_seen_at = now(), seen_count = public.customer_identity_keys.seen_count + 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- One-time backfill from the existing customer rows.
INSERT INTO public.customer_identity_keys (user_id, customer_id, key_type, key_value, raw_value, source, is_primary)
SELECT c.user_id, c.id, v.t, v.k, v.raw, 'backfill', true
FROM public.customers c
CROSS JOIN LATERAL (VALUES ('phone',   public.dup_norm_phone(c.phone),     c.phone),
                           ('email',   public.dup_norm_email(c.email),     c.email),
                           ('address', public.dup_norm_address(c.address), c.address)) AS v(t, k, raw)
WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL AND v.k IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Scoring + live lookup -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_pair_score(p_owner uuid, p_a uuid, p_b uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_na text; v_nb text; v_p boolean; v_e boolean; v_a boolean;
BEGIN
  SELECT name INTO v_na FROM public.customers WHERE id = p_a AND user_id = p_owner;
  SELECT name INTO v_nb FROM public.customers WHERE id = p_b AND user_id = p_owner;

  SELECT COALESCE(bool_or(x.key_type = 'phone'), false),
         COALESCE(bool_or(x.key_type = 'email'), false),
         COALESCE(bool_or(x.key_type = 'address'), false)
    INTO v_p, v_e, v_a
  FROM public.customer_identity_keys x
  JOIN public.customer_identity_keys y
    ON y.user_id = x.user_id AND y.key_type = x.key_type AND y.key_value = x.key_value AND y.customer_id = p_b
  WHERE x.user_id = p_owner AND x.customer_id = p_a
    AND (SELECT count(DISTINCT z.customer_id) FROM public.customer_identity_keys z
         WHERE z.user_id = x.user_id AND z.key_type = x.key_type AND z.key_value = x.key_value) <= 8;

  RETURN public.identity_combine_signals(v_p, v_e, v_a,
           public.identity_name_similarity(v_na, v_nb),
           public.identity_name_suffix_conflict(v_na, v_nb))
         || jsonb_build_object('a_id', p_a, 'b_id', p_b);
END $$;

-- Read-only. Safe to call while a caller is on the line.
CREATE OR REPLACE FUNCTION public.identity_lookup(
  p_owner uuid, p_phone text, p_email text, p_address text, p_name text, p_limit integer DEFAULT 3
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone text := public.dup_norm_phone(p_phone);
  v_email text := public.dup_norm_email(p_email);
  v_addr  text := public.dup_norm_address(p_address);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 3), 1), 5);
  v_all   jsonb;
  v_best  jsonb;
  v_score integer;
  v_band  text;
  v_cid   uuid;
  v_hh    jsonb := NULL;
BEGIN
  IF p_owner IS NULL OR (v_phone IS NULL AND v_email IS NULL AND v_addr IS NULL) THEN
    RETURN jsonb_build_object('matched', false, 'band', 'none', 'candidates', '[]'::jsonb);
  END IF;

  WITH hits AS (
    SELECT k.customer_id,
           bool_or(k.key_type = 'phone')   AS ph,
           bool_or(k.key_type = 'email')   AS em,
           bool_or(k.key_type = 'address') AS ad
    FROM public.customer_identity_keys k
    WHERE k.user_id = p_owner
      AND ((k.key_type = 'phone'   AND k.key_value = v_phone)
        OR (k.key_type = 'email'   AND k.key_value = v_email)
        OR (k.key_type = 'address' AND k.key_value = v_addr))
      AND (SELECT count(DISTINCT z.customer_id) FROM public.customer_identity_keys z
           WHERE z.user_id = k.user_id AND z.key_type = k.key_type AND z.key_value = k.key_value) <= 8
    GROUP BY k.customer_id
  ), scored AS (
    SELECT h.customer_id, c.name, c.customer_type, c.lifecycle_stage,
           public.identity_combine_signals(h.ph, h.em, h.ad,
             public.identity_name_similarity(p_name, c.name),
             public.identity_name_suffix_conflict(p_name, c.name)) AS s
    FROM hits h
    JOIN public.customers c ON c.id = h.customer_id AND c.user_id = p_owner
                           AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
  )
  SELECT jsonb_agg(jsonb_build_object(
           'customer_id', q.customer_id, 'name', q.name, 'customer_type', q.customer_type,
           'lifecycle_stage', q.lifecycle_stage, 'score', (q.s ->> 'score')::integer,
           'signals', q.s -> 'signals', 'conflict', (q.s ->> 'conflict')::boolean,
           'signal_count', (q.s ->> 'signal_count')::integer)
         ORDER BY (q.s ->> 'score')::integer DESC, q.customer_id)
    INTO v_all
  FROM (SELECT * FROM scored ORDER BY (s ->> 'score')::integer DESC, customer_id LIMIT v_limit) q;

  IF v_all IS NULL THEN
    RETURN jsonb_build_object('matched', false, 'band', 'none', 'candidates', '[]'::jsonb);
  END IF;

  v_best  := v_all -> 0;
  v_score := (v_best ->> 'score')::integer;
  v_cid   := (v_best ->> 'customer_id')::uuid;
  v_band  := CASE WHEN v_score >= 90 AND NOT (v_best ->> 'conflict')::boolean THEN 'high'
                  WHEN v_score >= 60 THEN 'medium' ELSE 'low' END;

  SELECT jsonb_build_object('id', h.id, 'name', h.name, 'members', COALESCE((
           SELECT jsonb_agg(jsonb_build_object('customer_id', m.customer_id, 'name', c.name, 'status', m.status)
                            ORDER BY c.name)
           FROM public.customer_household_members m
           JOIN public.customers c ON c.id = m.customer_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
           WHERE m.household_id = h.id AND m.customer_id <> v_cid AND m.status <> 'rejected'), '[]'::jsonb))
    INTO v_hh
  FROM public.customer_households h
  JOIN public.customer_household_members mm ON mm.household_id = h.id AND mm.customer_id = v_cid AND mm.status <> 'rejected'
  WHERE h.user_id = p_owner
  LIMIT 1;

  RETURN jsonb_build_object('matched', v_band IN ('high', 'medium'), 'band', v_band, 'best', v_best,
                            'candidates', v_all, 'household', v_hh);
END $$;

-- 5. Households ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_refresh_household(p_owner uuid, p_customer uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name  text;
  v_hh    uuid;
  v_mates jsonb;
  v_src   text;
BEGIN
  SELECT name INTO v_name FROM public.customers
   WHERE id = p_customer AND user_id = p_owner AND deleted_at IS NULL AND merged_into_id IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT m.household_id INTO v_hh FROM public.customer_household_members m
   WHERE m.customer_id = p_customer AND m.user_id = p_owner AND m.status <> 'rejected' LIMIT 1;

  -- Housemates: another active customer sharing an address key (always) or a phone key
  -- (only when the names differ, otherwise it is a duplicate, not a household).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('cid', x.cid, 'src', x.src)), '[]'::jsonb) INTO v_mates
  FROM (
    SELECT o.customer_id AS cid,
           CASE WHEN bool_or(k.key_type = 'address') THEN 'address' ELSE 'phone' END AS src
    FROM public.customer_identity_keys k
    JOIN public.customer_identity_keys o
      ON o.user_id = k.user_id AND o.key_type = k.key_type AND o.key_value = k.key_value AND o.customer_id <> k.customer_id
    JOIN public.customers c ON c.id = o.customer_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
    WHERE k.user_id = p_owner AND k.customer_id = p_customer AND k.key_type IN ('address', 'phone')
      AND (k.key_type = 'address' OR COALESCE(public.identity_name_similarity(v_name, c.name), 0) < 0.7)
      AND (SELECT count(DISTINCT z.customer_id) FROM public.customer_identity_keys z
           WHERE z.user_id = k.user_id AND z.key_type = k.key_type AND z.key_value = k.key_value) <= 8
    GROUP BY o.customer_id
    LIMIT 8
  ) x;

  IF jsonb_array_length(v_mates) = 0 THEN RETURN v_hh; END IF;

  IF v_hh IS NULL THEN
    SELECT m.household_id INTO v_hh
    FROM public.customer_household_members m
    WHERE m.user_id = p_owner AND m.status <> 'rejected'
      AND m.customer_id IN (SELECT (e ->> 'cid')::uuid FROM jsonb_array_elements(v_mates) e)
    LIMIT 1;
  END IF;

  IF v_hh IS NULL THEN
    INSERT INTO public.customer_households (user_id, name)
    VALUES (p_owner, COALESCE(NULLIF(initcap(substring(btrim(v_name) FROM '([^ ]+)$')), '') || ' household', 'Household'))
    RETURNING id INTO v_hh;
  END IF;

  v_src := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_mates) e WHERE e ->> 'src' = 'address')
                THEN 'address' ELSE 'phone' END;

  INSERT INTO public.customer_household_members (household_id, user_id, customer_id, source, confidence)
  VALUES (v_hh, p_owner, p_customer, v_src, CASE WHEN v_src = 'address' THEN 75 ELSE 55 END)
  ON CONFLICT (household_id, customer_id) DO NOTHING;

  INSERT INTO public.customer_household_members (household_id, user_id, customer_id, source, confidence)
  SELECT v_hh, p_owner, (e ->> 'cid')::uuid, e ->> 'src', CASE WHEN e ->> 'src' = 'address' THEN 75 ELSE 55 END
  FROM jsonb_array_elements(v_mates) e
  ON CONFLICT (household_id, customer_id) DO NOTHING;

  RETURN v_hh;
END $$;

-- 6. Review queue + auto-merge -------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_enqueue_pair(
  p_owner uuid, p_x uuid, p_y uuid, p_source text, p_source_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a uuid; v_b uuid; v_cfg jsonb := public.identity_settings_for(p_owner);
  v_s jsonb; v_score integer; v_band text; v_same_type boolean; v_id uuid; v_created boolean;
BEGIN
  IF p_x IS NULL OR p_y IS NULL OR p_x = p_y THEN RETURN jsonb_build_object('skipped', true, 'reason', 'same'); END IF;
  v_a := LEAST(p_x, p_y);
  v_b := GREATEST(p_x, p_y);

  IF EXISTS (SELECT 1 FROM public.duplicate_dismissals d
             WHERE d.user_id = p_owner AND d.kind = 'customers' AND d.a_id = v_a AND d.b_id = v_b) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'dismissed');
  END IF;

  SELECT (ca.customer_type = cb.customer_type) INTO v_same_type
  FROM public.customers ca, public.customers cb
  WHERE ca.id = v_a AND cb.id = v_b AND ca.user_id = p_owner AND cb.user_id = p_owner
    AND ca.deleted_at IS NULL AND cb.deleted_at IS NULL AND ca.merged_into_id IS NULL AND cb.merged_into_id IS NULL;
  IF v_same_type IS NULL THEN RETURN jsonb_build_object('skipped', true, 'reason', 'not_active'); END IF;

  v_s := public.identity_pair_score(p_owner, v_a, v_b);
  v_score := (v_s ->> 'score')::integer;
  IF v_score < (v_cfg ->> 'review')::integer THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'low_score', 'score', v_score);
  END IF;

  v_band := CASE WHEN v_score >= (v_cfg ->> 'auto')::integer
                  AND NOT (v_s ->> 'conflict')::boolean
                  AND (v_s ->> 'has_strong')::boolean
                  AND (v_s ->> 'signal_count')::integer >= 2
                  AND v_same_type
                 THEN 'auto_merge' ELSE 'review' END;

  INSERT INTO public.identity_match_candidates (user_id, a_id, b_id, score, band, signals, source, source_ref)
  VALUES (p_owner, v_a, v_b, v_score, v_band, v_s -> 'signals', COALESCE(p_source, 'system'), p_source_ref)
  ON CONFLICT (user_id, a_id, b_id) WHERE status = 'pending'
  DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, signals = EXCLUDED.signals, updated_at = now()
  RETURNING id, (xmax = 0) INTO v_id, v_created;

  RETURN jsonb_build_object('candidate_id', v_id, 'created', v_created, 'score', v_score, 'band', v_band,
                            'signals', v_s -> 'signals');
END $$;

CREATE OR REPLACE FUNCTION public.identity_enqueue_for_customer(p_owner uuid, p_customer uuid, p_source text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_n integer := 0; v_res jsonb;
BEGIN
  FOR r IN
    SELECT DISTINCT o.customer_id AS cid
    FROM public.customer_identity_keys k
    JOIN public.customer_identity_keys o
      ON o.user_id = k.user_id AND o.key_type = k.key_type AND o.key_value = k.key_value AND o.customer_id <> k.customer_id
    WHERE k.user_id = p_owner AND k.customer_id = p_customer
      AND (SELECT count(DISTINCT z.customer_id) FROM public.customer_identity_keys z
           WHERE z.user_id = k.user_id AND z.key_type = k.key_type AND z.key_value = k.key_value) <= 8
    LIMIT 5
  LOOP
    v_res := public.identity_enqueue_pair(p_owner, p_customer, r.cid, p_source, NULL);
    IF (v_res ->> 'candidate_id') IS NOT NULL THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;

-- Reuses merge_records() so the ledger and the 7-day undo behave exactly like a manual merge.
-- merge_records() authorises through auth.uid(); inside this transaction only, we act as the
-- account owner (GUCs are transaction-local and restored). Any failure falls back to the queue.
CREATE OR REPLACE FUNCTION public.identity_auto_merge(p_owner uuid, p_x uuid, p_y uuid, p_candidate uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_surv uuid; v_merged uuid; v_s jsonb; v_m jsonb; v_choices jsonb := '{}'::jsonb; v_col text;
  v_res jsonb; v_mid uuid; v_prev_sub text; v_prev_claims text;
BEGIN
  SELECT CASE WHEN (cx.created_at, cx.id) <= (cy.created_at, cy.id) THEN cx.id ELSE cy.id END,
         CASE WHEN (cx.created_at, cx.id) <= (cy.created_at, cy.id) THEN cy.id ELSE cx.id END
    INTO v_surv, v_merged
  FROM public.customers cx, public.customers cy
  WHERE cx.id = p_x AND cy.id = p_y AND cx.user_id = p_owner AND cy.user_id = p_owner
    AND cx.deleted_at IS NULL AND cy.deleted_at IS NULL AND cx.merged_into_id IS NULL AND cy.merged_into_id IS NULL;
  IF v_surv IS NULL THEN RETURN jsonb_build_object('merged', false, 'reason', 'not_active'); END IF;

  SELECT to_jsonb(t) INTO v_s FROM public.customers t WHERE t.id = v_surv;
  SELECT to_jsonb(t) INTO v_m FROM public.customers t WHERE t.id = v_merged;
  FOREACH v_col IN ARRAY ARRAY['phone', 'email', 'address'] LOOP
    IF btrim(COALESCE(v_s ->> v_col, '')) = '' AND btrim(COALESCE(v_m ->> v_col, '')) <> '' THEN
      v_choices := v_choices || jsonb_build_object(v_col, 'merged');
    END IF;
  END LOOP;

  v_prev_sub    := current_setting('request.jwt.claim.sub', true);
  v_prev_claims := current_setting('request.jwt.claims', true);
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
    PERFORM set_config('request.jwt.claims',
                       jsonb_build_object('sub', p_owner::text, 'role', 'authenticated')::text, true);
    v_res := public.merge_records('customers', v_surv, v_merged, v_choices);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
  EXCEPTION WHEN OTHERS THEN
    -- the sub-transaction rollback also restored the GUCs
    RETURN jsonb_build_object('merged', false, 'reason', 'merge_failed', 'error', SQLERRM);
  END;

  v_mid := (v_res ->> 'merge_id')::uuid;
  UPDATE public.record_merges SET merged_by = NULL, merged_by_email = 'system:identity-auto-merge' WHERE id = v_mid;
  UPDATE public.identity_match_candidates
     SET status = 'auto_merged', merge_id = v_mid, resolved_at = now(), updated_at = now()
   WHERE id = p_candidate;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (p_owner, NULL, 'system:identity-auto-merge', 'identity.auto_merge', 'customers',
          v_surv::text || '<-' || v_merged::text);

  RETURN jsonb_build_object('merged', true, 'survivor_id', v_surv, 'merged_id', v_merged, 'merge_id', v_mid);
END $$;

-- 7. Ingestion ----------------------------------------------------------------
-- link  : score >= 75, no conflict, and (>= 90 or clearly ahead of the runner-up) — a shared
--         household phone that matches two people is NOT linked blindly
-- learn : score >= 85, no conflict, >= 2 agreeing signals -> new identifiers are attached
-- merge : only via identity_enqueue_pair band 'auto_merge' (>= threshold, strong, no conflict)
CREATE OR REPLACE FUNCTION public.identity_ingest(
  p_owner uuid, p_phone text, p_email text, p_address text, p_name text,
  p_source text DEFAULT 'system', p_source_ref text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg jsonb; v_lookup jsonb; v_cands jsonb; v_best jsonb; v_second integer := 0;
  v_cid uuid; v_score integer; v_i integer; v_other uuid; v_pair jsonb; v_merge jsonb;
  v_registered integer := 0; v_queued integer := 0; v_merged jsonb := '[]'::jsonb; v_learn boolean;
BEGIN
  IF p_owner IS NULL THEN RETURN jsonb_build_object('status', 'no_owner'); END IF;
  v_cfg := public.identity_settings_for(p_owner);

  v_lookup := public.identity_lookup(p_owner, p_phone, p_email, p_address, p_name, 4);
  v_cands := COALESCE(v_lookup -> 'candidates', '[]'::jsonb);
  IF jsonb_typeof(v_cands) <> 'array' OR jsonb_array_length(v_cands) = 0 THEN
    RETURN jsonb_build_object('status', 'no_match');
  END IF;

  v_best  := v_cands -> 0;
  v_score := (v_best ->> 'score')::integer;
  IF jsonb_array_length(v_cands) > 1 THEN v_second := ((v_cands -> 1) ->> 'score')::integer; END IF;

  -- Ambiguity only matters for weak evidence (e.g. one phone shared by two people).
  -- A strong anchor (>= 90) that also touches a second customer is a bridging event: handled below.
  IF v_score < 75 OR (v_best ->> 'conflict')::boolean OR (v_score < 90 AND (v_score - v_second) < 15) THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_score >= 75 AND NOT (v_best ->> 'conflict')::boolean THEN 'ambiguous' ELSE 'weak_match' END,
      'score', v_score);
  END IF;

  v_cid := (v_best ->> 'customer_id')::uuid;

  -- Link the originating row (first writer wins; never overwrites a human decision).
  IF p_source_ref IS NOT NULL THEN
    BEGIN
      IF p_source = 'call' THEN
        UPDATE public.calls SET customer_id = v_cid
         WHERE id = p_source_ref::uuid AND user_id = p_owner AND customer_id IS NULL;
      ELSIF p_source = 'lead' THEN
        UPDATE public.leads SET customer_id = v_cid
         WHERE id = p_source_ref::uuid AND user_id = p_owner AND customer_id IS NULL;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN NULL;
    END;
  END IF;

  v_learn := v_score >= 85 AND (v_best ->> 'signal_count')::integer >= 2;
  IF v_learn THEN
    v_registered := public.identity_register_keys(p_owner, v_cid, p_phone, p_email, p_address, 'ingest_' || COALESCE(p_source, 'system'));

    FOR v_i IN 1 .. jsonb_array_length(v_cands) - 1 LOOP
      v_other := ((v_cands -> v_i) ->> 'customer_id')::uuid;
      v_pair := public.identity_enqueue_pair(p_owner, v_cid, v_other, p_source, p_source_ref);
      IF (v_pair ->> 'candidate_id') IS NOT NULL THEN
        IF (v_cfg ->> 'auto_enabled')::boolean AND v_pair ->> 'band' = 'auto_merge' THEN
          v_merge := public.identity_auto_merge(p_owner, v_cid, v_other, (v_pair ->> 'candidate_id')::uuid);
          IF COALESCE((v_merge ->> 'merged')::boolean, false) THEN
            v_merged := v_merged || jsonb_build_array(v_merge);
            v_cid := (v_merge ->> 'survivor_id')::uuid;
          ELSE
            v_queued := v_queued + 1;
          END IF;
        ELSE
          v_queued := v_queued + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  PERFORM public.identity_refresh_household(p_owner, v_cid);

  RETURN jsonb_build_object('status', 'linked', 'customer_id', v_cid, 'score', v_score,
                            'registered', v_registered, 'queued', v_queued, 'merged', v_merged);
END $$;

-- 8. Triggers (never block the write that fired them) ----------------------------

CREATE OR REPLACE FUNCTION public.trg_calls_identity_ingest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.identity_ingest(NEW.user_id, NEW.caller_phone, NULL, NULL, NEW.caller_name, 'call', NEW.id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'identity ingest skipped for call %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_calls_identity_ingest ON public.calls;
CREATE TRIGGER trg_calls_identity_ingest
  AFTER INSERT OR UPDATE OF caller_phone, caller_name ON public.calls
  FOR EACH ROW WHEN (NEW.caller_phone IS NOT NULL AND NEW.customer_id IS NULL)
  EXECUTE FUNCTION public.trg_calls_identity_ingest();

CREATE OR REPLACE FUNCTION public.trg_leads_identity_ingest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.identity_ingest(NEW.user_id, NEW.phone, NEW.email, NULL, NEW.name, 'lead', NEW.id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'identity ingest skipped for lead %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_leads_identity_ingest ON public.leads;
CREATE TRIGGER trg_leads_identity_ingest
  AFTER INSERT ON public.leads
  FOR EACH ROW WHEN (NEW.customer_id IS NULL AND (NEW.phone IS NOT NULL OR NEW.email IS NOT NULL))
  EXECUTE FUNCTION public.trg_leads_identity_ingest();

-- Keeps the key table in sync with every customer write (UI, imports, forms). Queue only, never merges:
-- the row may have just been created by a caller that still holds its id.
CREATE OR REPLACE FUNCTION public.trg_customers_identity_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.identity_register_keys(NEW.user_id, NEW.id, NEW.phone, NEW.email, NEW.address, 'customer_record');
    PERFORM public.identity_refresh_household(NEW.user_id, NEW.id);
    PERFORM public.identity_enqueue_for_customer(NEW.user_id, NEW.id, 'customer_record');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'identity sync skipped for customer %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customers_identity_sync ON public.customers;
CREATE TRIGGER trg_customers_identity_sync
  AFTER INSERT OR UPDATE OF name, phone, email, address ON public.customers
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL AND NEW.merged_into_id IS NULL)
  EXECUTE FUNCTION public.trg_customers_identity_sync();

-- Duplicates feature <-> queue coordination.
CREATE OR REPLACE FUNCTION public.trg_identity_on_merge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.kind = 'customers' THEN
      IF TG_OP = 'INSERT' THEN
        UPDATE public.identity_match_candidates
           SET status = 'merged', merge_id = NEW.id, resolved_at = now(), updated_at = now()
         WHERE user_id = NEW.user_id AND status = 'pending'
           AND a_id = LEAST(NEW.survivor_id, NEW.merged_id) AND b_id = GREATEST(NEW.survivor_id, NEW.merged_id);
        UPDATE public.identity_match_candidates
           SET status = 'superseded', resolved_at = now(), updated_at = now()
         WHERE user_id = NEW.user_id AND status = 'pending' AND (a_id = NEW.merged_id OR b_id = NEW.merged_id);
      ELSIF TG_OP = 'UPDATE' AND NEW.status = 'unmerged' AND OLD.status IS DISTINCT FROM 'unmerged' THEN
        -- The user said "these are different people": never auto-merge them again.
        INSERT INTO public.duplicate_dismissals (user_id, kind, a_id, b_id, dismissed_by)
        VALUES (NEW.user_id, 'customers', LEAST(NEW.survivor_id, NEW.merged_id), GREATEST(NEW.survivor_id, NEW.merged_id), NEW.unmerged_by)
        ON CONFLICT DO NOTHING;
        UPDATE public.identity_match_candidates
           SET status = 'dismissed', resolved_at = now(), updated_at = now()
         WHERE user_id = NEW.user_id AND status IN ('merged', 'auto_merged')
           AND a_id = LEAST(NEW.survivor_id, NEW.merged_id) AND b_id = GREATEST(NEW.survivor_id, NEW.merged_id);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'identity merge sync skipped: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_identity_on_merge ON public.record_merges;
CREATE TRIGGER trg_identity_on_merge
  AFTER INSERT OR UPDATE OF status ON public.record_merges
  FOR EACH ROW EXECUTE FUNCTION public.trg_identity_on_merge();

CREATE OR REPLACE FUNCTION public.trg_identity_on_dismiss()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.kind = 'customers' THEN
    UPDATE public.identity_match_candidates
       SET status = 'dismissed', resolved_at = now(), updated_at = now()
     WHERE user_id = NEW.user_id AND status = 'pending' AND a_id = NEW.a_id AND b_id = NEW.b_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_identity_on_dismiss ON public.duplicate_dismissals;
CREATE TRIGGER trg_identity_on_dismiss
  AFTER INSERT ON public.duplicate_dismissals
  FOR EACH ROW EXECUTE FUNCTION public.trg_identity_on_dismiss();

-- 9. Dashboard RPCs ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.customer_identity_profile(p_customer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_hh uuid; v_keys jsonb; v_house jsonb := NULL; v_cands jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers
                 WHERE id = p_customer AND user_id = v_owner AND deleted_at IS NULL AND merged_into_id IS NULL) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  v_hh := public.identity_refresh_household(v_owner, p_customer);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', k.id, 'type', k.key_type, 'value', k.key_value, 'raw', k.raw_value, 'source', k.source,
           'is_primary', k.is_primary, 'seen_count', k.seen_count, 'last_seen_at', k.last_seen_at)
           ORDER BY k.key_type, k.is_primary DESC, k.last_seen_at DESC), '[]'::jsonb)
    INTO v_keys
  FROM public.customer_identity_keys k
  WHERE k.customer_id = p_customer AND k.user_id = v_owner;

  IF v_hh IS NOT NULL THEN
    SELECT jsonb_build_object('id', h.id, 'name', h.name, 'members', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'customer_id', m.customer_id, 'name', c.name, 'phone', c.phone, 'email', c.email,
                      'role', m.role, 'status', m.status, 'source', m.source, 'confidence', m.confidence,
                      'is_self', m.customer_id = p_customer) ORDER BY (m.customer_id = p_customer) DESC, c.name)
             FROM public.customer_household_members m
             JOIN public.customers c ON c.id = m.customer_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
             WHERE m.household_id = h.id AND (m.status <> 'rejected' OR m.customer_id = p_customer)), '[]'::jsonb))
      INTO v_house
    FROM public.customer_households h WHERE h.id = v_hh AND h.user_id = v_owner;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', m.id, 'other_id', c.id, 'other_name', c.name, 'score', m.score, 'band', m.band,
           'signals', m.signals, 'created_at', m.created_at) ORDER BY m.score DESC), '[]'::jsonb)
    INTO v_cands
  FROM public.identity_match_candidates m
  JOIN public.customers c ON c.id = CASE WHEN m.a_id = p_customer THEN m.b_id ELSE m.a_id END
                         AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
  WHERE m.user_id = v_owner AND m.status = 'pending' AND (m.a_id = p_customer OR m.b_id = p_customer);

  RETURN jsonb_build_object('customer_id', p_customer, 'keys', v_keys, 'household', v_house, 'candidates', v_cands);
END $$;

CREATE OR REPLACE FUNCTION public.identity_list_candidates(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, a_id uuid, b_id uuid, score integer, band text, signals jsonb, source text,
  created_at timestamptz, a jsonb, b jsonb, total_count bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.id, m.a_id, m.b_id, m.score, m.band, m.signals, m.source, m.created_at,
         jsonb_build_object('id', ca.id, 'name', ca.name, 'phone', ca.phone, 'email', ca.email,
                            'address', ca.address, 'customer_type', ca.customer_type, 'created_at', ca.created_at),
         jsonb_build_object('id', cb.id, 'name', cb.name, 'phone', cb.phone, 'email', cb.email,
                            'address', cb.address, 'customer_type', cb.customer_type, 'created_at', cb.created_at),
         count(*) OVER ()
  FROM public.identity_match_candidates m
  JOIN public.customers ca ON ca.id = m.a_id AND ca.deleted_at IS NULL AND ca.merged_into_id IS NULL
  JOIN public.customers cb ON cb.id = m.b_id AND cb.deleted_at IS NULL AND cb.merged_into_id IS NULL
  WHERE m.user_id = v_owner AND m.status = 'pending'
  ORDER BY m.score DESC, m.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END $$;

CREATE OR REPLACE FUNCTION public.identity_dismiss_candidate(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_a uuid; v_b uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.identity_match_candidates
     SET status = 'dismissed', resolved_at = now(), resolved_by = auth.uid(), updated_at = now()
   WHERE id = p_id AND user_id = v_owner AND status = 'pending'
  RETURNING a_id, b_id INTO v_a, v_b;
  IF v_a IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.duplicate_dismissals (user_id, kind, a_id, b_id, dismissed_by)
  VALUES (v_owner, 'customers', v_a, v_b, auth.uid()) ON CONFLICT DO NOTHING;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          'identity.dismiss', 'customers', v_a::text || ',' || v_b::text);
END $$;

CREATE OR REPLACE FUNCTION public.identity_household_set_status(p_household uuid, p_customer uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('suggested', 'confirmed', 'rejected') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.customer_household_members
     SET status = p_status, source = CASE WHEN p_status = 'confirmed' THEN 'manual' ELSE source END
   WHERE household_id = p_household AND customer_id = p_customer AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.identity_get_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  RETURN public.identity_settings_for(v_owner);
END $$;

CREATE OR REPLACE FUNCTION public.identity_save_settings(p_auto_enabled boolean, p_auto_threshold integer, p_review_threshold integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_duplicates() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_auto_threshold IS NULL OR p_auto_threshold NOT BETWEEN 90 AND 100
     OR p_review_threshold IS NULL OR p_review_threshold NOT BETWEEN 40 AND 89
     OR p_review_threshold >= p_auto_threshold THEN
    RAISE EXCEPTION 'invalid_threshold' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.identity_settings (user_id, auto_merge_enabled, auto_merge_threshold, review_threshold)
  VALUES (v_owner, COALESCE(p_auto_enabled, true), p_auto_threshold, p_review_threshold)
  ON CONFLICT (user_id) DO UPDATE
    SET auto_merge_enabled = EXCLUDED.auto_merge_enabled,
        auto_merge_threshold = EXCLUDED.auto_merge_threshold,
        review_threshold = EXCLUDED.review_threshold,
        updated_at = now();
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()),
          'identity.settings', 'identity_settings', v_owner::text);
  RETURN public.identity_settings_for(v_owner);
END $$;

-- 10. Grants ---------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.identity_settings_for(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_register_keys(uuid, uuid, text, text, text, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_pair_score(uuid, uuid, uuid)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_lookup(uuid, text, text, text, text, integer)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_refresh_household(uuid, uuid)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_enqueue_pair(uuid, uuid, uuid, text, text)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_enqueue_for_customer(uuid, uuid, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_auto_merge(uuid, uuid, uuid, uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_ingest(uuid, text, text, text, text, text, text)     FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.identity_lookup(uuid, text, text, text, text, integer)     TO service_role;
GRANT EXECUTE ON FUNCTION public.identity_ingest(uuid, text, text, text, text, text, text)  TO service_role;

REVOKE ALL ON FUNCTION public.customer_identity_profile(uuid)                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.identity_list_candidates(integer, integer)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.identity_dismiss_candidate(uuid)                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.identity_household_set_status(uuid, uuid, text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.identity_get_settings()                                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.identity_save_settings(boolean, integer, integer)      FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.customer_identity_profile(uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.identity_list_candidates(integer, integer)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.identity_dismiss_candidate(uuid)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.identity_household_set_status(uuid, uuid, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.identity_get_settings()                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.identity_save_settings(boolean, integer, integer)   TO authenticated;
