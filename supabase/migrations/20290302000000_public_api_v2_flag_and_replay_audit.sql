-- Public API v2 foundation: feature flag (default OFF), service-side flag check, append-only replay audit.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_webhook_outbox_replay_audit ON public.webhook_outbox;
--   DROP FUNCTION IF EXISTS public.webhook_outbox_replay_audit();
--   DROP TABLE IF EXISTS public.webhook_replay_audit;
--   DROP FUNCTION IF EXISTS public.public_api_v2_enabled(uuid);
--   DELETE FROM public.feature_flags WHERE key = 'public_api_v2';

-- 1) Flag: enabled=true with rollout_pct=0 means "nobody by default"; only a per-tenant staff override (ON)
--    switches it on for an account. That override IS the per-account entitlement.
--    (enabled=false would ignore overrides entirely, so it must not be used here.)
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('public_api_v2', 'Public API v2 (filters, webhook replay console)',
        'Enables list filters on api-v1 and the webhook delivery/replay console. OFF = legacy behavior.', true, 0)
ON CONFLICT (key) DO NOTHING;

-- 2) Server-side evaluation for the edge function (service_role only; fails closed to false).
CREATE OR REPLACE FUNCTION public.public_api_v2_enabled(p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key)
      FROM public.feature_flags f
      LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
     WHERE f.key = 'public_api_v2'
  ), false);
$$;
REVOKE ALL ON FUNCTION public.public_api_v2_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_api_v2_enabled(uuid) TO service_role;

-- 3) Append-only audit of webhook replays (who replayed which delivery, when).
--    No FK on purpose: an audit row must outlive the delivery. Retention/erasure policy: REQUIRES COUNSEL.
CREATE TABLE IF NOT EXISTS public.webhook_replay_audit (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  actor_id uuid,
  outbox_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  replay_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_replay_audit_owner ON public.webhook_replay_audit (user_id, created_at DESC);

ALTER TABLE public.webhook_replay_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_webhook_replay_audit" ON public.webhook_replay_audit;
CREATE POLICY "select_own_webhook_replay_audit" ON public.webhook_replay_audit FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.agent_network_is_admin()));
-- No insert/update/delete policies; writes only through the trigger below.
REVOKE ALL ON public.webhook_replay_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.webhook_replay_audit TO authenticated;

CREATE OR REPLACE FUNCTION public.webhook_replay_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook_replay_audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_replay_audit_immutable ON public.webhook_replay_audit;
CREATE TRIGGER trg_webhook_replay_audit_immutable
  BEFORE UPDATE OR DELETE ON public.webhook_replay_audit
  FOR EACH ROW EXECUTE FUNCTION public.webhook_replay_audit_immutable();

CREATE OR REPLACE FUNCTION public.webhook_outbox_replay_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.webhook_replay_audit (user_id, actor_id, outbox_id, endpoint_id, delivery_id, replay_count)
  VALUES (NEW.user_id, auth.uid(), NEW.id, NEW.endpoint_id, NEW.delivery_id, NEW.replay_count);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_outbox_replay_audit ON public.webhook_outbox;
CREATE TRIGGER trg_webhook_outbox_replay_audit
  AFTER UPDATE ON public.webhook_outbox
  FOR EACH ROW WHEN (NEW.replay_count > OLD.replay_count)
  EXECUTE FUNCTION public.webhook_outbox_replay_audit();
