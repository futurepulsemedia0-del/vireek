/*
  # Per-state contact rules: cross-feature call ledger + decision audit

  DRAFT — NOT LEGAL ADVICE. Every rule VALUE lives in code (supabase/functions/_shared/contact-rules/table.ts)
  and is marked [COUNSEL][VERIFY]. This migration only adds the storage the enforcement needs.

  ## What it adds
  - contact_rule_events   one row per enforcement event.
      event = 'dial_reserved'  a call was RESERVED against the rolling-24h cap immediately before dialing
                               (the reservation row IS the cap ledger, shared by outbound-dialer,
                               followup-agent-dispatcher and speed-to-lead)
      event = 'deferred'       a call was held back (state hours / cap / rules unavailable)
  - contact_rules_reserve_call()  ATOMIC check-and-reserve (advisory lock per owner+number) so two workers
                               can never both pass the cap for the same number.
  - speed_to_lead_requests.contact_state / contact_state_basis / contact_rules_version
                               residency captured at intake (a state only when CONFIRMED; otherwise NULL =>
                               strictest profile at dial time).

  ## Security model
  - Phone numbers are stored only as a SHA-256 hash (+ last 4 digits for display).
  - Rows are written ONLY by service_role (edge functions) / the SECURITY DEFINER function below.
  - Account owner + team read their own rows (account_owner_id = public.get_account_owner_id()), same as
    speed_to_lead_attempts. No client INSERT/UPDATE/DELETE policy exists.
  - Evidence rows are append-only except `released_at` (a reservation can be released when the provider
    definitively refused the call). A trigger enforces that.

  ## Rollback (safe, additive)
    DROP FUNCTION IF EXISTS public.contact_rules_reserve_call(uuid, text, text, integer, text, text, text, text);
    DROP TABLE IF EXISTS public.contact_rule_events;
    ALTER TABLE public.speed_to_lead_requests
      DROP COLUMN IF EXISTS contact_state, DROP COLUMN IF EXISTS contact_state_basis, DROP COLUMN IF EXISTS contact_rules_version;
  Rolling back removes enforcement data only; edge functions fail closed (defer) if the function/table is missing.

  ## Requires
  public.get_account_owner_id(), profiles, speed_to_lead_requests
*/

-- ============================================================
-- 1. Event ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contact_rule_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('dial_reserved', 'deferred')),
  phone_hash text NOT NULL CHECK (char_length(phone_hash) = 64),
  phone_last4 text CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{1,4}$'),
  purpose text NOT NULL CHECK (purpose IN ('marketing', 'service', 'emergency')),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  jurisdiction text NOT NULL CHECK (char_length(jurisdiction) BETWEEN 2 AND 24),
  residency_basis text CHECK (residency_basis IS NULL OR residency_basis IN ('explicit', 'address', 'phone', 'conflict', 'unknown')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  timezone text,
  local_time text,
  rules_version text NOT NULL,
  cap integer CHECK (cap IS NULL OR cap BETWEEN 1 AND 10),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cap ledger lookups: live reservations for one number in the last 24 h.
CREATE INDEX IF NOT EXISTS idx_contact_rule_events_cap
  ON public.contact_rule_events (account_owner_id, phone_hash, created_at DESC)
  WHERE event = 'dial_reserved' AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_rule_events_owner_time
  ON public.contact_rule_events (account_owner_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.contact_rule_events_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only `released_at` may change, and only once, and only on a reservation row.
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at') THEN
      RAISE EXCEPTION 'contact_rule_events is append-only (only released_at may change)' USING ERRCODE = '42501';
    END IF;
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
      RAISE EXCEPTION 'a released reservation cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF OLD.event <> 'dial_reserved' AND NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'only dial_reserved rows can be released' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_contact_rule_events_guard ON public.contact_rule_events;
CREATE TRIGGER trg_contact_rule_events_guard BEFORE UPDATE ON public.contact_rule_events
  FOR EACH ROW EXECUTE FUNCTION public.contact_rule_events_guard();

ALTER TABLE public.contact_rule_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contact_rule_events_select" ON public.contact_rule_events;
CREATE POLICY "contact_rule_events_select" ON public.contact_rule_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- No INSERT / UPDATE / DELETE policy: only service_role (edge functions) writes.
REVOKE ALL ON public.contact_rule_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.contact_rule_events FROM authenticated;

-- ============================================================
-- 2. Atomic check-and-reserve
-- ============================================================
-- One transaction-scoped advisory lock per (owner, number) serialises concurrent dialers, so the count and the
-- insert can never interleave. Returns reserved=false (and the live count/oldest) when the cap is already used.
CREATE OR REPLACE FUNCTION public.contact_rules_reserve_call(
  p_owner uuid,
  p_phone_hash text,
  p_phone_last4 text,
  p_cap integer,
  p_purpose text,
  p_source text,
  p_jurisdiction text,
  p_rules_version text
)
RETURNS TABLE (reserved boolean, reservation_id uuid, call_count integer, oldest timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
  v_oldest timestamptz;
  v_id uuid;
BEGIN
  IF p_owner IS NULL OR p_phone_hash IS NULL OR char_length(p_phone_hash) <> 64 THEN
    RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
  END IF;
  IF p_cap IS NULL OR p_cap < 1 OR p_cap > 10 THEN
    RAISE EXCEPTION 'invalid cap' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || p_phone_hash, 0));

  SELECT count(*)::integer, min(e.created_at)
    INTO v_count, v_oldest
    FROM public.contact_rule_events e
   WHERE e.account_owner_id = p_owner
     AND e.phone_hash = p_phone_hash
     AND e.event = 'dial_reserved'
     AND e.released_at IS NULL
     AND e.created_at > now() - interval '24 hours';

  IF v_count >= p_cap THEN
    RETURN QUERY SELECT false, NULL::uuid, v_count, v_oldest;
    RETURN;
  END IF;

  INSERT INTO public.contact_rule_events (
    account_owner_id, event, phone_hash, phone_last4, purpose, source, jurisdiction, rules_version, cap
  ) VALUES (
    p_owner, 'dial_reserved', p_phone_hash, right(regexp_replace(coalesce(p_phone_last4, ''), '[^0-9]', '', 'g'), 4),
    p_purpose, left(p_source, 80), left(p_jurisdiction, 24), p_rules_version, p_cap
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT true, v_id, v_count + 1, coalesce(v_oldest, now());
END $$;

REVOKE ALL ON FUNCTION public.contact_rules_reserve_call(uuid, text, text, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contact_rules_reserve_call(uuid, text, text, integer, text, text, text, text) TO service_role;

-- ============================================================
-- 3. Speed-to-lead: residency captured at intake
-- ============================================================
ALTER TABLE public.speed_to_lead_requests
  ADD COLUMN IF NOT EXISTS contact_state text,
  ADD COLUMN IF NOT EXISTS contact_state_basis text,
  ADD COLUMN IF NOT EXISTS contact_rules_version text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stl_requests_contact_state_chk') THEN
    ALTER TABLE public.speed_to_lead_requests
      ADD CONSTRAINT stl_requests_contact_state_chk
      CHECK (contact_state IS NULL OR contact_state ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stl_requests_contact_basis_chk') THEN
    ALTER TABLE public.speed_to_lead_requests
      ADD CONSTRAINT stl_requests_contact_basis_chk
      CHECK (contact_state_basis IS NULL OR contact_state_basis IN ('explicit', 'address', 'phone', 'conflict', 'unknown'));
  END IF;
END $$;
