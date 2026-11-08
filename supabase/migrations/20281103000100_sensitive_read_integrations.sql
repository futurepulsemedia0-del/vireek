-- =============================================================
-- Sensitive read logging — integration helpers (additive, safe to apply before enforcement)
--  1. calls_safe: `calls` WITHOUT recording_url / transcript. List/dashboard pages read this view.
--  2. calls_recording_flags(): lets dashboards learn "has a recording?" without reading the URL.
--  3. homeowner_get_document_path(): same behaviour as before, plus business_user_id so the
--     edge function can log the access against the right tenant. Extra key only: callers unaffected.
--  4. search_calls_text(): server-side search over name/phone/summary/transcript (ids only, logged).
-- Depends on 20281103000000_sensitive_read_access_log.sql.
-- Rollback: DROP VIEW public.calls_safe; DROP FUNCTION public.calls_recording_flags(uuid[]), public.search_calls_text(text[]);
--           re-apply the original homeowner_get_document_path from 20271021000000_vireek_home.sql.
-- =============================================================

-- 1. calls_safe -------------------------------------------------------------------------
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'calls' AND column_name NOT IN ('recording_url', 'transcript');
  IF cols IS NULL THEN RAISE EXCEPTION 'public.calls not found'; END IF;
  EXECUTE format('CREATE OR REPLACE VIEW public.calls_safe WITH (security_invoker = true) AS SELECT %s FROM public.calls', cols);
END $$;
REVOKE ALL ON public.calls_safe FROM PUBLIC, anon;
GRANT SELECT ON public.calls_safe TO authenticated;
-- NOTE: re-run this block (or the ops enforcement script) after adding columns to public.calls.

-- 2. recording flags --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calls_recording_flags(p_ids uuid[])
RETURNS TABLE (id uuid, has_recording boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF v_acc IS NULL OR NOT public.sr_caller_can(ARRAY['can_view_billing','can_view_all_jobs']) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, (c.recording_url IS NOT NULL AND c.recording_url LIKE 'https://%')
    FROM calls c
   WHERE c.user_id = v_acc AND c.id = ANY (p_ids[1:500]);
END;
$$;
REVOKE ALL ON FUNCTION public.calls_recording_flags(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calls_recording_flags(uuid[]) TO authenticated;

-- 3. homeowner document path (adds business_user_id) -------------------------------------------
CREATE OR REPLACE FUNCTION public.homeowner_get_document_path(p_link_id uuid, p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.homeowner_business_links;
  v_result jsonb;
BEGIN
  v_link := public.homeowner_live_link(p_link_id);
  IF NOT v_link.share_documents THEN
    RAISE EXCEPTION 'documents are not shared' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object('storage_path', dv.storage_path, 'file_name', dv.file_name, 'mime_type', dv.mime_type,
                            'business_user_id', v_link.business_user_id)
  INTO v_result
  FROM public.documents d
  JOIN public.document_versions dv ON dv.id = d.current_version_id
  WHERE d.id = p_document_id
    AND d.user_id = v_link.business_user_id
    AND d.customer_id = v_link.customer_id
    AND d.homeowner_visible;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'document not available' USING ERRCODE = '42501';
  END IF;
  RETURN v_result;
END;
$$;

-- 4. Server-side call search (replaces client-side filtering over transcripts) -----------------------------------
-- Every token must appear in caller_name / caller_phone / summary / transcript (same rule the UI used).
-- Returns ids only. Matches are logged as ONE aggregated 'list' row (record_count = matches), rate limited.
CREATE OR REPLACE FUNCTION public.search_calls_text(p_tokens text[])
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_acc uuid; v_ids uuid[]; v_tokens text[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  v_acc := public.get_account_owner_id();
  IF v_acc IS NULL OR NOT public.sr_caller_can(ARRAY['can_view_billing','can_view_all_jobs']) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(lower(t)) INTO v_tokens FROM unnest(p_tokens[1:8]) t WHERE char_length(t) BETWEEN 1 AND 100;
  IF v_tokens IS NULL THEN RETURN ARRAY[]::uuid[]; END IF;
  PERFORM public.sr_enforce_bulk_limit(v_acc, v_uid, 1);

  SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT id, lower(concat_ws(' ', caller_name, caller_phone, summary, transcript)) AS hay
            FROM calls WHERE user_id = v_acc ORDER BY call_datetime DESC LIMIT 5000) c
   WHERE NOT EXISTS (SELECT 1 FROM unnest(v_tokens) t WHERE position(t IN c.hay) = 0);

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    PERFORM public.log_sensitive_read(v_acc, 'user', v_uid, NULL, 'transcript', 'list', 'rpc', 'calls', NULL, array_length(v_ids, 1));
  END IF;
  RETURN v_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.search_calls_text(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_calls_text(text[]) TO authenticated;
