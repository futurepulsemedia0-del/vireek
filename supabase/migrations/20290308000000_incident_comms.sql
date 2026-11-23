/*
  # Customer incident communication: draft -> human approval -> publish

  ## What this adds (on top of status_incidents / status_incident_updates / status_subscribers)
    - incident_comms_drafts    a status post + customer email drafted from ONE incident, with a state machine:
                               draft -> pending_approval -> approved -> sending -> sent | send_failed   (or rejected)
    - incident_comms_events    append-only trail (who drafted / edited / approved / sent what, when)
    - incident_comms_settings  singleton: require a SECOND person to approve SEV1/SEV2/major incidents (default ON)

  ## Guarantees enforced in the database (not only in the UI)
    1. Nothing is published without an approval row: send is only claimable from 'approved'.
    2. The approval is bound to the exact text: content_hash is stored at approval time; any later edit
       (trigger) drops the draft back to 'draft' and clears the approval. Send re-checks hash equality.
    3. Four-eyes for SEV1/SEV2 or major-impact incidents (setting, default ON): approver <> drafter/submitter.
    4. SEV3/SEV4 never go to the email audience (status page only).
    5. A draft that promised "next update by T" cannot be sent after T (regenerate instead).
    6. Publishing is idempotent per step: status post and email each have their own *_at marker, so a retry after a
       partial failure never posts or emails twice.
    7. All mutating RPCs are service_role only: the only gateway is the `incident-comms` edge function, which
       authenticates the caller, requires is_vireek_staff, and lints the text (PII, ids, provider names, breach wording)
       before submit/approve.

  Requires: status_incidents, status_incident_updates (20271102000000), is_vireek_staff(uuid), audit_log.
  [COUNSEL] regulatory / contractual customer notification duties (e.g. data-incident notices) are NOT automated here.
  Idempotent: safe to run twice.
*/

CREATE TABLE IF NOT EXISTS public.incident_comms_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  require_second_approver_major boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.incident_comms_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.incident_comms_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.status_incidents(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('investigating', 'identified', 'monitoring', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  audience text NOT NULL CHECK (audience IN ('status_page', 'status_page_and_subscribers')),
  status_post_text text NOT NULL CHECK (char_length(btrim(status_post_text)) BETWEEN 1 AND 600),
  email_subject text CHECK (email_subject IS NULL OR char_length(email_subject) <= 150),
  email_body text CHECK (email_body IS NULL OR char_length(email_body) <= 4000),
  next_update_at timestamptz,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent', 'send_failed')),
  created_by uuid NOT NULL,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  approved_hash text,
  rejected_by uuid,
  rejected_at timestamptz,
  reject_reason text CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 300),
  sent_by uuid,
  status_posted_at timestamptz,
  email_sent_at timestamptz,
  email_result jsonb,
  send_error text CHECK (send_error IS NULL OR char_length(send_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT icd_email_needed CHECK (audience = 'status_page' OR (email_subject IS NOT NULL AND email_body IS NOT NULL
    AND char_length(btrim(email_subject)) > 0 AND char_length(btrim(email_body)) > 0)),
  CONSTRAINT icd_minor_sev_no_email CHECK (severity IN ('sev1', 'sev2') OR audience = 'status_page'),
  CONSTRAINT icd_approval_complete CHECK (state NOT IN ('approved', 'sending', 'sent', 'send_failed')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_icd_incident ON public.incident_comms_drafts (incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_icd_state ON public.incident_comms_drafts (state, updated_at DESC);

-- Hash of everything a reader would see. Computed on demand (not a stored column) so no immutability caveats.
CREATE OR REPLACE FUNCTION public.incident_comms_hash(d public.incident_comms_drafts)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(
    d.phase || E'\n' || d.severity || E'\n' || d.audience || E'\n' ||
    coalesce(d.status_post_text, '') || E'\n--\n' || coalesce(d.email_subject, '') || E'\n--\n' || coalesce(d.email_body, ''),
    'UTF8')), 'hex');
$$;

CREATE TABLE IF NOT EXISTS public.incident_comms_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action IN (
    'drafted', 'edited', 'submitted', 'approved', 'rejected', 'send_started', 'status_posted', 'email_sent', 'sent', 'send_failed'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 200),
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ice_draft ON public.incident_comms_events (draft_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ice_incident ON public.incident_comms_events (incident_id, created_at);

CREATE OR REPLACE FUNCTION public.incident_comms_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS trg_ice_append_only ON public.incident_comms_events;
CREATE TRIGGER trg_ice_append_only BEFORE UPDATE OR DELETE ON public.incident_comms_events
  FOR EACH ROW EXECUTE FUNCTION public.incident_comms_events_append_only();

-- Editing after submit/approval invalidates the approval; nothing may be edited once sending started.
CREATE OR REPLACE FUNCTION public.incident_comms_guard_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.phase, NEW.severity, NEW.audience, NEW.status_post_text, NEW.email_subject, NEW.email_body, NEW.next_update_at)
     IS DISTINCT FROM
     (OLD.phase, OLD.severity, OLD.audience, OLD.status_post_text, OLD.email_subject, OLD.email_body, OLD.next_update_at) THEN
    IF OLD.state IN ('sending', 'sent', 'send_failed', 'rejected') THEN
      RAISE EXCEPTION 'draft is locked (%)', OLD.state USING ERRCODE = 'P0001';
    END IF;
    IF OLD.state IN ('pending_approval', 'approved') THEN
      NEW.state := 'draft';
      NEW.submitted_by := NULL; NEW.submitted_at := NULL;
      NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.approved_hash := NULL;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_icd_guard_edit ON public.incident_comms_drafts;
CREATE TRIGGER trg_icd_guard_edit BEFORE UPDATE ON public.incident_comms_drafts
  FOR EACH ROW EXECUTE FUNCTION public.incident_comms_guard_edit();

-- ---------------------------------------------------------------------------
-- RLS: staff read only; no client writes at all
-- ---------------------------------------------------------------------------
ALTER TABLE public.incident_comms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_comms_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_comms_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_incident_comms_settings" ON public.incident_comms_settings;
CREATE POLICY "staff_select_incident_comms_settings" ON public.incident_comms_settings
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));
DROP POLICY IF EXISTS "staff_select_incident_comms_drafts" ON public.incident_comms_drafts;
CREATE POLICY "staff_select_incident_comms_drafts" ON public.incident_comms_drafts
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));
DROP POLICY IF EXISTS "staff_select_incident_comms_events" ON public.incident_comms_events;
CREATE POLICY "staff_select_incident_comms_events" ON public.incident_comms_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));

REVOKE ALL ON public.incident_comms_settings, public.incident_comms_drafts, public.incident_comms_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.incident_comms_settings, public.incident_comms_drafts, public.incident_comms_events FROM authenticated;
GRANT SELECT ON public.incident_comms_settings, public.incident_comms_drafts, public.incident_comms_events TO authenticated;

-- ---------------------------------------------------------------------------
-- Internal: append an event (never callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_comms_log(p_draft uuid, p_actor uuid, p_action text, p_detail text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.incident_comms_events (draft_id, incident_id, actor_id, action, detail, content_hash)
  SELECT d.id, d.incident_id, p_actor, p_action, left(p_detail, 200), public.incident_comms_hash(d)
    FROM public.incident_comms_drafts d WHERE d.id = p_draft;
END;
$$;
REVOKE ALL ON FUNCTION public.incident_comms_log(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Service-role RPCs (called only by the incident-comms edge function, after it verified staff + linted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_comms_create_draft(
  p_actor uuid, p_incident uuid, p_phase text, p_severity text, p_audience text,
  p_status_post text, p_email_subject text, p_email_body text, p_next_update_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'actor required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.status_incidents WHERE id = p_incident) THEN
    RAISE EXCEPTION 'unknown incident' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.incident_comms_drafts
    (incident_id, phase, severity, audience, status_post_text, email_subject, email_body, next_update_at, created_by)
  VALUES (p_incident, p_phase, p_severity, p_audience, p_status_post,
          CASE WHEN p_audience = 'status_page' THEN NULL ELSE p_email_subject END,
          CASE WHEN p_audience = 'status_page' THEN NULL ELSE p_email_body END,
          p_next_update_at, p_actor)
  RETURNING id INTO v_id;
  PERFORM public.incident_comms_log(v_id, p_actor, 'drafted');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_comms_update_draft(
  p_actor uuid, p_id uuid, p_status_post text, p_email_subject text, p_email_body text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.incident_comms_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.incident_comms_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown draft' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.incident_comms_drafts
     SET status_post_text = p_status_post,
         email_subject = CASE WHEN d.audience = 'status_page' THEN NULL ELSE p_email_subject END,
         email_body = CASE WHEN d.audience = 'status_page' THEN NULL ELSE p_email_body END
   WHERE id = p_id;
  PERFORM public.incident_comms_log(p_id, p_actor, 'edited', CASE WHEN d.state IN ('pending_approval', 'approved') THEN 'approval reset' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_comms_submit(p_actor uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.incident_comms_drafts SET state = 'pending_approval', submitted_by = p_actor, submitted_at = now()
   WHERE id = p_id AND state = 'draft';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'only a draft can be submitted' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.incident_comms_log(p_id, p_actor, 'submitted');
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_comms_approve(p_actor uuid, p_id uuid, p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.incident_comms_drafts%ROWTYPE;
  v_major boolean;
  v_strict boolean;
BEGIN
  SELECT * INTO d FROM public.incident_comms_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown draft' USING ERRCODE = 'P0002'; END IF;
  IF d.state <> 'pending_approval' THEN RAISE EXCEPTION 'draft is not awaiting approval' USING ERRCODE = 'P0001'; END IF;
  IF p_hash IS DISTINCT FROM public.incident_comms_hash(d) THEN
    RAISE EXCEPTION 'the text changed since you reviewed it' USING ERRCODE = 'P0001';
  END IF;

  SELECT require_second_approver_major INTO v_strict FROM public.incident_comms_settings WHERE id;
  SELECT (i.impact = 'major') INTO v_major FROM public.status_incidents i WHERE i.id = d.incident_id;
  IF v_strict AND (d.severity IN ('sev1', 'sev2') OR COALESCE(v_major, false))
     AND p_actor IN (d.created_by, d.submitted_by) THEN
    RAISE EXCEPTION 'a second person must approve this incident communication' USING ERRCODE = '42501';
  END IF;

  UPDATE public.incident_comms_drafts
     SET state = 'approved', approved_by = p_actor, approved_at = now(), approved_hash = p_hash
   WHERE id = p_id;
  PERFORM public.incident_comms_log(p_id, p_actor, 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_comms_reject(p_actor uuid, p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.incident_comms_drafts
     SET state = 'rejected', rejected_by = p_actor, rejected_at = now(), reject_reason = left(p_reason, 300)
   WHERE id = p_id AND state IN ('pending_approval', 'approved');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'nothing to reject' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.incident_comms_log(p_id, p_actor, 'rejected', left(p_reason, 200));
END;
$$;

-- Atomic claim; returns what the sender still has to do (each step is idempotent via its own *_at marker).
CREATE OR REPLACE FUNCTION public.incident_comms_claim_send(p_actor uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.incident_comms_drafts%ROWTYPE;
  i public.status_incidents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.incident_comms_drafts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown draft' USING ERRCODE = 'P0002'; END IF;
  IF d.state NOT IN ('approved', 'send_failed') THEN
    RAISE EXCEPTION 'draft is not approved (state: %)', d.state USING ERRCODE = 'P0001';
  END IF;
  IF d.approved_hash IS DISTINCT FROM public.incident_comms_hash(d) THEN
    RAISE EXCEPTION 'approval does not match the current text' USING ERRCODE = 'P0001';
  END IF;
  IF d.phase <> 'resolved' AND d.next_update_at IS NOT NULL AND d.next_update_at < now()
     AND d.status_posted_at IS NULL THEN
    RAISE EXCEPTION 'draft_stale: the promised next-update time has passed, regenerate the draft' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.incident_comms_drafts SET state = 'sending', sent_by = p_actor, send_error = NULL WHERE id = p_id;
  PERFORM public.incident_comms_log(p_id, p_actor, 'send_started');
  SELECT * INTO i FROM public.status_incidents WHERE id = d.incident_id;

  RETURN jsonb_build_object(
    'id', d.id, 'incident_id', d.incident_id, 'audience', d.audience, 'phase', d.phase, 'severity', d.severity,
    'status_post_text', d.status_post_text, 'email_subject', d.email_subject, 'email_body', d.email_body,
    'impact', i.impact, 'incident_title', i.title,
    'status_posted', d.status_posted_at IS NOT NULL, 'email_sent', d.email_sent_at IS NOT NULL
  );
END;
$$;

-- Step 1: publish the status post (insert update + move incident status). Idempotent.
CREATE OR REPLACE FUNCTION public.incident_comms_publish_status(p_actor uuid, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.incident_comms_drafts%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO d FROM public.incident_comms_drafts WHERE id = p_id AND state = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'draft is not being sent' USING ERRCODE = 'P0001'; END IF;
  IF d.status_posted_at IS NOT NULL THEN RETURN false; END IF;

  v_status := CASE d.phase WHEN 'resolved' THEN 'resolved' WHEN 'monitoring' THEN 'monitoring' ELSE 'investigating' END;
  INSERT INTO public.status_incident_updates (incident_id, status, message) VALUES (d.incident_id, v_status, d.status_post_text);
  UPDATE public.status_incidents
     SET status = v_status,
         resolved_at = CASE WHEN v_status = 'resolved' THEN COALESCE(resolved_at, now()) ELSE NULL END,
         updated_at = now()
   WHERE id = d.incident_id;
  UPDATE public.incident_comms_drafts SET status_posted_at = now() WHERE id = p_id;
  PERFORM public.incident_comms_log(p_id, p_actor, 'status_posted');
  RETURN true;
END;
$$;

-- Step 2: record that the customer email went out. Idempotent.
CREATE OR REPLACE FUNCTION public.incident_comms_mark_emailed(p_actor uuid, p_id uuid, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.incident_comms_drafts
     SET email_sent_at = COALESCE(email_sent_at, now()), email_result = COALESCE(email_result, p_result)
   WHERE id = p_id AND state = 'sending';
  IF NOT FOUND THEN RAISE EXCEPTION 'draft is not being sent' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.incident_comms_log(p_id, p_actor, 'email_sent',
    left(COALESCE('sent=' || (p_result ->> 'sent') || ' failed=' || (p_result ->> 'failed'), ''), 200));
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_comms_finish(p_actor uuid, p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.incident_comms_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.incident_comms_drafts WHERE id = p_id AND state = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'draft is not being sent' USING ERRCODE = 'P0001'; END IF;
  IF p_ok AND (d.status_posted_at IS NULL OR (d.audience <> 'status_page' AND d.email_sent_at IS NULL)) THEN
    RAISE EXCEPTION 'cannot finish: a step is still missing' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.incident_comms_drafts
     SET state = CASE WHEN p_ok THEN 'sent' ELSE 'send_failed' END, send_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 300) END
   WHERE id = p_id;
  PERFORM public.incident_comms_log(p_id, p_actor, CASE WHEN p_ok THEN 'sent' ELSE 'send_failed' END, left(p_error, 200));
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'incident_comms_create_draft(uuid, uuid, text, text, text, text, text, text, timestamptz)',
    'incident_comms_update_draft(uuid, uuid, text, text, text)',
    'incident_comms_submit(uuid, uuid)',
    'incident_comms_approve(uuid, uuid, text)',
    'incident_comms_reject(uuid, uuid, text)',
    'incident_comms_claim_send(uuid, uuid)',
    'incident_comms_publish_status(uuid, uuid)',
    'incident_comms_mark_emailed(uuid, uuid, jsonb)',
    'incident_comms_finish(uuid, uuid, boolean, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Staff read + audited settings (authenticated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_incident_comms_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_incidents jsonb;
  v_drafts jsonb;
  v_strict boolean;
BEGIN
  IF NOT public.is_vireek_staff(v_uid) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  SELECT require_second_approver_major INTO v_strict FROM public.incident_comms_settings WHERE id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', i.id, 'title', i.title, 'impact', i.impact, 'status', i.status, 'component_id', i.component_id,
      'region', i.region, 'summary', i.summary, 'started_at', i.started_at, 'resolved_at', i.resolved_at,
      'last_update', (SELECT u.message FROM public.status_incident_updates u WHERE u.incident_id = i.id ORDER BY u.created_at DESC LIMIT 1)
    ) ORDER BY (i.status <> 'resolved') DESC, i.started_at DESC), '[]'::jsonb)
    INTO v_incidents
    FROM (SELECT * FROM public.status_incidents WHERE status <> 'resolved' OR started_at >= now() - interval '30 days'
          ORDER BY started_at DESC LIMIT 40) i;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'incident_id', d.incident_id, 'phase', d.phase, 'severity', d.severity, 'audience', d.audience,
      'status_post_text', d.status_post_text, 'email_subject', d.email_subject, 'email_body', d.email_body,
      'next_update_at', d.next_update_at, 'state', d.state, 'created_by', d.created_by, 'submitted_by', d.submitted_by,
      'approved_by', d.approved_by, 'approved_at', d.approved_at, 'reject_reason', d.reject_reason,
      'status_posted_at', d.status_posted_at, 'email_sent_at', d.email_sent_at, 'email_result', d.email_result,
      'send_error', d.send_error, 'content_hash', public.incident_comms_hash(d), 'updated_at', d.updated_at,
      'me', v_uid
    ) ORDER BY d.updated_at DESC), '[]'::jsonb)
    INTO v_drafts
    FROM (SELECT * FROM public.incident_comms_drafts ORDER BY updated_at DESC LIMIT 60) d;

  RETURN jsonb_build_object('me', v_uid, 'require_second_approver_major', v_strict, 'incidents', v_incidents, 'drafts', v_drafts);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_incident_comms_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_incident_comms_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_incident_comms_update_settings(p_require_second boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_vireek_staff(v_uid) THEN RAISE EXCEPTION 'staff only' USING ERRCODE = '42501'; END IF;
  IF p_require_second IS NULL THEN RAISE EXCEPTION 'value required' USING ERRCODE = '22023'; END IF;
  UPDATE public.incident_comms_settings SET require_second_approver_major = p_require_second, updated_by = v_uid, updated_at = now() WHERE id;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_uid, v_uid, (SELECT email FROM public.profiles WHERE id = v_uid), 'incident_comms_settings_updated', 'incident_comms_settings', 'singleton');
END;
$$;
REVOKE ALL ON FUNCTION public.staff_incident_comms_update_settings(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_incident_comms_update_settings(boolean) TO authenticated;
