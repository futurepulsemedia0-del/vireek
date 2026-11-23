/*
  # Shadow Mode live-listen (Mode B) — foundation, DEFAULT OFF

  Design: docs/SHADOW_LIVE_LISTEN_DESIGN.md. Expand-only and additive: nothing existing is altered.
  shadow_trials.mode stays 'replay' (its CHECK is untouched); live sessions live in their own tables.

  ## Adds
  - kill switch  `shadow_live_listen` (critical)  -> global / per-account stop, two-person resume (existing machinery)
  - feature flag `shadow_live_listen` (OFF, 0 %, risk critical) -> exposure needs a second approver (existing guard)
  - shadow_live_sessions  metadata ledger of every AUTHORIZED live session (and consent-blocked attempts once the flag is on).
                          NO audio, NO transcript, NO full phone number (last 4 only).
  - shadow_live_events    append-only audit trail (no PII). Deletable only by the retention purge.
  - RPCs (service_role ONLY): shadow_live_record, shadow_live_end, shadow_live_kill_sessions, shadow_live_purge_expired

  ## Safety enforced in the database (defence in depth — the edge function evaluates the same rules first)
  - A non-blocked session row cannot exist unless all four consent facts in consent_snapshot are true (CHECK).
  - shadow_live_record RE-READS the trial and refuses to authorize unless attestation, disclosure, staff notice and fork
    support are true on the trial row AND the jurisdiction is in the platform-set counsel_cleared_states.
  - Tenants (authenticated) get SELECT only, scoped by get_account_owner_id(). Every write is service-role.

  Requires: public.shadow_trials (20280410000000_shadow_mode.sql), public.kill_switches + public.feature_flags
  (20280501000000_release_safety_core.sql), public.get_account_owner_id().
*/
-- rollback: DROP FUNCTION public.shadow_live_record(uuid, uuid, text, text, text, text, text, jsonb, integer), public.shadow_live_end(uuid, text),
-- public.shadow_live_kill_sessions(uuid, text), public.shadow_live_purge_expired(); DROP TABLE public.shadow_live_events, public.shadow_live_sessions;
-- DELETE FROM public.feature_flags WHERE key = 'shadow_live_listen'; DELETE FROM public.kill_switches WHERE key = 'shadow_live_listen'.
-- No other object depends on these. Back up the two tables first if the ledger must be kept.

-- =============================================================
-- 1. Kill switch + flag (idempotent, flag OFF)
-- =============================================================
INSERT INTO public.kill_switches (key, label, description, risk)
VALUES ('shadow_live_listen', 'Shadow live-listen', 'One-way live audio fork for Shadow Mode (Mode B). Stopping denies new sessions at once and ends open ones within ~1 minute.', 'critical')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct, risk, kind, owner)
VALUES ('shadow_live_listen', 'Shadow live-listen', 'Gate for Shadow Mode live-listen. OFF = replay only. Needs consent gates, platform-cleared jurisdictions and a second approver.', false, 0, 'critical', 'release', 'platform-oncall')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 2. shadow_live_sessions
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trial_id uuid NOT NULL,
  call_ref text NOT NULL CHECK (char_length(call_ref) BETWEEN 1 AND 128),
  caller_last4 text CHECK (caller_last4 IS NULL OR caller_last4 ~ '^[0-9]{1,4}$'),
  jurisdiction text CHECK (jurisdiction IS NULL OR jurisdiction ~ '^([A-Z]{2}|NANP_UNLISTED)$'),
  status text NOT NULL CHECK (status IN ('authorized', 'blocked', 'ended', 'killed')),
  block_reason text CHECK (block_reason IS NULL OR char_length(block_reason) <= 64),
  consent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consent_snapshot) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR char_length(end_reason) <= 64),
  purge_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_live_sessions_one_per_call UNIQUE (user_id, call_ref),
  CONSTRAINT shadow_live_sessions_id_user UNIQUE (id, user_id),
  CONSTRAINT shadow_live_sessions_trial_fk FOREIGN KEY (trial_id, user_id)
    REFERENCES public.shadow_trials (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shadow_live_sessions_blocked_shape CHECK ((status = 'blocked') = (block_reason IS NOT NULL)),
  -- consent gate backstop: no non-blocked session may exist without every consent fact being true
  CONSTRAINT shadow_live_sessions_consent_gate CHECK (
    status = 'blocked'
    OR (
      consent_snapshot ->> 'replay_attested' = 'true'
      AND consent_snapshot ->> 'caller_disclosure_configured' = 'true'
      AND consent_snapshot ->> 'staff_notified' = 'true'
      AND consent_snapshot ->> 'telephony_supports_fork' = 'true'
      AND jurisdiction IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_shadow_live_sessions_trial ON public.shadow_live_sessions (trial_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_live_sessions_purge ON public.shadow_live_sessions (purge_after);
CREATE INDEX IF NOT EXISTS idx_shadow_live_sessions_open ON public.shadow_live_sessions (user_id) WHERE status = 'authorized';

-- =============================================================
-- 3. shadow_live_events (append-only audit, no PII)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_live_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,   -- deliberately NOT a FK: the audit trail must outlive the purged session row
  kind text NOT NULL CHECK (kind IN ('authorized', 'blocked', 'ended', 'killed')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 64),
  jurisdiction text CHECK (jurisdiction IS NULL OR jurisdiction ~ '^([A-Z]{2}|NANP_UNLISTED)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL DEFAULT (now() + interval '365 days')
);

CREATE INDEX IF NOT EXISTS idx_shadow_live_events_user ON public.shadow_live_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_live_events_purge ON public.shadow_live_events (purge_after);

CREATE OR REPLACE FUNCTION public.shadow_live_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.shadow_live_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'shadow_live_events is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_shadow_live_events_append_only ON public.shadow_live_events;
CREATE TRIGGER trg_shadow_live_events_append_only
  BEFORE UPDATE OR DELETE ON public.shadow_live_events
  FOR EACH ROW EXECUTE FUNCTION public.shadow_live_events_append_only();

-- =============================================================
-- 4. RLS + grants: tenants read their own rows, nobody writes directly
-- =============================================================
ALTER TABLE public.shadow_live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_live_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shadow_live_sessions, public.shadow_live_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.shadow_live_sessions, public.shadow_live_events FROM authenticated;
GRANT SELECT ON public.shadow_live_sessions, public.shadow_live_events TO authenticated;

DROP POLICY IF EXISTS shadow_live_sessions_select ON public.shadow_live_sessions;
CREATE POLICY shadow_live_sessions_select ON public.shadow_live_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS shadow_live_events_select ON public.shadow_live_events;
CREATE POLICY shadow_live_events_select ON public.shadow_live_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 5. RPCs — service_role only
-- =============================================================

-- Records the gate decision. Idempotent per (user, call_ref): a retry returns the first row's id and writes nothing.
-- p_decision = 'authorized' is RE-VERIFIED against the trial row; p_jurisdiction is an all-party state code or NANP_UNLISTED.
CREATE OR REPLACE FUNCTION public.shadow_live_record(
  p_user_id uuid, p_trial_id uuid, p_call_ref text, p_caller_last4 text, p_jurisdiction text,
  p_decision text, p_reason text, p_consent jsonb, p_retention_days integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  t public.shadow_trials%ROWTYPE;
  v_id uuid;
  v_days integer := LEAST(90, GREATEST(1, COALESCE(p_retention_days, 30)));
  v_status text;
BEGIN
  IF p_decision NOT IN ('authorized', 'blocked') THEN
    RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO t FROM public.shadow_trials s WHERE s.id = p_trial_id AND s.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trial not found for this account' USING ERRCODE = 'P0002';
  END IF;

  IF p_decision = 'authorized' THEN
    IF t.status <> 'active' OR t.ends_at <= now()
       OR NOT t.replay_attested OR NOT t.caller_disclosure_configured OR NOT t.staff_notified
       OR NOT t.telephony_supports_fork THEN
      RAISE EXCEPTION 'Consent gate failed: trial is not eligible for live-listen' USING ERRCODE = '42501';
    END IF;
    IF p_jurisdiction IS NULL OR NOT (p_jurisdiction = ANY (t.counsel_cleared_states)) THEN
      RAISE EXCEPTION 'Consent gate failed: jurisdiction not cleared by the platform' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_status := CASE WHEN p_decision = 'authorized' THEN 'authorized' ELSE 'blocked' END;

  INSERT INTO public.shadow_live_sessions
    (user_id, trial_id, call_ref, caller_last4, jurisdiction, status, block_reason, consent_snapshot, purge_after)
  VALUES
    (p_user_id, p_trial_id, p_call_ref, p_caller_last4, p_jurisdiction, v_status,
     CASE WHEN v_status = 'blocked' THEN COALESCE(left(NULLIF(btrim(p_reason), ''), 64), 'blocked') END,
     COALESCE(p_consent, '{}'::jsonb), now() + make_interval(days => v_days))
  ON CONFLICT (user_id, call_ref) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT s.id INTO v_id FROM public.shadow_live_sessions s WHERE s.user_id = p_user_id AND s.call_ref = p_call_ref;
    RETURN v_id; -- idempotent retry: no second row, no second audit event
  END IF;

  INSERT INTO public.shadow_live_events (user_id, session_id, kind, reason, jurisdiction)
  VALUES (p_user_id, v_id, v_status, CASE WHEN v_status = 'blocked' THEN left(NULLIF(btrim(p_reason), ''), 64) END, p_jurisdiction);
  RETURN v_id;
END;
$$;

-- Ends one open session. p_reason: 'completed' | 'kill_switch' | 'flag_off' | 'max_duration' | …
CREATE OR REPLACE FUNCTION public.shadow_live_end(p_session_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s public.shadow_live_sessions%ROWTYPE;
  v_reason text := COALESCE(left(NULLIF(btrim(p_reason), ''), 64), 'completed');
  v_kind text;
BEGIN
  SELECT * INTO s FROM public.shadow_live_sessions x WHERE x.id = p_session_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'authorized' THEN
    RETURN false;
  END IF;
  v_kind := CASE WHEN v_reason IN ('kill_switch', 'flag_off', 'max_duration', 'bad_clock') THEN 'killed' ELSE 'ended' END;
  UPDATE public.shadow_live_sessions
     SET status = v_kind, ended_at = now(), end_reason = v_reason
   WHERE id = s.id;
  INSERT INTO public.shadow_live_events (user_id, session_id, kind, reason, jurisdiction)
  VALUES (s.user_id, s.id, v_kind, v_reason, s.jurisdiction);
  RETURN true;
END;
$$;

-- Ledger clean-up after an operator stops the kill switch: marks every still-open session killed. p_user_id NULL = all accounts.
CREATE OR REPLACE FUNCTION public.shadow_live_kill_sessions(p_user_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := COALESCE(left(NULLIF(btrim(p_reason), ''), 64), 'kill_switch');
  v_n integer;
BEGIN
  WITH k AS (
    UPDATE public.shadow_live_sessions s
       SET status = 'killed', ended_at = now(), end_reason = v_reason
     WHERE s.status = 'authorized' AND (p_user_id IS NULL OR s.user_id = p_user_id)
    RETURNING s.id, s.user_id, s.jurisdiction
  ), ev AS (
    INSERT INTO public.shadow_live_events (user_id, session_id, kind, reason, jurisdiction)
    SELECT k.user_id, k.id, 'killed', v_reason, k.jurisdiction FROM k
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM ev;
  RETURN COALESCE(v_n, 0);
END;
$$;

-- Retention: expired session rows, and audit events past their own (longer) window. Returns sessions deleted.
CREATE OR REPLACE FUNCTION public.shadow_live_purge_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.shadow_live_purge', 'on', true);
  DELETE FROM public.shadow_live_sessions WHERE purge_after < now() AND status <> 'authorized';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.shadow_live_events WHERE purge_after < now();
  PERFORM set_config('app.shadow_live_purge', '', true);
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.shadow_live_record(uuid, uuid, text, text, text, text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_live_end(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_live_kill_sessions(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shadow_live_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_live_record(uuid, uuid, text, text, text, text, text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_live_end(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_live_kill_sessions(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shadow_live_purge_expired() TO service_role;
