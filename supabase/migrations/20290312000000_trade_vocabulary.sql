-- Trade vocabulary library (task 131).
--
-- A versioned glossary per trade and per regional dialect (terms, synonyms, brand/model names, pronunciation hints) that
-- feeds the live voice prompt ({{trade_vocabulary}}) and, once verified, STT keyterm biasing.
--
-- SCOPE: platform-owned reference content. It holds NO tenant data and NO personal data, so there is no per-account
-- column (no user_id / accountOwnerId) by design. Only Vireek staff (public.is_vireek_staff) can read or change it;
-- the voice webhook reads published versions with the service role.
--
--   trade_vocab_entries       editable working set (one row per trade + dialect + term). Retire, never delete.
--   trade_vocab_versions      IMMUTABLE published snapshots. The runtime only ever reads these.
--   trade_vocab_eval_runs     measured before/after results recorded from scripts/voice/trade-vocab-eval.mjs. Real numbers only.
--
-- Depends on: public.is_vireek_staff(uuid) (20260913020000_live_chat_and_academy.sql).
-- Idempotent: safe to run twice.
-- rollback: run the manual drop list below (destroys the glossary and its history; export trade_vocab_* first).
-- ROLLBACK (manual; destroys the glossary and its history):
--   drop function if exists public.trade_vocab_record_eval(text, text, uuid, text, text, integer, integer, integer, numeric, numeric, numeric, numeric, text);
--   drop function if exists public.trade_vocab_publish(text, text, text);
--   drop function if exists public.trade_vocab_upsert_entry(uuid, text, text, text, text, text[], text, smallint, text);
--   drop table if exists public.trade_vocab_eval_runs;
--   drop table if exists public.trade_vocab_versions;
--   drop table if exists public.trade_vocab_entries;
--   drop function if exists public.trade_vocab_versions_immutable();

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Working set
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trade_vocab_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade text NOT NULL CHECK (trade ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- 'en' applies to every English dialect; 'en-US' / 'en-GB' / 'es-MX' refine it. Same shape as BCP-47 language[-REGION].
  dialect text NOT NULL DEFAULT 'en' CHECK (dialect ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  term text NOT NULL CHECK (char_length(term) BETWEEN 2 AND 80 AND term = btrim(term) AND term !~ '[\x01-\x1f\x7f{}<>`"\\]' AND cardinality(regexp_split_to_array(term, ' ')) <= 6),
  category text NOT NULL DEFAULT 'term' CHECK (category IN ('term', 'brand', 'model', 'part', 'slang')),
  synonyms text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(synonyms) <= 12 AND array_to_string(synonyms, ' ') !~ '[\x01-\x1f\x7f{}<>`"\\]'),
  pronunciation_hint text CHECK (pronunciation_hint IS NULL OR (char_length(pronunciation_hint) BETWEEN 1 AND 120 AND pronunciation_hint !~ '[\x01-\x1f\x7f{}<>`"\\]')),
  boost smallint NOT NULL DEFAULT 1 CHECK (boost BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trade_vocab_entries_key_uidx ON public.trade_vocab_entries (trade, dialect, lower(term));
CREATE INDEX IF NOT EXISTS trade_vocab_entries_scope_idx ON public.trade_vocab_entries (trade, dialect, status);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Immutable published snapshots
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trade_vocab_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade text NOT NULL CHECK (trade ~ '^[a-z][a-z0-9_]{1,31}$'),
  dialect text NOT NULL CHECK (dialect ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  version integer NOT NULL CHECK (version >= 1),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 500),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade, dialect, version)
);
CREATE INDEX IF NOT EXISTS trade_vocab_versions_latest_idx ON public.trade_vocab_versions (trade, dialect, version DESC);

CREATE OR REPLACE FUNCTION public.trade_vocab_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'trade_vocab_versions rows are immutable' USING errcode = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trade_vocab_versions_no_change ON public.trade_vocab_versions;
CREATE TRIGGER trade_vocab_versions_no_change
  BEFORE UPDATE OR DELETE ON public.trade_vocab_versions
  FOR EACH ROW EXECUTE FUNCTION public.trade_vocab_versions_immutable();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Measured evaluation runs (written only with numbers produced by scripts/voice/trade-vocab-eval.mjs)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trade_vocab_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade text NOT NULL CHECK (trade ~ '^[a-z][a-z0-9_]{1,31}$'),
  dialect text NOT NULL CHECK (dialect ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  version_id uuid REFERENCES public.trade_vocab_versions(id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  dataset_ref text CHECK (dataset_ref IS NULL OR char_length(dataset_ref) <= 200),   -- pointer to the labeled set, never its content
  n_calls integer NOT NULL CHECK (n_calls >= 1),
  n_ref_words integer NOT NULL CHECK (n_ref_words >= 1),
  n_term_occurrences integer NOT NULL CHECK (n_term_occurrences >= 0),
  baseline_wer numeric NOT NULL CHECK (baseline_wer >= 0),
  biased_wer numeric NOT NULL CHECK (biased_wer >= 0),
  baseline_term_recall numeric CHECK (baseline_term_recall IS NULL OR baseline_term_recall BETWEEN 0 AND 1),
  biased_term_recall numeric CHECK (biased_term_recall IS NULL OR biased_term_recall BETWEEN 0 AND 1),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_vocab_eval_runs_scope_idx ON public.trade_vocab_eval_runs (trade, dialect, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. RLS + grants: staff can read; nobody writes directly; writes go through the RPCs below
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE public.trade_vocab_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_vocab_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_vocab_eval_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trade_vocab_entries_staff_select" ON public.trade_vocab_entries;
CREATE POLICY "trade_vocab_entries_staff_select" ON public.trade_vocab_entries
  FOR SELECT TO authenticated USING (public.is_vireek_staff((SELECT auth.uid())));
DROP POLICY IF EXISTS "trade_vocab_versions_staff_select" ON public.trade_vocab_versions;
CREATE POLICY "trade_vocab_versions_staff_select" ON public.trade_vocab_versions
  FOR SELECT TO authenticated USING (public.is_vireek_staff((SELECT auth.uid())));
DROP POLICY IF EXISTS "trade_vocab_eval_runs_staff_select" ON public.trade_vocab_eval_runs;
CREATE POLICY "trade_vocab_eval_runs_staff_select" ON public.trade_vocab_eval_runs
  FOR SELECT TO authenticated USING (public.is_vireek_staff((SELECT auth.uid())));

REVOKE ALL ON public.trade_vocab_entries, public.trade_vocab_versions, public.trade_vocab_eval_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trade_vocab_entries, public.trade_vocab_versions, public.trade_vocab_eval_runs TO authenticated;
GRANT SELECT ON public.trade_vocab_versions TO service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Staff RPCs
-- ---------------------------------------------------------------------------------------------------------------

-- Create or update one entry. p_id NULL = upsert by (trade, dialect, lower(term)); p_id set = edit that row.
-- Text is trimmed and whitespace-collapsed; synonyms are de-duplicated case-insensitively and never repeat the term.
CREATE OR REPLACE FUNCTION public.trade_vocab_upsert_entry(
  p_id uuid,
  p_trade text,
  p_dialect text,
  p_term text,
  p_category text DEFAULT 'term',
  p_synonyms text[] DEFAULT '{}',
  p_pronunciation_hint text DEFAULT NULL,
  p_boost smallint DEFAULT 1,
  p_status text DEFAULT 'active'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_term text;
  v_hint text;
  v_syn text[];
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;

  -- Refuse (do not flatten) line breaks / control characters, and sentences: an entry is a word or a short phrase.
  IF COALESCE(p_term, '') ~ '[\x01-\x1f\x7f]' OR COALESCE(p_pronunciation_hint, '') ~ '[\x01-\x1f\x7f]'
     OR array_to_string(COALESCE(p_synonyms, '{}'::text[]), ' ') ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'invalid_text' USING errcode = '22023';
  END IF;

  v_term := regexp_replace(btrim(COALESCE(p_term, '')), '\s+', ' ', 'g');
  IF cardinality(regexp_split_to_array(v_term, ' ')) > 6 THEN
    RAISE EXCEPTION 'term_too_long' USING errcode = '22023';
  END IF;
  v_hint := NULLIF(regexp_replace(btrim(COALESCE(p_pronunciation_hint, '')), '\s+', ' ', 'g'), '');

  SELECT COALESCE(array_agg(d.s ORDER BY lower(d.s)), '{}'::text[])
    INTO v_syn
    FROM (
      SELECT DISTINCT ON (lower(c.s)) c.s
        FROM (
          SELECT regexp_replace(btrim(x), '\s+', ' ', 'g') AS s
            FROM unnest(COALESCE(p_synonyms, '{}'::text[])) AS x
        ) c
       WHERE c.s <> '' AND char_length(c.s) <= 60 AND cardinality(regexp_split_to_array(c.s, ' ')) <= 6 AND lower(c.s) <> lower(v_term)
       ORDER BY lower(c.s), c.s
    ) d;

  IF p_id IS NULL THEN
    INSERT INTO public.trade_vocab_entries AS e
      (trade, dialect, term, category, synonyms, pronunciation_hint, boost, status, created_by, updated_by)
    VALUES
      (p_trade, p_dialect, v_term, p_category, v_syn, v_hint, p_boost, p_status, v_uid, v_uid)
    ON CONFLICT (trade, dialect, lower(term)) DO UPDATE
      SET category = EXCLUDED.category,
          synonyms = EXCLUDED.synonyms,
          pronunciation_hint = EXCLUDED.pronunciation_hint,
          boost = EXCLUDED.boost,
          status = EXCLUDED.status,
          updated_by = v_uid,
          updated_at = now()
    RETURNING e.id INTO v_id;
  ELSE
    UPDATE public.trade_vocab_entries e
       SET trade = p_trade, dialect = p_dialect, term = v_term, category = p_category, synonyms = v_syn,
           pronunciation_hint = v_hint, boost = p_boost, status = p_status, updated_by = v_uid, updated_at = now()
     WHERE e.id = p_id
    RETURNING e.id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'not_found' USING errcode = 'P0002';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- Publish the ACTIVE entries of one (trade, dialect) as the next immutable version.
-- Idempotent: if the active set is byte-identical to the latest version nothing new is created (created = false).
-- Serialised per scope with an advisory lock; the UNIQUE (trade, dialect, version) constraint is the backstop.
CREATE OR REPLACE FUNCTION public.trade_vocab_publish(p_trade text, p_dialect text, p_note text DEFAULT NULL)
RETURNS TABLE (version_id uuid, version_no integer, content_sha256 text, entry_count integer, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entries jsonb;
  v_hash text;
  v_latest_id uuid;
  v_latest_ver integer;
  v_latest_hash text;
  v_latest_entries jsonb;
  v_next integer;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF p_trade IS NULL OR p_trade !~ '^[a-z][a-z0-9_]{1,31}$' OR p_dialect IS NULL OR p_dialect !~ '^[a-z]{2}(-[A-Z]{2})?$' THEN
    RAISE EXCEPTION 'invalid_scope' USING errcode = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('trade_vocab:' || p_trade || ':' || p_dialect, 0));

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'term', e.term, 'category', e.category, 'synonyms', to_jsonb(e.synonyms),
             'pronunciation_hint', e.pronunciation_hint, 'boost', e.boost
           ) ORDER BY lower(e.term)), '[]'::jsonb)
    INTO v_entries
    FROM public.trade_vocab_entries e
   WHERE e.trade = p_trade AND e.dialect = p_dialect AND e.status = 'active';

  IF jsonb_array_length(v_entries) > 500 THEN
    RAISE EXCEPTION 'too_many_entries' USING errcode = '54000';
  END IF;

  v_hash := encode(sha256(convert_to(v_entries::text, 'UTF8')), 'hex');

  SELECT v.id, v.version, v.content_hash, v.entries
    INTO v_latest_id, v_latest_ver, v_latest_hash, v_latest_entries
    FROM public.trade_vocab_versions v
   WHERE v.trade = p_trade AND v.dialect = p_dialect
   ORDER BY v.version DESC
   LIMIT 1;

  IF v_latest_id IS NOT NULL AND v_latest_hash = v_hash THEN
    RETURN QUERY SELECT v_latest_id, v_latest_ver, v_latest_hash, jsonb_array_length(v_latest_entries), false;
    RETURN;
  END IF;
  IF v_latest_id IS NULL AND jsonb_array_length(v_entries) = 0 THEN
    RAISE EXCEPTION 'nothing_to_publish' USING errcode = '22023';
  END IF;

  v_next := COALESCE(v_latest_ver, 0) + 1;
  INSERT INTO public.trade_vocab_versions (trade, dialect, version, entries, content_hash, note, published_by)
  VALUES (p_trade, p_dialect, v_next, v_entries, v_hash, NULLIF(btrim(COALESCE(p_note, '')), ''), v_uid)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_next, v_hash, jsonb_array_length(v_entries), true;
END;
$$;

-- Record one measured evaluation run. The numbers must come from scripts/voice/trade-vocab-eval.mjs.
CREATE OR REPLACE FUNCTION public.trade_vocab_record_eval(
  p_trade text,
  p_dialect text,
  p_version_id uuid,
  p_label text,
  p_dataset_ref text,
  p_n_calls integer,
  p_n_ref_words integer,
  p_n_term_occurrences integer,
  p_baseline_wer numeric,
  p_biased_wer numeric,
  p_baseline_term_recall numeric,
  p_biased_term_recall numeric,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF p_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.trade_vocab_versions v WHERE v.id = p_version_id AND v.trade = p_trade AND v.dialect = p_dialect
  ) THEN
    RAISE EXCEPTION 'version_scope_mismatch' USING errcode = '22023';
  END IF;

  INSERT INTO public.trade_vocab_eval_runs
    (trade, dialect, version_id, label, dataset_ref, n_calls, n_ref_words, n_term_occurrences,
     baseline_wer, biased_wer, baseline_term_recall, biased_term_recall, notes, created_by)
  VALUES
    (p_trade, p_dialect, p_version_id, btrim(COALESCE(p_label, '')), NULLIF(btrim(COALESCE(p_dataset_ref, '')), ''),
     p_n_calls, p_n_ref_words, p_n_term_occurrences, p_baseline_wer, p_biased_wer,
     p_baseline_term_recall, p_biased_term_recall, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.trade_vocab_upsert_entry(uuid, text, text, text, text, text[], text, smallint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trade_vocab_publish(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trade_vocab_record_eval(text, text, uuid, text, text, integer, integer, integer, numeric, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trade_vocab_upsert_entry(uuid, text, text, text, text, text[], text, smallint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trade_vocab_publish(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trade_vocab_record_eval(text, text, uuid, text, text, integer, integer, integer, numeric, numeric, numeric, numeric, text) TO authenticated;
