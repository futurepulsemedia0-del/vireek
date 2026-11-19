/*
  # Permissive RLS policy review — fixes

  Source: docs/security/permissive-policies.md (classification of every `policy-true` and
  `anon-write-policy` finding from scripts/security/rls-audit.mjs).

  ## What changes
  1. demo_bookings, onboarding_bookings, status_subscribers: the "admin" read/update/delete policies were
     written as `profiles.role = 'admin'`, which is the TENANT-level role. Any customer account admin could
     read (and for demo_bookings / status_subscribers modify or delete) Vireek's sales leads and status
     subscribers (names, emails, phones, unsubscribe tokens). Replaced with `is_vireek_staff(auth.uid())`.
  2. The public INSERT policies on demo_bookings, onboarding_bookings, newsletter_subscribers and
     status_subscribers were `WITH CHECK (true)`: an anonymous caller could set `status`, send unbounded text
     or malformed emails. Now bounded; `status` must be the default. Rules live in the policy (not new table
     constraints) so existing rows are never re-validated.
  3. support_conversations / support_messages: the policies listed the `anon` role. Chat visitors are Supabase *anonymous-auth*
     users, whose JWT role is `authenticated` (src/lib/supportChat.ts), so `anon` was dead surface that the audit
     flags as `anon-write-policy`. Policies now target `authenticated` only.
  4. Column-level SELECT (row policy stays `true`, internals hidden):
       platform_backup_runs      hides storage_path, checksum_sha256, table_row_counts, error_message
       platform_restore_drills   hides row_count_mismatches
       pack_versions             hides artifacts (pack content is delivered by SECURITY DEFINER pack_apply)
       verification_sources      hides provider, config
     Every client read of these four tables was changed/verified to name its columns explicitly
     (src/lib/dataGovernance.ts changed in the same release; packsApi.ts and verificationNetwork.ts already did).

  ## Order
  Deploy the client change (src/lib/dataGovernance.ts) BEFORE or WITH this migration: an old client doing
  `select('*')` on the two DR tables gets "permission denied" afterwards.

  ## Not changed (intentional, documented in the allowlist)
  Global reference catalogs, aggregates, roadmap/community/subprocessor public reads, docs_feedback and
  security_report_requests (already size-constrained). See scripts/security/permissive-allowlist.mjs.

  ## Rollback
  Re-create the previous policies from the original migrations (20260911090000, 20260915000000,
  20260913080000, 20260913020000, 20260915020000) and `GRANT SELECT ON <table> TO authenticated;` for the four
  column-restricted tables. Idempotent: safe to re-run.

  ## Not verified here
  Written without a Postgres instance. Run: supabase db reset && supabase test db
  (supabase/tests/database/permissive_policies.test.sql).
*/

-- ---------------------------------------------------------------------
-- 1. Staff-only management of marketing/status tables (was tenant `admin`)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "admin_select_demo_bookings" ON public.demo_bookings;
DROP POLICY IF EXISTS "admin_update_demo_bookings" ON public.demo_bookings;
DROP POLICY IF EXISTS "admin_delete_demo_bookings" ON public.demo_bookings;
DROP POLICY IF EXISTS "staff_select_demo_bookings" ON public.demo_bookings;
DROP POLICY IF EXISTS "staff_update_demo_bookings" ON public.demo_bookings;
DROP POLICY IF EXISTS "staff_delete_demo_bookings" ON public.demo_bookings;
CREATE POLICY "staff_select_demo_bookings" ON public.demo_bookings FOR SELECT TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));
CREATE POLICY "staff_update_demo_bookings" ON public.demo_bookings FOR UPDATE TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_vireek_staff((SELECT auth.uid()))));
CREATE POLICY "staff_delete_demo_bookings" ON public.demo_bookings FOR DELETE TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));

DROP POLICY IF EXISTS "Only admins read onboarding bookings" ON public.onboarding_bookings;
DROP POLICY IF EXISTS "staff_select_onboarding_bookings" ON public.onboarding_bookings;
CREATE POLICY "staff_select_onboarding_bookings" ON public.onboarding_bookings FOR SELECT TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));

DROP POLICY IF EXISTS "admin_select_status_subscribers" ON public.status_subscribers;
DROP POLICY IF EXISTS "admin_delete_status_subscribers" ON public.status_subscribers;
DROP POLICY IF EXISTS "staff_select_status_subscribers" ON public.status_subscribers;
DROP POLICY IF EXISTS "staff_delete_status_subscribers" ON public.status_subscribers;
CREATE POLICY "staff_select_status_subscribers" ON public.status_subscribers FOR SELECT TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));
CREATE POLICY "staff_delete_status_subscribers" ON public.status_subscribers FOR DELETE TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));

-- ---------------------------------------------------------------------
-- 2. Public INSERT policies: bounded, no client-chosen status
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "public_insert_demo_bookings" ON public.demo_bookings;
CREATE POLICY "public_insert_demo_bookings" ON public.demo_bookings FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'scheduled'
    AND slot_end > slot_start
    AND char_length(btrim(full_name)) BETWEEN 1 AND 200
    AND char_length(work_email) <= 254 AND work_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(btrim(company_name)) BETWEEN 1 AND 200
    AND (phone IS NULL OR char_length(phone) <= 50)
    AND (team_size IS NULL OR char_length(team_size) <= 50)
    AND (message IS NULL OR char_length(message) <= 2000)
  );

DROP POLICY IF EXISTS "anyone can request onboarding slot" ON public.onboarding_bookings;
DROP POLICY IF EXISTS "Anyone can request onboarding slot" ON public.onboarding_bookings;
DROP POLICY IF EXISTS "public_insert_onboarding_bookings" ON public.onboarding_bookings;
CREATE POLICY "public_insert_onboarding_bookings" ON public.onboarding_bookings FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'scheduled'
    AND slot_end > slot_start
    AND char_length(btrim(full_name)) BETWEEN 1 AND 200
    AND char_length(work_email) <= 254 AND work_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(btrim(company_name)) BETWEEN 1 AND 200
    AND (phone IS NULL OR char_length(phone) <= 50)
    AND (plan_tier IS NULL OR char_length(plan_tier) <= 50)
    AND (message IS NULL OR char_length(message) <= 2000)
  );

DROP POLICY IF EXISTS "insert_newsletter_subscriber" ON public.newsletter_subscribers;
CREATE POLICY "insert_newsletter_subscriber" ON public.newsletter_subscribers FOR INSERT TO anon, authenticated
  WITH CHECK (
    char_length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND char_length(source) BETWEEN 1 AND 64
  );

DROP POLICY IF EXISTS "public_insert_status_subscribers" ON public.status_subscribers;
CREATE POLICY "public_insert_status_subscribers" ON public.status_subscribers FOR INSERT TO anon, authenticated
  WITH CHECK (
    char_length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND (phone IS NULL OR char_length(phone) <= 32)
  );

-- ---------------------------------------------------------------------
-- 3. support_conversations: visitors are `authenticated` (anonymous auth), never the `anon` role
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "visitor_select_own_conversation" ON public.support_conversations;
CREATE POLICY "visitor_select_own_conversation" ON public.support_conversations FOR SELECT TO authenticated
  USING (visitor_id = auth.uid() OR public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "visitor_insert_own_conversation" ON public.support_conversations;
CREATE POLICY "visitor_insert_own_conversation" ON public.support_conversations FOR INSERT TO authenticated
  WITH CHECK (visitor_id = auth.uid());

DROP POLICY IF EXISTS "update_conversation" ON public.support_conversations;
CREATE POLICY "update_conversation" ON public.support_conversations FOR UPDATE TO authenticated
  USING (visitor_id = auth.uid() OR public.is_vireek_staff(auth.uid()))
  WITH CHECK (visitor_id = auth.uid() OR public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "select_messages_in_own_conversation" ON public.support_messages;
CREATE POLICY "select_messages_in_own_conversation" ON public.support_messages FOR SELECT TO authenticated
  USING (
    public.is_vireek_staff(auth.uid())
    OR EXISTS (SELECT 1 FROM public.support_conversations c WHERE c.id = conversation_id AND c.visitor_id = auth.uid())
  );

DROP POLICY IF EXISTS "insert_message_in_own_conversation" ON public.support_messages;
CREATE POLICY "insert_message_in_own_conversation" ON public.support_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND (
      (sender_type = 'staff' AND public.is_vireek_staff(auth.uid()))
      OR (
        sender_type = 'visitor'
        AND EXISTS (SELECT 1 FROM public.support_conversations c WHERE c.id = conversation_id AND c.visitor_id = auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------
-- 4. Column-level SELECT: keep the row policy, hide internals.
--    REVOKE at table level first (it also drops any column grants), then grant the safe columns.
--    service_role / SECURITY DEFINER functions are unaffected.
-- ---------------------------------------------------------------------
REVOKE SELECT ON public.platform_backup_runs FROM anon, authenticated;
GRANT SELECT (id, started_at, completed_at, status, backup_type, size_bytes)
  ON public.platform_backup_runs TO authenticated;

REVOKE SELECT ON public.platform_restore_drills FROM anon, authenticated;
GRANT SELECT (id, backup_run_id, started_at, completed_at, status, rto_seconds, notes)
  ON public.platform_restore_drills TO authenticated;

REVOKE SELECT ON public.pack_versions FROM anon, authenticated;
GRANT SELECT (pack_id, version, seq, name, published_at)
  ON public.pack_versions TO authenticated;

REVOKE SELECT ON public.verification_sources FROM anon, authenticated;
GRANT SELECT (id, source_key, label, kind, jurisdiction, active)
  ON public.verification_sources TO authenticated;
