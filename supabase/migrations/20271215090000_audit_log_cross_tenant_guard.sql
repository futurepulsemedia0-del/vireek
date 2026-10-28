-- Audit log: block cross-tenant writes through log_audit_event().
--
-- Why: log_audit_event() is SECURITY DEFINER and granted to every authenticated
-- user, and it trusted p_user_id. Any signed-in user could therefore write rows
-- into ANOTHER account's audit trail (forged entries). This migration keeps the
-- exact same signature/return type and all legitimate callers working:
--   * service role / SQL editor / migrations (auth.uid() IS NULL)  -> allowed (unchanged)
--   * p_user_id = caller's own id                                  -> allowed
--   * p_user_id = caller's account owner id (team members)         -> allowed
--   * Vireek staff (is_vireek_staff)                               -> allowed
--   * anything else                                                -> 42501 error
-- Additive and idempotent (CREATE OR REPLACE only; no DROP/TRUNCATE/DELETE).

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_user_id uuid,
  p_action text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
  v_metadata jsonb := p_metadata;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL
     AND p_user_id IS DISTINCT FROM v_uid
     AND p_user_id IS DISTINCT FROM public.get_account_owner_id()
     AND NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'log_audit_event: not permitted to write to another account''s audit trail'
      USING ERRCODE = '42501';
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_uid;

  IF v_metadata IS NOT NULL THEN
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      v_metadata := jsonb_build_object('note', 'metadata dropped: not a JSON object');
    ELSIF pg_column_size(v_metadata) > 16384 THEN
      v_metadata := jsonb_build_object('note', 'metadata dropped: payload too large');
    END IF;
  END IF;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
  VALUES (p_user_id, v_uid, v_actor_email, p_action, p_target_table, p_target_id, v_metadata);
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) TO authenticated;
