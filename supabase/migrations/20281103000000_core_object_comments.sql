-- Documentation only: COMMENT ON for the tenant/permission helper functions and core security tables.
-- No schema or behaviour change. Safe to re-run. Objects that do not exist in a given database are skipped.
-- Texts are derived from the latest definitions in supabase/migrations as of this file's creation; update them
-- when a definition changes. Rename the file's timestamp to sort after your newest migration before applying.
--
-- Rollback (optional): re-run with every text set to NULL, e.g.  COMMENT ON FUNCTION ... IS NULL;
-- Verify:  select obj_description('public.get_account_owner_id()'::regprocedure, 'pg_proc');

DO $$
DECLARE
  f record;
  t record;
  r record;
BEGIN
  -- ---------------------------------------------------------------- functions (all overloads by name)
  FOR f IN
    SELECT * FROM (VALUES
      ('get_account_owner_id', 'Tenant resolver and RLS tenant boundary: account_owner_id of the caller''s team_members row, otherwise the caller''s own profiles.id; NULL when unauthenticated.'),
      ('get_my_team_member_id', 'Id of the caller''s team_members row (first match), or NULL.'),
      ('is_vireek_staff', 'True when profiles.is_staff is set for the given user id. Executable by anon and authenticated: callers must pass auth.uid(), never a client-supplied id.'),
      ('identity_is_manager', 'True when the caller is an owner/admin profile or a team member with the can_view_billing permission.'),
      ('invoice_permission', 'Permission check for invoicing: true for an owner profile; otherwise the caller''s team-member permission for the given key (a custom role''s value overrides the member''s), defaulting to false. Team member is matched by email.'),
      ('reports_can_access', 'True when the caller is the given owner, or a team member of that owner with can_view_billing.'),
      ('has_account_permission', 'Generic permission check: callers with no team_members row pass if they have a profile (owners); team members use the custom role''s value when it defines the key, otherwise their own permissions, defaulting to false.'),
      ('cadence_can_manage', 'True when the caller has the can_view_all_jobs permission (via cadence_has_perm).'),
      ('can_manage_install_projects', 'Authorisation helper for Install Projects: owner, or a team member whose own or custom-role permissions grant billing access. See the latest definition for the exact keys.'),
      ('quote_workspace_caller_can_view', 'True for an owner; otherwise can_view_billing from the custom role, falling back to the member''s permissions, defaulting to false.'),
      ('_is_account_manager', 'True when the caller''s team role or profile role is owner or admin; false otherwise.'),
      ('log_audit_event', 'Writes an audit_log entry for the given user: action, target table/id and metadata (actor email is added). SECURITY DEFINER.'),
      ('closeout_log', 'Appends a closeout_events row (note truncated to 500 characters) and mirrors it into the account audit log; an auditing failure never breaks the action.'),
      ('post_journal_entry', 'Posts a journal entry with its lines (jsonb) for a source record and returns the new entry id.'),
      ('bi_tenant_id', 'Tenant for BI access: the user_id of the active (not revoked) bi_reader_roles row for session_user, otherwise the account owner when the caller can export data.'),
      ('append_activity_event', 'Appends an event (aggregate type/id, event type and data, actor, correlation/causation ids) to business_activity_events and returns the row.'),
      ('assign_technician_to_job', 'Assigns a technician to a job (the given one, or the best candidate by load and capacity) and returns a jsonb result.')
    ) AS v(name, txt)
  LOOP
    FOR r IN
      SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = f.name
    LOOP
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.sig, f.txt);
    END LOOP;
  END LOOP;

  -- ---------------------------------------------------------------- tables
  FOR t IN
    SELECT * FROM (VALUES
      ('profiles', 'One row per authenticated user (id = auth.users.id): role (e.g. owner, admin) and the is_staff flag read by is_vireek_staff(). Tenant root for account owners; see get_account_owner_id().'),
      ('team_members', 'Members of an account: user_id, account_owner_id (the tenant), role, permissions (jsonb), custom_role_id and member_email. Used by get_account_owner_id() and the permission helpers.'),
      ('custom_roles', 'Named permission sets (permissions jsonb) assignable to team members; a custom role''s value overrides the member''s own for the same key in the permission helpers.'),
      ('audit_log', 'Account audit trail written through log_audit_event() (action, target table/id, metadata, actor).'),
      ('security_policies', 'Per-account security settings, e.g. ip_restriction_enabled, read by the check-ip-policy edge function.'),
      ('ip_allow_rules', 'CIDR allow-list entries per account, enforced when ip_restriction_enabled is set.'),
      ('scim_tokens', 'Bearer tokens that authenticate SCIM clients calling the scim-v2 edge function.'),
      ('sso_domains', 'Email domains configured for single sign-on per account, managed by the admin-sso edge function.'),
      ('trusted_devices', 'Devices trusted to skip repeated MFA prompts; the cookie holds only an opaque token (trusted-device edge function).'),
      ('bi_reader_roles', 'Database roles issued to BI export readers; bi_tenant_id() maps session_user to the tenant while revoked_at is NULL.'),
      ('closeout_events', 'Event log of install closeout steps (status changes and notes), written by closeout_log().'),
      ('business_activity_events', 'Activity ledger (aggregate, event type, actor, correlation/causation ids) written by append_activity_event().'),
      ('stripe_connect_accounts', 'Stripe Connect account per account owner, used to collect payments and pay out.'),
      ('payment_requests', 'Requests for payment collected through Stripe or bank rails; created by the create-payment-request edge function.'),
      ('refunds', 'Refund records created by the issue-refund edge function; the refund row id is the Stripe idempotency key.'),
      ('signature_requests', 'E-signature requests; signers live in signature_signers and events in signature_events.'),
      ('price_book_connections', 'Connections to external price-book providers (Jobber, Housecall Pro, ServiceTitan) per account.'),
      ('bank_connections', 'Plaid bank connections per account.'),
      ('bank_connection_secrets', 'Credentials for bank_connections, kept in a separate table from the connection row.'),
      ('voice_clone_consents', 'Consent records for voice cloning, managed by the voice-consent edge function.'),
      ('outbound_calls', 'Queue of outbound calls placed by the outbound-dialer edge function.')
    ) AS v(name, txt)
  LOOP
    IF to_regclass('public.' || t.name) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', t.name, t.txt);
    END IF;
  END LOOP;
END
$$;
