/*
  # Customer communication preference center (public /preferences/:token)

  ## What this adds (additive only — no existing table, column, policy or trigger is changed)
  - customer_communication_preferences : one row per customer. Channels (SMS / email / phone), optional
                                         categories (reminders / surveys / marketing), language, frequency,
                                         "unsubscribe from everything optional". Has its OWN random token,
                                         deliberately separate from customers.portal_token so a preference
                                         link in an email footer never grants access to jobs/quotes.
  - customer_preference_events         : append-only audit trail of every change (consent evidence).
  - get_customer_preferences(token)    : the ONLY anon read path. Returns masked contact info, never raw PII.
  - update_customer_preferences(...)   : the ONLY anon write path. Validated, audited, and — when BOTH phone
                                         channels are off — syncs into dnc_suppressions so the existing gates
                                         (sendCompliantSms, outbound dialer) honour it immediately.
  - ensure_customer_preference_token() : staff-only, returns the token to build a link for a customer.

  ## Design rules
  - Essential service messages (appointment confirmations, invoices/receipts, safety notices) are NOT
    controlled here — the page says so. "Unsubscribe from everything" switches off every OPTIONAL message.
  - Re-enabling SMS never deletes a dnc_suppressions row: a STOP reply must be honoured until the customer
    texts START. The page tells the customer when that is the case.
  - Tokens are random UUIDs; unknown tokens return no row / 'not_found' (no enumeration signal).

  ## Requires (already in your project)
  public.get_account_owner_id(), profiles, customers (name, phone, email), dnc_suppressions.
*/

-- =============================================================
-- Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.pref_normalize_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR regexp_replace(p, '\D', '', 'g') = '' THEN NULL
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 10 THEN '+1' || regexp_replace(p, '\D', '', 'g')
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 11 AND regexp_replace(p, '\D', '', 'g') LIKE '1%'
      THEN '+' || regexp_replace(p, '\D', '', 'g')
    WHEN left(p, 1) = '+' THEN p
    ELSE '+' || regexp_replace(p, '\D', '', 'g')
  END;
$$;

CREATE OR REPLACE FUNCTION public.pref_mask_email(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR position('@' IN p) < 2 THEN NULL
    ELSE left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2)
  END;
$$;

CREATE OR REPLACE FUNCTION public.pref_mask_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR length(regexp_replace(p, '\D', '', 'g')) < 4 THEN NULL
    ELSE '•••• ' || right(regexp_replace(p, '\D', '', 'g'), 4)
  END;
$$;

-- =============================================================
-- 1. Preferences
-- =============================================================
CREATE TABLE IF NOT EXISTS customer_communication_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  sms_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  voice_enabled boolean NOT NULL DEFAULT true,

  reminders_enabled boolean NOT NULL DEFAULT true,
  surveys_enabled boolean NOT NULL DEFAULT true,
  marketing_enabled boolean NOT NULL DEFAULT true,

  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es', 'fr', 'de', 'ar', 'fa')),
  frequency text NOT NULL DEFAULT 'all' CHECK (frequency IN ('all', 'weekly', 'monthly', 'essential')),

  unsubscribed_all boolean NOT NULL DEFAULT false,
  unsubscribed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_changed_by text NOT NULL DEFAULT 'system' CHECK (last_changed_by IN ('system', 'customer', 'staff')),

  UNIQUE (customer_id)
);

CREATE INDEX IF NOT EXISTS idx_ccp_user ON customer_communication_preferences (user_id);

ALTER TABLE customer_communication_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ccp_select" ON customer_communication_preferences;
CREATE POLICY "ccp_select" ON customer_communication_preferences FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Writes happen only through the SECURITY DEFINER functions below (and the service role).
REVOKE ALL ON customer_communication_preferences FROM anon, authenticated;
GRANT SELECT ON customer_communication_preferences TO authenticated;

-- =============================================================
-- 2. Audit trail (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS customer_preference_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('customer', 'staff', 'system')),
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpe_customer ON customer_preference_events (customer_id, created_at DESC);

ALTER TABLE customer_preference_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cpe_select" ON customer_preference_events;
CREATE POLICY "cpe_select" ON customer_preference_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE ALL ON customer_preference_events FROM anon, authenticated;
GRANT SELECT ON customer_preference_events TO authenticated;

-- =============================================================
-- 3. Staff: get (or lazily create) the preference token for a customer
-- =============================================================
CREATE OR REPLACE FUNCTION public.ensure_customer_preference_token(p_customer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_token uuid;
BEGIN
  IF v_owner IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p_customer_id AND c.user_id = v_owner) THEN
    RETURN NULL;
  END IF;

  INSERT INTO customer_communication_preferences (user_id, customer_id)
  VALUES (v_owner, p_customer_id)
  ON CONFLICT (customer_id) DO NOTHING;

  SELECT token INTO v_token FROM customer_communication_preferences WHERE customer_id = p_customer_id;
  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_customer_preference_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_customer_preference_token(uuid) TO authenticated;

-- =============================================================
-- 4. Public read (token-gated, masked)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_customer_preferences(p_token uuid)
RETURNS TABLE (
  business_name text,
  customer_first_name text,
  masked_phone text,
  masked_email text,
  sms_enabled boolean,
  email_enabled boolean,
  voice_enabled boolean,
  reminders_enabled boolean,
  surveys_enabled boolean,
  marketing_enabled boolean,
  language text,
  frequency text,
  unsubscribed_all boolean,
  sms_blocked_by_stop boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.company_name,
    split_part(btrim(c.name), ' ', 1),
    public.pref_mask_phone(c.phone),
    public.pref_mask_email(c.email),
    cp.sms_enabled, cp.email_enabled, cp.voice_enabled,
    cp.reminders_enabled, cp.surveys_enabled, cp.marketing_enabled,
    cp.language, cp.frequency, cp.unsubscribed_all,
    EXISTS (
      SELECT 1 FROM dnc_suppressions d
      WHERE d.user_id = cp.user_id AND d.phone_number = public.pref_normalize_phone(c.phone)
    )
  FROM customer_communication_preferences cp
  JOIN customers c ON c.id = cp.customer_id
  JOIN profiles p ON p.id = cp.user_id
  WHERE cp.token = p_token;
$$;

-- =============================================================
-- 5. Public write (token-gated, validated, audited, DNC-synced)
-- =============================================================
CREATE OR REPLACE FUNCTION public.update_customer_preferences(
  p_token uuid,
  p_sms boolean,
  p_email boolean,
  p_voice boolean,
  p_reminders boolean,
  p_surveys boolean,
  p_marketing boolean,
  p_language text,
  p_frequency text,
  p_unsubscribe_all boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cp customer_communication_preferences%ROWTYPE;
  c customers%ROWTYPE;
  n_sms boolean; n_email boolean; n_voice boolean;
  n_rem boolean; n_sur boolean; n_mkt boolean;
  n_unsub boolean;
  n_freq text;
  changes jsonb := '{}'::jsonb;
  phone_e164 text;
BEGIN
  IF p_token IS NULL THEN RETURN 'not_found'; END IF;

  SELECT * INTO cp FROM customer_communication_preferences WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF p_language IS NULL OR p_language NOT IN ('en', 'es', 'fr', 'de', 'ar', 'fa')
     OR p_frequency IS NULL OR p_frequency NOT IN ('all', 'weekly', 'monthly', 'essential')
     OR p_sms IS NULL OR p_email IS NULL OR p_voice IS NULL
     OR p_reminders IS NULL OR p_surveys IS NULL OR p_marketing IS NULL OR p_unsubscribe_all IS NULL THEN
    RETURN 'invalid';
  END IF;

  n_unsub := p_unsubscribe_all;
  IF n_unsub THEN
    -- Stop every OPTIONAL message on every channel. Essential service messages are not governed here.
    n_sms := false; n_email := false; n_voice := false;
    n_rem := false; n_sur := false; n_mkt := false;
    n_freq := 'essential';
  ELSE
    n_sms := p_sms; n_email := p_email; n_voice := p_voice;
    n_rem := p_reminders; n_sur := p_surveys; n_mkt := p_marketing;
    n_freq := p_frequency;
  END IF;

  IF cp.sms_enabled IS DISTINCT FROM n_sms THEN changes := changes || jsonb_build_object('sms_enabled', n_sms); END IF;
  IF cp.email_enabled IS DISTINCT FROM n_email THEN changes := changes || jsonb_build_object('email_enabled', n_email); END IF;
  IF cp.voice_enabled IS DISTINCT FROM n_voice THEN changes := changes || jsonb_build_object('voice_enabled', n_voice); END IF;
  IF cp.reminders_enabled IS DISTINCT FROM n_rem THEN changes := changes || jsonb_build_object('reminders_enabled', n_rem); END IF;
  IF cp.surveys_enabled IS DISTINCT FROM n_sur THEN changes := changes || jsonb_build_object('surveys_enabled', n_sur); END IF;
  IF cp.marketing_enabled IS DISTINCT FROM n_mkt THEN changes := changes || jsonb_build_object('marketing_enabled', n_mkt); END IF;
  IF cp.language IS DISTINCT FROM p_language THEN changes := changes || jsonb_build_object('language', p_language); END IF;
  IF cp.frequency IS DISTINCT FROM n_freq THEN changes := changes || jsonb_build_object('frequency', n_freq); END IF;
  IF cp.unsubscribed_all IS DISTINCT FROM n_unsub THEN changes := changes || jsonb_build_object('unsubscribed_all', n_unsub); END IF;

  IF changes = '{}'::jsonb THEN RETURN 'ok'; END IF;

  UPDATE customer_communication_preferences SET
    sms_enabled = n_sms, email_enabled = n_email, voice_enabled = n_voice,
    reminders_enabled = n_rem, surveys_enabled = n_sur, marketing_enabled = n_mkt,
    language = p_language, frequency = n_freq,
    unsubscribed_all = n_unsub,
    unsubscribed_at = CASE WHEN n_unsub THEN COALESCE(cp.unsubscribed_at, now()) ELSE NULL END,
    last_changed_by = 'customer',
    updated_at = now()
  WHERE id = cp.id;

  INSERT INTO customer_preference_events (user_id, customer_id, source, changes)
  VALUES (cp.user_id, cp.customer_id, 'customer', changes);

  -- dnc_suppressions is ONE list that blocks calls AND texts (by design, see sendSms.ts). So it is only
  -- written when the customer turns off BOTH phone channels (or unsubscribes from everything); a single
  -- channel opt-out is stored here and enforced by senders via _shared/compliance/preferenceCheck.ts.
  -- Opt-ins never remove a suppression: a STOP reply stays in force until the customer texts START.
  IF NOT n_sms AND NOT n_voice THEN
    SELECT * INTO c FROM customers WHERE id = cp.customer_id;
    phone_e164 := public.pref_normalize_phone(c.phone);
    IF phone_e164 IS NOT NULL THEN
      INSERT INTO dnc_suppressions (user_id, phone_number, reason)
      VALUES (cp.user_id, phone_e164, 'customer_opt_out')
      ON CONFLICT (user_id, phone_number) DO NOTHING;
    END IF;
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_preferences(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_customer_preferences(uuid, boolean, boolean, boolean, boolean, boolean, boolean, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_preferences(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_preferences(uuid, boolean, boolean, boolean, boolean, boolean, boolean, text, text, boolean) TO anon, authenticated;
