/*
  # Win Cards — owner-approved, privacy-safe, shareable outcome cards

  ## What this adds (purely additive — no existing table, column, policy or trigger is touched)
  - win_card_settings  : per-account switches (enable/disable, white-label, default expiry, hours/tz, large-job threshold)
  - win_cards          : one row per detected real event. `private_facts` NEVER leaves the owner's session;
                         `public_fields` is the ONLY thing the public endpoint can ever read, and it is
                         frozen at approval time (trigger-enforced).
  - win_card_reports   : abuse reports from the public page (hashed reporter, de-duplicated)
  - win_card_approve() : atomic, idempotent approval (row lock + daily quota + token issue)
  - win_card_report()  : atomic report + auto-suspend after 3 distinct reporters

  ## Security model
  - Owners / managers (public.identity_is_manager()) may SELECT their account's cards via RLS keyed to
    public.get_account_owner_id(). Authenticated clients have NO insert/update/delete privilege at all:
    every write goes through the `win-cards` edge function (service role), which re-checks permission,
    redacts server-side and writes the audit trail via public.log_audit_event().
  - The public page reads ONLY through the `win-card-public` edge function by an unguessable 256-bit token
    (43 chars base64url). Nothing is opened to the anon role.
  - Disabling the feature for an account (settings.enabled = false) or a staff compliance lock
    (staff_locked = true) makes every existing public link return 404 immediately (checked per request).

  ## Requires (verified in repo)
  public.get_account_owner_id(), public.identity_is_manager(), public.log_audit_event(), profiles.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy win-cards            (verify_jwt = true, default)
       supabase functions deploy win-card-public --no-verify-jwt
    3. supabase secrets set WIN_CARD_HASH_SALT=<random 32+ chars>   (SITE_URL must already be set)
    4. Deploy the Vercel edge route api/win-card.ts (see delivery notes).

  ## Rollback (safe: nothing else depends on these objects)
    DROP FUNCTION IF EXISTS public.win_card_report(uuid, text, text, text);
    DROP FUNCTION IF EXISTS public.win_card_approve(uuid, uuid, uuid, jsonb, text, integer, text, text, integer);
    DROP TABLE IF EXISTS win_card_reports, win_cards, win_card_settings CASCADE;
*/

-- =============================================================
-- 1. Settings (one row per account owner)
-- =============================================================
CREATE TABLE IF NOT EXISTS win_card_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  staff_locked boolean NOT NULL DEFAULT false,          -- compliance lock, set by Vireek staff (service role) only
  default_expiry_days smallint NOT NULL DEFAULT 30 CHECK (default_expiry_days BETWEEN 1 AND 90),
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  show_business_name boolean NOT NULL DEFAULT true,
  white_label boolean NOT NULL DEFAULT false,
  brand_name text CHECK (brand_name IS NULL OR char_length(btrim(brand_name)) BETWEEN 1 AND 60),
  accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$'),
  show_cta boolean NOT NULL DEFAULT true,
  business_hours_start smallint NOT NULL DEFAULT 8 CHECK (business_hours_start BETWEEN 0 AND 23),
  business_hours_end smallint NOT NULL DEFAULT 18 CHECK (business_hours_end BETWEEN 1 AND 24),
  timezone text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  large_job_threshold_cents integer NOT NULL DEFAULT 200000
    CHECK (large_job_threshold_cents BETWEEN 50000 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (business_hours_end > business_hours_start)
);

CREATE OR REPLACE FUNCTION public.win_card_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_win_card_settings_guard ON win_card_settings;
CREATE TRIGGER trg_win_card_settings_guard
  BEFORE INSERT OR UPDATE ON win_card_settings
  FOR EACH ROW EXECUTE FUNCTION public.win_card_settings_guard();

ALTER TABLE win_card_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "win_card_settings_select" ON win_card_settings;
CREATE POLICY "win_card_settings_select" ON win_card_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE ALL ON win_card_settings FROM anon, authenticated;
GRANT SELECT ON win_card_settings TO authenticated;

-- =============================================================
-- 2. Cards
-- =============================================================
CREATE TABLE IF NOT EXISTS win_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trigger_type text NOT NULL CHECK (trigger_type IN (
    'after_hours_booking', 'emergency_handled', 'recovered_large_job',
    'milestone_calls', 'speed_to_lead_record', 'five_star_ai_job'
  )),
  source_table text CHECK (source_table IS NULL OR source_table IN ('calls', 'revenue_recovery_events', 'speed_to_lead_requests', 'review_requests')),
  source_id uuid,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'revoked', 'dismissed', 'suspended')),
  -- Owner-only. Contains raw value/time and PII terms used to SCRUB captions. Never read by the public endpoint.
  private_facts jsonb NOT NULL CHECK (jsonb_typeof(private_facts) = 'object' AND pg_column_size(private_facts) <= 16384),
  -- Frozen at approval. The ONLY data the public endpoint can return.
  public_fields jsonb CHECK (public_fields IS NULL OR (jsonb_typeof(public_fields) = 'object' AND pg_column_size(public_fields) <= 8192)),
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  token text UNIQUE CHECK (token IS NULL OR token ~ '^[A-Za-z0-9_-]{43}$'),
  attribution_ref text UNIQUE CHECK (attribution_ref IS NULL OR attribution_ref ~ '^[A-Za-z0-9_-]{10,16}$'),
  approved_by uuid,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  suspended_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  cta_count integer NOT NULL DEFAULT 0,
  share_count integer NOT NULL DEFAULT 0,
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT win_cards_dedupe UNIQUE (user_id, dedupe_key),
  CONSTRAINT win_cards_approved_complete CHECK (
    status NOT IN ('approved', 'suspended')
    OR (token IS NOT NULL AND public_fields IS NOT NULL AND expires_at IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_win_cards_user_created ON win_cards(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_win_cards_user_status ON win_cards(user_id, status);
CREATE INDEX IF NOT EXISTS idx_win_cards_approved_recent ON win_cards(user_id, approved_at DESC) WHERE approved_at IS NOT NULL;

-- Integrity: once published, the public payload and the token can never be rewritten
-- (a link cannot be silently repointed at different content). Only status/expiry/counters move.
CREATE OR REPLACE FUNCTION public.win_cards_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.public_fields IS NOT NULL AND NEW.public_fields IS DISTINCT FROM OLD.public_fields THEN
      RAISE EXCEPTION 'win_cards: public_fields are immutable after approval' USING ERRCODE = '42501';
    END IF;
    IF OLD.token IS NOT NULL AND NEW.token IS DISTINCT FROM OLD.token THEN
      RAISE EXCEPTION 'win_cards: token is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key THEN
      RAISE EXCEPTION 'win_cards: ownership and dedupe key are immutable' USING ERRCODE = '42501';
    END IF;
    -- A revoked/dismissed card can never come back to life.
    IF OLD.status IN ('revoked', 'dismissed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'win_cards: % is a final state', OLD.status USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_win_cards_guard ON win_cards;
CREATE TRIGGER trg_win_cards_guard
  BEFORE INSERT OR UPDATE ON win_cards
  FOR EACH ROW EXECUTE FUNCTION public.win_cards_guard();

ALTER TABLE win_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "win_cards_select" ON win_cards;
CREATE POLICY "win_cards_select" ON win_cards FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE ALL ON win_cards FROM anon, authenticated;
GRANT SELECT ON win_cards TO authenticated;

-- =============================================================
-- 3. Abuse reports (service role only; hashed reporter, one per card)
-- =============================================================
CREATE TABLE IF NOT EXISTS win_card_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES win_cards(id) ON DELETE CASCADE,
  reporter_hash text NOT NULL CHECK (char_length(reporter_hash) BETWEEN 16 AND 128),
  reason text NOT NULL CHECK (reason IN ('contains_personal_info', 'inaccurate', 'spam_or_abuse', 'other')),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS idx_win_card_reports_card ON win_card_reports(card_id);
ALTER TABLE win_card_reports ENABLE ROW LEVEL SECURITY;   -- no policies: unreachable for anon/authenticated
REVOKE ALL ON win_card_reports FROM anon, authenticated;

-- =============================================================
-- 4. Atomic, idempotent approval
--    Called ONLY by the win-cards edge function after it has verified the caller, redacted the
--    payload and PII-scanned it. Retrying an approval returns the already-approved row unchanged.
-- =============================================================
CREATE OR REPLACE FUNCTION public.win_card_approve(
  p_card_id uuid,
  p_user_id uuid,
  p_actor uuid,
  p_public_fields jsonb,
  p_theme text,
  p_expiry_days integer,
  p_token text,
  p_ref text,
  p_daily_limit integer
) RETURNS win_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card win_cards;
  v_recent integer;
BEGIN
  SELECT * INTO v_card FROM win_cards WHERE id = p_card_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_card.status = 'approved' THEN
    RETURN v_card;                                   -- idempotent retry / double click
  END IF;
  IF v_card.status <> 'suggested' THEN
    RAISE EXCEPTION 'INVALID_STATE:%', v_card.status USING ERRCODE = 'P0001';
  END IF;
  IF p_expiry_days IS NULL OR p_expiry_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'INVALID_EXPIRY' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_recent FROM win_cards
   WHERE user_id = p_user_id AND approved_at > now() - interval '24 hours';
  IF v_recent >= p_daily_limit THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE win_cards SET
    status = 'approved',
    public_fields = p_public_fields,
    theme = p_theme,
    token = p_token,
    attribution_ref = p_ref,
    approved_by = p_actor,
    approved_at = now(),
    expires_at = now() + make_interval(days => p_expiry_days)
  WHERE id = p_card_id
  RETURNING * INTO v_card;
  RETURN v_card;
END $$;

REVOKE ALL ON FUNCTION public.win_card_approve(uuid, uuid, uuid, jsonb, text, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.win_card_approve(uuid, uuid, uuid, jsonb, text, integer, text, text, integer) TO service_role;

-- =============================================================
-- 5. Atomic abuse report (+ auto-suspend at 3 distinct reporters)
--    Returns: 'recorded' | 'duplicate' | 'suspended'
-- =============================================================
CREATE OR REPLACE FUNCTION public.win_card_report(
  p_card_id uuid, p_hash text, p_reason text, p_detail text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer;
  v_distinct integer;
  v_status text;
BEGIN
  INSERT INTO win_card_reports (card_id, reporter_hash, reason, detail)
  VALUES (p_card_id, p_hash, p_reason, left(p_detail, 500))
  ON CONFLICT (card_id, reporter_hash) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN 'duplicate'; END IF;

  SELECT count(*) INTO v_distinct FROM win_card_reports WHERE card_id = p_card_id;
  UPDATE win_cards SET report_count = v_distinct WHERE id = p_card_id;

  IF v_distinct >= 3 THEN
    UPDATE win_cards SET status = 'suspended', suspended_at = now()
     WHERE id = p_card_id AND status = 'approved'
     RETURNING status INTO v_status;
    IF v_status = 'suspended' THEN RETURN 'suspended'; END IF;
  END IF;
  RETURN 'recorded';
END $$;

REVOKE ALL ON FUNCTION public.win_card_report(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.win_card_report(uuid, text, text, text) TO service_role;
