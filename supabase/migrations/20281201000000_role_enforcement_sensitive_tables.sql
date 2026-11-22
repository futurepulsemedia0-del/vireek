-- DB-level role enforcement for sensitive tables (docs/security/identity-authz-audit.md, finding F2).
--
-- PROBLEM  Tables whose only policy is `user_id = get_account_owner_id()` are readable/writable by EVERY member of the
--          account (technicians included) straight through the API; the UI permission gate is advisory.
-- FIX      For the tables classified below, each legacy tenant-only policy is REPLACED by one that keeps the exact same
--          tenant predicate AND requires a permission (has_account_permission / bank_can_access).
--          Owners are unaffected: has_account_permission() is true for any user without a team_members row.
-- CLASSES  HR/payroll   employees, timesheets, pay_runs, pay_run_items   -> can_manage_team (write) / + can_view_billing (read)
--          Money        refunds, credit_memos                             -> can_view_billing OR can_issue_refunds (read)
--                       stripe_connect_accounts, financing_connections,
--                       cash_flow_*, accounting ledger tables             -> can_view_billing
--          Bank         bank_matches                                      -> bank_can_access() (same gate as its sibling tables)
--          Settings     api_keys                                          -> can_manage_security
--                       webhook_endpoints                                 -> can_edit_business_profile OR can_manage_security
-- UI       Technician screens read only {id, full_name, active} of employees: they move to the new view employee_directory
--          (SECURITY DEFINER view, same tenant predicate, no pay columns). See the edit notes delivered with this migration.
-- NOT DONE (needs a product decision, listed so nothing is silently "forgotten"): invoices, payment_requests, customers, jobs,
--          calls, leads, integrations and the other ~740 tenant-only tables.
-- IDEMPOTENT  Re-running finds no legacy policy left and changes nothing. Tables that do not exist are skipped.
-- ROLLBACK    select public.rbac_rollback_sensitive_tables();   (re-creates the saved legacy policies, service_role only)

CREATE TABLE IF NOT EXISTS public.rbac_policy_backup (
  tbl text NOT NULL,
  policyname text NOT NULL,
  cmd text NOT NULL,
  roles text NOT NULL,
  qual text,
  with_check text,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tbl, policyname)
);
ALTER TABLE public.rbac_policy_backup ENABLE ROW LEVEL SECURITY;      -- no policies: service role / owner only
REVOKE ALL ON public.rbac_policy_backup FROM PUBLIC, anon, authenticated;

DO $rbac$
DECLARE
  cfg record;
  pol record;
  perms text;
  kind text;
  wperms text;
  rperms text;
  cmds text[];
  c text;
  q text;
  w text;
  remaining int;
  fn text;
BEGIN
  IF to_regprocedure('public.has_account_permission(text)') IS NULL THEN
    RAISE EXCEPTION 'has_account_permission(text) is missing: apply the migration that defines it first';
  END IF;

  FOR cfg IN SELECT * FROM (VALUES
    -- tbl,                        read permissions (any of),                         write permissions (any of) or NULL
    ('employees',                  'can_manage_team,can_view_billing',                'can_manage_team'),
    ('timesheets',                 'can_manage_team,can_view_billing',                'can_manage_team'),
    ('pay_runs',                   'can_view_billing,can_manage_team',                NULL),
    ('pay_run_items',              'can_view_billing,can_manage_team',                NULL),
    ('refunds',                    'can_view_billing,can_issue_refunds',              NULL),
    ('credit_memos',               'can_view_billing,can_issue_refunds',              NULL),
    ('stripe_connect_accounts',    'can_view_billing',                                NULL),
    ('financing_connections',      'can_view_billing',                                NULL),
    ('cash_flow_settings',         'can_view_billing',                                'can_view_billing'),
    ('cash_flow_fixed_expenses',   'can_view_billing',                                'can_view_billing'),
    ('cash_flow_snapshots',        'can_view_billing',                                'can_view_billing'),
    ('chart_of_accounts',          'can_view_billing',                                NULL),
    ('accounting_periods',         'can_view_billing',                                NULL),
    ('journal_entries',            'can_view_billing',                                NULL),
    ('journal_lines',              'can_view_billing',                                NULL),
    ('ar_invoices',                'can_view_billing',                                NULL),
    ('ar_invoice_lines',           'can_view_billing',                                NULL),
    ('ar_payments',                'can_view_billing',                                NULL),
    ('ap_bills',                   'can_view_billing',                                NULL),
    ('ap_bill_lines',              'can_view_billing',                                NULL),
    ('ap_bill_payments',           'can_view_billing',                                NULL),
    ('bank_matches',               'fn:bank_can_access',                              NULL),
    ('api_keys',                   'can_manage_security',                             'can_manage_security'),
    ('webhook_endpoints',          'can_edit_business_profile,can_manage_security',   'can_edit_business_profile,can_manage_security')
  ) AS t(tbl, read_perms, write_perms)
  LOOP
    IF to_regclass('public.' || cfg.tbl) IS NULL THEN
      RAISE NOTICE 'rbac: % does not exist, skipped', cfg.tbl;
      CONTINUE;
    END IF;

    rperms := NULL; wperms := NULL;
    SELECT string_agg(CASE WHEN p LIKE 'fn:%' THEN format('(SELECT public.%I())', substr(p, 4))
                           ELSE format('(SELECT public.has_account_permission(%L))', p) END, ' OR ')
      INTO rperms FROM unnest(string_to_array(cfg.read_perms, ',')) AS p;
    IF cfg.write_perms IS NOT NULL THEN
      SELECT string_agg(format('(SELECT public.has_account_permission(%L))', p), ' OR ')
        INTO wperms FROM unnest(string_to_array(cfg.write_perms, ',')) AS p;
    END IF;

    FOR pol IN
      SELECT * FROM pg_policies
       WHERE schemaname = 'public' AND tablename = cfg.tbl
         AND policyname NOT LIKE 'rbac\_%'
         AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ILIKE '%get_account_owner_id%'
         AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT ILIKE '%has_account_permission%'
         AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT ILIKE '%bank_can_access%'
    LOOP
      INSERT INTO public.rbac_policy_backup (tbl, policyname, cmd, roles, qual, with_check)
        VALUES (cfg.tbl, pol.policyname, pol.cmd, array_to_string(pol.roles, ', '), pol.qual, pol.with_check)
        ON CONFLICT (tbl, policyname) DO NOTHING;

      cmds := CASE pol.cmd WHEN 'ALL' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] ELSE ARRAY[pol.cmd::text] END;
      FOREACH c IN ARRAY cmds LOOP
        perms := CASE WHEN c = 'SELECT' THEN rperms ELSE wperms END;
        IF perms IS NULL THEN
          RAISE EXCEPTION 'rbac: % has a legacy % policy (%) but no write permission is configured', cfg.tbl, c, pol.policyname;
        END IF;
        q := coalesce(pol.qual, pol.with_check);
        w := coalesce(pol.with_check, pol.qual);
        fn := format('rbac_%s_%s_%s', lower(c), left(cfg.tbl, 24), substr(md5(pol.policyname), 1, 8));
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', fn, cfg.tbl);
        IF c = 'SELECT' OR c = 'DELETE' THEN
          EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO %s USING ((%s) AND (%s))', fn, cfg.tbl, c, array_to_string(pol.roles, ', '), q, perms);
        ELSIF c = 'INSERT' THEN
          EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO %s WITH CHECK ((%s) AND (%s))', fn, cfg.tbl, array_to_string(pol.roles, ', '), w, perms);
        ELSE
          EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO %s USING ((%s) AND (%s)) WITH CHECK ((%s) AND (%s))', fn, cfg.tbl, array_to_string(pol.roles, ', '), q, perms, w, perms);
        END IF;
      END LOOP;
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, cfg.tbl);
    END LOOP;

    SELECT count(*) INTO remaining FROM pg_policies
     WHERE schemaname = 'public' AND tablename = cfg.tbl
       AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ILIKE '%get_account_owner_id%'
       AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT ILIKE '%has_account_permission%'
       AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT ILIKE '%bank_can_access%';
    IF remaining > 0 THEN
      RAISE EXCEPTION 'rbac: % still has % tenant-only policy(ies)', cfg.tbl, remaining;
    END IF;
  END LOOP;
END
$rbac$;

-- Directory view for screens that only need names (no pay columns). Runs with the view owner's rights, filtered to the caller's account.
DO $view$
BEGIN
  IF to_regclass('public.employees') IS NOT NULL THEN
    EXECUTE $v$CREATE OR REPLACE VIEW public.employee_directory WITH (security_invoker = false) AS
      SELECT e.id, e.user_id, e.full_name, e.active
        FROM public.employees e
       WHERE e.user_id = public.get_account_owner_id()$v$;
    REVOKE ALL ON public.employee_directory FROM PUBLIC, anon;
    GRANT SELECT ON public.employee_directory TO authenticated;
  END IF;
END
$view$;

CREATE OR REPLACE FUNCTION public.rbac_rollback_sensitive_tables()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE b record; n integer := 0; p record;
BEGIN
  FOR b IN SELECT * FROM public.rbac_policy_backup LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = b.tbl AND policyname LIKE 'rbac\_%' LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, b.tbl);
    END LOOP;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', b.policyname, b.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO %s%s%s', b.policyname, b.tbl, b.cmd, b.roles,
      CASE WHEN b.qual IS NOT NULL THEN format(' USING (%s)', b.qual) ELSE '' END,
      CASE WHEN b.with_check IS NOT NULL THEN format(' WITH CHECK (%s)', b.with_check) ELSE '' END);
    n := n + 1;
  END LOOP;
  DELETE FROM public.rbac_policy_backup;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.rbac_rollback_sensitive_tables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_rollback_sensitive_tables() TO service_role;
