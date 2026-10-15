/*
  # Message Templates (SMS + email) — /dashboard/templates

  ## Why
  One governed library of customer-facing SMS/email copy with variables, an approval workflow and usage
  stats, so every automated message is reviewed before it can be sent and is A2P 10DLC / CAN-SPAM safe.

  ## Model
    message_templates       — one row per template, scoped to the account owner (user_id = get_account_owner_id()).
    message_template_usage  — append-only usage events written ONLY by record_message_template_use().

  ## Security
  - RLS: every member of the account can read; only members with can_edit_business_profile (or the owner)
    can insert/update. There is no DELETE policy: templates are archived, never destroyed.
  - Status changes are impossible from the client: a trigger pins status/review fields unless the change
    comes through review_message_template() (SECURITY DEFINER), which enforces permissions, the
    four-eyes rule (a non-owner cannot approve their own template) and server-side compliance checks.
  - Editing the content of an approved / pending / rejected template sends it back to draft, so what is
    approved is always exactly what was reviewed.
*/

-- =============================================================
-- Permission helper (mirrors the UI: owner, else team flag, custom role overrides)
-- =============================================================

CREATE OR REPLACE FUNCTION public.message_templates_has_permission(p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_permission IN ('can_edit_business_profile', 'can_manage_team')
    AND (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      OR EXISTS (
        SELECT 1
        FROM team_members tm
        LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
        WHERE tm.user_id = auth.uid()
          AND COALESCE(
            CASE WHEN cr.permissions ? p_permission THEN (cr.permissions -> p_permission) = 'true'::jsonb END,
            (tm.permissions -> p_permission) = 'true'::jsonb,
            false
          )
      )
    );
$$;

-- =============================================================
-- MESSAGE_TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  category text NOT NULL CHECK (category IN ('appointment', 'service_update', 'payment', 'review_request', 'follow_up', 'marketing')),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 200),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived')),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_templates_sms_length CHECK (channel <> 'sms' OR char_length(body) <= 1600)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_templates_active_name
  ON message_templates (user_id, channel, lower(btrim(name)))
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_message_templates_account
  ON message_templates (user_id, status, updated_at DESC);

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_message_templates" ON message_templates;
CREATE POLICY "select_account_message_templates" ON message_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_message_templates" ON message_templates;
CREATE POLICY "insert_account_message_templates" ON message_templates FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND status = 'draft'
    AND public.message_templates_has_permission('can_edit_business_profile')
  );

DROP POLICY IF EXISTS "update_account_message_templates" ON message_templates;
CREATE POLICY "update_account_message_templates" ON message_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.message_templates_has_permission('can_edit_business_profile'))
  WITH CHECK (user_id = public.get_account_owner_id() AND public.message_templates_has_permission('can_edit_business_profile'));

-- No DELETE policy on purpose: archive instead.

-- Guard: pins status/review fields to the RPC and resets approval when content changes.
CREATE OR REPLACE FUNCTION public.guard_message_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rpc boolean := COALESCE(current_setting('vireek.template_rpc', true), '') = 'on';
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    IF NOT v_rpc THEN
      NEW.status := 'draft';
      NEW.review_note := NULL;
      NEW.submitted_at := NULL;
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_rpc THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.status := OLD.status;
    NEW.review_note := OLD.review_note;
    NEW.submitted_at := OLD.submitted_at;
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;

    IF (NEW.name, NEW.channel, NEW.category, NEW.subject, NEW.body)
       IS DISTINCT FROM (OLD.name, OLD.channel, OLD.category, OLD.subject, OLD.body) THEN
      IF OLD.status = 'archived' THEN
        RAISE EXCEPTION 'Restore this template before editing it.' USING ERRCODE = '55000';
      END IF;
      IF (NEW.channel, NEW.category, NEW.subject, NEW.body)
         IS DISTINCT FROM (OLD.channel, OLD.category, OLD.subject, OLD.body)
         AND OLD.status IN ('pending_review', 'approved', 'rejected') THEN
        NEW.status := 'draft';
        NEW.review_note := NULL;
        NEW.submitted_at := NULL;
        NEW.reviewed_by := NULL;
        NEW.reviewed_at := NULL;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_message_template ON message_templates;
CREATE TRIGGER trg_guard_message_template
  BEFORE INSERT OR UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_template();

-- =============================================================
-- MESSAGE_TEMPLATE_USAGE
-- =============================================================

CREATE TABLE IF NOT EXISTS message_template_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  source text NOT NULL DEFAULT 'manual' CHECK (char_length(source) BETWEEN 1 AND 40),
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_template_usage_template
  ON message_template_usage (user_id, template_id, used_at DESC);

ALTER TABLE message_template_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_message_template_usage" ON message_template_usage;
CREATE POLICY "select_account_message_template_usage" ON message_template_usage FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE: only record_message_template_use() writes.

-- =============================================================
-- Compliance check shared by submit + approve (the database is the authority)
-- =============================================================

CREATE OR REPLACE FUNCTION public.message_template_compliance_error(p_row message_templates)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_row.channel = 'email' AND btrim(COALESCE(p_row.subject, '')) = '' THEN
    RETURN 'Add a subject line before submitting.';
  END IF;
  IF p_row.channel = 'email' AND COALESCE(p_row.subject, '') ~ '[\r\n]' THEN
    RETURN 'The subject must be a single line.';
  END IF;
  IF p_row.channel = 'sms' AND p_row.category = 'marketing' AND p_row.body !~* '\mstop\M' THEN
    RETURN 'Marketing texts must include opt-out language such as "Reply STOP to opt out."';
  END IF;
  IF p_row.channel = 'email' AND p_row.category = 'marketing'
     AND (COALESCE(p_row.subject, '') || p_row.body) !~* '\{\{\s*unsubscribe_link\s*(\|[^{}|]*)?\}\}' THEN
    RETURN 'Marketing emails must include the {{unsubscribe_link}} variable.';
  END IF;
  RETURN NULL;
END;
$$;

-- =============================================================
-- RPC: review_message_template — the only way status changes
-- =============================================================

CREATE OR REPLACE FUNCTION public.review_message_template(
  p_template_id uuid,
  p_action text,
  p_note text DEFAULT NULL
)
RETURNS message_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row message_templates;
  v_is_owner boolean;
  v_error text;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = '28000';
  END IF;
  IF p_action NOT IN ('submit', 'approve', 'reject', 'archive', 'restore') THEN
    RAISE EXCEPTION 'Unknown action.' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'The note must be 1,000 characters or fewer.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM message_templates WHERE id = p_template_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = 'P0002';
  END IF;

  IF p_action IN ('approve', 'reject') THEN
    IF NOT public.message_templates_has_permission('can_manage_team') THEN
      RAISE EXCEPTION 'You do not have permission to review templates.' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'pending_review' THEN
      RAISE EXCEPTION 'Only templates that are pending review can be approved or rejected.' USING ERRCODE = '55000';
    END IF;
    v_is_owner := EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner');
    IF NOT v_is_owner AND v_row.created_by = auth.uid() THEN
      RAISE EXCEPTION 'You cannot review a template you wrote. Ask another reviewer.' USING ERRCODE = '42501';
    END IF;
    IF p_action = 'reject' AND v_note IS NULL THEN
      RAISE EXCEPTION 'Add a short reason so the author knows what to fix.' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT public.message_templates_has_permission('can_edit_business_profile') THEN
      RAISE EXCEPTION 'You do not have permission to change this template.' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('vireek.template_rpc', 'on', true);

  IF p_action = 'submit' THEN
    IF v_row.status NOT IN ('draft', 'rejected') THEN
      RAISE EXCEPTION 'Only drafts and rejected templates can be submitted.' USING ERRCODE = '55000';
    END IF;
    v_error := public.message_template_compliance_error(v_row);
    IF v_error IS NOT NULL THEN
      RAISE EXCEPTION '%', v_error USING ERRCODE = '22023';
    END IF;
    UPDATE message_templates
      SET status = 'pending_review', submitted_at = now(), review_note = NULL, reviewed_by = NULL, reviewed_at = NULL
      WHERE id = v_row.id RETURNING * INTO v_row;

  ELSIF p_action = 'approve' THEN
    v_error := public.message_template_compliance_error(v_row);
    IF v_error IS NOT NULL THEN
      RAISE EXCEPTION '%', v_error USING ERRCODE = '22023';
    END IF;
    UPDATE message_templates
      SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
      WHERE id = v_row.id RETURNING * INTO v_row;

  ELSIF p_action = 'reject' THEN
    UPDATE message_templates
      SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
      WHERE id = v_row.id RETURNING * INTO v_row;

  ELSIF p_action = 'archive' THEN
    IF v_row.status = 'archived' THEN
      RAISE EXCEPTION 'This template is already archived.' USING ERRCODE = '55000';
    END IF;
    UPDATE message_templates SET status = 'archived' WHERE id = v_row.id RETURNING * INTO v_row;

  ELSE -- restore
    IF v_row.status <> 'archived' THEN
      RAISE EXCEPTION 'Only archived templates can be restored.' USING ERRCODE = '55000';
    END IF;
    UPDATE message_templates
      SET status = 'draft', submitted_at = NULL, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
      WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: record_message_template_use — called by any sender (workflow, dispatch, manual send)
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_message_template_use(
  p_template_id uuid,
  p_source text DEFAULT 'manual'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row message_templates;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row FROM message_templates WHERE id = p_template_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved templates can be used.' USING ERRCODE = '55000';
  END IF;
  INSERT INTO message_template_usage (user_id, template_id, channel, source)
  VALUES (v_owner, v_row.id, v_row.channel, left(COALESCE(NULLIF(btrim(p_source), ''), 'manual'), 40));
END;
$$;

-- =============================================================
-- RPC: get_message_template_stats — per-template usage (RLS applies; explicit owner filter too)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_message_template_stats()
RETURNS TABLE (template_id uuid, total_uses bigint, uses_30d bigint, last_used_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT u.template_id,
         count(*)::bigint,
         (count(*) FILTER (WHERE u.used_at >= now() - interval '30 days'))::bigint,
         max(u.used_at)
  FROM message_template_usage u
  WHERE u.user_id = public.get_account_owner_id()
  GROUP BY u.template_id;
$$;

-- =============================================================
-- Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.message_templates_has_permission(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_message_template(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_message_template_use(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_message_template_stats() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.message_templates_has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_message_template(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_message_template_use(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_template_stats() TO authenticated;

COMMENT ON TABLE message_templates IS
  'SMS/email template library per account. Status changes only through review_message_template(); content edits reset approval.';
COMMENT ON TABLE message_template_usage IS
  'Append-only usage events for approved templates, written only by record_message_template_use().';
