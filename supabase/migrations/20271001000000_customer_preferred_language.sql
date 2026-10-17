/*
  # Customer language preference

  Stores the language a CUSTOMER wants to be served in, so the AI voice agent,
  SMS, email, invoices and the customer portal can all speak it.

  ## customers
  - preferred_language            text, one of the 9 supported codes (NULL = not known yet)
  - preferred_language_source     'auto_detected' | 'staff' | 'customer'  (NULL <=> language NULL)
  - preferred_language_updated_at timestamptz

  Rules (enforced here, not only in app code):
  - Automatic detection (first call / inbound message) may only FILL an empty
    language. It never overwrites a stored one, so a guess can never undo a
    choice made by staff or by the customer.
  - A human change (staff edit, or the customer in the portal) always wins.
  - Clearing the language also clears the source.
  - A new customer created for a phone number that already called inherits
    the language detected on that caller's most recent call.

  ## calls
  - detected_language_code        ISO code detected from the caller's words.
    NOTE: the older free-text calls.detected_language ('Spanish', used by
    emergency routing) is deliberately left untouched.
  - detected_language_confidence  numeric(3,2)

  ## Functions
  - phone_match_key(text)                              last 10 digits, for matching "+1 (555)…" with "5551234567"
  - find_customer_language(...)                        service_role: customer row, else last call
  - record_detected_customer_language(...)             service_role: "fill only if empty"
  - get_portal_language(token) / set_portal_language   anon: portal visitor reads / changes own language
  - get_invoice_language(token)                        anon: language for the public invoice page

  Purely additive; no existing data, policy or function is modified.
*/

-- =============================================================
-- Columns
-- =============================================================
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS preferred_language text,
  ADD COLUMN IF NOT EXISTS preferred_language_source text,
  ADD COLUMN IF NOT EXISTS preferred_language_updated_at timestamptz;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_preferred_language_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_preferred_language_check
  CHECK (preferred_language IS NULL OR preferred_language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_preferred_language_source_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_preferred_language_source_check
  CHECK (preferred_language_source IS NULL OR preferred_language_source IN ('auto_detected', 'staff', 'customer'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_preferred_language_pair_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_preferred_language_pair_check
  CHECK ((preferred_language IS NULL) = (preferred_language_source IS NULL));

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS detected_language_code text,
  ADD COLUMN IF NOT EXISTS detected_language_confidence numeric(3, 2);

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_detected_language_code_check;
ALTER TABLE calls
  ADD CONSTRAINT calls_detected_language_code_check
  CHECK (detected_language_code IS NULL OR detected_language_code IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja'));

-- =============================================================
-- Phone matching helper + indexes
-- =============================================================
CREATE OR REPLACE FUNCTION public.phone_match_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 7
      THEN right(regexp_replace(p, '\D', '', 'g'), 10)
  END
$$;

CREATE INDEX IF NOT EXISTS idx_customers_user_phone_key
  ON customers (user_id, public.phone_match_key(phone))
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calls_user_phone_key_language
  ON calls (user_id, public.phone_match_key(caller_phone), call_datetime DESC)
  WHERE detected_language_code IS NOT NULL;

-- =============================================================
-- Guard trigger: keeps source / timestamp consistent and inherits from calls
-- =============================================================
CREATE OR REPLACE FUNCTION public.customers_language_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_src text := nullif(current_setting('app.language_source', true), '');
  v_lang text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.preferred_language IS NULL THEN
      NEW.preferred_language_source := NULL;
      IF public.phone_match_key(NEW.phone) IS NOT NULL THEN
        SELECT c.detected_language_code INTO v_lang
        FROM calls c
        WHERE c.user_id = NEW.user_id
          AND c.deleted_at IS NULL
          AND c.detected_language_code IS NOT NULL
          AND public.phone_match_key(c.caller_phone) = public.phone_match_key(NEW.phone)
        ORDER BY c.call_datetime DESC
        LIMIT 1;
        IF v_lang IS NOT NULL THEN
          NEW.preferred_language := v_lang;
          NEW.preferred_language_source := 'auto_detected';
          NEW.preferred_language_updated_at := now();
        END IF;
      END IF;
    ELSIF NEW.preferred_language_source IS NULL THEN
      NEW.preferred_language_source := coalesce(v_src, 'staff');
      NEW.preferred_language_updated_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.preferred_language IS NULL THEN
    IF OLD.preferred_language IS NOT NULL THEN
      NEW.preferred_language_updated_at := now();
    END IF;
    NEW.preferred_language_source := NULL;
  ELSIF NEW.preferred_language IS DISTINCT FROM OLD.preferred_language THEN
    NEW.preferred_language_source := coalesce(v_src, CASE WHEN NEW.preferred_language_source IN ('staff', 'customer') THEN NEW.preferred_language_source END, 'staff');
    NEW.preferred_language_updated_at := now();
  ELSIF NEW.preferred_language_source IS DISTINCT FROM OLD.preferred_language_source THEN
    -- Same language, source changed (e.g. staff "locks in" a detected language).
    -- A client may promote to staff/customer but never downgrade to auto_detected.
    IF NEW.preferred_language_source IS NULL
       OR (NEW.preferred_language_source = 'auto_detected' AND v_src IS DISTINCT FROM 'auto_detected') THEN
      NEW.preferred_language_source := OLD.preferred_language_source;
    ELSE
      NEW.preferred_language_updated_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_language_guard ON customers;
CREATE TRIGGER trg_customers_language_guard
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION public.customers_language_guard();

-- =============================================================
-- find_customer_language — service role only
-- =============================================================
CREATE OR REPLACE FUNCTION public.find_customer_language(
  p_user_id uuid,
  p_customer_id uuid DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS TABLE (language text, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := public.phone_match_key(p_phone);
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
BEGIN
  IF p_customer_id IS NOT NULL THEN
    RETURN QUERY
      SELECT c.preferred_language, c.preferred_language_source
      FROM customers c
      WHERE c.id = p_customer_id AND c.user_id = p_user_id AND c.deleted_at IS NULL
        AND c.preferred_language IS NOT NULL;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_key IS NOT NULL THEN
    RETURN QUERY
      SELECT c.preferred_language, c.preferred_language_source
      FROM customers c
      WHERE c.user_id = p_user_id AND c.deleted_at IS NULL
        AND c.preferred_language IS NOT NULL
        AND public.phone_match_key(c.phone) = v_key
      ORDER BY c.updated_at DESC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_email IS NOT NULL THEN
    RETURN QUERY
      SELECT c.preferred_language, c.preferred_language_source
      FROM customers c
      WHERE c.user_id = p_user_id AND c.deleted_at IS NULL
        AND c.preferred_language IS NOT NULL
        AND lower(c.email) = v_email
      ORDER BY c.updated_at DESC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Not on a customer yet: fall back to what was heard on their latest call.
  IF v_key IS NOT NULL THEN
    RETURN QUERY
      SELECT k.detected_language_code, 'auto_detected'::text
      FROM calls k
      WHERE k.user_id = p_user_id AND k.deleted_at IS NULL
        AND k.detected_language_code IS NOT NULL
        AND public.phone_match_key(k.caller_phone) = v_key
      ORDER BY k.call_datetime DESC
      LIMIT 1;
  END IF;
END;
$$;

-- =============================================================
-- record_detected_customer_language — service role only, "fill only if empty"
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_detected_customer_language(
  p_user_id uuid,
  p_phone text,
  p_email text,
  p_language text,
  p_confidence numeric DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := public.phone_match_key(p_phone);
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_count integer := 0;
BEGIN
  IF p_language IS NULL OR p_language NOT IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja') THEN
    RETURN 0;
  END IF;
  IF v_key IS NULL AND v_email IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.language_source', 'auto_detected', true);

  UPDATE customers c
  SET preferred_language = p_language,
      preferred_language_source = 'auto_detected',
      preferred_language_updated_at = now()
  WHERE c.user_id = p_user_id
    AND c.deleted_at IS NULL
    AND c.preferred_language IS NULL
    AND (
      (v_key IS NOT NULL AND public.phone_match_key(c.phone) = v_key)
      OR (v_email IS NOT NULL AND lower(c.email) = v_email)
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM set_config('app.language_source', '', true);
  RETURN v_count;
END;
$$;

-- =============================================================
-- Customer portal: read / change own language by portal token
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_portal_language(p_token uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.preferred_language
  FROM customers c
  WHERE c.portal_token = p_token AND c.deleted_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.set_portal_language(p_token uuid, p_language text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_language IS NULL OR p_language NOT IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja') THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.language_source', 'customer', true);
  UPDATE customers
  SET preferred_language = p_language,
      preferred_language_source = 'customer',
      preferred_language_updated_at = now()
  WHERE portal_token = p_token AND deleted_at IS NULL
    AND (preferred_language IS DISTINCT FROM p_language OR preferred_language_source IS DISTINCT FROM 'customer');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.language_source', '', true);

  -- true also when nothing needed changing, as long as the token is valid
  RETURN v_rows > 0 OR EXISTS (SELECT 1 FROM customers WHERE portal_token = p_token AND deleted_at IS NULL);
END;
$$;

-- =============================================================
-- Public invoice page: language of the invoiced customer
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_invoice_language(p_token uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv invoices%ROWTYPE;
  v_lang text;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE invoice_token = p_token AND deleted_at IS NULL AND status <> 'draft';
  IF v_inv.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT l.language INTO v_lang
  FROM public.find_customer_language(v_inv.user_id, v_inv.customer_id, v_inv.customer_phone, v_inv.customer_email) l
  LIMIT 1;
  RETURN v_lang;
END;
$$;

-- =============================================================
-- Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.find_customer_language(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_detected_customer_language(uuid, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_customer_language(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_detected_customer_language(uuid, text, text, text, numeric) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_portal_language(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_portal_language(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_language(uuid) TO anon, authenticated;
