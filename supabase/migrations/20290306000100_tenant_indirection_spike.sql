/*
  # Tenant id indirection — SPIKE on 3 low-risk tables
  Design: docs/architecture/tenant-indirection.md

  Adds a stable tenant id that is DECOUPLED from the owner's auth uid, and moves exactly three
  leaf tables onto it: call_sources, estimate_templates, api_usage_alert_rules.
  Nothing else in the schema changes.

  * `tenants(id, owner_user_id)`: one row per existing profile with id = profile id (identity
    mapping), so no data is rewritten. A later ownership transfer changes owner_user_id only.
  * `tenant_id` is added to the three tables, backfilled from user_id, and kept in step by a
    BEFORE trigger (dual-write): old clients that only write user_id keep working.
  * Policies keep the OLD semantics (owner-only: team members are NOT widened in) but resolve the
    owner through tenants. `OR (tenant_id IS NULL AND user_id = auth.uid())` is a transitional
    clause for orphan rows whose user has no profile; drop it in the contract phase.
  * Account deletion behaves as before: profile delete cascades to tenants and from there to the rows
    (RESTRICT is the goal once ownership transfer exists; see the design doc risk list).
  * user_id stays NOT NULL and untouched. No column, FK, index or old data is dropped.
*/
-- rollback: the policies keep their original names; re-create them with the original
-- user_id = auth.uid() predicates (listed in docs/architecture/tenant-indirection.md section 7); then
-- DROP TRIGGER trg_<table>_tenant_sync on the three tables. tenants / tenant_id may stay (additive).

CREATE TABLE IF NOT EXISTS public.tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tenants TO authenticated;

DROP POLICY IF EXISTS "tenants_select_owner" ON public.tenants;
CREATE POLICY "tenants_select_owner" ON public.tenants
  FOR SELECT TO authenticated USING (owner_user_id = auth.uid());
-- No write policies: tenants are minted by the profile trigger below / service role only.

INSERT INTO public.tenants (id, owner_user_id)
SELECT p.id, p.id FROM public.profiles p
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.tenants_mint_for_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.tenants (id, owner_user_id) VALUES (NEW.id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tenants_mint_for_profile() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_mint_tenant ON public.profiles;
CREATE TRIGGER trg_profiles_mint_tenant AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tenants_mint_for_profile();

-- Tenant the caller OWNS (owner-only semantics, same as `user_id = auth.uid()`).
CREATE OR REPLACE FUNCTION public.current_owner_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM public.tenants t WHERE t.owner_user_id = auth.uid();
$$;
-- Tenant the caller belongs to (owner OR team member), the future replacement for get_account_owner_id().
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM public.tenants t WHERE t.owner_user_id = public.get_account_owner_id();
$$;
REVOKE ALL ON FUNCTION public.current_owner_tenant_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_owner_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;

-- Dual-write: derive tenant_id from user_id; refuse rows where the two disagree.
CREATE OR REPLACE FUNCTION public.tenant_sync_from_user_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT t.id INTO NEW.tenant_id FROM public.tenants t WHERE t.owner_user_id = NEW.user_id;
  ELSE
    SELECT t.owner_user_id INTO v_owner FROM public.tenants t WHERE t.id = NEW.tenant_id;
    IF v_owner IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'tenant_id does not belong to user_id' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tenant_sync_from_user_id() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t text;
  -- table | owner-only policy names to replace (verified against the final state of all migrations)
  spec constant text[][] := ARRAY[
    ARRAY['call_sources',          'select_own_call_sources',          'insert_own_call_sources',          'update_own_call_sources',          'delete_own_call_sources'],
    ARRAY['estimate_templates',    'select_own_estimate_templates',    'insert_own_estimate_templates',    'update_own_estimate_templates',    'delete_own_estimate_templates'],
    ARRAY['api_usage_alert_rules', 'aar_select',                       'aar_insert',                       'aar_update',                       NULL]
  ];
  i int;
  c_using constant text := '(tenant_id = (SELECT public.current_owner_tenant_id()) OR (tenant_id IS NULL AND user_id = auth.uid()))';
BEGIN
  FOR i IN 1..array_length(spec, 1) LOOP
    t := spec[i][1];
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    EXECUTE format('UPDATE public.%I x SET tenant_id = tn.id FROM public.tenants tn WHERE tn.owner_user_id = x.user_id AND x.tenant_id IS NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)', 'idx_' || t || '_tenant_id', t);

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_tenant_fk') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE NOT VALID', t, t || '_tenant_fk');
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t, t || '_tenant_fk');
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_tenant_sync', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF user_id, tenant_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tenant_sync_from_user_id()', 'trg_' || t || '_tenant_sync', t);

    -- select
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec[i][2], t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING %s', spec[i][2], t, c_using);
    -- insert
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec[i][3], t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK %s', spec[i][3], t, c_using);
    -- update
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec[i][4], t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING %s WITH CHECK %s', spec[i][4], t, c_using, c_using);
    -- delete (api_usage_alert_rules never had one)
    IF spec[i][5] IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec[i][5], t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING %s', spec[i][5], t, c_using);
    END IF;
  END LOOP;
END $$;
