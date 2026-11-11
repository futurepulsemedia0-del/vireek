/*
  # Inbound free-minute allowance: rollout switch + staff report (additive on 20280403000000)

  - fraud_settings.enforcement_mode ('shadow' | 'enforce', default 'shadow') governs ONLY the inbound free-minute
    allowance gate (_shared/fraud/inboundGate.ts). It is separate from fraud_settings.enforce, which governs the
    outbound guard and defaults to true. In 'shadow' the call is never changed; a 'would_block' row is written to
    fraud_events instead.
  - View fraud_inbound_would_block_7d: would_block counts per plan for the last 7 days. security_invoker = true,
    so the existing staff-only RLS policy on fraud_events applies (non-staff get zero rows).
  - fraud_inbound_allowance() and all plan numbers are NOT touched.

  ## Rollback
  See bottom (commented). Switching back without dropping anything:
  UPDATE public.fraud_settings SET enforcement_mode = 'shadow' WHERE id = true;
*/

ALTER TABLE public.fraud_settings
  ADD COLUMN IF NOT EXISTS enforcement_mode text NOT NULL DEFAULT 'shadow'
  CHECK (enforcement_mode IN ('shadow', 'enforce'));

COMMENT ON COLUMN public.fraud_settings.enforcement_mode IS
  'Inbound free-minute allowance gate only: shadow = log would_block, never alter the call; enforce = forward/announce. Not related to fraud_settings.enforce (outbound guard).';

CREATE OR REPLACE VIEW public.fraud_inbound_would_block_7d
WITH (security_invoker = true) AS
SELECT
  COALESCE(e.detail ->> 'plan', 'unknown')                                  AS plan,
  COUNT(*)                                                                  AS events,
  COUNT(DISTINCT COALESCE(e.detail ->> 'call_id', e.id::text))              AS calls,
  COUNT(DISTINCT e.user_id)                                                 AS accounts,
  MIN(e.created_at)                                                         AS first_at,
  MAX(e.created_at)                                                         AS last_at
FROM public.fraud_events e
WHERE e.kind = 'would_block'
  AND e.code = 'INBOUND_FREE_EXHAUSTED'
  AND e.created_at >= now() - interval '7 days'
GROUP BY 1;

REVOKE ALL ON public.fraud_inbound_would_block_7d FROM PUBLIC, anon;
GRANT SELECT ON public.fraud_inbound_would_block_7d TO authenticated, service_role;

/* ROLLBACK (manual):
   DROP VIEW IF EXISTS public.fraud_inbound_would_block_7d;
   ALTER TABLE public.fraud_settings DROP COLUMN IF EXISTS enforcement_mode;
*/
