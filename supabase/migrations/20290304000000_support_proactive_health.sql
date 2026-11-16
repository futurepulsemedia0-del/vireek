-- 20290304000000_support_proactive_health.sql
-- Purely additive. ROLLBACK (newest first):
--   DROP FUNCTION IF EXISTS public.proactive_alert_candidates();
--   DROP FUNCTION IF EXISTS public.staff_customer_health(integer);
--   DROP TABLE    IF EXISTS public.customer_alert_log;
--   DROP TRIGGER  IF EXISTS trg_support_diag_immutable ON public.support_conversations;
--   DROP FUNCTION IF EXISTS public.support_diag_immutable();
--   ALTER TABLE public.support_conversations DROP CONSTRAINT IF EXISTS support_conversations_diagnostics_size;
--   ALTER TABLE public.support_conversations DROP COLUMN IF EXISTS diagnostics;

ALTER TABLE public.support_conversations ADD COLUMN IF NOT EXISTS diagnostics jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_diagnostics_size') THEN
    ALTER TABLE public.support_conversations
      ADD CONSTRAINT support_conversations_diagnostics_size
      CHECK (diagnostics IS NULL OR pg_column_size(diagnostics) <= 8192);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.support_diag_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.diagnostics IS DISTINCT FROM OLD.diagnostics AND NOT public.is_vireek_staff(auth.uid()) THEN
    NEW.diagnostics := OLD.diagnostics;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_support_diag_immutable ON public.support_conversations;
CREATE TRIGGER trg_support_diag_immutable
  BEFORE UPDATE ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.support_diag_immutable();

CREATE TABLE IF NOT EXISTS public.customer_alert_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('integration_error','payment_failed','call_volume_drop','forwarding_suspect')),
  dedupe_key  text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_customer_alert_log_created ON public.customer_alert_log (created_at DESC);
ALTER TABLE public.customer_alert_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_alert_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_customer_health(p_limit integer DEFAULT 200)
RETURNS TABLE (
  account_id uuid, email text, company_name text, plan text, subscription_status text,
  onboarding_completed boolean, has_forwarding boolean, created_at timestamptz,
  calls_7d integer, calls_30d integer, calls_prev_7d integer,
  integrations_in_error integer, escalations_open integer, tickets_open integer,
  last_sign_in_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id, p.email, p.company_name, p.plan, p.subscription_status,
         p.onboarding_completed,
         (p.forwarding_number IS NOT NULL AND btrim(p.forwarding_number) <> ''),
         p.created_at,
         COALESCE(c.c7, 0), COALESCE(c.c30, 0), COALESCE(c.cprev, 0),
         COALESCE(i.n, 0)::int, COALESCE(e.n, 0), COALESCE(t.n, 0),
         u.last_sign_in_at
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE x.call_datetime >= now() - interval '7 days')::int AS c7,
           count(*)::int AS c30,
           count(*) FILTER (WHERE x.call_datetime >= now() - interval '14 days'
                              AND x.call_datetime <  now() - interval '7 days')::int AS cprev
    FROM public.calls x
    WHERE x.user_id = p.id AND x.call_datetime >= now() - interval '30 days'
  ) c ON TRUE
  LEFT JOIN LATERAL (
    SELECT (SELECT count(*) FROM public.acct_connections a WHERE a.user_id = p.id AND a.status = 'error')
         + (SELECT count(*) FROM public.integrations g WHERE g.user_id = p.id AND g.status = 'error') AS n
  ) i ON TRUE
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n FROM public.escalation_events ev
    WHERE ev.user_id = p.id AND ev.status IN ('active','exhausted') AND ev.created_at >= now() - interval '30 days'
  ) e ON TRUE
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n FROM public.support_conversations s
    WHERE s.kind = 'ticket' AND s.account_owner_id = p.id AND s.status <> 'closed'
  ) t ON TRUE
  WHERE p.role = 'owner' AND NOT p.is_staff
  ORDER BY p.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END $$;
REVOKE ALL ON FUNCTION public.staff_customer_health(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_customer_health(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.proactive_alert_candidates()
RETURNS TABLE (account_id uuid, kind text, dedupe_key text, title text, message text, action_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH wk AS (SELECT to_char(now(), 'IYYY-"W"IW') AS w)
  SELECT p.id, 'payment_failed', 'pd-' || wk.w,
         'Your last payment didn’t go through',
         'Update your payment method to keep your AI receptionist answering calls without interruption.',
         '/dashboard/billing/update-payment'
  FROM public.profiles p, wk
  WHERE p.role = 'owner' AND NOT p.is_staff AND p.subscription_status = 'past_due'
  UNION ALL
  SELECT a.user_id, 'integration_error', 'acct-' || a.id::text || '-' || wk.w,
         'Your ' || initcap(replace(a.provider, '_', ' ')) || ' connection needs attention',
         'Syncing has stopped. Reconnect it so invoices and payments keep flowing.',
         '/dashboard/accounting'
  FROM public.acct_connections a, wk
  WHERE a.status = 'error'
  UNION ALL
  SELECT s.id, 'call_volume_drop', 'drop-' || wk.w,
         'Fewer calls than usual this week',
         'We’re seeing far fewer calls than last week. If that’s unexpected, check that call forwarding to your Vireek number is still active.',
         '/dashboard/phone-numbers'
  FROM (
    SELECT p.id,
           count(*) FILTER (WHERE c.call_datetime >= now() - interval '7 days') AS c7,
           count(*) FILTER (WHERE c.call_datetime >= now() - interval '14 days' AND c.call_datetime < now() - interval '7 days') AS cprev
    FROM public.profiles p
    JOIN public.calls c ON c.user_id = p.id AND c.call_datetime >= now() - interval '14 days'
    WHERE p.role = 'owner' AND NOT p.is_staff AND p.created_at < now() - interval '14 days'
    GROUP BY p.id
  ) s, wk
  WHERE s.cprev >= 10 AND s.c7 <= s.cprev * 0.4
  UNION ALL
  SELECT s.id, 'forwarding_suspect', 'fwd-' || wk.w,
         'We haven’t received calls for 3 days',
         'Calls may no longer be forwarding to your Vireek number. Open your phone settings to check, or contact support.',
         '/dashboard/phone-numbers'
  FROM (
    SELECT p.id,
           count(*) FILTER (WHERE c.call_datetime >= now() - interval '3 days') AS recent,
           count(*) FILTER (WHERE c.call_datetime < now() - interval '3 days') AS before
    FROM public.profiles p
    JOIN public.calls c ON c.user_id = p.id AND c.call_datetime >= now() - interval '14 days'
    WHERE p.role = 'owner' AND NOT p.is_staff AND p.onboarding_completed
      AND p.forwarding_number IS NOT NULL AND btrim(p.forwarding_number) <> ''
    GROUP BY p.id
  ) s, wk
  WHERE s.recent = 0 AND s.before >= 5;
$$;
REVOKE ALL ON FUNCTION public.proactive_alert_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.proactive_alert_candidates() TO service_role;
