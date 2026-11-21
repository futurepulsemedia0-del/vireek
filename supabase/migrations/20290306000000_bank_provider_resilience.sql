/*
  # Bank data provider resilience

  ## Why
  Bank data comes from a third-party aggregator (Plaid today). When it is slow or down we must
  (a) stop hammering it, (b) keep serving the data we already have, (c) tell the user honestly how
  fresh that data is, (d) know what every pull costs us, and (e) be able to prove what each user
  consented to. Code: supabase/functions/_shared/bank/provider/*. Runbook:
  docs/runbooks/bank-data-provider-failure.md.

  ## Adds (no existing table is altered)
  1. bank_provider_health   one row per provider: circuit-breaker state
  2. bank_provider_rates    per-provider, per-operation unit cost in micro-USD (EMPTY on purpose)
  3. bank_pull_usage        one row per provider call (metering)
  4. bank_data_consents     consent records, append-only apart from one-time revocation
  RPCs (service_role only): bank_provider_save_health, bank_record_pull, bank_record_consent,
  bank_revoke_consents, bank_has_active_consent, bank_prune_pull_usage.

  ## Security
  - All four tables: RLS on, privileges revoked from anon/authenticated. Only the owner can read
    their own consent records (same predicate as the other bank tables).
  - Every RPC is SECURITY DEFINER with a fixed search_path and EXECUTE granted to service_role only.
  - Works against either bank_connections variant in the repo (only id, user_id, provider, status,
    created_at are referenced).

  ## Rollback
  DROP the four tables and six functions listed above (nothing else depends on them). The code
  degrades safely: provider/supabaseStore.ts errors are swallowed by the resilience decorator
  (fail-open), and sync.ts only calls bank_has_active_consent when BANK_CONSENT_ENFORCE=true.
*/

-- =============================================================
-- 1. Provider health (circuit breaker state)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bank_provider_health (
  provider text PRIMARY KEY CHECK (provider IN ('plaid', 'mx', 'finicity', 'mock')),
  state text NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy', 'degraded', 'down')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_kind text,
  circuit_open_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bank_provider_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_provider_health FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_provider_save_health(
  p_provider text, p_state text, p_consecutive_failures integer,
  p_last_success_at timestamptz, p_last_failure_at timestamptz,
  p_last_error_kind text, p_circuit_open_until timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO bank_provider_health AS h (provider, state, consecutive_failures, last_success_at, last_failure_at, last_error_kind, circuit_open_until, updated_at)
  VALUES (p_provider, p_state, greatest(p_consecutive_failures, 0), p_last_success_at, p_last_failure_at, left(p_last_error_kind, 60), p_circuit_open_until, now())
  ON CONFLICT (provider) DO UPDATE SET
    state = EXCLUDED.state,
    consecutive_failures = EXCLUDED.consecutive_failures,
    last_success_at = coalesce(EXCLUDED.last_success_at, h.last_success_at),
    last_failure_at = coalesce(EXCLUDED.last_failure_at, h.last_failure_at),
    last_error_kind = EXCLUDED.last_error_kind,
    circuit_open_until = EXCLUDED.circuit_open_until,
    updated_at = now();
END $$;

-- =============================================================
-- 2. Rate card (micro-USD per unit). Intentionally empty: vendor pricing is contract-specific [VERIFY].
--    Unknown rate => bank_pull_usage.cost_micros = NULL (unknown), never 0.
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bank_provider_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('plaid', 'mx', 'finicity', 'mock')),
  operation text NOT NULL CHECK (operation IN ('link_token', 'exchange', 'accounts', 'transactions_page', 'remove_item', 'webhook_verify')),
  micros_per_unit bigint NOT NULL CHECK (micros_per_unit >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, operation, effective_from)
);
ALTER TABLE public.bank_provider_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_provider_rates FROM anon, authenticated;

-- =============================================================
-- 3. Per-pull metering
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bank_pull_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  connection_id uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('plaid', 'mx', 'finicity', 'mock')),
  operation text NOT NULL CHECK (operation IN ('link_token', 'exchange', 'accounts', 'transactions_page', 'remove_item', 'webhook_verify')),
  units integer NOT NULL DEFAULT 1 CHECK (units >= 0),
  status text NOT NULL CHECK (status IN ('ok', 'error', 'blocked')),
  error_kind text,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_pull_usage_user_time ON public.bank_pull_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_pull_usage_time ON public.bank_pull_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_pull_usage_conn ON public.bank_pull_usage (connection_id) WHERE connection_id IS NOT NULL;
ALTER TABLE public.bank_pull_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_pull_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_record_pull(
  p_user_id uuid, p_connection_id uuid, p_provider text, p_operation text, p_units integer,
  p_status text, p_error_kind text, p_duration_ms integer, p_cost_micros bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO bank_pull_usage (user_id, connection_id, provider, operation, units, status, error_kind, duration_ms, cost_micros)
  VALUES (p_user_id,
          -- a dangling id must not make metering fail
          (SELECT id FROM bank_connections WHERE id = p_connection_id),
          p_provider, p_operation, greatest(p_units, 0), p_status, left(p_error_kind, 60), greatest(p_duration_ms, 0), p_cost_micros);
END $$;

CREATE OR REPLACE FUNCTION public.bank_prune_pull_usage(p_keep_days integer DEFAULT 400)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF p_keep_days < 30 THEN RAISE EXCEPTION 'p_keep_days must be >= 30'; END IF;
  DELETE FROM bank_pull_usage WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Ops view (service role only): daily calls, errors, blocked calls and KNOWN cost. Unknown-cost calls are counted separately.
CREATE OR REPLACE VIEW public.bank_pull_usage_daily AS
SELECT date_trunc('day', created_at) AS day,
       provider, operation,
       count(*) AS calls,
       sum(units) AS units,
       count(*) FILTER (WHERE status = 'error') AS errors,
       count(*) FILTER (WHERE status = 'blocked') AS blocked,
       coalesce(sum(cost_micros), 0) AS known_cost_micros,
       count(*) FILTER (WHERE cost_micros IS NULL) AS calls_with_unknown_cost
FROM public.bank_pull_usage
GROUP BY 1, 2, 3;
REVOKE ALL ON public.bank_pull_usage_daily FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 4. Consent records
-- =============================================================
CREATE TABLE IF NOT EXISTS public.bank_data_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                      -- account owner (tenant)
  connection_id uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('plaid', 'mx', 'finicity', 'mock')),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['accounts', 'transactions', 'balances']::text[]),
  source text NOT NULL CHECK (source IN ('link_flow', 'legacy_inventory')),
  -- 'link_completed' = the user finished the provider's link flow in our app (provable).
  -- 'legacy_inventory' = connection predates this table; NOT proof of what the user was shown.
  evidence text NOT NULL CHECK (evidence IN ('link_completed', 'legacy_inventory')),
  notice_version text,                        -- Vireek notice text version, only if the client reported it [COUNSEL]
  notice_acknowledged boolean NOT NULL DEFAULT false,
  granted_by uuid,                            -- auth user who performed the action (owner or team member)
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_consent_one_active ON public.bank_data_consents (connection_id) WHERE revoked_at IS NULL AND connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_consent_user ON public.bank_data_consents (user_id, granted_at DESC);

ALTER TABLE public.bank_data_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_bank_consents" ON public.bank_data_consents;
CREATE POLICY "select_own_bank_consents" ON public.bank_data_consents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.bank_can_access());
REVOKE ALL ON public.bank_data_consents FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.bank_data_consents FROM authenticated;

-- Append-only. Legal mutations: (1) one-time revocation (revoked_* NULL -> value) and
-- (2) connection_id -> NULL, which is what ON DELETE SET NULL does when a connection row is purged.
CREATE OR REPLACE FUNCTION public._bank_consent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.notice_acknowledged IS DISTINCT FROM OLD.notice_acknowledged
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'consent records are append-only; only revocation may change a row' USING ERRCODE = '42501';
  END IF;
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id AND NEW.connection_id IS NOT NULL THEN
    RAISE EXCEPTION 'consent records cannot be re-pointed to another connection' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'consent record % is already revoked and immutable', OLD.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bank_consent_guard ON public.bank_data_consents;
CREATE TRIGGER trg_bank_consent_guard BEFORE UPDATE ON public.bank_data_consents
  FOR EACH ROW EXECUTE FUNCTION public._bank_consent_guard();

CREATE OR REPLACE FUNCTION public.bank_record_consent(
  p_user_id uuid, p_connection_id uuid, p_provider text, p_actor_id uuid,
  p_scopes text[], p_source text DEFAULT 'link_flow',
  p_notice_version text DEFAULT NULL, p_notice_acknowledged boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bank_connections WHERE id = p_connection_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'connection does not belong to this account' USING ERRCODE = '42501';
  END IF;
  INSERT INTO bank_data_consents (user_id, connection_id, provider, scopes, source, evidence, notice_version, notice_acknowledged, granted_by)
  VALUES (p_user_id, p_connection_id, p_provider, p_scopes, p_source,
          CASE WHEN p_source = 'link_flow' THEN 'link_completed' ELSE 'legacy_inventory' END,
          left(p_notice_version, 40), coalesce(p_notice_acknowledged, false), p_actor_id)
  ON CONFLICT (connection_id) WHERE revoked_at IS NULL AND connection_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id; -- NULL when an active consent already existed (idempotent re-link)
END $$;

CREATE OR REPLACE FUNCTION public.bank_revoke_consents(p_connection_id uuid, p_actor_id uuid, p_reason text DEFAULT 'revoked')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  UPDATE bank_data_consents SET revoked_at = now(), revoked_by = p_actor_id, revoke_reason = left(p_reason, 120)
  WHERE connection_id = p_connection_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.bank_has_active_consent(p_connection_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_data_consents
    WHERE connection_id = p_connection_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
  );
$$;

-- Inventory of connections that pre-date consent records. Marked 'legacy_inventory': it says "this
-- connection existed", NOT "the user was shown notice X". Whether that is sufficient is [COUNSEL].
INSERT INTO public.bank_data_consents (user_id, connection_id, provider, scopes, source, evidence, granted_at)
SELECT c.user_id, c.id, c.provider, ARRAY['accounts', 'transactions', 'balances'], 'legacy_inventory', 'legacy_inventory', c.created_at
FROM public.bank_connections c
WHERE c.status <> 'disconnected'
  AND c.provider IN ('plaid', 'mx', 'finicity')
  AND NOT EXISTS (SELECT 1 FROM public.bank_data_consents k WHERE k.connection_id = c.id AND k.revoked_at IS NULL);

-- =============================================================
-- Privileges: service_role only
-- =============================================================
REVOKE ALL ON FUNCTION public.bank_provider_save_health(text, text, integer, timestamptz, timestamptz, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_record_pull(uuid, uuid, text, text, integer, text, text, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_prune_pull_usage(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_record_consent(uuid, uuid, text, uuid, text[], text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_revoke_consents(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_has_active_consent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._bank_consent_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_provider_save_health(text, text, integer, timestamptz, timestamptz, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_record_pull(uuid, uuid, text, text, integer, text, text, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_prune_pull_usage(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_record_consent(uuid, uuid, text, uuid, text[], text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_revoke_consents(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_has_active_consent(uuid) TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_provider_health, public.bank_provider_rates, public.bank_pull_usage, public.bank_data_consents TO service_role;
GRANT SELECT ON public.bank_pull_usage_daily TO service_role;
