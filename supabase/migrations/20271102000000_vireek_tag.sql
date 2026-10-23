/*
  # Vireek Tag — scannable QR/NFC service tags (built ON the Equipment Passport)

  - equipment_tags        : the physical sticker. Own random token (NOT the passport code) so a sticker can be
                            rotated/revoked without touching the machine's identity or history.
  - equipment_tag_events  : privacy-safe scan analytics (no IP; salted per-tag visitor hash).
  - equipment_tag_requests: public "request service" submissions (rate-limit + analytics); each creates a lead.

  Tamper-safety: 80-bit unguessable token, one ACTIVE tag per passport, rotation/revoke retire the old token
  immediately (it then resolves to a harmless "replaced" page), every assign/rotate/revoke is appended to the
  hash-chained passport history (visibility 'network' = members only).
  All writes go through SECURITY DEFINER RPCs. Tables are read-only for clients.
*/

-- 0. HELPERS --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vt_generate_token()
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT public.vp_generate_code() || left(public.vp_generate_code(), 4);  -- 16 Crockford chars = 80 bits
$$;

CREATE OR REPLACE FUNCTION public.vt_normalize_token(p_token text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(c) = 19 AND left(c, 3) = 'VTG' THEN substr(c, 4) ELSE c END
  FROM (SELECT translate(upper(regexp_replace(coalesce(p_token, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011') AS c) s;
$$;

CREATE OR REPLACE FUNCTION public.vt_viewer_hash(p_session text, p_tag uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_session IS NULL OR length(btrim(p_session)) < 8 THEN NULL
         ELSE encode(sha256(convert_to(left(btrim(p_session), 64) || ':' || p_tag::text, 'UTF8')), 'hex') END;
$$;

CREATE OR REPLACE FUNCTION public.vt_can_manage(p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND p_owner IS NOT NULL AND (
    auth.uid() = p_owner OR EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.user_id = auth.uid() AND tm.account_owner_id = p_owner
        AND tm.role = 'admin' AND tm.invite_status = 'active'));
$$;

-- 1. TABLES ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.equipment_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE CHECK (token ~ '^[0-9A-HJKMNP-TV-Z]{16}$'),
  owner_user_id uuid NOT NULL,
  passport_id uuid REFERENCES public.equipment_passports(id),
  status text NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned', 'active', 'rotated', 'revoked')),
  batch_id uuid,
  batch_label text CHECK (batch_label IS NULL OR char_length(batch_label) <= 80),
  rotated_from_id uuid REFERENCES public.equipment_tags(id),
  rotation_reason text CHECK (rotation_reason IS NULL OR rotation_reason IN ('lost', 'damaged', 'suspected_tamper', 'scheduled')),
  assigned_at timestamptz,
  assigned_by uuid,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vt_status_passport CHECK (
    (status = 'unassigned' AND passport_id IS NULL) OR
    (status = 'active' AND passport_id IS NOT NULL) OR
    status IN ('rotated', 'revoked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vt_active_per_passport ON public.equipment_tags (passport_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vt_tags_owner ON public.equipment_tags (owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.equipment_tag_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tag_id uuid NOT NULL REFERENCES public.equipment_tags(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  passport_id uuid,
  action text NOT NULL CHECK (action IN ('scan', 'manual_click', 'register_click', 'request_click', 'request_submitted', 'tamper_report')),
  outcome text NOT NULL DEFAULT 'active' CHECK (outcome IN ('active', 'unassigned', 'rotated', 'revoked')),
  viewer text NOT NULL DEFAULT 'public' CHECK (viewer IN ('public', 'member')),
  source text NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'nfc', 'link')),
  device text NOT NULL DEFAULT 'unknown' CHECK (device IN ('mobile', 'tablet', 'desktop', 'unknown')),
  visitor_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vt_events_owner ON public.equipment_tag_events (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vt_events_tag ON public.equipment_tag_events (tag_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.equipment_tag_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES public.equipment_tags(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  passport_id uuid,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  urgency text NOT NULL CHECK (urgency IN ('routine', 'soon', 'urgent')),
  visitor_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vt_requests_tag ON public.equipment_tag_requests (tag_id, created_at DESC);

-- 2. RLS (read-only for clients) ------------------------------------------------------------------
ALTER TABLE public.equipment_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_tag_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_tag_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vt_tags_select" ON public.equipment_tags;
CREATE POLICY "vt_tags_select" ON public.equipment_tags FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "vt_events_select" ON public.equipment_tag_events;
CREATE POLICY "vt_events_select" ON public.equipment_tag_events FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "vt_requests_select" ON public.equipment_tag_requests;
CREATE POLICY "vt_requests_select" ON public.equipment_tag_requests FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id());

REVOKE ALL ON public.equipment_tags, public.equipment_tag_events, public.equipment_tag_requests FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.equipment_tags, public.equipment_tag_events, public.equipment_tag_requests FROM authenticated;

-- 3. INTERNAL LOGGER ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vt_log(
  p_tag public.equipment_tags, p_action text, p_outcome text, p_viewer text, p_source text, p_device text, p_session text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hash text := public.vt_viewer_hash(p_session, p_tag.id);
BEGIN
  IF v_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.equipment_tag_events e
    WHERE e.tag_id = p_tag.id AND e.visitor_hash = v_hash AND e.action = p_action AND e.outcome = p_outcome
      AND e.created_at > now() - interval '10 minutes') THEN
    RETURN;
  END IF;
  INSERT INTO public.equipment_tag_events (tag_id, owner_user_id, passport_id, action, outcome, viewer, source, device, visitor_hash)
  VALUES (p_tag.id, p_tag.owner_user_id, p_tag.passport_id, p_action, p_outcome,
          CASE WHEN p_viewer = 'member' THEN 'member' ELSE 'public' END,
          CASE WHEN p_source IN ('qr', 'nfc', 'link') THEN p_source ELSE 'qr' END,
          CASE WHEN p_device IN ('mobile', 'tablet', 'desktop') THEN p_device ELSE 'unknown' END,
          v_hash);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'vireek tag log skipped: %', SQLERRM;   -- analytics must never break a scan
END;
$$;

-- 4. PUBLIC: RESOLVE A SCANNED TAG ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_equipment_tag(
  p_token text, p_session text DEFAULT NULL, p_source text DEFAULT 'qr', p_device text DEFAULT 'unknown')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.equipment_tags;
  p public.equipment_passports;
  v_owner uuid := CASE WHEN auth.uid() IS NULL THEN NULL ELSE public.get_account_owner_id() END;
  v_pid uuid;
  v_member boolean := false;
  v_slug text;
  v_enabled boolean;
  v_biz jsonb;
  v_pj jsonb;
  v_docs jsonb := '[]'::jsonb;
  v_reg boolean := false;
  v_is_owner boolean;
BEGIN
  SELECT * INTO t FROM public.equipment_tags WHERE token = public.vt_normalize_token(p_token);
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false, 'state', 'unknown'); END IF;

  v_is_owner := v_owner IS NOT NULL AND v_owner = t.owner_user_id;
  SELECT booking_slug, booking_enabled INTO v_slug, v_enabled FROM public.business_profile WHERE user_id = t.owner_user_id;
  v_biz := jsonb_build_object('name', public.vp_company_name(t.owner_user_id),
                              'booking_slug', CASE WHEN coalesce(v_enabled, false) THEN v_slug END);

  IF t.status <> 'active' THEN
    PERFORM public.vt_log(t, 'scan', t.status, CASE WHEN v_is_owner THEN 'member' ELSE 'public' END, p_source, p_device, p_session);
    RETURN jsonb_build_object('found', true, 'state', t.status, 'business', v_biz,
                              'can_assign', t.status = 'unassigned' AND v_is_owner);
  END IF;

  SELECT coalesce(superseded_by, id) INTO v_pid FROM public.equipment_passports WHERE id = t.passport_id;
  SELECT * INTO p FROM public.equipment_passports WHERE id = v_pid;
  v_member := v_owner IS NOT NULL AND (v_is_owner OR EXISTS (
    SELECT 1 FROM public.equipment_passport_links l
    WHERE l.passport_id = v_pid AND l.user_id = v_owner AND l.status = 'active' AND l.verified));

  v_pj := public.vp_passport_json(v_pid, v_member, v_owner);

  BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_docs FROM (
      SELECT DISTINCT ON (d.url) d.doc_type, d.title, d.url, d.language
      FROM public.oem_documents d
      JOIN public.oem_manufacturers m ON m.id = d.manufacturer_id
      LEFT JOIN public.oem_equipment_models em ON em.id = d.model_id
      WHERE regexp_replace(lower(m.name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(coalesce(p.make, '')), '[^a-z0-9]', '', 'g')
        AND (d.model_id IS NULL OR lower(btrim(em.model_number)) = lower(btrim(coalesce(p.model, ''))))
        AND d.url ~* '^https://'
      ORDER BY d.url, (d.model_id IS NULL), d.doc_type
      LIMIT 12) x;
  EXCEPTION WHEN undefined_table THEN v_docs := '[]'::jsonb;
  END;

  BEGIN
    SELECT EXISTS (SELECT 1 FROM public.warranty_registrations WHERE passport_id = v_pid) INTO v_reg;
  EXCEPTION WHEN undefined_table THEN v_reg := false;
  END;

  PERFORM public.vt_log(t, 'scan', 'active', CASE WHEN v_member THEN 'member' ELSE 'public' END, p_source, p_device, p_session);

  RETURN jsonb_build_object(
    'found', true, 'state', 'active',
    'viewer', CASE WHEN v_member THEN 'member' ELSE 'public' END,
    'tag', jsonb_build_object('id', CASE WHEN v_member THEN t.id END, 'assigned_at', t.assigned_at),
    'business', v_biz,
    'passport', v_pj,
    'documents', v_docs,
    'warranty_registered', v_reg,
    'equipment_id', CASE WHEN v_member THEN v_pj #>> '{link,equipment_id}' END);
END;
$$;

-- Funnel/tamper clicks from the public page.
CREATE OR REPLACE FUNCTION public.record_tag_action(
  p_token text, p_action text, p_session text DEFAULT NULL, p_source text DEFAULT 'qr', p_device text DEFAULT 'unknown')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.equipment_tags;
BEGIN
  IF p_action NOT IN ('manual_click', 'register_click', 'request_click', 'tamper_report') THEN RETURN; END IF;
  SELECT * INTO t FROM public.equipment_tags WHERE token = public.vt_normalize_token(p_token) AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM public.vt_log(t, p_action, 'active', 'public', p_source, p_device, p_session);
END;
$$;

-- Public "request service": creates a lead for the tag's company. Honeypot + per-tag/per-visitor limits.
CREATE OR REPLACE FUNCTION public.submit_tag_service_request(
  p_token text, p_name text, p_phone text, p_email text, p_issue text, p_urgency text,
  p_session text DEFAULT NULL, p_website text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.equipment_tags;
  p public.equipment_passports;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_issue text := left(btrim(coalesce(p_issue, '')), 1000);
  v_hash text;
  v_cust uuid;
  v_lead uuid;
  v_req uuid;
BEGIN
  IF nullif(btrim(coalesce(p_website, '')), '') IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true);                       -- honeypot: pretend success, store nothing
  END IF;
  IF char_length(v_name) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'TAG_INVALID: name' USING ERRCODE = 'P0001'; END IF;
  IF p_urgency IS NULL OR p_urgency NOT IN ('routine', 'soon', 'urgent') THEN RAISE EXCEPTION 'TAG_INVALID: urgency' USING ERRCODE = 'P0001'; END IF;
  IF v_phone IS NULL AND v_email IS NULL THEN RAISE EXCEPTION 'TAG_INVALID: contact' USING ERRCODE = 'P0001'; END IF;
  IF v_phone IS NOT NULL AND length(regexp_replace(v_phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'TAG_INVALID: phone' USING ERRCODE = 'P0001'; END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 254 OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'TAG_INVALID: email' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO t FROM public.equipment_tags WHERE token = public.vt_normalize_token(p_token);
  IF NOT FOUND OR t.status <> 'active' THEN RAISE EXCEPTION 'TAG_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;

  v_hash := public.vt_viewer_hash(p_session, t.id);
  IF (SELECT count(*) FROM public.equipment_tag_requests WHERE tag_id = t.id AND created_at > now() - interval '1 hour') >= 5
     OR (SELECT count(*) FROM public.equipment_tag_requests WHERE tag_id = t.id AND created_at > now() - interval '24 hours') >= 20
     OR (v_hash IS NOT NULL AND (SELECT count(*) FROM public.equipment_tag_requests
                                 WHERE tag_id = t.id AND visitor_hash = v_hash AND created_at > now() - interval '1 hour') >= 3) THEN
    RAISE EXCEPTION 'TAG_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO p FROM public.equipment_passports WHERE id = t.passport_id;
  SELECT id INTO v_cust FROM public.customers
  WHERE user_id = t.owner_user_id AND ((v_phone IS NOT NULL AND phone = v_phone) OR (v_email IS NOT NULL AND lower(email) = lower(v_email)))
  LIMIT 1;

  INSERT INTO public.leads (user_id, customer_id, name, phone, email, service_interested, notes)
  VALUES (t.owner_user_id, v_cust, v_name, v_phone, v_email, 'Service request (Vireek Tag)',
          'Urgency: ' || p_urgency
          || E'\nEquipment: ' || coalesce(nullif(btrim(concat_ws(' ', p.make, p.model)), ''), p.equipment_type, 'unknown')
          || E'\nPassport: VEQ-' || substr(p.public_code, 1, 4) || '-' || substr(p.public_code, 5, 4) || '-' || substr(p.public_code, 9, 4)
          || CASE WHEN v_issue <> '' THEN E'\nIssue: ' || v_issue ELSE '' END)
  RETURNING id INTO v_lead;

  INSERT INTO public.equipment_tag_requests (tag_id, owner_user_id, passport_id, lead_id, urgency, visitor_hash)
  VALUES (t.id, t.owner_user_id, t.passport_id, v_lead, p_urgency, v_hash)
  RETURNING id INTO v_req;

  PERFORM public.vt_log(t, 'request_submitted', 'active', 'public', 'qr', 'unknown', p_session);
  RETURN jsonb_build_object('ok', true, 'reference', upper(left(replace(v_req::text, '-', ''), 8)));
END;
$$;

-- 5. AUTHENTICATED: INVENTORY / ASSIGN / ROTATE / REVOKE ------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_equipment_tags(p_count integer, p_batch_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_batch uuid := gen_random_uuid();
  v_label text := nullif(left(btrim(coalesce(p_batch_label, '')), 80), '');
  v_stock integer; v_tokens jsonb := '[]'::jsonb; v_i integer; v_tries integer; v_id uuid; v_tok text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.vt_can_manage(v_owner) THEN RAISE EXCEPTION 'TAG_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF p_count IS NULL OR p_count < 1 OR p_count > 120 THEN RAISE EXCEPTION 'TAG_INVALID: count must be 1-120' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_stock FROM public.equipment_tags WHERE owner_user_id = v_owner AND status = 'unassigned';
  IF v_stock + p_count > 2000 THEN RAISE EXCEPTION 'TAG_STOCK_LIMIT' USING ERRCODE = 'P0001'; END IF;

  FOR v_i IN 1..p_count LOOP
    v_tries := 0;
    LOOP
      v_tok := public.vt_generate_token();
      BEGIN
        INSERT INTO public.equipment_tags (token, owner_user_id, batch_id, batch_label)
        VALUES (v_tok, v_owner, v_batch, v_label) RETURNING id INTO v_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_tries := v_tries + 1;
        IF v_tries >= 5 THEN RAISE EXCEPTION 'TAG_INVALID: could not allocate a unique token' USING ERRCODE = 'P0001'; END IF;
      END;
    END LOOP;
    v_tokens := v_tokens || jsonb_build_array(jsonb_build_object('id', v_id, 'token', v_tok));
  END LOOP;
  RETURN jsonb_build_object('batch_id', v_batch, 'tags', v_tokens);
END;
$$;

-- Technician on site: stick a tag from the sheet on a machine -> bind it to that equipment's passport.
CREATE OR REPLACE FUNCTION public.assign_equipment_tag(p_token text, p_equipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  t public.equipment_tags; eq record; v_pid uuid; v_code text; v_verified boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM public.equipment_tags WHERE token = public.vt_normalize_token(p_token) AND owner_user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'unassigned' THEN RAISE EXCEPTION 'TAG_ALREADY_ASSIGNED' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO eq FROM public.equipment WHERE id = p_equipment_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_EQUIPMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  v_pid := public.vp_issue_for_equipment(eq.id);
  IF v_pid IS NULL THEN RAISE EXCEPTION 'TAG_EQUIPMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_pid FROM public.equipment_passports WHERE id = v_pid;
  SELECT public_code INTO v_code FROM public.equipment_passports WHERE id = v_pid;

  -- Physically attaching the tag proves access: verify the link through the existing claim flow if needed.
  SELECT verified INTO v_verified FROM public.equipment_passport_links
  WHERE passport_id = v_pid AND user_id = v_owner AND status = 'active';
  IF v_verified IS DISTINCT FROM true THEN PERFORM public.claim_equipment_passport(v_code, eq.id); END IF;

  IF EXISTS (SELECT 1 FROM public.equipment_tags WHERE passport_id = v_pid AND status = 'active') THEN
    RAISE EXCEPTION 'TAG_PASSPORT_ALREADY_TAGGED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.equipment_tags
  SET passport_id = v_pid, status = 'active', assigned_at = now(), assigned_by = auth.uid()
  WHERE id = t.id;

  PERFORM public.vp_append_event(v_pid, 'note', 'Vireek Tag attached', NULL,
    jsonb_build_object('action', 'tag_attached'), now(), v_owner, NULL, 'tag-assign:' || t.id::text, 'network');

  RETURN jsonb_build_object('tag_id', t.id, 'passport_code', v_code, 'equipment_id', eq.id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'TAG_PASSPORT_ALREADY_TAGGED' USING ERRCODE = 'P0001';
END;
$$;

-- Tamper-safe rotation: old token dies instantly, a fresh token replaces it on the same passport.
CREATE OR REPLACE FUNCTION public.rotate_equipment_tag(p_tag_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  t public.equipment_tags; v_id uuid; v_tok text; v_tries integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('lost', 'damaged', 'suspected_tamper', 'scheduled') THEN
    RAISE EXCEPTION 'TAG_INVALID: reason' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM public.equipment_tags WHERE id = p_tag_id AND owner_user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'active' THEN RAISE EXCEPTION 'TAG_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.equipment_tags SET status = 'rotated', retired_at = now(), rotation_reason = p_reason WHERE id = t.id;

  LOOP
    v_tok := public.vt_generate_token();
    BEGIN
      INSERT INTO public.equipment_tags
        (token, owner_user_id, passport_id, status, batch_id, batch_label, rotated_from_id, assigned_at, assigned_by)
      VALUES (v_tok, v_owner, t.passport_id, 'active', t.batch_id, t.batch_label, t.id, now(), auth.uid())
      RETURNING id INTO v_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries >= 5 THEN RAISE EXCEPTION 'TAG_INVALID: could not allocate a unique token' USING ERRCODE = 'P0001'; END IF;
    END;
  END LOOP;

  PERFORM public.vp_append_event(t.passport_id, 'note',
    CASE WHEN p_reason = 'suspected_tamper' THEN 'Vireek Tag replaced after suspected tampering' ELSE 'Vireek Tag replaced' END,
    NULL, jsonb_build_object('action', 'tag_rotated', 'reason', p_reason), now(), v_owner, NULL, 'tag-rotate:' || v_id::text, 'network');

  RETURN jsonb_build_object('id', v_id, 'token', v_tok);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_equipment_tag(p_tag_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); t public.equipment_tags;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.vt_can_manage(v_owner) THEN RAISE EXCEPTION 'TAG_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM public.equipment_tags WHERE id = p_tag_id AND owner_user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF t.status NOT IN ('unassigned', 'active') THEN RAISE EXCEPTION 'TAG_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.equipment_tags SET status = 'revoked', retired_at = now() WHERE id = t.id;
  IF t.passport_id IS NOT NULL THEN
    PERFORM public.vp_append_event(t.passport_id, 'note', 'Vireek Tag deactivated', NULL,
      jsonb_build_object('action', 'tag_revoked'), now(), v_owner, NULL, 'tag-revoke:' || t.id::text, 'network');
  END IF;
  RETURN jsonb_build_object('status', 'revoked');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_equipment_tags(p_status text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_total integer; v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_total FROM public.equipment_tags t WHERE t.owner_user_id = v_owner AND (p_status IS NULL OR t.status = p_status);
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.id), '[]'::jsonb) INTO v_rows FROM (
    SELECT t.id, t.token, t.status, t.batch_id, t.batch_label, t.created_at, t.assigned_at, t.retired_at,
           t.rotated_from_id, t.rotation_reason, p.public_code AS passport_code, p.equipment_type, p.make, p.model,
           (SELECT count(*) FROM public.equipment_tag_events e WHERE e.tag_id = t.id AND e.action = 'scan' AND e.outcome = 'active') AS scan_count,
           (SELECT max(e.created_at) FROM public.equipment_tag_events e WHERE e.tag_id = t.id AND e.action = 'scan' AND e.outcome = 'active') AS last_scan_at,
           (SELECT count(*) FROM public.equipment_tag_events e WHERE e.tag_id = t.id AND e.action = 'request_submitted') AS request_count,
           (SELECT count(*) FROM public.equipment_tag_events e WHERE e.tag_id = t.id AND e.action = 'tamper_report') AS report_count
    FROM public.equipment_tags t
    LEFT JOIN public.equipment_passports p ON p.id = t.passport_id
    WHERE t.owner_user_id = v_owner AND (p_status IS NULL OR t.status = p_status)
    ORDER BY t.created_at DESC, t.id
    LIMIT v_limit OFFSET v_off) r;
  RETURN jsonb_build_object('total', v_total, 'tags', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tag_analytics(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  v_totals jsonb; v_by_day jsonb; v_by_source jsonb; v_by_device jsonb; v_top jsonb; v_inv jsonb; v_never integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT jsonb_build_object(
    'scans', count(*) FILTER (WHERE action = 'scan' AND outcome = 'active'),
    'unique_visitors', count(DISTINCT visitor_hash) FILTER (WHERE action = 'scan' AND outcome = 'active'),
    'team_scans', count(*) FILTER (WHERE action = 'scan' AND outcome = 'active' AND viewer = 'member'),
    'stale_scans', count(*) FILTER (WHERE action = 'scan' AND outcome IN ('rotated', 'revoked')),
    'request_clicks', count(*) FILTER (WHERE action = 'request_click'),
    'requests', count(*) FILTER (WHERE action = 'request_submitted'),
    'manual_clicks', count(*) FILTER (WHERE action = 'manual_click'),
    'register_clicks', count(*) FILTER (WHERE action = 'register_click'),
    'tamper_reports', count(*) FILTER (WHERE action = 'tamper_report'))
  INTO v_totals FROM public.equipment_tag_events WHERE owner_user_id = v_owner AND created_at >= v_since;

  SELECT coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'scans', coalesce(s.n, 0)) ORDER BY d.day), '[]'::jsonb) INTO v_by_day
  FROM (SELECT generate_series(v_since::date, now()::date, interval '1 day')::date AS day) d
  LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM public.equipment_tag_events
             WHERE owner_user_id = v_owner AND action = 'scan' AND outcome = 'active' AND created_at >= v_since GROUP BY 1) s
    ON s.day = d.day;

  SELECT coalesce(jsonb_agg(jsonb_build_object('key', source, 'count', n) ORDER BY n DESC), '[]'::jsonb) INTO v_by_source
  FROM (SELECT source, count(*) AS n FROM public.equipment_tag_events
        WHERE owner_user_id = v_owner AND action = 'scan' AND outcome = 'active' AND created_at >= v_since GROUP BY source) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('key', device, 'count', n) ORDER BY n DESC), '[]'::jsonb) INTO v_by_device
  FROM (SELECT device, count(*) AS n FROM public.equipment_tag_events
        WHERE owner_user_id = v_owner AND action = 'scan' AND outcome = 'active' AND created_at >= v_since GROUP BY device) s;

  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.scans DESC), '[]'::jsonb) INTO v_top FROM (
    SELECT t.id AS tag_id, t.token,
           coalesce(nullif(btrim(concat_ws(' ', p.make, p.model)), ''), p.equipment_type) AS label, count(*) AS scans
    FROM public.equipment_tag_events e
    JOIN public.equipment_tags t ON t.id = e.tag_id
    LEFT JOIN public.equipment_passports p ON p.id = t.passport_id
    WHERE e.owner_user_id = v_owner AND e.action = 'scan' AND e.outcome = 'active' AND e.created_at >= v_since
    GROUP BY t.id, t.token, p.make, p.model, p.equipment_type
    ORDER BY scans DESC LIMIT 10) x;

  SELECT jsonb_build_object(
    'unassigned', count(*) FILTER (WHERE status = 'unassigned'), 'active', count(*) FILTER (WHERE status = 'active'),
    'rotated', count(*) FILTER (WHERE status = 'rotated'), 'revoked', count(*) FILTER (WHERE status = 'revoked'))
  INTO v_inv FROM public.equipment_tags WHERE owner_user_id = v_owner;

  SELECT count(*) INTO v_never FROM public.equipment_tags t
  WHERE t.owner_user_id = v_owner AND t.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.equipment_tag_events e WHERE e.tag_id = t.id AND e.action = 'scan' AND e.outcome = 'active');

  RETURN jsonb_build_object('range_days', v_days, 'totals', v_totals, 'by_day', v_by_day, 'by_source', v_by_source,
    'by_device', v_by_device, 'top_tags', v_top, 'inventory', v_inv || jsonb_build_object('active_never_scanned', v_never));
END;
$$;

-- Quick job from a scanned tag (technician with a verified link to this machine).
CREATE OR REPLACE FUNCTION public.create_job_from_tag(p_token text, p_service_type text, p_assign_to_me boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_type text := btrim(coalesce(p_service_type, ''));
  t public.equipment_tags; v_pid uuid; v_eq uuid; v_cust uuid; v_cname text; v_cphone text; v_job uuid; v_existing uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'TAG_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_type) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'TAG_INVALID: service type' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM public.equipment_tags WHERE token = public.vt_normalize_token(p_token) AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_pid FROM public.equipment_passports WHERE id = t.passport_id;

  SELECT equipment_id INTO v_eq FROM public.equipment_passport_links
  WHERE passport_id = v_pid AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RAISE EXCEPTION 'TAG_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF v_eq IS NULL THEN RAISE EXCEPTION 'TAG_NO_EQUIPMENT' USING ERRCODE = 'P0001'; END IF;

  SELECT j.id INTO v_existing FROM public.jobs j JOIN public.job_equipment je ON je.job_id = j.id
  WHERE j.user_id = v_owner AND je.equipment_id = v_eq AND j.service_type = v_type
    AND j.job_status NOT IN ('completed', 'cancelled') AND j.created_at > now() - interval '10 minutes'
  ORDER BY j.created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('job_id', v_existing, 'existing', true); END IF;

  SELECT e.customer_id, c.name, c.phone INTO v_cust, v_cname, v_cphone
  FROM public.equipment e LEFT JOIN public.customers c ON c.id = e.customer_id
  WHERE e.id = v_eq AND e.user_id = v_owner;

  INSERT INTO public.jobs (user_id, customer_id, customer_name, customer_phone, service_type, job_status, assigned_technician_id)
  VALUES (v_owner, v_cust, coalesce(v_cname, 'Customer'), v_cphone, v_type, 'scheduled',
          CASE WHEN coalesce(p_assign_to_me, true) THEN public.get_my_team_member_id() END)
  RETURNING id INTO v_job;

  INSERT INTO public.job_equipment (job_id, equipment_id, service_type) VALUES (v_job, v_eq, v_type) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('job_id', v_job, 'existing', false);
END;
$$;

-- Retention (service_role / pg_cron): keep analytics 13 months.
CREATE OR REPLACE FUNCTION public.purge_old_tag_events(p_days integer DEFAULT 400)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.equipment_tag_events WHERE created_at < now() - make_interval(days => greatest(30, p_days));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- 6. GRANTS ---------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.vt_generate_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vt_viewer_hash(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vt_can_manage(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.vt_log(public.equipment_tags, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_equipment_tag(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_tag_action(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_tag_service_request(text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_equipment_tags(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assign_equipment_tag(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rotate_equipment_tag(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_equipment_tag(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_equipment_tags(text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tag_analytics(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_job_from_tag(text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_old_tag_events(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_equipment_tag(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_tag_action(text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_tag_service_request(text, text, text, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vt_can_manage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_equipment_tags(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_equipment_tag(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_equipment_tag(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_equipment_tag(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_equipment_tags(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tag_analytics(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_job_from_tag(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_tag_events(integer) TO service_role;
