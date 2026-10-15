-- Audit log: record WHAT changed, not just that something happened.
--
-- audit_log originally stored only (actor, action, target). The owner-only
-- viewer at /dashboard/settings/audit-log renders a before/after diff, which
-- needs a place to keep it. `metadata` is free-form jsonb; the viewer
-- understands two shapes (anything else is shown as redacted raw JSON):
--
--   { "changes": { "<field>": { "from": <old>, "to": <new> } } }
--   { "before": { ... }, "after": { ... } }
--
-- Existing rows keep metadata = NULL and render as "no change details".
-- Never put secrets in metadata — the viewer also redacts obvious secret
-- keys (password, token, secret, api key, authorization) as a safety net.

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_metadata_is_object;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_metadata_is_object
  CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');

-- Filter support: action / target lookups per account, newest first.
CREATE INDEX IF NOT EXISTS idx_audit_log_user_action_created
  ON public.audit_log (user_id, action, created_at DESC);

-- Replace log_audit_event with a version that accepts optional metadata.
-- The old 4-argument signature is dropped first: leaving both would make
-- 4-argument calls ambiguous. Existing callers keep working unchanged
-- because p_metadata defaults to NULL.
DROP FUNCTION IF EXISTS public.log_audit_event(uuid, text, text, text);

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
BEGIN
  SELECT email INTO v_actor_email FROM auth.users WHERE id = auth.uid();

  -- Keep rows small: oversized or non-object payloads are replaced by a marker.
  IF v_metadata IS NOT NULL THEN
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      v_metadata := jsonb_build_object('note', 'metadata dropped: not a JSON object');
    ELSIF pg_column_size(v_metadata) > 16384 THEN
      v_metadata := jsonb_build_object('note', 'metadata dropped: payload too large');
    END IF;
  END IF;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
  VALUES (p_user_id, auth.uid(), v_actor_email, p_action, p_target_table, p_target_id, v_metadata);
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) TO authenticated;
