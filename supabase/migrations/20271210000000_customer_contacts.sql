/*
  # Multi-contact per customer, with roles
  (additive only — nothing existing is changed)
*/

CREATE OR REPLACE FUNCTION public.cc_normalize_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR regexp_replace(p, '\D', '', 'g') = '' THEN NULL
    WHEN left(btrim(p), 1) = '+' THEN '+' || regexp_replace(p, '\D', '', 'g')
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 10 THEN '+1' || regexp_replace(p, '\D', '', 'g')
    ELSE '+' || regexp_replace(p, '\D', '', 'g')
  END;
$$;

CREATE OR REPLACE FUNCTION public.cc_mask_email(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR position('@' IN p) < 2 THEN NULL
    ELSE left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2)
  END;
$$;

CREATE OR REPLACE FUNCTION public.cc_mask_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR length(regexp_replace(p, '\D', '', 'g')) < 4 THEN NULL
    ELSE '•••• ' || right(regexp_replace(p, '\D', '', 'g'), 4)
  END;
$$;

CREATE TABLE IF NOT EXISTS customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  full_name text NOT NULL
    CHECK (char_length(full_name) BETWEEN 1 AND 120),
  job_title text
    CHECK (job_title IS NULL OR char_length(job_title) <= 120),
  email text
    CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone text
    CHECK (phone IS NULL OR char_length(phone) <= 40),
  phone_e164 text
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[0-9]{7,15}$'),

  roles text[] NOT NULL DEFAULT '{}'
    CHECK (roles <@ ARRAY['billing', 'site', 'emergency', 'tenant']::text[]),
  is_primary boolean NOT NULL DEFAULT false,
  site_label text
    CHECK (site_label IS NULL OR char_length(site_label) <= 120),
  preferred_channel text NOT NULL DEFAULT 'any'
    CHECK (preferred_channel IN ('any', 'email', 'sms', 'phone')),
  language text
    CHECK (language IS NULL OR language IN ('en', 'es', 'fr', 'de', 'ar', 'fa')),
  portal_access boolean NOT NULL DEFAULT false,
  notes text
    CHECK (notes IS NULL OR char_length(notes) <= 1000),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer_contacts_reachable CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_user ON customer_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_phone ON customer_contacts(user_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_contacts_email ON customer_contacts(user_id, email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_contacts_email
  ON customer_contacts(customer_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_contacts_phone
  ON customer_contacts(customer_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_contacts_one_primary
  ON customer_contacts(customer_id) WHERE is_primary;

CREATE OR REPLACE FUNCTION public.customer_contacts_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT c.user_id INTO v_owner FROM customers c WHERE c.id = NEW.customer_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'A contact cannot be moved to another customer' USING ERRCODE = '23514';
  END IF;

  NEW.user_id := v_owner;

  NEW.full_name := btrim(NEW.full_name);
  NEW.email := lower(nullif(btrim(coalesce(NEW.email, '')), ''));
  NEW.phone := nullif(btrim(coalesce(NEW.phone, '')), '');
  NEW.phone_e164 := public.cc_normalize_phone(NEW.phone);
  NEW.job_title := nullif(btrim(coalesce(NEW.job_title, '')), '');
  NEW.site_label := nullif(btrim(coalesce(NEW.site_label, '')), '');
  NEW.notes := nullif(btrim(coalesce(NEW.notes, '')), '');
  NEW.roles := ARRAY(SELECT DISTINCT r FROM unnest(NEW.roles) AS r ORDER BY r);

  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM customer_contacts x WHERE x.customer_id = NEW.customer_id) THEN
    NEW.is_primary := true;
  END IF;

  IF NEW.is_primary THEN
    UPDATE customer_contacts x
       SET is_primary = false
     WHERE x.customer_id = NEW.customer_id
       AND x.id <> NEW.id
       AND x.is_primary;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_contacts_before_write ON customer_contacts;
CREATE TRIGGER trg_customer_contacts_before_write
  BEFORE INSERT OR UPDATE ON customer_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.customer_contacts_before_write();

CREATE OR REPLACE FUNCTION public.customer_contacts_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_primary AND EXISTS (SELECT 1 FROM customers c WHERE c.id = OLD.customer_id) THEN
    UPDATE customer_contacts x
       SET is_primary = true
     WHERE x.id = (
       SELECT y.id FROM customer_contacts y
        WHERE y.customer_id = OLD.customer_id
        ORDER BY y.created_at ASC, y.id ASC
        LIMIT 1
     );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_contacts_after_delete ON customer_contacts;
CREATE TRIGGER trg_customer_contacts_after_delete
  AFTER DELETE ON customer_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.customer_contacts_after_delete();

DROP TRIGGER IF EXISTS trg_customer_contacts_updated_at ON customer_contacts;
CREATE TRIGGER trg_customer_contacts_updated_at
  BEFORE UPDATE ON customer_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_customer_contacts" ON customer_contacts;
CREATE POLICY "select_own_customer_contacts"
ON customer_contacts FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_customer_contacts" ON customer_contacts;
CREATE POLICY "insert_own_customer_contacts"
ON customer_contacts FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_customer_contacts" ON customer_contacts;
CREATE POLICY "update_own_customer_contacts"
ON customer_contacts FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_customer_contacts" ON customer_contacts;
CREATE POLICY "delete_own_customer_contacts"
ON customer_contacts FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

REVOKE ALL ON customer_contacts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_contacts TO authenticated;

CREATE OR REPLACE FUNCTION public.customer_contact_recipients(p_user_id uuid, p_customer_id uuid, p_purpose text)
RETURNS TABLE (
  contact_id uuid,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_language text,
  contact_roles text[],
  is_fallback boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('invoice', 'service', 'emergency', 'portal', 'general') THEN
    RAISE EXCEPTION 'Invalid purpose: %', p_purpose USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT cc.id, cc.full_name, cc.email, cc.phone, cc.language, cc.roles, false
    FROM customer_contacts cc
   WHERE cc.user_id = p_user_id
     AND cc.customer_id = p_customer_id
     AND CASE p_purpose
           WHEN 'invoice'   THEN 'billing' = ANY (cc.roles) AND cc.email IS NOT NULL
           WHEN 'service'   THEN cc.roles && ARRAY['site', 'tenant']::text[] AND (cc.email IS NOT NULL OR cc.phone IS NOT NULL)
           WHEN 'emergency' THEN 'emergency' = ANY (cc.roles) AND (cc.email IS NOT NULL OR cc.phone IS NOT NULL)
           WHEN 'portal'    THEN cc.portal_access AND cc.email IS NOT NULL
           ELSE cc.is_primary AND (cc.email IS NOT NULL OR cc.phone IS NOT NULL)
         END
   ORDER BY cc.is_primary DESC, cc.created_at ASC, cc.id ASC;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT cc.id, cc.full_name, cc.email, cc.phone, cc.language, cc.roles, true
    FROM customer_contacts cc
   WHERE cc.user_id = p_user_id
     AND cc.customer_id = p_customer_id
     AND cc.is_primary
     AND CASE WHEN p_purpose IN ('invoice', 'portal') THEN cc.email IS NOT NULL
              ELSE cc.email IS NOT NULL OR cc.phone IS NOT NULL END;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT NULL::uuid, c.name, c.email, c.phone, NULL::text, ARRAY[]::text[], true
    FROM customers c
   WHERE c.id = p_customer_id
     AND c.user_id = p_user_id
     AND CASE WHEN p_purpose IN ('invoice', 'portal') THEN c.email IS NOT NULL
              ELSE c.email IS NOT NULL OR c.phone IS NOT NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_contact_recipients(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_contact_recipients(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_portal_customer_contacts(p_token uuid)
RETURNS TABLE (
  contact_id uuid,
  display_name text,
  contact_title text,
  contact_roles text[],
  masked_email text,
  masked_phone text,
  primary_contact boolean,
  portal_recipient boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cc.id,
         cc.full_name,
         cc.job_title,
         cc.roles,
         public.cc_mask_email(cc.email),
         public.cc_mask_phone(cc.phone),
         cc.is_primary,
         cc.portal_access
    FROM customers c
    JOIN customer_contacts cc ON cc.customer_id = c.id AND cc.user_id = c.user_id
   WHERE c.portal_token = p_token
   ORDER BY cc.is_primary DESC, cc.created_at ASC, cc.id ASC;
$$;

REVOKE ALL ON FUNCTION public.get_portal_customer_contacts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portal_customer_contacts(uuid) TO anon, authenticated;

INSERT INTO customer_contacts (user_id, customer_id, full_name, email, phone, roles, is_primary)
SELECT c.user_id,
       c.id,
       COALESCE(NULLIF(left(btrim(c.name), 120), ''), 'Primary contact'),
       CASE WHEN c.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(c.email) <= 254 THEN c.email END,
       CASE WHEN char_length(c.phone) <= 40
             AND public.cc_normalize_phone(c.phone) ~ '^\+[0-9]{7,15}$' THEN c.phone END,
       ARRAY['billing']::text[],
       true
  FROM customers c
 WHERE EXISTS (SELECT 1 FROM profiles p WHERE p.id = c.user_id)
   AND NOT EXISTS (SELECT 1 FROM customer_contacts x WHERE x.customer_id = c.id)
   AND (
     (c.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(c.email) <= 254)
     OR (char_length(c.phone) <= 40 AND public.cc_normalize_phone(c.phone) ~ '^\+[0-9]{7,15}$')
   )
ON CONFLICT DO NOTHING;
