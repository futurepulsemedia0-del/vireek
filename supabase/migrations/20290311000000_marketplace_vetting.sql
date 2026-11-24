/*
  # Marketplace third-party app vetting

  Builds ON TOP of 20270210000000_agent_marketplace.sql (+ review_queue). Nothing is dropped.
  Adds: automated vetting reports, a staff review checklist, richer approval states, delisting.

  ## What changes
  - marketplace_agent_versions.status gains 'changes_requested'.
  - marketplace_agents.status gains 'delisted' (+ delisted_at / delisted_reason_code / delisted_by).
  - validate_marketplace_manifest(): optional manifest.outbound_domains (<= 10 hostnames, SELF-ATTESTED).
  - NEW marketplace_vetting_reports        append-only; written only by the marketplace-vetting edge function (service role).
  - NEW marketplace_review_checklist_items reference data (labels live in i18n, keyed by slug).
  - NEW marketplace_review_checklist_answers staff answers per version.
  - NEW marketplace_delisting_events       append-only history of delist / reinstate.
  - NEW RPCs (staff only, checked inside): save_marketplace_review_answer, get_marketplace_review_state,
         request_marketplace_changes, delist_marketplace_agent, reinstate_marketplace_agent.
  - REPLACED RPCs (same signatures): review_marketplace_agent_version (approval now gated),
         submit_marketplace_agent_version (refuses delisted agents), validate_marketplace_manifest.
  - Staff can now SELECT every agent / version (publishers and tenants are unchanged).

  ## Approval gate (enforced in the database, not only in the UI)
  Approve requires: reviewer is not the publisher; a vetting report for THIS manifest_hash and endpoint, newer than 14 days,
  with verdict <> 'fail'; every applicable checklist item answered 'pass' (or 'na' where allowed). Anything else raises
  'APPROVAL_BLOCKED: <codes>'. First-party seeded agents are unaffected (they are seeded already approved).

  ## Existing queue
  Versions that are 'submitted' at deploy time must be vetted + checklisted before they can be approved.

  ## Rollback (data-preserving; run in this order)
    DROP FUNCTION IF EXISTS public.reinstate_marketplace_agent(uuid, text);
    DROP FUNCTION IF EXISTS public.delist_marketplace_agent(uuid, text, text, text);
    DROP FUNCTION IF EXISTS public.request_marketplace_changes(uuid, text);
    DROP FUNCTION IF EXISTS public.get_marketplace_review_state(uuid);
    DROP FUNCTION IF EXISTS public.save_marketplace_review_answer(uuid, text, text, text);
    DROP FUNCTION IF EXISTS public.marketplace_approval_blockers(uuid);
    DROP FUNCTION IF EXISTS public.marketplace_item_applies(text, text[], text, text);
    -- Re-create review_marketplace_agent_version / submit_marketplace_agent_version / validate_marketplace_manifest
    -- from 20270210000000_agent_marketplace.sql, then optionally drop the four new tables.
    -- Agents already set to 'delisted' must be moved to another status BEFORE restoring the old status CHECK.
*/

-- =============================================================
-- 1. Widen status CHECK constraints (name-independent, idempotent)
-- =============================================================
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.marketplace_agents'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%status%' AND pg_get_constraintdef(oid) ILIKE '%draft%'
  LOOP
    EXECUTE format('ALTER TABLE public.marketplace_agents DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.marketplace_agent_versions'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%status%' AND pg_get_constraintdef(oid) ILIKE '%submitted%'
  LOOP
    EXECUTE format('ALTER TABLE public.marketplace_agent_versions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.marketplace_agents
  ADD CONSTRAINT marketplace_agents_status_check
  CHECK (status IN ('draft', 'in_review', 'published', 'suspended', 'delisted'));
ALTER TABLE public.marketplace_agent_versions
  ADD CONSTRAINT marketplace_agent_versions_status_check
  CHECK (status IN ('submitted', 'changes_requested', 'approved', 'rejected', 'deprecated'));

ALTER TABLE public.marketplace_agents ADD COLUMN IF NOT EXISTS delisted_at timestamptz;
ALTER TABLE public.marketplace_agents ADD COLUMN IF NOT EXISTS delisted_reason_code text;
ALTER TABLE public.marketplace_agents ADD COLUMN IF NOT EXISTS delisted_by uuid;

-- Staff can read every agent / version (needed for delisting and review). Other policies are untouched.
DROP POLICY IF EXISTS "staff_select_all_marketplace_agents" ON public.marketplace_agents;
CREATE POLICY "staff_select_all_marketplace_agents" ON public.marketplace_agents FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_all_marketplace_versions" ON public.marketplace_agent_versions;
CREATE POLICY "staff_select_all_marketplace_versions" ON public.marketplace_agent_versions FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

-- =============================================================
-- 2. Manifest validation: optional outbound_domains (self-attested)
-- =============================================================
CREATE OR REPLACE FUNCTION public.validate_marketplace_manifest(p_manifest jsonb)
RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE
  v_item text;
  v_n integer;
BEGIN
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
    RAISE EXCEPTION 'Manifest must be a JSON object.';
  END IF;

  IF jsonb_typeof(p_manifest -> 'scopes') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_manifest -> 'scopes') NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'manifest.scopes must be an array of 1-12 scopes.';
  END IF;
  FOR v_item IN SELECT jsonb_array_elements_text(p_manifest -> 'scopes') LOOP
    IF NOT EXISTS (SELECT 1 FROM marketplace_scopes WHERE slug = v_item) THEN
      RAISE EXCEPTION 'Unknown scope: %', v_item;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_manifest -> 'triggers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_manifest -> 'triggers') NOT BETWEEN 1 AND 6 THEN
    RAISE EXCEPTION 'manifest.triggers must be an array of 1-6 triggers.';
  END IF;
  FOR v_item IN SELECT jsonb_array_elements_text(p_manifest -> 'triggers') LOOP
    IF NOT (v_item = ANY (public.marketplace_valid_triggers())) THEN
      RAISE EXCEPTION 'Unknown trigger: %', v_item;
    END IF;
  END LOOP;

  IF jsonb_exists(p_manifest, 'limits') THEN
    IF jsonb_typeof(p_manifest -> 'limits') <> 'object' THEN
      RAISE EXCEPTION 'manifest.limits must be an object.';
    END IF;
    IF jsonb_exists(p_manifest -> 'limits', 'timeout_ms') THEN
      IF jsonb_typeof(p_manifest -> 'limits' -> 'timeout_ms') <> 'number' THEN RAISE EXCEPTION 'limits.timeout_ms must be a number.'; END IF;
      v_n := (p_manifest -> 'limits' ->> 'timeout_ms')::numeric::integer;
      IF v_n NOT BETWEEN 1000 AND 15000 THEN RAISE EXCEPTION 'limits.timeout_ms must be 1000-15000.'; END IF;
    END IF;
    IF jsonb_exists(p_manifest -> 'limits', 'max_actions') THEN
      IF jsonb_typeof(p_manifest -> 'limits' -> 'max_actions') <> 'number' THEN RAISE EXCEPTION 'limits.max_actions must be a number.'; END IF;
      v_n := (p_manifest -> 'limits' ->> 'max_actions')::numeric::integer;
      IF v_n NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'limits.max_actions must be 1-10.'; END IF;
    END IF;
  END IF;

  IF jsonb_exists(p_manifest, 'system_prompt') THEN
    IF jsonb_typeof(p_manifest -> 'system_prompt') <> 'string' OR length(p_manifest ->> 'system_prompt') > 4000 THEN
      RAISE EXCEPTION 'manifest.system_prompt must be a string up to 4000 characters.';
    END IF;
  END IF;

  IF jsonb_exists(p_manifest, 'outbound_domains') THEN
    IF jsonb_typeof(p_manifest -> 'outbound_domains') <> 'array'
       OR jsonb_array_length(p_manifest -> 'outbound_domains') > 10 THEN
      RAISE EXCEPTION 'manifest.outbound_domains must be an array of at most 10 hostnames.';
    END IF;
    FOR v_item IN SELECT jsonb_array_elements_text(p_manifest -> 'outbound_domains') LOOP
      IF v_item !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
        RAISE EXCEPTION 'Invalid outbound domain: %', left(v_item, 80);
      END IF;
    END LOOP;
  END IF;
END;
$$;

-- Same as before, plus: a delisted agent cannot receive new versions.
CREATE OR REPLACE FUNCTION public.submit_marketplace_agent_version(p_agent_id uuid, p_version text, p_manifest jsonb)
RETURNS marketplace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent marketplace_agents;
  v_row marketplace_agent_versions;
BEGIN
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = p_agent_id AND publisher_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found.'; END IF;
  IF v_agent.status = 'suspended' THEN RAISE EXCEPTION 'This agent is suspended.'; END IF;
  IF v_agent.status = 'delisted' THEN RAISE EXCEPTION 'This agent is delisted.'; END IF;
  PERFORM public.validate_marketplace_manifest(p_manifest);
  IF v_agent.runtime = 'webhook' AND jsonb_exists(p_manifest, 'system_prompt') THEN
    RAISE EXCEPTION 'system_prompt is only valid for built-in agents.';
  END IF;

  INSERT INTO marketplace_agent_versions (agent_id, version, manifest, manifest_hash)
  VALUES (p_agent_id, p_version, p_manifest, encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex'))
  RETURNING * INTO v_row;

  IF v_agent.status = 'draft' THEN
    UPDATE marketplace_agents SET status = 'in_review', updated_at = now() WHERE id = p_agent_id;
  END IF;
  RETURN v_row;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Version % already exists for this agent.', p_version;
END;
$$;

-- =============================================================
-- 3. Vetting reports (append-only; no FK so history outlives its version)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.marketplace_vetting_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  manifest_hash text NOT NULL,
  endpoint_url text,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'warn', 'fail')),
  risk_tier text NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high')),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  data_exposure jsonb NOT NULL DEFAULT '{}'::jsonb,
  outbound_domains text[] NOT NULL DEFAULT '{}',
  engine_version text NOT NULL DEFAULT 'vetting/1',
  ran_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mvr_version_created ON public.marketplace_vetting_reports (version_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_mvr_immutable ON public.marketplace_vetting_reports;
CREATE TRIGGER trg_mvr_immutable BEFORE UPDATE OR DELETE ON public.marketplace_vetting_reports
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_block_mutation();

ALTER TABLE public.marketplace_vetting_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_select_marketplace_vetting_reports" ON public.marketplace_vetting_reports;
CREATE POLICY "staff_select_marketplace_vetting_reports" ON public.marketplace_vetting_reports FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_vetting_reports FROM anon, authenticated;

-- =============================================================
-- 4. Review checklist (reference data + staff answers)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.marketplace_review_checklist_items (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{2,59}$'),
  category text NOT NULL CHECK (category IN ('identity', 'security', 'data', 'behavior', 'commercial', 'legal')),
  applies_to text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'paid', 'pii', 'sms', 'high_risk')),
  allows_na boolean NOT NULL DEFAULT false,
  needs_counsel boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100
);
ALTER TABLE public.marketplace_review_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_select_marketplace_checklist_items" ON public.marketplace_review_checklist_items;
CREATE POLICY "staff_select_marketplace_checklist_items" ON public.marketplace_review_checklist_items FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

INSERT INTO public.marketplace_review_checklist_items (slug, category, applies_to, allows_na, needs_counsel, sort_order) VALUES
  ('publisher_identity',     'identity',   'all',       false, false, 10),
  ('security_contact',       'security',   'all',       false, false, 20),
  ('endpoint_control',       'security',   'all',       false, false, 30),
  ('signature_verification', 'security',   'all',       false, false, 40),
  ('scopes_justified',       'data',       'all',       false, false, 50),
  ('pii_minimisation',       'data',       'pii',       false, false, 60),
  ('subprocessors_match',    'data',       'pii',       true,  false, 70),
  ('dpa_in_place',           'legal',      'high_risk', false, true,  80),
  ('sandbox_run_reviewed',   'behavior',   'all',       false, false, 90),
  ('sms_compliance',         'behavior',   'sms',       false, true,  100),
  ('pricing_terms_clear',    'commercial', 'paid',      false, false, 110),
  ('delisting_terms_ack',    'legal',      'all',       false, true,  120)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.marketplace_review_checklist_answers (
  version_id uuid NOT NULL REFERENCES public.marketplace_agent_versions(id) ON DELETE CASCADE,
  item_slug text NOT NULL REFERENCES public.marketplace_review_checklist_items(slug),
  answer text NOT NULL CHECK (answer IN ('pass', 'fail', 'na')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  answered_by uuid NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, item_slug),
  CONSTRAINT mrca_note_required CHECK (answer = 'pass' OR (note IS NOT NULL AND length(btrim(note)) >= 5))
);
ALTER TABLE public.marketplace_review_checklist_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_select_marketplace_checklist_answers" ON public.marketplace_review_checklist_answers;
CREATE POLICY "staff_select_marketplace_checklist_answers" ON public.marketplace_review_checklist_answers FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_review_checklist_answers FROM anon, authenticated;

-- =============================================================
-- 5. Delisting history (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.marketplace_delisting_events (
  id bigserial PRIMARY KEY,
  agent_id uuid NOT NULL,
  agent_slug text NOT NULL,
  action text NOT NULL CHECK (action IN ('delisted', 'reinstated')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('security', 'privacy', 'policy', 'fraud', 'quality', 'publisher_request', 'legal', 'other')),
  detail text NOT NULL CHECK (length(btrim(detail)) BETWEEN 5 AND 2000),
  installs_revoked integer NOT NULL DEFAULT 0,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mde_reason_for_delist CHECK (action <> 'delisted' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mde_agent_created ON public.marketplace_delisting_events (agent_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_mde_immutable ON public.marketplace_delisting_events;
CREATE TRIGGER trg_mde_immutable BEFORE UPDATE OR DELETE ON public.marketplace_delisting_events
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_block_mutation();
ALTER TABLE public.marketplace_delisting_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_select_marketplace_delisting_events" ON public.marketplace_delisting_events;
CREATE POLICY "staff_select_marketplace_delisting_events" ON public.marketplace_delisting_events FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_delisting_events FROM anon, authenticated;

-- =============================================================
-- 6. Gate helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.marketplace_item_applies(p_applies_to text, p_scopes text[], p_pricing_model text, p_risk_tier text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_applies_to
    WHEN 'all' THEN true
    WHEN 'paid' THEN COALESCE(p_pricing_model, 'free') <> 'free'
    WHEN 'pii' THEN 'read:customer_contact' = ANY (COALESCE(p_scopes, '{}'::text[]))
    WHEN 'sms' THEN 'act:send_sms' = ANY (COALESCE(p_scopes, '{}'::text[]))
    WHEN 'high_risk' THEN COALESCE(p_risk_tier, 'high') = 'high'
    ELSE true
  END;
$$;

-- Single source of truth for "can this version be approved right now?". Returns blocker codes (empty = ready).
CREATE OR REPLACE FUNCTION public.marketplace_approval_blockers(p_version_id uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v marketplace_agent_versions;
  a marketplace_agents;
  rep marketplace_vetting_reports;
  v_scopes text[];
  v_blockers text[] := '{}';
BEGIN
  SELECT * INTO v FROM marketplace_agent_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RETURN ARRAY['version_missing']; END IF;
  SELECT * INTO a FROM marketplace_agents WHERE id = v.agent_id;

  IF a.publisher_id IS NOT NULL AND a.publisher_id = auth.uid() THEN v_blockers := v_blockers || 'self_review'; END IF;
  IF a.status IN ('suspended', 'delisted') THEN v_blockers := v_blockers || ('agent_' || a.status); END IF;

  SELECT * INTO rep FROM marketplace_vetting_reports WHERE version_id = p_version_id ORDER BY created_at DESC LIMIT 1;
  IF rep.id IS NULL THEN
    v_blockers := v_blockers || 'no_report';
  ELSE
    IF rep.manifest_hash <> v.manifest_hash THEN v_blockers := v_blockers || 'report_manifest_mismatch'; END IF;
    IF rep.endpoint_url IS DISTINCT FROM a.endpoint_url THEN v_blockers := v_blockers || 'report_endpoint_mismatch'; END IF;
    IF rep.created_at < now() - interval '14 days' THEN v_blockers := v_blockers || 'report_stale'; END IF;
    IF rep.verdict = 'fail' THEN v_blockers := v_blockers || 'report_failed'; END IF;
  END IF;

  v_scopes := ARRAY(SELECT jsonb_array_elements_text(v.manifest -> 'scopes'));

  IF EXISTS (SELECT 1 FROM marketplace_review_checklist_answers r WHERE r.version_id = p_version_id AND r.answer = 'fail') THEN
    v_blockers := v_blockers || 'checklist_failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM marketplace_review_checklist_items i
    WHERE public.marketplace_item_applies(i.applies_to, v_scopes, a.pricing_model, COALESCE(rep.risk_tier, 'high'))
      AND NOT EXISTS (
        SELECT 1 FROM marketplace_review_checklist_answers r
        WHERE r.version_id = p_version_id AND r.item_slug = i.slug AND r.answer IN ('pass', 'na')
      )
  ) THEN
    v_blockers := v_blockers || 'checklist_incomplete';
  END IF;
  RETURN v_blockers;
END;
$$;

-- =============================================================
-- 7. Staff RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_marketplace_review_answer(p_version_id uuid, p_item_slug text, p_answer text, p_note text DEFAULT NULL)
RETURNS marketplace_review_checklist_answers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v marketplace_agent_versions;
  a marketplace_agents;
  it marketplace_review_checklist_items;
  v_row marketplace_review_checklist_answers;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  SELECT * INTO v FROM marketplace_agent_versions WHERE id = p_version_id AND status = 'submitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found or not awaiting review.'; END IF;
  SELECT * INTO a FROM marketplace_agents WHERE id = v.agent_id;
  IF a.publisher_id IS NOT NULL AND a.publisher_id = auth.uid() THEN RAISE EXCEPTION 'You cannot review your own agent.'; END IF;
  SELECT * INTO it FROM marketplace_review_checklist_items WHERE slug = p_item_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown checklist item.'; END IF;
  IF p_answer NOT IN ('pass', 'fail', 'na') THEN RAISE EXCEPTION 'Answer must be pass, fail or na.'; END IF;
  IF p_answer = 'na' AND NOT it.allows_na THEN RAISE EXCEPTION 'This item cannot be marked not applicable.'; END IF;
  IF p_answer <> 'pass' AND length(btrim(COALESCE(p_note, ''))) < 5 THEN RAISE EXCEPTION 'A note of at least 5 characters is required for fail / na.'; END IF;

  INSERT INTO marketplace_review_checklist_answers (version_id, item_slug, answer, note, answered_by)
  VALUES (p_version_id, p_item_slug, p_answer, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  ON CONFLICT (version_id, item_slug)
  DO UPDATE SET answer = EXCLUDED.answer, note = EXCLUDED.note, answered_by = EXCLUDED.answered_by, answered_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_marketplace_review_state(p_version_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v marketplace_agent_versions;
  a marketplace_agents;
  rep marketplace_vetting_reports;
  v_scopes text[];
  v_items jsonb;
  v_blockers text[];
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  SELECT * INTO v FROM marketplace_agent_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found.'; END IF;
  SELECT * INTO a FROM marketplace_agents WHERE id = v.agent_id;
  SELECT * INTO rep FROM marketplace_vetting_reports WHERE version_id = p_version_id ORDER BY created_at DESC LIMIT 1;
  v_scopes := ARRAY(SELECT jsonb_array_elements_text(v.manifest -> 'scopes'));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slug', i.slug, 'category', i.category, 'allows_na', i.allows_na, 'needs_counsel', i.needs_counsel,
           'applies', public.marketplace_item_applies(i.applies_to, v_scopes, a.pricing_model, COALESCE(rep.risk_tier, 'high')),
           'answer', r.answer, 'note', r.note) ORDER BY i.sort_order, i.slug), '[]'::jsonb)
    INTO v_items
  FROM marketplace_review_checklist_items i
  LEFT JOIN marketplace_review_checklist_answers r ON r.item_slug = i.slug AND r.version_id = p_version_id;

  v_blockers := public.marketplace_approval_blockers(p_version_id);
  RETURN jsonb_build_object(
    'version_id', p_version_id,
    'status', v.status,
    'report', CASE WHEN rep.id IS NULL THEN NULL ELSE to_jsonb(rep) END,
    'items', v_items,
    'blockers', to_jsonb(v_blockers),
    'ready', COALESCE(array_length(v_blockers, 1), 0) = 0
  );
END;
$$;

-- Approval is now gated. Same signature as before.
CREATE OR REPLACE FUNCTION public.review_marketplace_agent_version(p_version_id uuid, p_approve boolean, p_notes text DEFAULT NULL)
RETURNS marketplace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row marketplace_agent_versions;
  v_agent marketplace_agents;
  v_blockers text[];
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  SELECT * INTO v_row FROM marketplace_agent_versions WHERE id = p_version_id AND status = 'submitted' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found or already reviewed.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_row.agent_id FOR UPDATE;
  IF v_agent.status IN ('suspended', 'delisted') THEN RAISE EXCEPTION 'Agent is %.', v_agent.status; END IF;
  IF v_agent.publisher_id IS NOT NULL AND v_agent.publisher_id = auth.uid() THEN RAISE EXCEPTION 'You cannot review your own agent.'; END IF;

  IF NOT p_approve AND length(btrim(COALESCE(p_notes, ''))) < 5 THEN
    RAISE EXCEPTION 'A rejection needs a note of at least 5 characters.';
  END IF;
  IF p_approve THEN
    v_blockers := public.marketplace_approval_blockers(p_version_id);
    IF COALESCE(array_length(v_blockers, 1), 0) > 0 THEN
      RAISE EXCEPTION 'APPROVAL_BLOCKED: %', array_to_string(v_blockers, ',');
    END IF;
  END IF;

  UPDATE marketplace_agent_versions
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      review_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_version_id RETURNING * INTO v_row;

  IF p_approve THEN
    UPDATE marketplace_agent_versions SET status = 'deprecated'
      WHERE agent_id = v_row.agent_id AND status = 'approved' AND id <> p_version_id;
    UPDATE marketplace_agents SET current_version_id = p_version_id, status = 'published', updated_at = now()
      WHERE id = v_row.agent_id;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_marketplace_changes(p_version_id uuid, p_notes text)
RETURNS marketplace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row marketplace_agent_versions;
  v_agent marketplace_agents;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  IF length(btrim(COALESCE(p_notes, ''))) < 5 THEN RAISE EXCEPTION 'Describe the requested changes (at least 5 characters).'; END IF;
  SELECT * INTO v_row FROM marketplace_agent_versions WHERE id = p_version_id AND status = 'submitted' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found or already reviewed.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = v_row.agent_id;
  IF v_agent.publisher_id IS NOT NULL AND v_agent.publisher_id = auth.uid() THEN RAISE EXCEPTION 'You cannot review your own agent.'; END IF;
  IF v_agent.status IN ('suspended', 'delisted') THEN RAISE EXCEPTION 'Agent is %.', v_agent.status; END IF;

  UPDATE marketplace_agent_versions
  SET status = 'changes_requested', review_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_version_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delist_marketplace_agent(p_agent_id uuid, p_reason_code text, p_internal_detail text, p_publisher_message text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent marketplace_agents;
  r record;
  v_n integer := 0;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('security', 'privacy', 'policy', 'fraud', 'quality', 'publisher_request', 'legal', 'other') THEN
    RAISE EXCEPTION 'Invalid delisting reason.';
  END IF;
  IF length(btrim(COALESCE(p_internal_detail, ''))) NOT BETWEEN 5 AND 2000 THEN RAISE EXCEPTION 'Internal detail must be 5-2000 characters.'; END IF;
  IF length(btrim(COALESCE(p_publisher_message, ''))) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'Publisher message must be 5-500 characters.'; END IF;

  SELECT * INTO v_agent FROM marketplace_agents WHERE id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found.'; END IF;
  IF v_agent.status = 'delisted' THEN RAISE EXCEPTION 'Agent is already delisted.'; END IF;

  UPDATE marketplace_agents
  SET status = 'delisted', delisted_at = now(), delisted_reason_code = p_reason_code, delisted_by = auth.uid(),
      suspended_reason = btrim(p_publisher_message), updated_at = now()
  WHERE id = p_agent_id;

  -- Approved versions can no longer be installed or upgraded to; re-listing needs a fresh review.
  UPDATE marketplace_agent_versions SET status = 'deprecated' WHERE agent_id = p_agent_id AND status = 'approved';

  FOR r IN SELECT id, user_id FROM marketplace_agent_installs WHERE agent_id = p_agent_id AND status <> 'revoked' FOR UPDATE LOOP
    UPDATE marketplace_agent_installs SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = r.id;
    UPDATE marketplace_agent_runs SET status = 'blocked', error = 'Agent delisted', finished_at = now(), input = '{}'::jsonb
      WHERE install_id = r.id AND status = 'queued';
    PERFORM public.marketplace_audit_log(r.user_id, p_agent_id, r.id, auth.uid(), 'agent_delisted', jsonb_build_object('reason_code', p_reason_code));
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO marketplace_delisting_events (agent_id, agent_slug, action, reason_code, detail, installs_revoked, actor)
  VALUES (p_agent_id, v_agent.slug, 'delisted', p_reason_code, btrim(p_internal_detail), v_n, auth.uid());
  RETURN jsonb_build_object('agent_id', p_agent_id, 'installs_revoked', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.reinstate_marketplace_agent(p_agent_id uuid, p_detail text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_agent marketplace_agents;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  IF length(btrim(COALESCE(p_detail, ''))) NOT BETWEEN 5 AND 2000 THEN RAISE EXCEPTION 'Detail must be 5-2000 characters.'; END IF;
  SELECT * INTO v_agent FROM marketplace_agents WHERE id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found.'; END IF;
  IF v_agent.status <> 'delisted' THEN RAISE EXCEPTION 'Agent is not delisted.'; END IF;

  -- Back to draft with no current version: it must pass vetting + the checklist again before it is listed.
  UPDATE marketplace_agents
  SET status = 'draft', current_version_id = NULL, suspended_reason = NULL, updated_at = now()
  WHERE id = p_agent_id;
  INSERT INTO marketplace_delisting_events (agent_id, agent_slug, action, reason_code, detail, installs_revoked, actor)
  VALUES (p_agent_id, v_agent.slug, 'reinstated', NULL, btrim(p_detail), 0, auth.uid());
END;
$$;

-- =============================================================
-- 8. Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.marketplace_approval_blockers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_approval_blockers(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.save_marketplace_review_answer(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_marketplace_review_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_marketplace_changes(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delist_marketplace_agent(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reinstate_marketplace_agent(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_marketplace_review_answer(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_marketplace_review_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_marketplace_changes(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delist_marketplace_agent(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reinstate_marketplace_agent(uuid, text) TO authenticated;
