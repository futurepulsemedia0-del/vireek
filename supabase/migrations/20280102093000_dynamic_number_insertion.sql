/*
  # Dynamic Number Insertion (DNI) — website call tracking by traffic source

  A small script on the customer's website swaps the phone number a visitor sees for a tracking number
  that depends on where the visitor came from (Google Ads, Google Business Profile, Facebook, email, ...).
  When that number is dialled, the existing Vapi webhook looks the dialled number up and stamps the call
  with the source, so "which marketing actually makes the phone ring" is answered with real data.

  Two ways to get a number (both can be used at once):
    - SOURCE number : one dedicated number per source (e.g. every Google Ads visitor sees the same number).
    - POOL  number  : a pool of numbers leased to one visitor session at a time, so the call can be matched
                      to that visitor's campaign, keyword and landing page (classic session-level DNI).
  Direct visitors always keep the normal number and never use up a pool number.

  Builds on (does not change): calls, profiles, team_members, public.get_account_owner_id(),
  and the existing calls.source_label / calls.source_channel columns, so the Lead Source breakdown
  shows these sources with no further change.

  ## Objects
  - dni_settings          : one row per account — public key, default number, allowed domains, lease length.
  - dni_numbers           : tracking numbers (kind 'source' or 'pool'); lease columns are server-managed.
  - dni_source_rules      : optional custom rules that map a visit to a source (checked before the built-ins).
  - dni_sessions          : one row per website visit that was given a number (no personal data stored).
  - dni_daily_stats       : counters for pool exhaustion and rate limiting.
  - calls.dni_session_id / dni_source_key / dni_attribution : snapshot written by the webhook.
  - dni_get_assignment    : anon      - the embed script calls this; returns the number to show.
  - dni_resolve_call      : service   - webhook calls this with the dialled number.
  - dni_performance       : manager   - sessions, calls and call rate per source + pool health.
  - dni_preview_classification : manager - "which source would this URL be?" tester.
  - dni_rotate_key        : manager   - new public key (old snippet stops working).
  - dni_purge_sessions    : service   - retention (scheduled nightly when pg_cron exists).

  ## Security notes
  - The public key ships in page source and is NOT a secret. Abuse is bounded by allowed domains,
    a per-account limit on new sessions per minute, bot user-agent filtering and strict validation.
  - Anonymous users get NO table access, only the SECURITY DEFINER RPC above.
  - Only the marketing signals (UTM values, click-id type/value, referrer host, landing PATH) are stored.
    The full URL, query string, IP address and user agent are never stored.
  - Lease columns, public_key and last_seen_* cannot be written from the browser (guard triggers).
*/

-- 1) Permission helper ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
      OR EXISTS (
        SELECT 1 FROM team_members m
        WHERE m.user_id = auth.uid()
          AND coalesce((m.permissions ->> 'can_edit_business_profile')::boolean, false)
      );
$$;
REVOKE ALL ON FUNCTION public.dni_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dni_can_manage() TO authenticated;

-- 2) Settings ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dni_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE DEFAULT ('dni_' || replace(gen_random_uuid()::text, '-', '')),
  enabled boolean NOT NULL DEFAULT false,
  default_number text,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  lease_minutes integer NOT NULL DEFAULT 30,
  last_seen_at timestamptz,
  last_seen_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dni_settings_number_check CHECK (default_number IS NULL OR default_number ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT dni_settings_lease_check CHECK (lease_minutes BETWEEN 5 AND 1440),
  CONSTRAINT dni_settings_domains_check CHECK (cardinality(allowed_domains) <= 20)
);

ALTER TABLE dni_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dni_settings_select" ON dni_settings;
CREATE POLICY "dni_settings_select" ON dni_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_settings_insert" ON dni_settings;
CREATE POLICY "dni_settings_insert" ON dni_settings FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_settings_update" ON dni_settings;
CREATE POLICY "dni_settings_update" ON dni_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

-- public_key / last_seen_* are server-managed. SECURITY DEFINER functions run as the table owner, so
-- only statements issued directly by the browser roles are held back.
CREATE OR REPLACE FUNCTION public.dni_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.account_owner_id := OLD.account_owner_id;
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.public_key := OLD.public_key;
      NEW.last_seen_at := OLD.last_seen_at;
      NEW.last_seen_host := OLD.last_seen_host;
    END IF;
  ELSIF current_user IN ('authenticated', 'anon') THEN
    NEW.last_seen_at := NULL;
    NEW.last_seen_host := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dni_settings_guard ON dni_settings;
CREATE TRIGGER trg_dni_settings_guard BEFORE INSERT OR UPDATE ON dni_settings
  FOR EACH ROW EXECUTE FUNCTION public.dni_settings_guard();

-- 3) Tracking numbers -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dni_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  vapi_phone_number_id text,
  label text NOT NULL DEFAULT '',
  kind text NOT NULL,
  source_key text,
  active boolean NOT NULL DEFAULT true,
  leased_to uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dni_numbers_phone_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT dni_numbers_kind_check CHECK (kind IN ('source', 'pool')),
  CONSTRAINT dni_numbers_source_check CHECK (
    (kind = 'source' AND source_key IS NOT NULL AND source_key ~ '^[a-z0-9_]{1,40}$')
    OR (kind = 'pool' AND source_key IS NULL)
  ),
  CONSTRAINT dni_numbers_label_check CHECK (char_length(label) <= 80),
  CONSTRAINT dni_numbers_vapi_check CHECK (vapi_phone_number_id IS NULL OR char_length(vapi_phone_number_id) <= 120)
);

-- A phone number can belong to exactly one account; a source can have one dedicated number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dni_numbers_phone ON dni_numbers(phone_e164);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dni_numbers_source ON dni_numbers(account_owner_id, source_key) WHERE kind = 'source';
CREATE INDEX IF NOT EXISTS idx_dni_numbers_pool ON dni_numbers(account_owner_id, lease_until) WHERE kind = 'pool' AND active;
CREATE INDEX IF NOT EXISTS idx_dni_numbers_vapi ON dni_numbers(account_owner_id, vapi_phone_number_id) WHERE vapi_phone_number_id IS NOT NULL;

ALTER TABLE dni_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dni_numbers_select" ON dni_numbers;
CREATE POLICY "dni_numbers_select" ON dni_numbers FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_numbers_insert" ON dni_numbers;
CREATE POLICY "dni_numbers_insert" ON dni_numbers FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_numbers_update" ON dni_numbers;
CREATE POLICY "dni_numbers_update" ON dni_numbers FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_numbers_delete" ON dni_numbers;
CREATE POLICY "dni_numbers_delete" ON dni_numbers FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

-- Number, kind and owner never change after creation (history stays truthful); leases are server-managed.
CREATE OR REPLACE FUNCTION public.dni_numbers_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.leased_to := NULL;
      NEW.lease_until := NULL;
    END IF;
    IF (SELECT count(*) FROM dni_numbers WHERE account_owner_id = NEW.account_owner_id) >= 100 THEN
      RAISE EXCEPTION 'DNI_LIMIT_NUMBERS';
    END IF;
  ELSE
    NEW.account_owner_id := OLD.account_owner_id;
    NEW.phone_e164 := OLD.phone_e164;
    NEW.kind := OLD.kind;
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.leased_to := OLD.leased_to;
      NEW.lease_until := OLD.lease_until;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dni_numbers_guard ON dni_numbers;
CREATE TRIGGER trg_dni_numbers_guard BEFORE INSERT OR UPDATE ON dni_numbers
  FOR EACH ROW EXECUTE FUNCTION public.dni_numbers_guard();

-- 4) Custom source rules ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dni_source_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100,
  match_field text NOT NULL,
  match_op text NOT NULL,
  match_value text,
  source_key text NOT NULL,
  source_label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dni_rules_field_check CHECK (match_field IN ('utm_source', 'utm_medium', 'utm_campaign', 'referrer_host', 'landing_path', 'click_id')),
  CONSTRAINT dni_rules_op_check CHECK (match_op IN ('equals', 'contains', 'present')),
  CONSTRAINT dni_rules_value_check CHECK (
    (match_op = 'present' AND match_value IS NULL)
    OR (match_op <> 'present' AND match_value IS NOT NULL AND char_length(btrim(match_value)) BETWEEN 1 AND 120)
  ),
  CONSTRAINT dni_rules_key_check CHECK (source_key ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT dni_rules_label_check CHECK (char_length(btrim(source_label)) BETWEEN 1 AND 60),
  CONSTRAINT dni_rules_priority_check CHECK (priority BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS idx_dni_rules_owner ON dni_source_rules(account_owner_id, priority);

ALTER TABLE dni_source_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dni_rules_select" ON dni_source_rules;
CREATE POLICY "dni_rules_select" ON dni_source_rules FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_rules_insert" ON dni_source_rules;
CREATE POLICY "dni_rules_insert" ON dni_source_rules FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_rules_update" ON dni_source_rules;
CREATE POLICY "dni_rules_update" ON dni_source_rules FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

DROP POLICY IF EXISTS "dni_rules_delete" ON dni_source_rules;
CREATE POLICY "dni_rules_delete" ON dni_source_rules FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

CREATE OR REPLACE FUNCTION public.dni_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM dni_source_rules WHERE account_owner_id = NEW.account_owner_id) >= 50 THEN
      RAISE EXCEPTION 'DNI_LIMIT_RULES';
    END IF;
  ELSE
    NEW.account_owner_id := OLD.account_owner_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dni_rules_guard ON dni_source_rules;
CREATE TRIGGER trg_dni_rules_guard BEFORE INSERT OR UPDATE ON dni_source_rules
  FOR EACH ROW EXECUTE FUNCTION public.dni_rules_guard();

-- 5) Sessions (written ONLY by the definer RPCs below) ----------------------------------------
CREATE TABLE IF NOT EXISTS dni_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  visitor_token text NOT NULL,
  source_key text NOT NULL,
  source_label text NOT NULL,
  medium text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  click_id_type text,
  click_id text,
  referrer_host text,
  landing_path text,
  page_host text,
  number_id uuid REFERENCES dni_numbers(id) ON DELETE SET NULL,
  phone_e164 text,
  assigned_at timestamptz,
  lease_until timestamptz,
  pageviews integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dni_sessions_token_check CHECK (visitor_token ~ '^[A-Za-z0-9_-]{16,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dni_sessions_token ON dni_sessions(account_owner_id, visitor_token);
CREATE INDEX IF NOT EXISTS idx_dni_sessions_recent ON dni_sessions(account_owner_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_dni_sessions_number ON dni_sessions(number_id, assigned_at DESC) WHERE number_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dni_sessions_purge ON dni_sessions(last_seen_at);

ALTER TABLE dni_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dni_sessions FROM anon;

DROP POLICY IF EXISTS "dni_sessions_select" ON dni_sessions;
CREATE POLICY "dni_sessions_select" ON dni_sessions FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());
-- No INSERT / UPDATE / DELETE policies on purpose.

-- 6) Daily counters ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dni_daily_stats (
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  pool_exhausted integer NOT NULL DEFAULT 0,
  rate_limited integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_owner_id, day)
);

ALTER TABLE dni_daily_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dni_daily_stats FROM anon;

DROP POLICY IF EXISTS "dni_stats_select" ON dni_daily_stats;
CREATE POLICY "dni_stats_select" ON dni_daily_stats FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dni_can_manage());

-- 7) Call snapshot columns --------------------------------------------------------------------
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dni_session_id uuid REFERENCES dni_sessions(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dni_source_key text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dni_attribution jsonb;
CREATE INDEX IF NOT EXISTS idx_calls_dni_source ON calls(user_id, dni_source_key, call_datetime DESC) WHERE dni_source_key IS NOT NULL;

-- 8) Small pure helpers -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_slug(p text, p_max integer DEFAULT 40)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(left(trim(both '_' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g')), p_max), '');
$$;

CREATE OR REPLACE FUNCTION public.dni_sig(p jsonb, p_key text, p_len integer DEFAULT 120)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(left(btrim(CASE WHEN jsonb_typeof(p -> p_key) = 'string' THEN p ->> p_key ELSE '' END), p_len), '');
$$;

CREATE OR REPLACE FUNCTION public.dni_url_host(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(coalesce(p, '')) ~ '^https?://[^/?#:@]+'
    THEN left(substring(lower(p) from '^https?://(?:[^/?#@]*@)?([^/?#:]+)'), 253)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.dni_builtin_label(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_key
    WHEN 'google_ads' THEN 'Google Ads'
    WHEN 'google_organic' THEN 'Google Search (organic)'
    WHEN 'google_business_profile' THEN 'Google Business Profile'
    WHEN 'bing_ads' THEN 'Microsoft Ads'
    WHEN 'bing_organic' THEN 'Bing (organic)'
    WHEN 'organic_search' THEN 'Other search engines'
    WHEN 'meta' THEN 'Facebook / Instagram'
    WHEN 'tiktok_ads' THEN 'TikTok Ads'
    WHEN 'email' THEN 'Email'
    WHEN 'sms' THEN 'Text message'
    WHEN 'yelp' THEN 'Yelp'
    WHEN 'nextdoor' THEN 'Nextdoor'
    WHEN 'referral' THEN 'Referral sites'
    WHEN 'direct' THEN 'Direct'
    WHEN 'website_unmatched' THEN 'Website (visit not matched)'
    ELSE initcap(replace(regexp_replace(coalesce(p_key, ''), '^utm_', ''), '_', ' '))
  END;
$$;

-- Host the request really came from: browser-set Origin header first, client-supplied host as fallback.
CREATE OR REPLACE FUNCTION public.dni_request_host(p_host text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_headers jsonb;
  v_origin text;
BEGIN
  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  v_origin := lower(coalesce(v_headers ->> 'origin', ''));
  IF v_origin ~ '^https?://[^/:]+' THEN
    RETURN left(regexp_replace(v_origin, '^https?://([^/:]+).*$', '\1'), 253);
  END IF;
  RETURN left(lower(nullif(btrim(coalesce(p_host, '')), '')), 253);
END;
$$;

CREATE OR REPLACE FUNCTION public.dni_host_allowed(p_allowed text[], p_host text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT cardinality(coalesce(p_allowed, '{}')) = 0
      OR EXISTS (
        SELECT 1 FROM unnest(p_allowed) d
        WHERE lower(coalesce(p_host, '')) = d OR lower(coalesce(p_host, '')) LIKE '%.' || d
      );
$$;

-- Internal: counters. Not callable by API roles.
CREATE OR REPLACE FUNCTION public.dni_bump(p_owner uuid, p_exhausted integer, p_limited integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO dni_daily_stats AS s (account_owner_id, day, pool_exhausted, rate_limited)
  VALUES (p_owner, (now() AT TIME ZONE 'utc')::date, p_exhausted, p_limited)
  ON CONFLICT (account_owner_id, day) DO UPDATE
    SET pool_exhausted = s.pool_exhausted + EXCLUDED.pool_exhausted,
        rate_limited = s.rate_limited + EXCLUDED.rate_limited;
$$;
REVOKE ALL ON FUNCTION public.dni_bump(uuid, integer, integer) FROM PUBLIC, anon, authenticated;

-- 9) Classification: visit signals -> source --------------------------------------------------
-- Order: custom rules (priority), paid click ids, Google Business Profile tags, paid UTM mediums,
-- email / SMS, other UTM sources, referrer, direct. Internal (same-site) referrers are ignored.
CREATE OR REPLACE FUNCTION public.dni_classify(p_owner uuid, p_signals jsonb, p_site_host text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r dni_source_rules;
  v_us text := lower(public.dni_sig(p_signals, 'utm_source', 80));
  v_um text := lower(public.dni_sig(p_signals, 'utm_medium', 80));
  v_uc text := lower(public.dni_sig(p_signals, 'utm_campaign', 120));
  v_ut text := lower(public.dni_sig(p_signals, 'utm_content', 120));
  v_cid text := lower(public.dni_sig(p_signals, 'click_id_type', 20));
  v_ref text := public.dni_url_host(public.dni_sig(p_signals, 'referrer', 300));
  v_path text := lower(public.dni_sig(p_signals, 'landing_path', 200));
  v_site text := lower(nullif(btrim(coalesce(p_site_host, '')), ''));
  v_gbp constant text := '(^|[^a-z])(gbp|gmb)([^a-z]|$)|google[ _-]?(my[ _-]?)?business';
  v_val text;
  v_hit boolean;
  v_key text;
  v_medium text;
BEGIN
  IF v_ref IS NOT NULL AND v_site IS NOT NULL
     AND (v_ref = v_site OR v_ref LIKE '%.' || v_site OR v_site LIKE '%.' || v_ref) THEN
    v_ref := NULL;
  END IF;

  FOR r IN
    SELECT * FROM dni_source_rules WHERE account_owner_id = p_owner AND enabled ORDER BY priority, created_at
  LOOP
    v_val := CASE r.match_field
      WHEN 'utm_source' THEN v_us
      WHEN 'utm_medium' THEN v_um
      WHEN 'utm_campaign' THEN v_uc
      WHEN 'referrer_host' THEN v_ref
      WHEN 'landing_path' THEN v_path
      WHEN 'click_id' THEN v_cid
    END;
    v_hit := CASE r.match_op
      WHEN 'present' THEN v_val IS NOT NULL
      WHEN 'equals' THEN v_val = lower(btrim(r.match_value))
      WHEN 'contains' THEN v_val IS NOT NULL AND position(lower(btrim(r.match_value)) IN v_val) > 0
      ELSE false
    END;
    IF coalesce(v_hit, false) THEN
      RETURN jsonb_build_object('source_key', r.source_key, 'source_label', btrim(r.source_label), 'medium', 'custom');
    END IF;
  END LOOP;

  IF v_cid IN ('gclid', 'gbraid', 'wbraid') THEN
    v_key := 'google_ads'; v_medium := 'paid';
  ELSIF v_cid = 'msclkid' THEN
    v_key := 'bing_ads'; v_medium := 'paid';
  ELSIF v_cid = 'ttclid' THEN
    v_key := 'tiktok_ads'; v_medium := 'paid';
  ELSIF v_cid = 'fbclid' THEN
    v_key := 'meta'; v_medium := CASE WHEN coalesce(v_um, '') ~ '(cpc|ppc|paid)' THEN 'paid' ELSE 'social' END;
  ELSIF coalesce(v_us, '') ~ v_gbp OR coalesce(v_uc, '') ~ v_gbp OR coalesce(v_ut, '') ~ v_gbp THEN
    v_key := 'google_business_profile'; v_medium := 'organic';
  ELSIF coalesce(v_um, '') ~ '^(cpc|ppc|paid|paidsearch|paid[ _-]?search|paid[ _-]?social|display|cpm)$' THEN
    v_medium := 'paid';
    v_key := CASE
      WHEN coalesce(v_us, '') ~ 'google' THEN 'google_ads'
      WHEN coalesce(v_us, '') ~ '(bing|microsoft)' THEN 'bing_ads'
      WHEN coalesce(v_us, '') ~ '(facebook|instagram|meta|^fb$|^ig$)' THEN 'meta'
      WHEN coalesce(v_us, '') ~ 'tiktok' THEN 'tiktok_ads'
      WHEN v_us IS NOT NULL THEN 'utm_' || coalesce(public.dni_slug(v_us, 30), 'other')
      ELSE 'utm_paid'
    END;
  ELSIF coalesce(v_um, '') ~ '^(e-?mail|newsletter)$' OR coalesce(v_us, '') ~ '^(e-?mail|newsletter)$' THEN
    v_key := 'email'; v_medium := 'email';
  ELSIF coalesce(v_um, '') IN ('sms', 'text') OR coalesce(v_us, '') IN ('sms', 'text') THEN
    v_key := 'sms'; v_medium := 'sms';
  ELSIF v_us IS NOT NULL THEN
    IF v_us ~ '^(facebook|fb|instagram|ig|meta)$' THEN
      v_key := 'meta'; v_medium := 'social';
    ELSIF v_us = 'google' AND coalesce(v_um, 'organic') = 'organic' THEN
      v_key := 'google_organic'; v_medium := 'organic';
    ELSIF v_us = 'bing' AND coalesce(v_um, 'organic') = 'organic' THEN
      v_key := 'bing_organic'; v_medium := 'organic';
    ELSIF v_us IN ('yelp', 'nextdoor') THEN
      v_key := v_us; v_medium := 'referral';
    ELSE
      v_key := 'utm_' || coalesce(public.dni_slug(v_us, 30), 'other'); v_medium := 'other';
    END IF;
  ELSIF v_ref IS NOT NULL THEN
    IF v_ref ~ '(^|\.)google\.[a-z.]{2,}$' THEN
      v_key := 'google_organic'; v_medium := 'organic';
    ELSIF v_ref ~ '(^|\.)bing\.com$' THEN
      v_key := 'bing_organic'; v_medium := 'organic';
    ELSIF v_ref ~ '(^|\.)(yahoo|duckduckgo|ecosia|brave|baidu|yandex|startpage|ask)\.[a-z.]{2,}$' THEN
      v_key := 'organic_search'; v_medium := 'organic';
    ELSIF v_ref ~ '(^|\.)(facebook|instagram|fb)\.(com|me)$' THEN
      v_key := 'meta'; v_medium := 'social';
    ELSIF v_ref ~ '(^|\.)yelp\.com$' THEN
      v_key := 'yelp'; v_medium := 'referral';
    ELSIF v_ref ~ '(^|\.)nextdoor\.com$' THEN
      v_key := 'nextdoor'; v_medium := 'social';
    ELSE
      v_key := 'referral'; v_medium := 'referral';
    END IF;
  ELSE
    v_key := 'direct'; v_medium := 'direct';
  END IF;

  RETURN jsonb_build_object('source_key', v_key, 'source_label', public.dni_builtin_label(v_key), 'medium', v_medium);
END;
$$;
REVOKE ALL ON FUNCTION public.dni_classify(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;

-- 10) Number assignment (internal) ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_assign_number(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sess dni_sessions;
  st dni_settings;
  n dni_numbers;
  v_lease interval;
  v_secs integer;
BEGIN
  SELECT * INTO sess FROM dni_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('mode', 'default'); END IF;
  SELECT * INTO st FROM dni_settings WHERE account_owner_id = sess.account_owner_id;
  v_lease := make_interval(mins => coalesce(st.lease_minutes, 30));
  v_secs := coalesce(st.lease_minutes, 30) * 60;

  -- 1) A number dedicated to this source: every visitor from that source sees the same number.
  SELECT * INTO n FROM dni_numbers
   WHERE account_owner_id = sess.account_owner_id AND kind = 'source' AND active AND source_key = sess.source_key
   LIMIT 1;
  IF FOUND THEN
    UPDATE dni_sessions
       SET assigned_at = CASE WHEN number_id IS NOT DISTINCT FROM n.id THEN assigned_at ELSE now() END,
           number_id = n.id,
           phone_e164 = n.phone_e164,
           lease_until = now() + v_lease
     WHERE id = sess.id;
    RETURN jsonb_build_object('mode', 'source', 'phone', n.phone_e164, 'lease_seconds', v_secs);
  END IF;

  -- 2) Direct visitors keep the normal number and never use up a pool number.
  IF sess.source_key = 'direct' THEN
    RETURN jsonb_build_object('mode', 'default');
  END IF;

  -- 3) Keep the pool number this visit already holds (extend its lease).
  IF sess.number_id IS NOT NULL THEN
    SELECT * INTO n FROM dni_numbers
     WHERE id = sess.number_id AND kind = 'pool' AND active AND leased_to = sess.id AND lease_until > now()
     FOR UPDATE;
    IF FOUND THEN
      UPDATE dni_numbers SET lease_until = now() + v_lease WHERE id = n.id;
      UPDATE dni_sessions SET lease_until = now() + v_lease WHERE id = sess.id;
      RETURN jsonb_build_object('mode', 'pool', 'phone', n.phone_e164, 'lease_seconds', v_secs);
    END IF;
  END IF;

  -- 4) Lease the pool number that has been free the longest (rest time before re-use).
  SELECT * INTO n FROM dni_numbers
   WHERE account_owner_id = sess.account_owner_id AND kind = 'pool' AND active
     AND (lease_until IS NULL OR lease_until <= now())
   ORDER BY lease_until ASC NULLS FIRST, created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE dni_numbers SET leased_to = sess.id, lease_until = now() + v_lease WHERE id = n.id;
    UPDATE dni_sessions
       SET number_id = n.id, phone_e164 = n.phone_e164, assigned_at = now(), lease_until = now() + v_lease
     WHERE id = sess.id;
    RETURN jsonb_build_object('mode', 'pool', 'phone', n.phone_e164, 'lease_seconds', v_secs);
  END IF;

  -- 5) No free number: show the normal one and count it so the dashboard can warn.
  UPDATE dni_sessions SET number_id = NULL, phone_e164 = NULL, lease_until = NULL WHERE id = sess.id;
  PERFORM public.dni_bump(sess.account_owner_id, 1, 0);
  RETURN jsonb_build_object('mode', 'default', 'exhausted', true);
END;
$$;
REVOKE ALL ON FUNCTION public.dni_assign_number(uuid) FROM PUBLIC, anon, authenticated;

-- 11) Public RPC used by the embed script (anon) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_get_assignment(p_key text, p_host text, p_token text, p_signals jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  st dni_settings;
  sess dni_sessions;
  v_host text := public.dni_request_host(p_host);
  v_sig jsonb := CASE WHEN jsonb_typeof(p_signals) = 'object' THEN p_signals ELSE '{}'::jsonb END;
  v_headers jsonb;
  v_ua text;
  v_class jsonb;
  v_assign jsonb;
  v_recent integer;
BEGIN
  IF p_key IS NULL OR p_key !~ '^dni_[0-9a-f]{32}$' OR p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  SELECT * INTO st FROM dni_settings WHERE public_key = p_key AND enabled;
  IF NOT FOUND OR NOT public.dni_host_allowed(st.allowed_domains, v_host) THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  -- Install heartbeat, at most once a minute (the WHERE is re-checked after a lock wait).
  UPDATE dni_settings
     SET last_seen_at = now(), last_seen_host = v_host
   WHERE account_owner_id = st.account_owner_id
     AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute');

  -- Crawlers and monitors see the normal number and never create a session.
  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  v_ua := lower(coalesce(v_headers ->> 'user-agent', ''));
  IF v_ua ~ '(bot|crawl|spider|slurp|headless|lighthouse|pagespeed|mediapartners|inspectiontool|facebookexternalhit|monitor|curl/|wget/|python-requests)' THEN
    RETURN jsonb_build_object('ok', true, 'default', st.default_number, 'number', st.default_number,
                              'mode', 'default', 'lease_seconds', st.lease_minutes * 60);
  END IF;

  SELECT * INTO sess FROM dni_sessions WHERE account_owner_id = st.account_owner_id AND visitor_token = p_token;
  IF FOUND THEN
    UPDATE dni_sessions SET last_seen_at = now(), pageviews = pageviews + 1 WHERE id = sess.id;
  ELSE
    SELECT count(*) INTO v_recent FROM dni_sessions
     WHERE account_owner_id = st.account_owner_id AND first_seen_at > now() - interval '1 minute';
    IF v_recent >= 120 THEN
      PERFORM public.dni_bump(st.account_owner_id, 0, 1);
      RETURN jsonb_build_object('ok', true, 'default', st.default_number, 'number', st.default_number,
                                'mode', 'default', 'lease_seconds', st.lease_minutes * 60);
    END IF;

    v_class := public.dni_classify(st.account_owner_id, v_sig, v_host);
    INSERT INTO dni_sessions (
      account_owner_id, visitor_token, source_key, source_label, medium,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      click_id_type, click_id, referrer_host, landing_path, page_host
    ) VALUES (
      st.account_owner_id, p_token, v_class ->> 'source_key', v_class ->> 'source_label', v_class ->> 'medium',
      public.dni_sig(v_sig, 'utm_source', 80), public.dni_sig(v_sig, 'utm_medium', 80),
      public.dni_sig(v_sig, 'utm_campaign', 120), public.dni_sig(v_sig, 'utm_term', 120),
      public.dni_sig(v_sig, 'utm_content', 120),
      lower(public.dni_sig(v_sig, 'click_id_type', 20)), public.dni_sig(v_sig, 'click_id', 120),
      public.dni_url_host(public.dni_sig(v_sig, 'referrer', 300)),
      public.dni_sig(v_sig, 'landing_path', 200), v_host
    )
    ON CONFLICT (account_owner_id, visitor_token)
      DO UPDATE SET last_seen_at = now(), pageviews = dni_sessions.pageviews + 1
    RETURNING * INTO sess;
  END IF;

  v_assign := public.dni_assign_number(sess.id);

  RETURN jsonb_build_object(
    'ok', true,
    'default', st.default_number,
    'number', coalesce(v_assign ->> 'phone', st.default_number),
    'mode', coalesce(v_assign ->> 'mode', 'default'),
    'source_key', sess.source_key,
    'source_label', sess.source_label,
    'lease_seconds', coalesce((v_assign ->> 'lease_seconds')::integer, st.lease_minutes * 60),
    'exhausted', coalesce((v_assign ->> 'exhausted')::boolean, false)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dni_get_assignment(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dni_get_assignment(text, text, text, jsonb) TO anon, authenticated;

-- 12) Webhook lookup (service role only) ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_resolve_call(
  p_owner uuid, p_dialed text, p_vapi_phone_number_id text, p_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text := CASE WHEN nullif(btrim(coalesce(p_dialed, '')), '') IS NULL THEN NULL
                       ELSE '+' || regexp_replace(p_dialed, '\D', '', 'g') END;
  v_at timestamptz := coalesce(p_at, now());
  n dni_numbers;
  sess dni_sessions;
  v_label text;
BEGIN
  IF p_owner IS NULL OR (v_phone IS NULL AND p_vapi_phone_number_id IS NULL) THEN RETURN NULL; END IF;

  SELECT * INTO n FROM dni_numbers
   WHERE account_owner_id = p_owner
     AND ((v_phone IS NOT NULL AND phone_e164 = v_phone)
          OR (p_vapi_phone_number_id IS NOT NULL AND vapi_phone_number_id = p_vapi_phone_number_id))
   ORDER BY (phone_e164 = v_phone) DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF n.kind = 'source' THEN
    v_label := coalesce(
      (SELECT btrim(r.source_label) FROM dni_source_rules r
        WHERE r.account_owner_id = p_owner AND r.source_key = n.source_key ORDER BY r.priority LIMIT 1),
      public.dni_builtin_label(n.source_key)
    );
    RETURN jsonb_build_object('mode', 'source', 'source_key', n.source_key, 'source_label', v_label, 'number_id', n.id);
  END IF;

  -- Pool number: the visit that held it when the call started (2 min clock-skew allowance,
  -- 30 min grace after its lease ended, because people copy a number and dial later).
  SELECT * INTO sess FROM dni_sessions
   WHERE account_owner_id = p_owner AND number_id = n.id
     AND assigned_at <= v_at + interval '2 minutes'
     AND coalesce(lease_until, assigned_at) + interval '30 minutes' >= v_at
   ORDER BY assigned_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('mode', 'pool', 'source_key', 'website_unmatched',
                              'source_label', public.dni_builtin_label('website_unmatched'), 'number_id', n.id);
  END IF;

  RETURN jsonb_build_object(
    'mode', 'pool',
    'source_key', sess.source_key,
    'source_label', sess.source_label,
    'number_id', n.id,
    'session_id', sess.id,
    'attribution', jsonb_strip_nulls(jsonb_build_object(
      'medium', sess.medium, 'utm_source', sess.utm_source, 'utm_medium', sess.utm_medium,
      'utm_campaign', sess.utm_campaign, 'utm_term', sess.utm_term, 'utm_content', sess.utm_content,
      'click_id_type', sess.click_id_type, 'referrer_host', sess.referrer_host, 'landing_path', sess.landing_path
    ))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dni_resolve_call(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dni_resolve_call(uuid, text, text, timestamptz) TO service_role;

-- 13) Dashboard RPCs (managers) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dni_performance(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz;
  v_sources jsonb;
  v_pool jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.dni_can_manage() THEN RAISE EXCEPTION 'DNI_FORBIDDEN'; END IF;
  v_since := now() - make_interval(days => v_days);

  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.calls DESC, x.sessions DESC, x.source_key), '[]'::jsonb)
    INTO v_sources
  FROM (
    SELECT coalesce(s.source_key, c.source_key) AS source_key,
           coalesce(s.source_label, c.source_label, public.dni_builtin_label(coalesce(s.source_key, c.source_key))) AS source_label,
           coalesce(s.sessions, 0)::integer AS sessions,
           coalesce(c.calls, 0)::integer AS calls,
           c.last_call_at
    FROM (
      SELECT source_key, max(source_label) AS source_label, count(*) AS sessions
        FROM dni_sessions
       WHERE account_owner_id = v_owner AND first_seen_at >= v_since
       GROUP BY source_key
    ) s
    FULL OUTER JOIN (
      SELECT dni_source_key AS source_key, max(source_label) AS source_label,
             count(*) AS calls, max(call_datetime) AS last_call_at
        FROM calls
       WHERE user_id = v_owner AND dni_source_key IS NOT NULL AND call_datetime >= v_since
       GROUP BY dni_source_key
    ) c ON c.source_key = s.source_key
  ) x;

  SELECT jsonb_build_object(
           'pool_total', count(*) FILTER (WHERE kind = 'pool' AND active),
           'pool_leased', count(*) FILTER (WHERE kind = 'pool' AND active AND lease_until > now()),
           'dedicated', count(*) FILTER (WHERE kind = 'source' AND active)
         )
    INTO v_pool
    FROM dni_numbers WHERE account_owner_id = v_owner;

  RETURN jsonb_build_object(
    'days', v_days,
    'sources', v_sources,
    'pool', v_pool,
    'exhausted_events', coalesce((SELECT sum(pool_exhausted) FROM dni_daily_stats
                                   WHERE account_owner_id = v_owner AND day >= (v_since AT TIME ZONE 'utc')::date), 0),
    'rate_limited_events', coalesce((SELECT sum(rate_limited) FROM dni_daily_stats
                                      WHERE account_owner_id = v_owner AND day >= (v_since AT TIME ZONE 'utc')::date), 0)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dni_performance(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dni_performance(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.dni_preview_classification(p_signals jsonb, p_site_host text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_sig jsonb := CASE WHEN jsonb_typeof(p_signals) = 'object' THEN p_signals ELSE '{}'::jsonb END;
  v_class jsonb;
  v_phone text;
  v_mode text := 'default';
BEGIN
  IF v_owner IS NULL OR NOT public.dni_can_manage() THEN RAISE EXCEPTION 'DNI_FORBIDDEN'; END IF;
  v_class := public.dni_classify(v_owner, v_sig, lower(nullif(btrim(coalesce(p_site_host, '')), '')));

  SELECT n.phone_e164 INTO v_phone FROM dni_numbers n
   WHERE n.account_owner_id = v_owner AND n.kind = 'source' AND n.active AND n.source_key = v_class ->> 'source_key'
   LIMIT 1;
  IF v_phone IS NOT NULL THEN
    v_mode := 'source';
  ELSIF v_class ->> 'source_key' <> 'direct'
        AND EXISTS (SELECT 1 FROM dni_numbers n WHERE n.account_owner_id = v_owner AND n.kind = 'pool' AND n.active) THEN
    v_mode := 'pool';
  END IF;

  RETURN v_class || jsonb_build_object('number_mode', v_mode, 'dedicated_number', v_phone);
END;
$$;
REVOKE ALL ON FUNCTION public.dni_preview_classification(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dni_preview_classification(jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.dni_rotate_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text := 'dni_' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF v_owner IS NULL OR NOT public.dni_can_manage() THEN RAISE EXCEPTION 'DNI_FORBIDDEN'; END IF;
  UPDATE dni_settings SET public_key = v_key WHERE account_owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'DNI_NOT_CONFIGURED'; END IF;
  RETURN v_key;
END;
$$;
REVOKE ALL ON FUNCTION public.dni_rotate_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dni_rotate_key() TO authenticated;

-- 14) Retention -------------------------------------------------------------------------------
-- Calls keep their own snapshot (source, UTM values, landing path), so old visit rows can go.
CREATE OR REPLACE FUNCTION public.dni_purge_sessions(p_older_than interval DEFAULT interval '90 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM dni_sessions
   WHERE last_seen_at < now() - p_older_than
     AND (lease_until IS NULL OR lease_until < now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM dni_daily_stats WHERE day < ((now() - p_older_than) AT TIME ZONE 'utc')::date;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.dni_purge_sessions(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dni_purge_sessions(interval) TO service_role;

-- Nightly purge when pg_cron is installed; silently skipped otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('dni-purge-sessions', '40 3 * * *', 'SELECT public.dni_purge_sessions(interval ''90 days'')');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'dni purge schedule skipped: %', SQLERRM;
END;
$$;
