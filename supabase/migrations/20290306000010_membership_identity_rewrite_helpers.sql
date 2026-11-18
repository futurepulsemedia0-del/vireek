/*
# Membership identity: rewrite legacy email-matched helpers and policies

Runs AFTER 20290306000000_membership_identity_unification.sql.

Rewrites, inside every function and RLS policy of schema public, the legacy predicates
    member_email = (SELECT email FROM auth.users WHERE id = auth.uid())      (+ lower()/COALESCE/alias/jwt variants)
into
    (user_id = auth.uid() AND public.team_member_is_live(invite_status, deactivated_at))

Safety:
- Each object is rewritten in its own sub-transaction. If one fails, the ORIGINAL stays in place and a WARNING is raised;
  nothing else is affected. Every rewritten object is announced with a NOTICE.
- Idempotent: once rewritten, an object no longer matches, so a re-run changes nothing.
- Functions: only the body text is replaced; owner, grants, SECURITY DEFINER, search_path and volatility are preserved.
- Policies: ALTER POLICY with the rewritten USING / WITH CHECK, role list unchanged.
- Not touched (deliberately, not authorization): lower(member_email) = lower(<profile email>) used for revenue attribution,
  talent-profile matching and founder KPI exclusion.

[VERIFY] The policy rewrite works on the text PostgreSQL deparses into pg_policies. Run the pgTAP file
supabase/tests/database/membership_identity.test.sql: its ratchet test fails and lists every function/policy that still
compares member_email to auth.users.

Rollback: not automatic. Re-apply the original migration of a given object, or restore from backup.
*/

CREATE OR REPLACE FUNCTION pg_temp._vk_rewrite_email_membership(p_src text)
RETURNS text
LANGUAGE plpgsql
AS $f$
DECLARE
  v text := p_src;
BEGIN
  -- A_plain
  v := regexp_replace(v, $rx$((?:\w+\.)?)member_email\s*=\s*\(\s*SELECT\s+(?:\w+\.)?email\s+FROM\s+auth\.users(?:\s+\w+)?\s+WHERE\s+\(?\s*(?:\w+\.)?id\s*=\s*(auth\.uid\(\)|v_uid|p_user)\s*\)?\s*\)$rx$, $rp$(\1user_id = \2 AND public.team_member_is_live(\1invite_status, \1deactivated_at))$rp$, 'gi');
  -- B_lower_sub
  v := regexp_replace(v, $rx$lower\(\s*((?:\w+\.)?)member_email\s*(?:::text)?\)\s*=\s*lower\(\s*(?:COALESCE\(\s*)?\(\s*SELECT\s+(?:\w+\.)?email\s+FROM\s+auth\.users(?:\s+\w+)?\s+WHERE\s+\(?\s*(?:\w+\.)?id\s*=\s*(auth\.uid\(\)|v_uid|p_user)\s*\)?\s*\)(?:\s*,\s*''(?:::text)?\s*\))?\s*\)$rx$, $rp$(\1user_id = \2 AND public.team_member_is_live(\1invite_status, \1deactivated_at))$rp$, 'gi');
  -- C1_jwt_coalesce
  v := regexp_replace(v, $rx$lower\(\s*((?:\w+\.)?)member_email\s*\)\s*=\s*lower\(\s*COALESCE\(\s*\(?\s*auth\.jwt\(\)\s*->>\s*'email'(?:::text)?\s*\)?\s*,\s*''(?:::text)?\s*\)\s*\)$rx$, $rp$(\1user_id = auth.uid() AND public.team_member_is_live(\1invite_status, \1deactivated_at))$rp$, 'gi');
  -- C2_jwt
  v := regexp_replace(v, $rx$lower\(\s*((?:\w+\.)?)member_email\s*\)\s*=\s*lower\(\s*\(?\s*auth\.jwt\(\)\s*->>\s*'email'(?:::text)?\s*\)?\s*\)$rx$, $rp$(\1user_id = auth.uid() AND public.team_member_is_live(\1invite_status, \1deactivated_at))$rp$, 'gi');
  RETURN v;
END
$f$;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
DO $fn$
DECLARE
  r record;
  v_new text;
  v_def text;
  v_def_new text;
  n_done integer := 0;
  n_fail integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE ns.nspname = 'public'
       AND p.prokind = 'f'
       AND l.lanname IN ('sql', 'plpgsql')
       AND p.prosrc ~* 'member_email'
       AND p.prosrc ~* '(auth\.users|auth\.jwt)'
  LOOP
    v_new := pg_temp._vk_rewrite_email_membership(r.prosrc);
    CONTINUE WHEN v_new = r.prosrc;
    BEGIN
      v_def := pg_get_functiondef(r.oid);
      v_def_new := replace(v_def, r.prosrc, v_new);
      IF v_def_new = v_def THEN
        RAISE EXCEPTION 'function body not found inside its own definition';
      END IF;
      EXECUTE v_def_new;
      n_done := n_done + 1;
      RAISE NOTICE 'membership rewrite: function public.%(%)', r.proname, r.args;
    EXCEPTION WHEN OTHERS THEN
      n_fail := n_fail + 1;
      RAISE WARNING 'membership rewrite SKIPPED function public.%(%): %', r.proname, r.args, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'membership rewrite: % functions rewritten, % skipped', n_done, n_fail;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
DO $pol$
DECLARE
  r record;
  v_q text;
  v_w text;
  n_done integer := 0;
  n_fail integer := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual ~* 'member_email' OR with_check ~* 'member_email')
  LOOP
    v_q := CASE WHEN r.qual IS NULL THEN NULL ELSE pg_temp._vk_rewrite_email_membership(r.qual) END;
    v_w := CASE WHEN r.with_check IS NULL THEN NULL ELSE pg_temp._vk_rewrite_email_membership(r.with_check) END;
    CONTINUE WHEN v_q IS NOT DISTINCT FROM r.qual AND v_w IS NOT DISTINCT FROM r.with_check;
    BEGIN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I%s%s',
        r.policyname, r.schemaname, r.tablename,
        CASE WHEN v_q IS DISTINCT FROM r.qual THEN ' USING (' || v_q || ')' ELSE '' END,
        CASE WHEN v_w IS DISTINCT FROM r.with_check THEN ' WITH CHECK (' || v_w || ')' ELSE '' END
      );
      n_done := n_done + 1;
      RAISE NOTICE 'membership rewrite: policy % on public.%', r.policyname, r.tablename;
    EXCEPTION WHEN OTHERS THEN
      n_fail := n_fail + 1;
      RAISE WARNING 'membership rewrite SKIPPED policy % on public.%: %', r.policyname, r.tablename, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'membership rewrite: % policies rewritten, % skipped', n_done, n_fail;
END
$pol$;
