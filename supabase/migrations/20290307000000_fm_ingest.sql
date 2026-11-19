-- FM-portal ingestion (Phase 1b): forwarded-email + PDF intake and rejection-learning drafts.
--
-- Adds, on top of the Work-Order Guard layer (20280215000000_work_order_guard.sql):
--   1. wog_ingest_items        every inbound email / PDF: sanitized text, SHA-256, original kept in storage.
--   2. fm-ingest-originals     PRIVATE bucket. Writes are service-role only (the edge functions validate first);
--                              managers of the owning account may read/download their own originals.
--   3. wog_rule_suggestions    tenant-scoped DRAFTS produced by rejection learning. They are inert: nothing here
--                              touches the global compliance catalog (staff-only) and nothing is ever enforced.
--
-- Nothing is imported automatically: an ingested item waits for a manager to review it and press Import
-- (which goes through the existing wog_import_orders RPC).
--
-- Rollback (data loss for these tables only):
--   DROP FUNCTION IF EXISTS public.wog_rule_suggestion_save(jsonb), public.wog_rule_suggestion_set_status(uuid, text),
--     public.wog_rule_suggestion_delete(uuid), public.wog_ingest_store(uuid, uuid, jsonb),
--     public.wog_ingest_discard(uuid, uuid), public.wog_ingest_mark(uuid, text, uuid);
--   DROP TABLE IF EXISTS public.wog_rule_suggestions, public.wog_ingest_items;
--   DELETE FROM storage.objects WHERE bucket_id = 'fm-ingest-originals'; DELETE FROM storage.buckets WHERE id = 'fm-ingest-originals';

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.wog_ingest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                   -- account owner (tenant key)
  channel text NOT NULL CHECK (channel IN ('email', 'pdf')),
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'needs_ocr', 'rejected', 'imported', 'dismissed')),
  reject_code text CHECK (reject_code IS NULL OR char_length(reject_code) <= 40),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  original_path text CHECK (original_path IS NULL OR char_length(original_path) <= 300),
  original_name text CHECK (original_name IS NULL OR char_length(original_name) <= 100),
  original_bytes integer CHECK (original_bytes IS NULL OR original_bytes BETWEEN 0 AND 10485760),
  sender text CHECK (sender IS NULL OR char_length(sender) <= 254),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 300),
  text_content text CHECK (text_content IS NULL OR char_length(text_content) <= 200000),
  text_truncated boolean NOT NULL DEFAULT false,
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 0 AND 1000),
  sanitize_stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sanitize_stats) = 'object'),
  batch_id uuid REFERENCES public.wog_import_batches(id) ON DELETE SET NULL,
  created_by uuid,                                         -- null = inbound email (no signed-in actor)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_sha256)                         -- same bytes twice = one item (idempotent forwards)
);
CREATE INDEX IF NOT EXISTS idx_wog_ingest_items_user ON public.wog_ingest_items (user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_wog_ingest_items_touch ON public.wog_ingest_items;
CREATE TRIGGER trg_wog_ingest_items_touch BEFORE UPDATE ON public.wog_ingest_items
  FOR EACH ROW EXECUTE FUNCTION public.wog_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.wog_rule_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  candidate_key text NOT NULL CHECK (char_length(candidate_key) BETWEEN 1 AND 40 AND candidate_key ~ '^[a-z0-9-]+$'),
  kind text NOT NULL CHECK (kind IN ('fm_nte_cap', 'fm_proposal_before_parts', 'fm_invoice_deadline', 'fm_ineligibility_window',
                                     'fm_prohibited_line_item', 'fm_single_invoice', 'fm_required_attachment')),
  suggested_params jsonb NOT NULL CHECK (jsonb_typeof(suggested_params) = 'object' AND octet_length(suggested_params::text) <= 2000),
  evidence_count integer NOT NULL CHECK (evidence_count BETWEEN 1 AND 100000),
  example_reasons text[] NOT NULL DEFAULT '{}' CHECK (cardinality(example_reasons) <= 3),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'dismissed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, candidate_key)
);
CREATE INDEX IF NOT EXISTS idx_wog_rule_suggestions_user ON public.wog_rule_suggestions (user_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_wog_rule_suggestions_touch ON public.wog_rule_suggestions;
CREATE TRIGGER trg_wog_rule_suggestions_touch BEFORE UPDATE ON public.wog_rule_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.wog_touch_updated_at();

-- =============================================================
-- RLS + GRANTS (read-only for clients, writes only through RPCs)
-- =============================================================
ALTER TABLE public.wog_ingest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wog_rule_suggestions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wog_ingest_items, public.wog_rule_suggestions FROM anon, authenticated;
GRANT SELECT ON public.wog_ingest_items, public.wog_rule_suggestions TO authenticated;

DROP POLICY IF EXISTS "wog_ingest_items_select" ON public.wog_ingest_items;
CREATE POLICY "wog_ingest_items_select" ON public.wog_ingest_items FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_ingest_items.user_id AND c.can_manage));

DROP POLICY IF EXISTS "wog_rule_suggestions_select" ON public.wog_rule_suggestions;
CREATE POLICY "wog_rule_suggestions_select" ON public.wog_rule_suggestions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.owner_id = wog_rule_suggestions.user_id AND c.can_manage));

-- =============================================================
-- PRIVATE STORAGE for originals
-- =============================================================
-- Path: {owner_id}/{item_id}.pdf | .json. Only the edge functions (service role) write. The MIME list is
-- enforced by Storage; the functions ALSO verify magic bytes before uploading.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fm-ingest-originals', 'fm-ingest-originals', false, 8388608, ARRAY['application/pdf', 'application/json'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "fm_ingest_originals_select" ON storage.objects;
CREATE POLICY "fm_ingest_originals_select" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'fm-ingest-originals'
  AND EXISTS (SELECT 1 FROM public.wog_ctx() c WHERE c.can_manage AND (storage.foldername(name))[1] = c.owner_id::text)
);
-- No INSERT / UPDATE / DELETE policy on purpose: originals are append-only evidence for the browser.

-- =============================================================
-- SERVICE-ROLE RPCs (edge functions only)
-- =============================================================

-- Stores one ingested item. Idempotent on (owner, sha256). Enforces a per-owner hourly rate and a total quota.
-- p keys: id, channel, status, reject_code, content_sha256, original_path, original_name, original_bytes,
--         sender, subject, text_content, text_truncated, page_count, sanitize_stats
-- Returns {ok:true, id, duplicate, status} | {ok:false, reason:'rate_limited'|'quota'|'invalid'}.
CREATE OR REPLACE FUNCTION public.wog_ingest_store(p_owner uuid, p_actor uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_existing public.wog_ingest_items;
  v_status text := COALESCE(p ->> 'status', 'ready');
BEGIN
  IF p_owner IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF v_status NOT IN ('ready', 'needs_ocr', 'rejected') OR COALESCE(p ->> 'channel', '') NOT IN ('email', 'pdf')
     OR COALESCE(p ->> 'content_sha256', '') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- One advisory lock per owner serialises the counters below (cheap: only ingestion calls take it).
  PERFORM pg_advisory_xact_lock(hashtextextended('wog_ingest:' || p_owner::text, 0));

  SELECT * INTO v_existing FROM public.wog_ingest_items
    WHERE user_id = p_owner AND content_sha256 = p ->> 'content_sha256';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', v_existing.id, 'status', v_existing.status);
  END IF;

  IF (SELECT count(*) FROM public.wog_ingest_items WHERE user_id = p_owner AND created_at > now() - interval '1 hour') >= 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;
  IF (SELECT count(*) FROM public.wog_ingest_items WHERE user_id = p_owner) >= 5000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quota');
  END IF;

  v_id := COALESCE(NULLIF(p ->> 'id', '')::uuid, gen_random_uuid());
  INSERT INTO public.wog_ingest_items (
    id, user_id, channel, status, reject_code, content_sha256, original_path, original_name, original_bytes,
    sender, subject, text_content, text_truncated, page_count, sanitize_stats, created_by
  ) VALUES (
    v_id, p_owner, p ->> 'channel', v_status, left(p ->> 'reject_code', 40), p ->> 'content_sha256',
    left(p ->> 'original_path', 300), left(p ->> 'original_name', 100), NULLIF(p ->> 'original_bytes', '')::integer,
    left(p ->> 'sender', 254), left(p ->> 'subject', 300), left(p ->> 'text_content', 200000),
    COALESCE((p ->> 'text_truncated')::boolean, false), NULLIF(p ->> 'page_count', '')::integer,
    CASE WHEN jsonb_typeof(p -> 'sanitize_stats') = 'object' THEN p -> 'sanitize_stats' ELSE '{}'::jsonb END, p_actor
  );
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'status', v_status);
END;
$$;

-- Used only when the original could not be uploaded after the row was written.
CREATE OR REPLACE FUNCTION public.wog_ingest_discard(p_owner uuid, p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.wog_ingest_items WHERE id = p_id AND user_id = p_owner AND status <> 'imported';
$$;

REVOKE ALL ON FUNCTION public.wog_ingest_store(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wog_ingest_discard(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wog_ingest_store(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.wog_ingest_discard(uuid, uuid) TO service_role;

-- =============================================================
-- MANAGER RPCs
-- =============================================================

-- Moves an item through its review lifecycle. ready|needs_ocr|rejected -> dismissed; ready -> imported (needs the batch).
CREATE OR REPLACE FUNCTION public.wog_ingest_mark(p_id uuid, p_status text, p_batch_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  v_item public.wog_ingest_items;
BEGIN
  IF p_status NOT IN ('imported', 'dismissed') THEN
    RAISE EXCEPTION 'status_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.wog_ingest_items WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status = 'imported' THEN RAISE EXCEPTION 'already_imported' USING ERRCODE = '22023'; END IF;
  IF p_status = 'imported' THEN
    IF v_item.status <> 'ready' THEN RAISE EXCEPTION 'not_importable' USING ERRCODE = '22023'; END IF;
    IF p_batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.wog_import_batches WHERE id = p_batch_id AND user_id = v_owner) THEN
      RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  UPDATE public.wog_ingest_items
     SET status = p_status, batch_id = CASE WHEN p_status = 'imported' THEN p_batch_id ELSE batch_id END
   WHERE id = p_id;
END;
$$;

-- Saves (or refreshes) a rejection-learning candidate as a DRAFT for this account. Never creates a rule.
-- p: { candidate_key, kind, suggested_params, evidence_count, example_reasons[] }
CREATE OR REPLACE FUNCTION public.wog_rule_suggestion_save(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.wog_require_manager();
  v_key text;
  v_params jsonb;
  v_reasons text[];
  v_id uuid;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'suggestion_invalid' USING ERRCODE = '22023'; END IF;
  v_key := lower(btrim(COALESCE(p ->> 'candidate_key', '')));
  v_params := p -> 'suggested_params';
  IF v_key !~ '^[a-z0-9-]{1,40}$' OR jsonb_typeof(v_params) <> 'object' OR octet_length(v_params::text) > 2000
     OR COALESCE(p ->> 'kind', '') NOT IN ('fm_nte_cap', 'fm_proposal_before_parts', 'fm_invoice_deadline', 'fm_ineligibility_window',
                                           'fm_prohibited_line_item', 'fm_single_invoice', 'fm_required_attachment')
     OR COALESCE(NULLIF(p ->> 'evidence_count', '')::integer, 0) NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'suggestion_invalid' USING ERRCODE = '22023';
  END IF;

  -- Reasons are free text from portals: strip control characters, cap length and count.
  SELECT COALESCE(array_agg(left(btrim(regexp_replace(r, '[[:cntrl:]]+', ' ', 'g')), 160)), '{}')
    INTO v_reasons
  FROM (SELECT r FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p -> 'example_reasons') = 'array' THEN p -> 'example_reasons' ELSE '[]'::jsonb END) AS r LIMIT 3) s
  WHERE btrim(r) <> '';

  IF NOT EXISTS (SELECT 1 FROM public.wog_rule_suggestions WHERE user_id = v_owner AND candidate_key = v_key)
     AND (SELECT count(*) FROM public.wog_rule_suggestions WHERE user_id = v_owner) >= 100 THEN
    RAISE EXCEPTION 'suggestion_limit' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.wog_rule_suggestions (user_id, candidate_key, kind, suggested_params, evidence_count, example_reasons, created_by)
  VALUES (v_owner, v_key, p ->> 'kind', v_params, (p ->> 'evidence_count')::integer, v_reasons, auth.uid())
  ON CONFLICT (user_id, candidate_key) DO UPDATE
    SET kind = EXCLUDED.kind, suggested_params = EXCLUDED.suggested_params, evidence_count = EXCLUDED.evidence_count,
        example_reasons = EXCLUDED.example_reasons, status = 'draft'
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.wog_rule_suggestion_set_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.wog_require_manager();
BEGIN
  IF p_status NOT IN ('draft', 'dismissed') THEN RAISE EXCEPTION 'status_invalid' USING ERRCODE = '22023'; END IF;
  UPDATE public.wog_rule_suggestions SET status = p_status WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.wog_rule_suggestion_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.wog_require_manager();
BEGIN
  DELETE FROM public.wog_rule_suggestions WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.wog_ingest_mark(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_rule_suggestion_save(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_rule_suggestion_set_status(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wog_rule_suggestion_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wog_ingest_mark(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_rule_suggestion_save(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_rule_suggestion_set_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wog_rule_suggestion_delete(uuid) TO authenticated;
