/*
  # Document Templates (PDF designer) — /dashboard/document-templates

  ## Why
  Lets an account design how its customer-facing PDFs look (quotes, invoices, reports): brand colors,
  typography, header, table, totals, section order, terms and footer. One template per type can be the
  account default; the renderer (src/lib/documentTemplatePdf.ts) reads it.

  ## Model
    document_templates — one row per template, scoped to the account owner (user_id = get_account_owner_id()).
                         `design` is a versioned JSON document that the client normalises on read, so an
                         older / hand-edited row can never crash the renderer.

  ## Security
  - RLS: every member of the account can read; only the owner or a member with can_edit_business_profile
    (base permission or custom-role override — same precedence as can_manage_branding()) can insert/update.
  - There is NO DELETE policy: templates are archived, never destroyed.
  - `is_default` cannot be set from the client: a BEFORE trigger pins it unless the change comes through
    set_document_template_default() (SECURITY DEFINER), which locks the row, checks permission + ownership and
    swaps the default atomically (the partial unique index guarantees at most one default per type).
  - user_id, doc_type, created_by and created_at are immutable after insert.
  - Design size is capped server-side (64 KB) so a client cannot store arbitrary blobs.
  - Additive only: no existing table, policy or function is touched.
*/

-- =============================================================
-- Permission helper (same rule as can_manage_branding)
-- =============================================================

CREATE OR REPLACE FUNCTION public.document_templates_can_edit()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR COALESCE((
      SELECT COALESCE(
               (cr.permissions ->> 'can_edit_business_profile')::boolean,
               (tm.permissions ->> 'can_edit_business_profile')::boolean,
               false
             )
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false);
$$;

GRANT EXECUTE ON FUNCTION public.document_templates_can_edit() TO authenticated;

-- =============================================================
-- TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  doc_type text NOT NULL CHECK (doc_type IN ('quote', 'invoice', 'report')),
  design jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(design) = 'object'),
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique name per (account, type) among active templates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_active_name
  ON public.document_templates (user_id, doc_type, lower(btrim(name)))
  WHERE status = 'active';

-- At most one default per (account, type).
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_default
  ON public.document_templates (user_id, doc_type)
  WHERE is_default AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_document_templates_account
  ON public.document_templates (user_id, doc_type, status, updated_at DESC);

ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_document_templates" ON public.document_templates;
CREATE POLICY "select_account_document_templates" ON public.document_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_document_templates" ON public.document_templates;
CREATE POLICY "insert_account_document_templates" ON public.document_templates FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.document_templates_can_edit()
  );

DROP POLICY IF EXISTS "update_account_document_templates" ON public.document_templates;
CREATE POLICY "update_account_document_templates" ON public.document_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.document_templates_can_edit())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.document_templates_can_edit());

-- No DELETE policy on purpose: archive instead.

GRANT SELECT, INSERT, UPDATE ON public.document_templates TO authenticated;

-- =============================================================
-- GUARD TRIGGER
-- =============================================================

CREATE OR REPLACE FUNCTION public.guard_document_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rpc boolean := COALESCE(current_setting('vireek.doc_template_rpc', true), '') = 'on';
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();

  IF octet_length(NEW.design::text) > 65536 THEN
    RAISE EXCEPTION 'This template design is too large.' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_rpc THEN
      NEW.is_default := false;
      NEW.status := 'active';
    END IF;
    NEW.revision := 1;
    RETURN NEW;
  END IF;

  -- UPDATE: identity columns are immutable.
  NEW.user_id := OLD.user_id;
  NEW.doc_type := OLD.doc_type;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;

  IF NOT v_rpc THEN
    NEW.is_default := OLD.is_default;
  END IF;

  IF OLD.status = 'archived' AND NEW.status = 'archived'
     AND (NEW.name, NEW.design) IS DISTINCT FROM (OLD.name, OLD.design) THEN
    RAISE EXCEPTION 'Restore this template before editing it.' USING ERRCODE = '55000';
  END IF;

  -- An archived template can never be the default.
  IF NEW.status = 'archived' THEN
    NEW.is_default := false;
  END IF;

  IF (NEW.name, NEW.design) IS DISTINCT FROM (OLD.name, OLD.design) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_document_template ON public.document_templates;
CREATE TRIGGER trg_guard_document_template
  BEFORE INSERT OR UPDATE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.guard_document_template();

-- =============================================================
-- RPC: set / clear the default template for a type (atomic)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_document_template_default(p_id uuid, p_default boolean)
RETURNS public.document_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.document_templates;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '28000';
  END IF;
  IF NOT public.document_templates_can_edit() THEN
    RAISE EXCEPTION 'You do not have permission to change templates.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.document_templates
  WHERE id = p_id AND user_id = v_owner
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'Restore this template before making it the default.' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('vireek.doc_template_rpc', 'on', true);

  IF p_default THEN
    UPDATE public.document_templates
       SET is_default = false
     WHERE user_id = v_owner AND doc_type = v_row.doc_type AND is_default AND id <> p_id;
  END IF;

  UPDATE public.document_templates
     SET is_default = COALESCE(p_default, false)
   WHERE id = p_id
  RETURNING * INTO v_row;

  PERFORM set_config('vireek.doc_template_rpc', 'off', true);

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_document_template_default(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_document_template_default(uuid, boolean) TO authenticated;
