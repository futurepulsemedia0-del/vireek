/*
  # Exit-Ready: add-back evidence attachments

  Links documents from the vault to add-backs as evidence (B.4 "add-back schedule with evidence attachments").
  Replaces exit_create_staged_room() so the NDA-stage add-back schedule lists evidence document TITLES
  (never files, never customer data). Apply AFTER 20281115000000_exit_ready_lineage.sql.

  Also adds exit_dataroom_refresh() (re-read without using a view) and moves the staged payload into _exit_staged_view().

  Rollback:
    DROP FUNCTION IF EXISTS public.exit_dataroom_refresh(text);
    -- also restore exit_set_stage() from 20281115000000_exit_ready_lineage.sql
    DROP TABLE IF EXISTS public.exit_addback_evidence;
    -- then restore exit_create_staged_room() and exit_dataroom_open() from 20281115000000_exit_ready_lineage.sql
*/

CREATE TABLE IF NOT EXISTS public.exit_addback_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  addback_id uuid NOT NULL REFERENCES public.exit_addbacks(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (addback_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_exit_addback_evidence_owner ON public.exit_addback_evidence(account_owner_id, addback_id);

CREATE OR REPLACE FUNCTION public.exit_addback_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT count(*) FROM exit_addback_evidence e WHERE e.addback_id = NEW.addback_id) >= 10 THEN
    RAISE EXCEPTION 'An add-back can have at most 10 evidence documents.' USING ERRCODE = '53400';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_exit_addback_evidence_guard ON public.exit_addback_evidence;
CREATE TRIGGER trg_exit_addback_evidence_guard BEFORE INSERT ON public.exit_addback_evidence
  FOR EACH ROW EXECUTE FUNCTION public.exit_addback_evidence_guard();

ALTER TABLE public.exit_addback_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_addback_evidence_owner_select" ON public.exit_addback_evidence;
CREATE POLICY "exit_addback_evidence_owner_select" ON public.exit_addback_evidence FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
DROP POLICY IF EXISTS "exit_addback_evidence_owner_insert" ON public.exit_addback_evidence;
CREATE POLICY "exit_addback_evidence_owner_insert" ON public.exit_addback_evidence FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id() AND public.exit_is_owner()
    AND EXISTS (SELECT 1 FROM public.exit_addbacks a WHERE a.id = addback_id AND a.account_owner_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "exit_addback_evidence_owner_delete" ON public.exit_addback_evidence;
CREATE POLICY "exit_addback_evidence_owner_delete" ON public.exit_addback_evidence FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
REVOKE UPDATE ON public.exit_addback_evidence FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.exit_create_staged_room(
  p_label text, p_recipient text, p_expires_hours integer, p_max_views integer, p_nda_text text,
  p_valuation jsonb, p_token_hash text, p_token_hint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_run exit_lineage_runs%ROWTYPE;
  v_facts jsonb;
  v_rev bigint;
  v_content jsonb;
  v_teaser jsonb;
  v_nda jsonb;
  v_package uuid;
  v_link uuid;
  v_expires timestamptz;
  v_addbacks jsonb;
BEGIN
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Name the data room (2-120 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'Links last between 1 hour and 30 days.' USING ERRCODE = '22023';
  END IF;
  IF p_max_views IS NULL OR p_max_views NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Choose between 1 and 1000 views.' USING ERRCODE = '22023';
  END IF;
  IF p_recipient IS NOT NULL AND char_length(p_recipient) > 120 THEN
    RAISE EXCEPTION 'Recipient label too long.' USING ERRCODE = '22023';
  END IF;
  IF p_nda_text IS NULL OR char_length(btrim(p_nda_text)) NOT BETWEEN 50 AND 20000 THEN
    RAISE EXCEPTION 'Paste the NDA text your lawyer approved (50-20000 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_token_hint IS NULL OR char_length(p_token_hint) <> 4 THEN
    RAISE EXCEPTION 'Invalid link token.' USING ERRCODE = '22023';
  END IF;
  IF p_valuation IS NOT NULL AND (jsonb_typeof(p_valuation) <> 'object' OR octet_length(p_valuation::text) > 50000) THEN
    RAISE EXCEPTION 'Invalid estimate summary.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM exit_dataroom_links l
      WHERE l.account_owner_id = v_owner AND l.revoked_at IS NULL AND l.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'You already have 25 active links. Revoke one first.' USING ERRCODE = '53400';
  END IF;

  SELECT * INTO v_run FROM exit_lineage_runs r
  WHERE r.account_owner_id = v_owner AND r.run_hash IS NOT NULL
  ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_run.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Run the lineage check first (it must be less than 24 hours old).' USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(jsonb_object_agg(f.metric_key, jsonb_build_object(
           'label', f.label, 'value', f.value, 'asOf', f.as_of, 'sourceCount', f.source_count, 'hash', f.content_hash)), '{}'::jsonb)
  INTO v_facts FROM exit_lineage_facts f WHERE f.run_id = v_run.id;

  v_rev := nullif(v_facts #>> '{revenue_invoiced_12m,value,subtotalCents}', '')::bigint;

  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'label', a.label, 'amountCents', a.amount_cents,
                   'justification', a.justification,
                   'evidence', (SELECT coalesce(jsonb_agg(d.title ORDER BY d.title), '[]'::jsonb)
                                FROM exit_addback_evidence e JOIN documents d ON d.id = e.document_id
                                WHERE e.addback_id = a.id))
                   ORDER BY a.created_at), '[]'::jsonb)
  INTO v_addbacks FROM exit_addbacks a WHERE a.account_owner_id = v_owner AND a.active;

  v_teaser := jsonb_build_object(
    'revenueBand', public._exit_band(v_rev),
    'jobsCompleted12mBand', CASE
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint IS NULL THEN 'undisclosed'
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint < 500 THEN 'under 500'
        WHEN (v_facts #>> '{jobs_12m,value,completed}')::bigint < 2000 THEN '500-2,000'
        ELSE 'over 2,000' END,
    'hasRecurringRevenue', coalesce((v_facts #>> '{recurring_revenue,value,activeMemberships}')::bigint, 0) > 0,
    'asOf', v_run.as_of,
    'note', 'Teaser contains banded, non-identifying information only.');

  v_nda := jsonb_build_object(
    'facts', v_facts,
    'reconciliation', v_run.reconciliation,
    'addBacks', v_addbacks,
    'estimate', p_valuation,
    'runHash', v_run.run_hash,
    'piiPolicy', 'Aggregates only. No customer names, contacts or addresses.');

  v_content := jsonb_build_object('teaser', v_teaser, 'nda', v_nda);

  INSERT INTO exit_dataroom_packages (account_owner_id, label, sections, include_names, content, stage_content, lineage_run_id, content_hash)
  VALUES (v_owner, btrim(p_label), ARRAY['kpis'], false, '{}'::jsonb, v_content, v_run.id,
          encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex'))
  RETURNING id INTO v_package;

  v_expires := now() + make_interval(hours => p_expires_hours);
  INSERT INTO exit_dataroom_links (package_id, account_owner_id, recipient_label, token_hash, token_hint, expires_at, max_views,
                                   room_mode, stage_ceiling, nda_text, nda_text_hash, view_only, watermark_text)
  VALUES (v_package, v_owner, nullif(btrim(coalesce(p_recipient, '')), ''), p_token_hash, p_token_hint, v_expires, p_max_views,
          'staged', 'teaser', btrim(p_nda_text), encode(sha256(convert_to(btrim(p_nda_text), 'UTF8')), 'hex'), true,
          left(coalesce(nullif(btrim(p_recipient), ''), 'Recipient') || ' | ' || p_token_hint || ' | ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 200))
  RETURNING id INTO v_link;

  PERFORM public._exit_audit(v_owner, 'owner', 'room_created', 'link', v_link, jsonb_build_object('package', v_package, 'runId', v_run.id));
  RETURN jsonb_build_object('linkId', v_link, 'packageId', v_package, 'expiresAt', v_expires);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_create_staged_room(text, text, integer, integer, text, jsonb, text, text) TO authenticated;

-- Builds the stage-gated payload for a staged link. Shared by open() and refresh() so both always agree.
CREATE OR REPLACE FUNCTION public._exit_staged_view(p_link exit_dataroom_links, p_label text, p_views_remaining integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links := p_link;
  v_label text := p_label;
  v_content jsonb;
  v_stage text;
  v_body jsonb;
  v_docs jsonb;
  v_qa jsonb;
BEGIN
  v_stage := public._exit_effective_stage(v_link);
  SELECT p.stage_content INTO v_content FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;

  v_body := jsonb_build_object('teaser', v_content -> 'teaser');
  IF v_stage IN ('nda', 'detailed') THEN
    v_body := v_body || jsonb_build_object('nda', v_content -> 'nda');
  END IF;
  IF v_stage = 'detailed' THEN
    v_body := v_body || jsonb_build_object('detailed', v_link.detailed_content);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('documentId', d.id, 'title', d.title, 'category', d.category,
           'fileName', d.current_file_name, 'minStage', x.min_stage) ORDER BY d.title), '[]'::jsonb)
  INTO v_docs
  FROM exit_dataroom_documents x
  JOIN documents d ON d.id = x.document_id
  WHERE x.link_id = v_link.id
    AND (x.min_stage = 'nda' AND v_stage IN ('nda', 'detailed') OR x.min_stage = 'detailed' AND v_stage = 'detailed');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'askedAt', q.asked_at,
           'answer', q.answer, 'answeredAt', q.answered_at) ORDER BY q.asked_at), '[]'::jsonb)
  INTO v_qa
  FROM exit_dataroom_questions q WHERE q.link_id = v_link.id;

  RETURN jsonb_build_object(
    'outcome', 'granted',
    'mode', 'staged',
    'label', v_label,
    'expiresAt', v_link.expires_at,
    'viewsRemaining', greatest(p_views_remaining, 0),
    'stage', v_stage,
    'stageCeiling', v_link.stage_ceiling,
    'ndaRequired', v_link.stage_ceiling IN ('nda', 'detailed') AND v_link.nda_accepted_at IS NULL,
    'ndaText', CASE WHEN v_link.stage_ceiling IN ('nda', 'detailed') AND v_link.nda_accepted_at IS NULL THEN v_link.nda_text END,
    'viewOnly', v_link.view_only,
    'watermark', v_link.watermark_text,
    'content', v_body,
    'documents', v_docs,
    'questions', v_qa
  );
END;
$$;
REVOKE ALL ON FUNCTION public._exit_staged_view(exit_dataroom_links, text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.exit_dataroom_open(p_token_hash text, p_ip_hash text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_content jsonb;
  v_label text;
  v_outcome text;
  v_ua text := left(coalesce(p_user_agent, ''), 200);
  v_stage text;
  v_body jsonb;
  v_docs jsonb;
  v_qa jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  IF p_ip_hash IS NOT NULL AND (
    SELECT count(*) FROM exit_dataroom_access_logs
    WHERE ip_hash = p_ip_hash AND accessed_at > now() - interval '10 minutes'
  ) >= 30 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited');
  END IF;

  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
    VALUES (NULL, NULL, 'invalid_token', left(p_ip_hash, 64), nullif(v_ua, ''));
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  IF v_link.revoked_at IS NOT NULL THEN
    v_outcome := 'revoked';
  ELSIF v_link.expires_at <= now() THEN
    v_outcome := 'expired';
  ELSIF v_link.view_count >= v_link.max_views THEN
    v_outcome := 'exhausted';
  ELSE
    v_outcome := 'granted';
  END IF;

  INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
  VALUES (v_link.id, v_link.account_owner_id, v_outcome, left(p_ip_hash, 64), nullif(v_ua, ''));

  IF v_outcome <> 'granted' THEN
    RETURN jsonb_build_object('outcome', v_outcome);
  END IF;

  UPDATE exit_dataroom_links
  SET view_count = view_count + 1, last_viewed_at = now()
  WHERE id = v_link.id;

  SELECT p.content, p.label INTO v_content, v_label FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;

  IF v_link.room_mode = 'legacy' THEN
    RETURN jsonb_build_object(
      'outcome', 'granted',
      'label', v_label,
      'expiresAt', v_link.expires_at,
      'viewsRemaining', v_link.max_views - v_link.view_count - 1,
      'content', v_content
    );
  END IF;

  RETURN public._exit_staged_view(v_link, v_label, v_link.max_views - v_link.view_count - 1);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_open(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_open(text, text, text) TO service_role;

-- Re-reads a staged room WITHOUT using a view, so the page can update after the NDA is accepted or a question is
-- answered. Only works inside a 30-minute window after a counted open, so it cannot be used to bypass the view limit.
CREATE OR REPLACE FUNCTION public.exit_dataroom_refresh(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_label text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash;
  IF NOT FOUND OR v_link.room_mode <> 'staged' OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now()
     OR v_link.last_viewed_at IS NULL OR v_link.last_viewed_at < now() - interval '30 minutes' THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  SELECT p.label INTO v_label FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;
  RETURN public._exit_staged_view(v_link, v_label, v_link.max_views - v_link.view_count);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_dataroom_refresh(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_refresh(text) TO service_role;

-- The detailed stage can only be pseudonymized or named: the underlying package builder has no third, aggregated-only mode
-- (aggregated figures are what the NDA stage already shows).
CREATE OR REPLACE FUNCTION public.exit_set_stage(p_link_id uuid, p_ceiling text, p_pii_level text, p_sections text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_link exit_dataroom_links%ROWTYPE;
  v_allowed text[] := ARRAY['financials', 'kpis', 'contracts', 'equipment', 'credentials'];
  v_detailed jsonb;
BEGIN
  IF p_ceiling NOT IN ('teaser', 'nda', 'detailed') THEN
    RAISE EXCEPTION 'Invalid stage.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_link FROM exit_dataroom_links WHERE id = p_link_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_link.room_mode <> 'staged' THEN
    RAISE EXCEPTION 'Staged room link not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_link.revoked_at IS NOT NULL OR v_link.expires_at <= now() THEN
    RAISE EXCEPTION 'This link is revoked or expired.' USING ERRCODE = '55000';
  END IF;

  IF p_ceiling = 'detailed' THEN
    IF v_link.nda_accepted_at IS NULL THEN
      RAISE EXCEPTION 'The recipient must accept the NDA before the detailed stage can be approved.' USING ERRCODE = '55000';
    END IF;
    IF p_pii_level IS NULL OR p_pii_level NOT IN ('pseudonymized', 'named') THEN
      RAISE EXCEPTION 'Choose pseudonymized (Customer 1, Technician 1) or named disclosure for the detailed stage.' USING ERRCODE = '22023';
    END IF;
    IF p_sections IS NULL OR cardinality(p_sections) < 1 OR NOT (p_sections <@ v_allowed) THEN
      RAISE EXCEPTION 'Choose at least one valid detailed section.' USING ERRCODE = '22023';
    END IF;
    v_detailed := public._exit_build_package(v_owner, p_sections, p_pii_level = 'named', NULL);
    IF octet_length(v_detailed::text) > 4000000 THEN
      RAISE EXCEPTION 'Detailed package is too large. Share fewer sections.' USING ERRCODE = '54000';
    END IF;
    UPDATE exit_dataroom_links
    SET stage_ceiling = 'detailed', pii_level = p_pii_level, detailed_content = v_detailed, detailed_approved_at = now()
    WHERE id = p_link_id;
  ELSE
    UPDATE exit_dataroom_links
    SET stage_ceiling = p_ceiling, pii_level = 'aggregated', detailed_content = NULL, detailed_approved_at = NULL
    WHERE id = p_link_id;
  END IF;

  PERFORM public._exit_audit(v_owner, 'owner', 'stage_set', 'link', p_link_id,
    jsonb_build_object('ceiling', p_ceiling, 'piiLevel', CASE WHEN p_ceiling = 'detailed' THEN p_pii_level ELSE 'aggregated' END));
  RETURN jsonb_build_object('linkId', p_link_id, 'stageCeiling', p_ceiling);
END;
$$;
REVOKE ALL ON FUNCTION public.exit_set_stage(uuid, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_set_stage(uuid, text, text, text[]) TO authenticated;
