-- =============================================================
-- OPTIONAL ENFORCEMENT STEP — do NOT run until every precondition is met.
--
-- Purpose: make the access log un-bypassable for call recordings/transcripts. After this,
-- a signed-in user can no longer SELECT calls.recording_url / calls.transcript directly;
-- the only way is public.read_call_sensitive(), which logs inside the same transaction.
--
-- Preconditions (all of them):
--  1. 20281103000000_sensitive_read_access_log.sql is applied and its tests pass.
--  2. Every client query that does .from('calls').select('*') (or names recording_url /
--     transcript) is changed: list/dashboard pages -> .from('calls_safe'); detail page and
--     moneyRecovered.ts recording lookups -> read_call_sensitive(). `node scripts/check-sensitive-reads.mjs`
--     must show no remaining `calls-direct-read` sites under src/.
--  3. Supabase Realtime subscriptions on `calls` were tested on staging (column-level grants
--     may affect postgres_changes for that table). If they break, do not apply.
--  4. Service-role code (edge functions) is unaffected: service_role keeps full access.
--
-- Maintenance: columns added to public.calls later get NO client grant until you re-run the
-- GRANT block below (deliberate: new columns default to hidden).
-- Rollback:  GRANT SELECT ON public.calls TO authenticated;  DROP VIEW public.calls_safe;
-- =============================================================
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'calls' AND column_name NOT IN ('recording_url', 'transcript');
  IF cols IS NULL THEN RAISE EXCEPTION 'public.calls not found'; END IF;

  EXECUTE format('CREATE OR REPLACE VIEW public.calls_safe WITH (security_invoker = true) AS SELECT %s FROM public.calls', cols);
  REVOKE ALL ON public.calls_safe FROM PUBLIC, anon;
  GRANT SELECT ON public.calls_safe TO authenticated;

  REVOKE SELECT ON public.calls FROM authenticated;
  EXECUTE format('GRANT SELECT (%s) ON public.calls TO authenticated', cols);
END $$;
