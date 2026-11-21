/*
  # Voice clone: versioned consent text + retention with automatic deletion + provider-deletion evidence

  What this adds
  1. public.voice_clone_consent_texts   immutable registry of every consent text ever offered (v1 legacy, v2 current)
  2. voice_clone_consents               + retention_days, expires_at, provider deletion/verification stamps, purge bookkeeping,
                                          status 'expired', FK consent_version -> consent_texts (NOT VALID: new rows only)
  3. trigger                            stamps approved_at/expires_at when a consent becomes 'approved'; retention can only shrink
  4. public.voice_clone_purge_log       append-only evidence of every purge (owner can read their own rows)
  5. public.voice_clone_claim_due()     lease-based claim of due work for the sweep (service_role only; SKIP LOCKED)
  6. public.voice_clone_retention_tick() + pg_cron job calling the voice-clone-retention-sweep edge function daily

  Legacy rows: voices already 'approved' were consented under v1, which said nothing about retention. They get
  expires_at = migration time + 365 days (never "approved_at + 365", which could delete old voices the moment this runs).
  Whether those owners must re-consent is [COUNSEL] (docs/compliance/voice-clone-data.md).

  Idempotent: safe to run twice. Order: this migration, then deploy functions, then the UI.

  Rollback (manual, in this order; loses retention data, keeps voices):
    SELECT cron.unschedule('vireek-voice-clone-retention');           -- if pg_cron is installed
    DROP TRIGGER IF EXISTS voice_clone_consents_retention_guard ON public.voice_clone_consents;
    DROP FUNCTION IF EXISTS public.voice_clone_consents_retention_guard();
    DROP FUNCTION IF EXISTS public.voice_clone_claim_due(integer, integer);
    DROP FUNCTION IF EXISTS public.voice_clone_retention_tick();
    DROP TABLE IF EXISTS public.voice_clone_purge_log;
    ALTER TABLE public.voice_clone_consents DROP CONSTRAINT IF EXISTS voice_clone_consents_consent_version_fkey;
    -- columns/status 'expired'/consent_texts are left in place on purpose (additive); remove by hand only if needed.
*/

-- 1. CONSENT TEXTS (immutable) -----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_clone_consent_texts (
  version      text PRIMARY KEY CHECK (version ~ '^v[0-9]{1,3}$'),
  text_sha256  text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 50 AND 4000),
  published_at timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);
ALTER TABLE public.voice_clone_consent_texts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_clone_consent_texts_read ON public.voice_clone_consent_texts;
CREATE POLICY voice_clone_consent_texts_read ON public.voice_clone_consent_texts FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.voice_clone_consent_texts TO authenticated;

CREATE OR REPLACE FUNCTION public.voice_clone_consent_texts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent texts are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.text_sha256 IS DISTINCT FROM OLD.text_sha256
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'consent texts are immutable (only retired_at may be set, once)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_clone_consent_texts_guard ON public.voice_clone_consent_texts;
CREATE TRIGGER voice_clone_consent_texts_guard
  BEFORE UPDATE OR DELETE ON public.voice_clone_consent_texts
  FOR EACH ROW EXECUTE FUNCTION public.voice_clone_consent_texts_guard();

-- Seed. The bodies are dollar-quoted verbatim copies of CONSENT_TEXT_V1 / V2 in
-- supabase/functions/_shared/voice-studio/consent.ts (a test fails if they differ). The hash is computed here.
INSERT INTO public.voice_clone_consent_texts (version, text_sha256, body, retired_at)
SELECT v.version, encode(sha256(convert_to(v.body, 'UTF8')), 'hex'), v.body, v.retired_at
FROM (VALUES
  ('v1', $voice_v1$I confirm that the voice in the sample I upload is my own, or that its owner gave me explicit written permission to create a synthetic copy of it for this business's AI receptionist. I will not clone any other person's voice. I understand calls will still disclose that the assistant is AI, and that I can revoke this consent at any time, which deletes the cloned voice.$voice_v1$, now()),
  ('v2', $voice_v2$I confirm that the voice in the sample I upload is my own, or that its owner gave me explicit written permission to create a synthetic copy of it for this business's AI receptionist. I will not clone any other person's voice. I understand calls will still disclose that the assistant is AI. I understand that the uploaded sample and the cloned voice are kept only for the retention period I choose, after which both are deleted automatically, and that I can revoke this consent at any time, which deletes them sooner.$voice_v2$, NULL::timestamptz)
) AS v(version, body, retired_at)
ON CONFLICT (version) DO NOTHING;

-- 2. CONSENT RECORD COLUMNS --------------------------------------------------------------------------------------
ALTER TABLE public.voice_clone_consents
  ADD COLUMN IF NOT EXISTS retention_days              integer     NOT NULL DEFAULT 365,
  ADD COLUMN IF NOT EXISTS expires_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS provider_deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS provider_delete_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_attempts              integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purge_last_error            text,
  ADD COLUMN IF NOT EXISTS purge_claimed_at            timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_notice_stage         integer     NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_clone_consents_retention_days_check') THEN
    ALTER TABLE public.voice_clone_consents
      ADD CONSTRAINT voice_clone_consents_retention_days_check CHECK (retention_days BETWEEN 7 AND 730);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_clone_consents_notice_stage_check') THEN
    ALTER TABLE public.voice_clone_consents
      ADD CONSTRAINT voice_clone_consents_notice_stage_check CHECK (expiry_notice_stage BETWEEN 0 AND 3);
  END IF;
  -- consent_version must name a published text (new rows only; existing rows are all 'v1').
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_clone_consents_consent_version_fkey') THEN
    ALTER TABLE public.voice_clone_consents
      ADD CONSTRAINT voice_clone_consents_consent_version_fkey
      FOREIGN KEY (consent_version) REFERENCES public.voice_clone_consent_texts (version) NOT VALID;
  END IF;
END $$;

-- status: add 'expired' (replace the original inline CHECK, whatever the engine named it).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.voice_clone_consents'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%pending%approved%rejected%revoked%'
    AND pg_get_constraintdef(oid) NOT ILIKE '%expired%'
  LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.voice_clone_consents DROP CONSTRAINT %I', c);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_clone_consents_status_check_v2') THEN
    ALTER TABLE public.voice_clone_consents
      ADD CONSTRAINT voice_clone_consents_status_check_v2
      CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'expired'));
  END IF;
END $$;

-- Legacy approved voices: grace period starts now (see header).
UPDATE public.voice_clone_consents
SET expires_at = now() + make_interval(secs => retention_days::double precision * 86400)
WHERE status = 'approved' AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS voice_clone_consents_due
  ON public.voice_clone_consents (expires_at) WHERE status = 'approved' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_clone_consents_cleanup
  ON public.voice_clone_consents (created_at)
  WHERE status IN ('revoked', 'expired', 'rejected') AND (provider_voice_id IS NOT NULL OR sample_path IS NOT NULL);

-- 3. EXPIRY STAMPING + "RETENTION ONLY SHRINKS" ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.voice_clone_consents_retention_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Becoming approved: stamp the approval time and the end of the retention period.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.expires_at  := NEW.approved_at + make_interval(secs => NEW.retention_days::double precision * 86400);
    RETURN NEW;
  END IF;

  -- Becoming expired: stamp it.
  IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired' THEN
    NEW.expired_at := COALESCE(NEW.expired_at, now());
  END IF;

  -- Still approved: retention may be shortened, never lengthened (a longer period needs a fresh consent).
  IF OLD.status = 'approved' AND NEW.status = 'approved' THEN
    IF NEW.retention_days > OLD.retention_days THEN
      RAISE EXCEPTION 'retention can only be shortened; give a new consent to extend it' USING ERRCODE = '23514';
    END IF;
    IF NEW.retention_days <> OLD.retention_days AND NEW.approved_at IS NOT NULL THEN
      NEW.expires_at := NEW.approved_at + make_interval(secs => NEW.retention_days::double precision * 86400);
    END IF;
    IF OLD.expires_at IS NOT NULL AND NEW.expires_at IS NOT NULL AND NEW.expires_at > OLD.expires_at THEN
      RAISE EXCEPTION 'expiry cannot be moved later' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_clone_consents_retention_guard ON public.voice_clone_consents;
CREATE TRIGGER voice_clone_consents_retention_guard
  BEFORE UPDATE ON public.voice_clone_consents
  FOR EACH ROW EXECUTE FUNCTION public.voice_clone_consents_retention_guard();

-- 4. PURGE LOG (append-only evidence) -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_clone_purge_log (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consent_id        uuid NOT NULL,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason            text NOT NULL CHECK (reason IN ('retention_expired', 'revoked', 'owner_deleted', 'provider_cleanup')),
  outcome           text NOT NULL CHECK (outcome IN ('purged', 'incomplete')),
  provider_delete   text CHECK (provider_delete IN ('deleted', 'not_found', 'failed', 'skipped')),
  provider_verified boolean NOT NULL DEFAULT false,
  samples_removed   integer NOT NULL DEFAULT 0 CHECK (samples_removed >= 0),
  assistant_restore text CHECK (assistant_restore IN ('not_needed', 'restored', 'no_preset', 'skipped', 'failed')),
  error             text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_clone_purge_log_user ON public.voice_clone_purge_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_clone_purge_log_consent ON public.voice_clone_purge_log (consent_id);
ALTER TABLE public.voice_clone_purge_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_clone_purge_log_select ON public.voice_clone_purge_log;
CREATE POLICY voice_clone_purge_log_select ON public.voice_clone_purge_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
GRANT SELECT ON public.voice_clone_purge_log TO authenticated;   -- writes: service_role only (no INSERT/UPDATE/DELETE grant)

-- 5. CLAIM DUE WORK (lease + SKIP LOCKED: two overlapping sweeps never process the same row) -----------------------
CREATE OR REPLACE FUNCTION public.voice_clone_claim_due(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 600)
RETURNS TABLE (
  consent_id uuid, owner_id uuid, consent_status text, voice_id text, sample text, reason text, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT c.id AS cid,
           CASE WHEN c.status = 'approved' THEN 'retention_expired' ELSE 'provider_cleanup' END AS why
    FROM public.voice_clone_consents c
    WHERE (
            (c.status = 'approved' AND c.expires_at IS NOT NULL AND c.expires_at <= now())
         OR (c.status IN ('revoked', 'expired', 'rejected') AND (c.provider_voice_id IS NOT NULL OR c.sample_path IS NOT NULL))
          )
      AND c.purge_attempts < 30
      AND (c.purge_claimed_at IS NULL OR c.purge_claimed_at < now() - make_interval(secs => GREATEST(30, p_lease_seconds)))
    ORDER BY COALESCE(c.expires_at, c.revoked_at, c.created_at)
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.voice_clone_consents u
       SET purge_claimed_at = now(), purge_attempts = u.purge_attempts + 1
      FROM due
     WHERE u.id = due.cid
    RETURNING u.id, u.user_id, u.status, u.provider_voice_id, u.sample_path, due.why, u.purge_attempts
  )
  SELECT k.id, k.user_id, k.status, k.provider_voice_id, k.sample_path, k.why, k.purge_attempts FROM claimed k;
END $$;
REVOKE ALL ON FUNCTION public.voice_clone_claim_due(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_clone_claim_due(integer, integer) TO service_role;

-- 6. DAILY SCHEDULE (same transport as voice_cron_tick) ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.voice_clone_retention_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_secret text;
BEGIN
  v_base := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF coalesce(v_base, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base || '/voice-clone-retention-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
    body := '{}'::jsonb
  );
END $$;
REVOKE ALL ON FUNCTION public.voice_clone_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_clone_retention_tick() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-voice-clone-retention', '40 3 * * *', $c$select public.voice_clone_retention_tick()$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: call public.voice_clone_retention_tick() daily from your external cron (see docs/compliance/voice-clone-data.md)';
  END IF;
END $$;
