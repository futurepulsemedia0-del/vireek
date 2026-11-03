/*
  # Missed-Call Audit (public lead magnet)

  A home-service owner verifies their OWN business line (SMS/voice code to that same number), consents,
  and Vireek places up to 3 short, AI-identified test calls to it, then delivers a scored, private report.

  ## Tables (ALL are service_role-only: RLS enabled, deliberately NO policies for anon/authenticated)
  - audit_settings        single row: kill switch, per-feature switches, spend caps, retention
  - audit_blocklist       phone / email / email-domain / ip-hash blocklist
  - audit_rate_limit      atomic counters (hashed keys only)
  - audit_usage_daily     per-day counters + spend (cost guard)
  - audit_cooldown        one audit per number per 30 days (peppered hash only; survives deletion by design)
  - audit_verifications   OTP challenges (phone + email held only until expiry / purge)
  - audits                one row per verified, consented audit (private report token stored as sha256)
  - audit_calls           up to 3 test calls per audit (hard cap: UNIQUE(audit_id, slot), slot 1..3)
  - audit_consents        append-only consent ledger (who, when, IP, text version + hash)
  - audit_email_queue     report-ready email (transactional) + consented follow-ups
  - audit_email_suppressions  unsubscribes (email hash only, kept so we never re-mail)
  - audit_events          operational timeline (deleted with the audit)

  ## Security model
  - Nothing here is readable or writable by browsers. The public flow goes through the audit-api Edge Function
    (service role), which rate-limits, bot-checks and validates. Report access = possession of a random token
    whose sha256 is stored; the token itself is never stored.
  - SECURITY DEFINER functions pin search_path and are executable by service_role only (staff RPCs excepted:
    they check is_vireek_staff(auth.uid())).
  - Consent rows are append-only. Only audit_delete()/audit_purge_expired() may REDACT or purge them (session flag
    audit.maintenance), so one-click deletion and the 30-day retention can both be honoured.

  ## Retention (flag for counsel — see docs/compliance/missed-call-audit.md)
  - Audit PII (phone, email, results) is deleted at expires_at (30 days) or on the owner's one-click delete.
  - Consent rows are REDACTED (phone/email/IP/UA removed; hash, text version, timestamps kept) and then kept for
    audit_settings.consent_receipt_retention_days (default 30, per product spec). TCPA claims can reach back 4 years,
    so counsel may want a longer value for the redacted receipt. It is one UPDATE to change.

  ## Rollback
  See the commented block at the bottom of this file (run manually; it is destructive by nature).

  ## Scheduling (run once after deploying audit-runner; same pattern as speed-to-lead)
    select cron.schedule('audit-sweep', '* * * * *', $$
      select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/audit-runner?action=sweep',
        headers := jsonb_build_object('X-Cron-Secret', '<AUDIT_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb); $$);
    select cron.schedule('audit-housekeeping', '17 * * * *', $$
      select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/audit-runner?action=housekeeping',
        headers := jsonb_build_object('X-Cron-Secret', '<AUDIT_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb); $$);

  ## Requires (already in your project)
  public.is_vireek_staff(uuid)
*/

-- ============================================================
-- 1. Settings (single row; master switch defaults to OFF)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  otp_enabled boolean NOT NULL DEFAULT true,
  calls_enabled boolean NOT NULL DEFAULT true,
  followups_enabled boolean NOT NULL DEFAULT true,
  allowed_countries text[] NOT NULL DEFAULT '{US,CA}',
  daily_start_cap integer NOT NULL DEFAULT 60 CHECK (daily_start_cap BETWEEN 0 AND 10000),
  daily_budget_cents integer NOT NULL DEFAULT 3000 CHECK (daily_budget_cents >= 0),
  per_audit_cap_cents integer NOT NULL DEFAULT 150 CHECK (per_audit_cap_cents BETWEEN 0 AND 2000),
  cooldown_days integer NOT NULL DEFAULT 30 CHECK (cooldown_days BETWEEN 1 AND 365),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 90),
  consent_receipt_retention_days integer NOT NULL DEFAULT 30 CHECK (consent_receipt_retention_days BETWEEN 30 AND 1825),
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE audit_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. Abuse controls
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('phone_hash', 'email_hash', 'email_domain', 'ip_hash')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 3 AND 128),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
ALTER TABLE audit_blocklist ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_rate_limit (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE audit_rate_limit ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_usage_daily (
  day date PRIMARY KEY,
  starts integer NOT NULL DEFAULT 0,
  otp_sent integer NOT NULL DEFAULT 0,
  calls_placed integer NOT NULL DEFAULT 0,
  emails_sent integer NOT NULL DEFAULT 0,
  spend_cents integer NOT NULL DEFAULT 0
);
ALTER TABLE audit_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_cooldown (
  phone_hash text PRIMARY KEY CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  last_audit_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_cooldown_expiry ON audit_cooldown (expires_at);
ALTER TABLE audit_cooldown ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_email_suppressions (
  email_hash text PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL DEFAULT 'unsubscribe',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_email_suppressions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Verification challenges
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9]\d{2}[2-9]\d{6}$'),
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  email text NOT NULL CHECK (char_length(email) <= 254),
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  business_name text NOT NULL CHECK (char_length(btrim(business_name)) BETWEEN 2 AND 120),
  trade text NOT NULL CHECK (char_length(trade) BETWEEN 2 AND 40),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 3 AND 64),
  channel text NOT NULL CHECK (channel IN ('sms', 'voice')),
  ip_hash text NOT NULL,
  user_agent text,
  provider_ref text,
  otp_consent_text_version text NOT NULL,
  otp_consent_text_sha256 text NOT NULL CHECK (otp_consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  followup_opt_in boolean NOT NULL DEFAULT false,
  optional_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_audit_verifications_phone ON audit_verifications (phone_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_verifications_created ON audit_verifications (created_at);
ALTER TABLE audit_verifications ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Audits and their (max 3) test calls
-- ============================================================
CREATE TABLE IF NOT EXISTS audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  share_token_hash text UNIQUE CHECK (share_token_hash IS NULL OR share_token_hash ~ '^[0-9a-f]{64}$'),
  verification_id uuid,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9]\d{2}[2-9]\d{6}$'),
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  email text NOT NULL,
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  business_name text NOT NULL CHECK (char_length(btrim(business_name)) BETWEEN 2 AND 120),
  trade text NOT NULL,
  timezone text NOT NULL,
  business_hours jsonb,
  status text NOT NULL DEFAULT 'verified'
    CHECK (status IN ('verified', 'scheduled', 'running', 'complete', 'cancelled')),
  followup_opt_in boolean NOT NULL DEFAULT false,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  score jsonb,
  cost_cents_reserved integer NOT NULL DEFAULT 0 CHECK (cost_cents_reserved >= 0),
  cost_cents_actual integer NOT NULL DEFAULT 0 CHECK (cost_cents_actual >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_expiry ON audits (expires_at);
CREATE INDEX IF NOT EXISTS idx_audits_status ON audits (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audits_phone_hash ON audits (phone_hash);
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  -- HARD CAP: at most 3 calls per audit, and each slot is dialed at most once (no re-dial, ever).
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
  condition text NOT NULL CHECK (condition IN ('business_hours', 'lunch', 'after_hours')),
  scheduled_for timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'claimed', 'dialing', 'completed', 'failed', 'skipped', 'cancelled')),
  skip_reason text,
  vapi_call_id text UNIQUE,
  claimed_at timestamptz,
  placed_at timestamptz,
  ringing_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  ring_seconds integer CHECK (ring_seconds IS NULL OR ring_seconds BETWEEN 0 AND 600),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 3600),
  answer_kind text CHECK (answer_kind IS NULL OR answer_kind IN ('live_person', 'live_ai', 'ivr', 'voicemail', 'no_answer', 'busy', 'failed', 'unknown')),
  observations jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text CHECK (summary IS NULL OR char_length(summary) <= 500),
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_calls_slot_unique UNIQUE (audit_id, slot),
  CONSTRAINT audit_calls_condition_unique UNIQUE (audit_id, condition),
  CONSTRAINT audit_calls_window_order CHECK (window_end > scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_audit_calls_due ON audit_calls (scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_audit_calls_open ON audit_calls (status, claimed_at) WHERE status IN ('claimed', 'dialing');
ALTER TABLE audit_calls ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. Consent ledger (append-only proof; redactable only by the maintenance functions)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid,
  verification_id uuid,
  scope text NOT NULL CHECK (scope IN ('otp_message', 'ai_test_calls', 'email_followup')),
  granted boolean NOT NULL,
  phone_e164 text,
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  email text,
  text_version text NOT NULL,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  text_snapshot text NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  page_url text,
  basis text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_audit_consents_audit ON audit_consents (audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_consents_phone ON audit_consents (phone_hash, received_at DESC);

CREATE OR REPLACE FUNCTION public.audit_consents_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_setting('audit.maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'audit_consents is append-only' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_audit_consents_guard ON audit_consents;
CREATE TRIGGER trg_audit_consents_guard BEFORE UPDATE OR DELETE ON audit_consents
  FOR EACH ROW EXECUTE FUNCTION public.audit_consents_guard();
ALTER TABLE audit_consents ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 6. Email queue + operational timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  step smallint NOT NULL CHECK (step BETWEEN 0 AND 2),
  kind text NOT NULL CHECK (kind IN ('transactional', 'followup')),
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'skipped', 'failed')),
  skip_reason text,
  sent_at timestamptz,
  provider_id text,
  UNIQUE (audit_id, step)
);
CREATE INDEX IF NOT EXISTS idx_audit_email_due ON audit_email_queue (send_at) WHERE status = 'queued';
ALTER TABLE audit_email_queue ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  audit_id uuid NOT NULL,
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 2 AND 60),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_audit ON audit_events (audit_id, id);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Belt and braces: even if someone later adds a broad GRANT, browsers never get these tables.
REVOKE ALL ON audit_settings, audit_blocklist, audit_rate_limit, audit_usage_daily, audit_cooldown,
  audit_email_suppressions, audit_verifications, audits, audit_calls, audit_consents,
  audit_email_queue, audit_events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE audit_events_id_seq FROM anon, authenticated;

-- ============================================================
-- 7. Functions (service_role only unless stated)
-- ============================================================

-- Atomic per-key counter (hashed keys only). Returns true while under the limit.
CREATE OR REPLACE FUNCTION public.audit_consume_rate(p_key text, p_max integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO audit_rate_limit AS r (key, window_start, request_count) VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.request_count + 1 END
  RETURNING request_count INTO v_count;
  RETURN v_count <= p_max;
END $$;

-- Counters used by the cost guard and the ops summary.
CREATE OR REPLACE FUNCTION public.audit_bump(p_field text, p_n integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_field NOT IN ('starts', 'otp_sent', 'calls_placed', 'emails_sent') THEN
    RAISE EXCEPTION 'unknown counter %', p_field USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit_usage_daily (day) VALUES ((now() AT TIME ZONE 'utc')::date) ON CONFLICT (day) DO NOTHING;
  EXECUTE format('UPDATE audit_usage_daily SET %I = %I + $1 WHERE day = (now() AT TIME ZONE ''utc'')::date', p_field, p_field) USING p_n;
END $$;

-- Daily start cap: true if this start may proceed (and counts it).
CREATE OR REPLACE FUNCTION public.audit_try_start()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cap integer; v_day date := (now() AT TIME ZONE 'utc')::date; v_ok boolean;
BEGIN
  SELECT daily_start_cap INTO v_cap FROM audit_settings WHERE id;
  INSERT INTO audit_usage_daily (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
  UPDATE audit_usage_daily SET starts = starts + 1 WHERE day = v_day AND starts < v_cap RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $$;

-- Reserve spend against the daily budget (OTP costs have no audit yet). Returns true if reserved.
CREATE OR REPLACE FUNCTION public.audit_reserve_daily(p_cents integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cap integer; v_day date := (now() AT TIME ZONE 'utc')::date; v_ok boolean;
BEGIN
  IF p_cents < 0 THEN RAISE EXCEPTION 'negative spend' USING ERRCODE = '22023'; END IF;
  SELECT daily_budget_cents INTO v_cap FROM audit_settings WHERE id;
  INSERT INTO audit_usage_daily (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
  UPDATE audit_usage_daily SET spend_cents = spend_cents + p_cents
    WHERE day = v_day AND spend_cents + p_cents <= v_cap RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $$;

-- Reserve spend for one audit: per-audit cap first, then the daily budget. Returns 'ok' | 'audit_cap' | 'daily_budget'.
CREATE OR REPLACE FUNCTION public.audit_reserve_audit(p_audit_id uuid, p_cents integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cap integer; v_ok boolean;
BEGIN
  IF p_cents < 0 THEN RAISE EXCEPTION 'negative spend' USING ERRCODE = '22023'; END IF;
  SELECT per_audit_cap_cents INTO v_cap FROM audit_settings WHERE id;
  UPDATE audits SET cost_cents_reserved = cost_cents_reserved + p_cents
    WHERE id = p_audit_id AND cost_cents_reserved + p_cents <= v_cap RETURNING true INTO v_ok;
  IF NOT COALESCE(v_ok, false) THEN RETURN 'audit_cap'; END IF;
  IF NOT public.audit_reserve_daily(p_cents) THEN
    UPDATE audits SET cost_cents_reserved = cost_cents_reserved - p_cents WHERE id = p_audit_id;
    RETURN 'daily_budget';
  END IF;
  RETURN 'ok';
END $$;

-- One audit per number per cooldown window. Returns true if THIS call claimed the number.
CREATE OR REPLACE FUNCTION public.audit_claim_number(p_phone_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_days integer; v_ok boolean;
BEGIN
  SELECT cooldown_days INTO v_days FROM audit_settings WHERE id;
  INSERT INTO audit_cooldown AS c (phone_hash, last_audit_at, expires_at)
    VALUES (p_phone_hash, now(), now() + make_interval(days => v_days))
  ON CONFLICT (phone_hash) DO UPDATE SET last_audit_at = now(), expires_at = now() + make_interval(days => v_days)
    WHERE c.expires_at <= now()
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $$;

-- Hands the number back (used when OUR side failed and no test could run).
CREATE OR REPLACE FUNCTION public.audit_release_number(p_phone_hash text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM audit_cooldown WHERE phone_hash = p_phone_hash;
$$;

-- Claim due calls for dialing (SKIP LOCKED => two sweeps never claim the same call).
CREATE OR REPLACE FUNCTION public.audit_claim_due_calls(p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb;
BEGIN
  UPDATE audit_calls SET status = 'skipped', skip_reason = 'window_missed'
    WHERE status = 'scheduled' AND window_end <= now();

  WITH due AS (
    SELECT c.id FROM audit_calls c JOIN audits a ON a.id = c.audit_id
    WHERE c.status = 'scheduled' AND c.scheduled_for <= now() AND c.window_end > now()
      AND a.status IN ('scheduled', 'running') AND a.expires_at > now()
    ORDER BY c.scheduled_for LIMIT GREATEST(1, LEAST(p_limit, 20))
    FOR UPDATE OF c SKIP LOCKED
  ), upd AS (
    UPDATE audit_calls c SET status = 'claimed', claimed_at = now() FROM due WHERE c.id = due.id RETURNING c.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'call_id', u.id, 'audit_id', u.audit_id, 'slot', u.slot, 'condition', u.condition,
    'scheduled_for', u.scheduled_for, 'window_end', u.window_end,
    'phone_e164', a.phone_e164, 'timezone', a.timezone, 'business_name', a.business_name)), '[]'::jsonb)
  INTO v_rows FROM upd u JOIN audits a ON a.id = u.audit_id;

  UPDATE audits SET status = 'running' WHERE status = 'scheduled'
    AND id IN (SELECT (e->>'audit_id')::uuid FROM jsonb_array_elements(v_rows) e);
  RETURN v_rows;
END $$;

-- Calls whose outcome we cannot prove are parked, NEVER re-dialed.
CREATE OR REPLACE FUNCTION public.audit_release_stuck()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a integer; v_b integer;
BEGIN
  UPDATE audit_calls SET status = 'failed', skip_reason = 'dial_state_unknown', answer_kind = 'unknown', ended_at = now()
    WHERE status = 'claimed' AND claimed_at < now() - interval '3 minutes';
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE audit_calls SET status = 'failed', skip_reason = 'no_report', answer_kind = 'unknown', ended_at = now()
    WHERE status = 'dialing' AND placed_at < now() - interval '20 minutes';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;

-- Marks audits finished when no call is still pending; returns the ids that just completed.
CREATE OR REPLACE FUNCTION public.audit_complete_ready()
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[];
BEGIN
  UPDATE audit_calls SET status = 'skipped', skip_reason = 'audit_expired'
    WHERE status = 'scheduled' AND audit_id IN (SELECT id FROM audits WHERE expires_at <= now());
  WITH done AS (
    UPDATE audits a SET status = 'complete', completed_at = now()
    WHERE a.status IN ('scheduled', 'running')
      AND EXISTS (SELECT 1 FROM audit_calls c WHERE c.audit_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM audit_calls c WHERE c.audit_id = a.id AND c.status IN ('scheduled', 'claimed', 'dialing'))
    RETURNING a.id)
  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM done;
  RETURN v_ids;
END $$;

-- One-click deletion: removes the audit and everything hanging off it; REDACTS (not deletes) its consent receipts.
CREATE OR REPLACE FUNCTION public.audit_delete(p_audit_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_found boolean;
BEGIN
  PERFORM set_config('audit.maintenance', 'on', true);
  UPDATE audit_consents SET phone_e164 = NULL, email = NULL, ip_address = NULL, user_agent = NULL, page_url = NULL,
    evidence = '{}'::jsonb, redacted_at = COALESCE(redacted_at, now())
    WHERE audit_id = p_audit_id;
  DELETE FROM audit_events WHERE audit_id = p_audit_id;
  DELETE FROM audits WHERE id = p_audit_id RETURNING true INTO v_found;
  PERFORM set_config('audit.maintenance', 'off', true);
  RETURN COALESCE(v_found, false);
END $$;

-- Hourly housekeeping: retention for audits, verifications, counters, cooldowns and redacted receipts.
CREATE OR REPLACE FUNCTION public.audit_purge_expired()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_audits integer := 0; v_ver integer; v_rl integer; v_cd integer; v_rec integer; v_receipt integer;
BEGIN
  FOR v_id IN SELECT id FROM audits WHERE expires_at <= now() ORDER BY expires_at LIMIT 500 LOOP
    PERFORM public.audit_delete(v_id);
    v_audits := v_audits + 1;
  END LOOP;
  PERFORM set_config('audit.maintenance', 'on', true);
  -- Consents of audits that never got created (OTP only) or are already gone: redact once their verification expired.
  UPDATE audit_consents SET phone_e164 = NULL, email = NULL, ip_address = NULL, user_agent = NULL, page_url = NULL,
    evidence = '{}'::jsonb, redacted_at = now()
    WHERE redacted_at IS NULL AND received_at < now() - interval '1 day'
      AND (audit_id IS NULL OR NOT EXISTS (SELECT 1 FROM audits a WHERE a.id = audit_consents.audit_id));
  SELECT consent_receipt_retention_days INTO v_receipt FROM audit_settings WHERE id;
  DELETE FROM audit_consents WHERE redacted_at IS NOT NULL AND received_at < now() - make_interval(days => v_receipt);
  GET DIAGNOSTICS v_rec = ROW_COUNT;
  PERFORM set_config('audit.maintenance', 'off', true);
  DELETE FROM audit_verifications WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS v_ver = ROW_COUNT;
  DELETE FROM audit_rate_limit WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS v_rl = ROW_COUNT;
  DELETE FROM audit_cooldown WHERE expires_at < now();
  GET DIAGNOSTICS v_cd = ROW_COUNT;
  DELETE FROM audit_usage_daily WHERE day < (now() AT TIME ZONE 'utc')::date - 90;
  RETURN jsonb_build_object('audits_deleted', v_audits, 'verifications', v_ver, 'rate_rows', v_rl, 'cooldowns', v_cd, 'receipts_deleted', v_rec);
END $$;

-- Aggregate benchmarks. Returns NULL until at least 30 completed, non-low-confidence audits exist (k-anonymity floor).
-- No per-business or per-region data is ever returned; per-trade rows appear only when that trade alone has >= 30.
CREATE OR REPLACE FUNCTION public.audit_benchmark_public()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer; v_overall jsonb; v_trades jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM audits WHERE status = 'complete' AND score IS NOT NULL AND score->>'confidence' <> 'low';
  IF v_n < 30 THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('n', count(*),
    'total_p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY (score->>'total')::numeric),
    'total_p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY (score->>'total')::numeric),
    'total_p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY (score->>'total')::numeric))
  INTO v_overall FROM audits WHERE status = 'complete' AND score IS NOT NULL AND score->>'confidence' <> 'low';
  SELECT COALESCE(jsonb_object_agg(trade, j), '{}'::jsonb) INTO v_trades FROM (
    SELECT trade, jsonb_build_object('n', count(*), 'total_p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY (score->>'total')::numeric)) AS j
    FROM audits WHERE status = 'complete' AND score IS NOT NULL AND score->>'confidence' <> 'low'
    GROUP BY trade HAVING count(*) >= 30) t;
  RETURN jsonb_build_object('overall', v_overall, 'by_trade', v_trades, 'as_of', now());
END $$;

-- Staff-only ops view + kill switch. These two check the caller; they are the only functions browsers may reach.
CREATE OR REPLACE FUNCTION public.audit_ops_summary()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'settings', (SELECT to_jsonb(s) FROM audit_settings s WHERE id),
    'today', (SELECT to_jsonb(u) FROM audit_usage_daily u WHERE day = (now() AT TIME ZONE 'utc')::date),
    'last_7_days', (SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY day DESC), '[]'::jsonb) FROM audit_usage_daily u WHERE day >= (now() AT TIME ZONE 'utc')::date - 6),
    'audits_by_status', (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM audits GROUP BY status) x),
    'calls_by_status', (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM audit_calls WHERE created_at > now() - interval '7 days' GROUP BY status) x));
END $$;

CREATE OR REPLACE FUNCTION public.audit_staff_set_enabled(p_enabled boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  UPDATE audit_settings SET enabled = p_enabled, disabled_reason = CASE WHEN p_enabled THEN NULL ELSE left(p_reason, 200) END,
    updated_at = now() WHERE id;
END $$;

REVOKE ALL ON FUNCTION public.audit_consume_rate(text, integer, integer), public.audit_bump(text, integer),
  public.audit_try_start(), public.audit_reserve_daily(integer), public.audit_reserve_audit(uuid, integer),
  public.audit_claim_number(text), public.audit_release_number(text), public.audit_claim_due_calls(integer),
  public.audit_release_stuck(), public.audit_complete_ready(), public.audit_delete(uuid),
  public.audit_purge_expired(), public.audit_benchmark_public() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_consume_rate(text, integer, integer), public.audit_bump(text, integer),
  public.audit_try_start(), public.audit_reserve_daily(integer), public.audit_reserve_audit(uuid, integer),
  public.audit_claim_number(text), public.audit_release_number(text), public.audit_claim_due_calls(integer),
  public.audit_release_stuck(), public.audit_complete_ready(), public.audit_delete(uuid),
  public.audit_purge_expired(), public.audit_benchmark_public() TO service_role;

REVOKE ALL ON FUNCTION public.audit_ops_summary(), public.audit_staff_set_enabled(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_ops_summary(), public.audit_staff_set_enabled(boolean, text) TO authenticated;

/* ---- ROLLBACK (manual; destructive — deletes all audit data) ----
DROP FUNCTION IF EXISTS public.audit_staff_set_enabled(boolean, text), public.audit_ops_summary(),
  public.audit_benchmark_public(), public.audit_purge_expired(), public.audit_delete(uuid), public.audit_complete_ready(),
  public.audit_release_stuck(), public.audit_claim_due_calls(integer), public.audit_release_number(text),
  public.audit_claim_number(text), public.audit_reserve_audit(uuid, integer), public.audit_reserve_daily(integer),
  public.audit_try_start(), public.audit_bump(text, integer), public.audit_consume_rate(text, integer, integer),
  public.audit_consents_guard();
DROP TABLE IF EXISTS audit_events, audit_email_queue, audit_calls, audit_consents, audits, audit_verifications,
  audit_email_suppressions, audit_cooldown, audit_usage_daily, audit_rate_limit, audit_blocklist, audit_settings;
*/
