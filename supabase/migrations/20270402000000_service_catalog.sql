/*
  # Service Catalog

  Per-account catalog of bookable services: categories, flat/hourly pricing,
  default duration, required technician skills, tax class, bookable toggle and
  AI quoting rules (how the AI assistant may quote each service).

  - Every row is scoped by user_id = get_account_owner_id() (the ACCOUNT OWNER's id).
  - Any account member can READ. Only the owner, or a member whose effective
    can_view_billing is true (custom role overrides team_members.permissions), can WRITE.
  - Triggers enforce: same-tenant category, normalised tags, per-account caps,
    immutable user_id. Changes are appended to audit_log.
  - Purely additive. Separate from price_book_items (voice assistant lookup_price).
*/

CREATE OR REPLACE FUNCTION public.service_catalog_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    auth.uid() = public.get_account_owner_id()
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr
        ON cr.id = tm.custom_role_id AND cr.user_id = tm.account_owner_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE(
          (cr.permissions ->> 'can_view_billing')::boolean,
          (tm.permissions ->> 'can_view_billing')::boolean,
          false
        )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.service_catalog_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_catalog_can_manage() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.service_catalog_clean_tags(p_tags text[], p_max integer DEFAULT 20)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(s.t ORDER BY s.ord), '{}'::text[])
  FROM (
    SELECT d.t, d.ord
    FROM (
      SELECT DISTINCT ON (lower(btrim(u.x))) btrim(u.x) AS t, u.ord
      FROM unnest(COALESCE(p_tags, '{}'::text[])) WITH ORDINALITY AS u(x, ord)
      WHERE btrim(u.x) <> '' AND char_length(btrim(u.x)) <= 40
      ORDER BY lower(btrim(u.x)), u.ord
    ) d
    ORDER BY d.ord
    LIMIT p_max
  ) s;
$$;

CREATE TABLE IF NOT EXISTS public.service_catalog_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_catalog_categories_name
  ON public.service_catalog_categories (user_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.service_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  category_id uuid REFERENCES public.service_catalog_categories(id) ON DELETE SET NULL,

  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),

  pricing_model text NOT NULL DEFAULT 'flat' CHECK (pricing_model IN ('flat', 'hourly')),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  min_charge_cents integer CHECK (min_charge_cents IS NULL OR min_charge_cents BETWEEN 0 AND 100000000),
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 5 AND 1440),

  required_skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_skills) <= 20),
  tax_class text NOT NULL DEFAULT 'taxable'
    CHECK (tax_class IN ('taxable', 'non_taxable', 'labor_taxable', 'materials_taxable')),
  bookable boolean NOT NULL DEFAULT true,

  ai_quote_mode text NOT NULL DEFAULT 'quote'
    CHECK (ai_quote_mode IN ('quote', 'range', 'visit_required', 'never')),
  ai_range_pct smallint NOT NULL DEFAULT 15 CHECK (ai_range_pct BETWEEN 1 AND 100),
  ai_max_discount_pct smallint NOT NULL DEFAULT 0 CHECK (ai_max_discount_pct BETWEEN 0 AND 50),
  ai_price_floor_cents integer CHECK (ai_price_floor_cents IS NULL OR ai_price_floor_cents BETWEEN 0 AND 100000000),
  ai_approval_above_cents integer CHECK (ai_approval_above_cents IS NULL OR ai_approval_above_cents BETWEEN 0 AND 100000000),
  ai_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(ai_keywords) <= 20),
  ai_notes text CHECK (ai_notes IS NULL OR char_length(ai_notes) <= 500),

  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_catalog_items_min_charge_hourly
    CHECK (min_charge_cents IS NULL OR pricing_model = 'hourly'),
  CONSTRAINT service_catalog_items_floor_le_price
    CHECK (ai_price_floor_cents IS NULL OR ai_price_floor_cents <= price_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_catalog_items_name
  ON public.service_catalog_items (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_service_catalog_items_owner
  ON public.service_catalog_items (user_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_service_catalog_items_category
  ON public.service_catalog_items (category_id);

CREATE OR REPLACE FUNCTION public.service_catalog_categories_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'service_catalog: the owning account cannot be changed' USING ERRCODE = '42501';
  END IF;

  NEW.name := btrim(NEW.name);

  IF TG_OP = 'INSERT' AND (
    SELECT count(*) FROM public.service_catalog_categories c WHERE c.user_id = NEW.user_id
  ) >= 100 THEN
    RAISE EXCEPTION 'service_catalog: category limit reached (100)' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_catalog_categories_guard ON public.service_catalog_categories;
CREATE TRIGGER trg_service_catalog_categories_guard
  BEFORE INSERT OR UPDATE ON public.service_catalog_categories
  FOR EACH ROW EXECUTE FUNCTION public.service_catalog_categories_guard();

CREATE OR REPLACE FUNCTION public.service_catalog_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'service_catalog: the owning account cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_catalog_categories c
    WHERE c.id = NEW.category_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'service_catalog: category does not belong to this account' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (
    SELECT count(*) FROM public.service_catalog_items i WHERE i.user_id = NEW.user_id
  ) >= 2000 THEN
    RAISE EXCEPTION 'service_catalog: service limit reached (2000)' USING ERRCODE = '23514';
  END IF;

  NEW.name := btrim(NEW.name);
  NEW.description := NULLIF(btrim(COALESCE(NEW.description, '')), '');
  NEW.ai_notes := NULLIF(btrim(COALESCE(NEW.ai_notes, '')), '');
  NEW.required_skills := public.service_catalog_clean_tags(NEW.required_skills, 20);
  NEW.ai_keywords := public.service_catalog_clean_tags(NEW.ai_keywords, 20);

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_catalog_items_guard ON public.service_catalog_items;
CREATE TRIGGER trg_service_catalog_items_guard
  BEFORE INSERT OR UPDATE ON public.service_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.service_catalog_items_guard();

CREATE OR REPLACE FUNCTION public.service_catalog_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  v_action := CASE WHEN TG_TABLE_NAME = 'service_catalog_categories'
                   THEN 'service_catalog.category_' ELSE 'service_catalog.' END
           || CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END;

  BEGIN
    PERFORM public.log_audit_event(v_row.user_id, v_action, TG_TABLE_NAME, v_row.id::text);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_catalog_categories_audit ON public.service_catalog_categories;
CREATE TRIGGER trg_service_catalog_categories_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.service_catalog_categories
  FOR EACH ROW EXECUTE FUNCTION public.service_catalog_audit();

DROP TRIGGER IF EXISTS trg_service_catalog_items_audit ON public.service_catalog_items;
CREATE TRIGGER trg_service_catalog_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.service_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.service_catalog_audit();

ALTER TABLE public.service_catalog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_catalog_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_service_catalog_categories" ON public.service_catalog_categories;
CREATE POLICY "select_service_catalog_categories" ON public.service_catalog_categories
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_service_catalog_categories" ON public.service_catalog_categories;
CREATE POLICY "insert_service_catalog_categories" ON public.service_catalog_categories
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());
DROP POLICY IF EXISTS "update_service_catalog_categories" ON public.service_catalog_categories;
CREATE POLICY "update_service_catalog_categories" ON public.service_catalog_categories
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());
DROP POLICY IF EXISTS "delete_service_catalog_categories" ON public.service_catalog_categories;
CREATE POLICY "delete_service_catalog_categories" ON public.service_catalog_categories
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());

DROP POLICY IF EXISTS "select_service_catalog_items" ON public.service_catalog_items;
CREATE POLICY "select_service_catalog_items" ON public.service_catalog_items
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_service_catalog_items" ON public.service_catalog_items;
CREATE POLICY "insert_service_catalog_items" ON public.service_catalog_items
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());
DROP POLICY IF EXISTS "update_service_catalog_items" ON public.service_catalog_items;
CREATE POLICY "update_service_catalog_items" ON public.service_catalog_items
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());
DROP POLICY IF EXISTS "delete_service_catalog_items" ON public.service_catalog_items;
CREATE POLICY "delete_service_catalog_items" ON public.service_catalog_items
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.service_catalog_can_manage());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_catalog_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_catalog_items TO authenticated;
GRANT ALL ON public.service_catalog_categories TO service_role;
GRANT ALL ON public.service_catalog_items TO service_role;
