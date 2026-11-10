/*
  # AI credential health (metadata only)

  Tracks the runtime health of platform-level AI provider keys managed by
  supabase/functions/_shared/ai-core/keyPool.ts.

  - Stores ONLY: provider, label, status, cool-down, counters, timestamps.
    NEVER the secret, a hash, a prefix or any derivative of it. Secrets stay in Supabase Edge secrets.
  - RLS enabled with ZERO policies and all grants revoked => service role only (same model as provider_credentials).
  - Written through record_ai_credential_event(): atomic upsert, strictly validated inputs,
    EXECUTE granted to service_role only.
  - Additive. Rollback (safe, data is advisory only):
      DROP FUNCTION IF EXISTS public.record_ai_credential_event(text, text, text, timestamptz);
      DROP TABLE IF EXISTS public.ai_credential_health;
*/

CREATE TABLE IF NOT EXISTS public.ai_credential_health (
  provider text NOT NULL CHECK (provider IN ('gemini', 'groq', 'cerebras', 'cloudflare', 'openrouter', 'anthropic', 'cohere')),
  label text NOT NULL CHECK (label ~ '^[A-Za-z0-9_-]{1,32}$'),
  status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'rate_limited', 'quarantined')),
  cooldown_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_successes bigint NOT NULL DEFAULT 0,
  total_auth_failures bigint NOT NULL DEFAULT 0,
  total_rate_limits bigint NOT NULL DEFAULT 0,
  total_other_failures bigint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_kind text CHECK (last_failure_kind IN ('AUTH', 'RATE_LIMIT', 'OTHER')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, label)
);

ALTER TABLE public.ai_credential_health ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: default deny for anon/authenticated. Edge functions use the service role.
REVOKE ALL ON public.ai_credential_health FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ai_credential_health IS 'Health metadata for platform AI keys. No secrets. Service role only.';

CREATE OR REPLACE FUNCTION public.record_ai_credential_event(
  p_provider text,
  p_label text,
  p_kind text,
  p_cooldown_until timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_kind NOT IN ('success', 'AUTH', 'RATE_LIMIT', 'OTHER') THEN
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ai_credential_health AS h (
    provider, label, status, cooldown_until, consecutive_failures,
    total_successes, total_auth_failures, total_rate_limits, total_other_failures,
    last_success_at, last_failure_at, last_failure_kind, updated_at
  ) VALUES (
    p_provider, p_label,
    CASE p_kind WHEN 'AUTH' THEN 'quarantined' WHEN 'RATE_LIMIT' THEN 'rate_limited' ELSE 'healthy' END,
    CASE WHEN p_kind IN ('AUTH', 'RATE_LIMIT') THEN p_cooldown_until END,
    CASE WHEN p_kind = 'success' THEN 0 ELSE 1 END,
    (p_kind = 'success')::int, (p_kind = 'AUTH')::int, (p_kind = 'RATE_LIMIT')::int, (p_kind = 'OTHER')::int,
    CASE WHEN p_kind = 'success' THEN now() END,
    CASE WHEN p_kind <> 'success' THEN now() END,
    CASE WHEN p_kind <> 'success' THEN p_kind END,
    now()
  )
  ON CONFLICT (provider, label) DO UPDATE SET
    status = CASE p_kind WHEN 'AUTH' THEN 'quarantined' WHEN 'RATE_LIMIT' THEN 'rate_limited' WHEN 'success' THEN 'healthy' ELSE h.status END,
    cooldown_until = CASE
      WHEN p_kind IN ('AUTH', 'RATE_LIMIT') THEN p_cooldown_until
      WHEN p_kind = 'success' THEN NULL
      ELSE h.cooldown_until END,
    consecutive_failures = CASE WHEN p_kind = 'success' THEN 0 ELSE h.consecutive_failures + 1 END,
    total_successes = h.total_successes + (p_kind = 'success')::int,
    total_auth_failures = h.total_auth_failures + (p_kind = 'AUTH')::int,
    total_rate_limits = h.total_rate_limits + (p_kind = 'RATE_LIMIT')::int,
    total_other_failures = h.total_other_failures + (p_kind = 'OTHER')::int,
    last_success_at = CASE WHEN p_kind = 'success' THEN now() ELSE h.last_success_at END,
    last_failure_at = CASE WHEN p_kind <> 'success' THEN now() ELSE h.last_failure_at END,
    last_failure_kind = CASE WHEN p_kind <> 'success' THEN p_kind ELSE h.last_failure_kind END,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_credential_event(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_credential_event(text, text, text, timestamptz) TO service_role;
