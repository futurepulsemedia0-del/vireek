/*
  # Public warranty registration

  A homeowner registers a purchased unit at /warranty/register (no login).

  ## What this adds
  - `warranty_registrations`: the owner's registration. Linked to an
    `equipment_passports` row when the owner enters the passport code from the
    QR label ('code') or when make + serial matches an active passport ('serial').
  - `warranty_claims.registration_id`: a claim opened for the same unit is
    linked to its registration automatically (BEFORE INSERT trigger), and open
    claims are back-linked when a registration arrives later.
  - `warranty_register_rate_limit` + `wr_rate_limit_hit()`: ATOMIC per-IP limit
    (a single upsert, so parallel requests cannot slip past the cap).
  - `register_warranty(jsonb)`: the only write path. Validates, links, dedupes,
    and appends ONE sanitised passport event (no name, email, phone or address).

  ## Security
  - No anon access to any table. The public page calls the `warranty-register`
    edge function, which uses the service role to call the RPCs below.
  - The RPCs are executable by service_role ONLY.
  - Owner PII (name/email/phone/address) is readable only by authenticated
    accounts with a VERIFIED, active link to the passport (they own or serviced
    the unit); nobody can write through RLS.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 1) Registrations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.warranty_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_code text NOT NULL UNIQUE,
  passport_id uuid REFERENCES public.equipment_passports(id) ON DELETE SET NULL,
  link_method text NOT NULL DEFAULT 'none' CHECK (link_method IN ('code', 'serial', 'none')),

  owner_name text NOT NULL CHECK (char_length(btrim(owner_name)) BETWEEN 2 AND 120),
  owner_email text NOT NULL CHECK (char_length(owner_email) <= 254 AND owner_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  owner_phone text CHECK (owner_phone IS NULL OR char_length(owner_phone) BETWEEN 7 AND 30),
  service_address text CHECK (service_address IS NULL OR char_length(service_address) <= 300),

  equipment_type text NOT NULL CHECK (char_length(btrim(equipment_type)) BETWEEN 1 AND 80),
  make text NOT NULL CHECK (char_length(btrim(make)) BETWEEN 1 AND 80),
  model text CHECK (model IS NULL OR char_length(model) <= 80),
  serial_number text NOT NULL CHECK (char_length(btrim(serial_number)) BETWEEN 4 AND 60),
  serial_key text,

  purchase_date date NOT NULL,
  install_date date,
  purchased_from text CHECK (purchased_from IS NULL OR char_length(purchased_from) <= 120),
  installer_name text CHECK (installer_name IS NULL OR char_length(installer_name) <= 120),

  terms_accepted boolean NOT NULL CHECK (terms_accepted),
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wr_install_after_purchase CHECK (install_date IS NULL OR install_date >= purchase_date)
);

-- One registration per unit per owner email (re-submits are idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wr_serial_email
  ON public.warranty_registrations (serial_key, (lower(owner_email))) WHERE serial_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wr_serial_key ON public.warranty_registrations (serial_key) WHERE serial_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wr_passport ON public.warranty_registrations (passport_id) WHERE passport_id IS NOT NULL;

ALTER TABLE public.warranty_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warranty_registrations FROM anon, authenticated;
GRANT SELECT ON public.warranty_registrations TO authenticated;

CREATE OR REPLACE FUNCTION public.wr_can_view(p_passport uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_passport IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.equipment_passport_links l
    WHERE l.passport_id = p_passport
      AND l.status = 'active'
      AND l.verified
      AND l.user_id = public.get_account_owner_id()
  );
$$;
REVOKE ALL ON FUNCTION public.wr_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wr_can_view(uuid) TO authenticated;

DROP POLICY IF EXISTS "wr_select_linked_accounts" ON public.warranty_registrations;
CREATE POLICY "wr_select_linked_accounts" ON public.warranty_registrations FOR SELECT TO authenticated
  USING (public.wr_can_view(passport_id));

-- 2) Claims link back to the registration --------------------------------------
ALTER TABLE public.warranty_claims
  ADD COLUMN IF NOT EXISTS registration_id uuid REFERENCES public.warranty_registrations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_warranty_claims_registration ON public.warranty_claims (registration_id) WHERE registration_id IS NOT NULL;

-- New claim for a unit that is already registered -> link it. Never blocks the insert.
CREATE OR REPLACE FUNCTION public.wr_link_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_reg uuid;
BEGIN
  IF NEW.registration_id IS NOT NULL THEN RETURN NEW; END IF;
  v_key := public.vp_serial_key(NEW.manufacturer, NEW.serial_number);
  IF v_key IS NULL THEN RETURN NEW; END IF;

  SELECT r.id INTO v_reg
  FROM public.warranty_registrations r
  JOIN public.equipment_passport_links l
    ON l.passport_id = r.passport_id AND l.status = 'active' AND l.verified AND l.user_id = NEW.user_id
  WHERE r.serial_key = v_key
  ORDER BY r.created_at DESC
  LIMIT 1;

  NEW.registration_id := v_reg;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'warranty claim registration link skipped: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wr_link_claim ON public.warranty_claims;
CREATE TRIGGER trg_wr_link_claim BEFORE INSERT ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.wr_link_claim();

-- 3) Atomic per-IP rate limit ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.warranty_register_rate_limit (
  ip_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wr_rate_window ON public.warranty_register_rate_limit (window_start);
ALTER TABLE public.warranty_register_rate_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warranty_register_rate_limit FROM anon, authenticated;
-- Intentionally no policies: service-role only.

-- Returns true when the caller is still within the limit. One statement = no race.
CREATE OR REPLACE FUNCTION public.wr_rate_limit_hit(p_ip_hash text, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_window interval := make_interval(secs => p_window_seconds);
BEGIN
  INSERT INTO public.warranty_register_rate_limit AS r (ip_hash, window_start, request_count)
  VALUES (p_ip_hash, now(), 1)
  ON CONFLICT (ip_hash) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - v_window THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - v_window THEN 1 ELSE r.request_count + 1 END
  RETURNING request_count INTO v_count;

  IF random() < 0.02 THEN
    DELETE FROM public.warranty_register_rate_limit WHERE window_start < now() - interval '2 days';
  END IF;

  RETURN v_count <= p_max;
END;
$$;

-- 4) The one write path ----------------------------------------------------------------
-- Returns {ok:true,...} or {ok:false,error:'<code>'}; never raises for bad input.
CREATE OR REPLACE FUNCTION public.register_warranty(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(coalesce(p->>'owner_name', ''));
  v_email text := lower(btrim(coalesce(p->>'owner_email', '')));
  v_phone text := nullif(btrim(coalesce(p->>'owner_phone', '')), '');
  v_address text := nullif(btrim(coalesce(p->>'service_address', '')), '');
  v_type text := btrim(coalesce(p->>'equipment_type', ''));
  v_make text := btrim(coalesce(p->>'make', ''));
  v_model text := nullif(btrim(coalesce(p->>'model', '')), '');
  v_serial text := btrim(coalesce(p->>'serial_number', ''));
  v_installer text := nullif(btrim(coalesce(p->>'installer_name', '')), '');
  v_from text := nullif(btrim(coalesce(p->>'purchased_from', '')), '');
  v_code_in text := nullif(btrim(coalesce(p->>'passport_code', '')), '');
  v_purchase date;
  v_install date;
  v_key text;
  v_passport uuid;
  v_passport_code text;
  v_method text := 'none';
  v_id uuid;
  v_conf text;
  v_tries int := 0;
  v_linked_claims int := 0;
BEGIN
  BEGIN
    v_purchase := (p->>'purchase_date')::date;
    v_install := nullif(p->>'install_date', '')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_date');
  END;

  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_name'); END IF;
  IF char_length(v_email) > 254 OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_email'); END IF;
  IF char_length(v_type) NOT BETWEEN 1 AND 80 OR char_length(v_make) NOT BETWEEN 1 AND 80 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_equipment'); END IF;
  IF char_length(v_serial) NOT BETWEEN 4 AND 60 THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_serial'); END IF;
  -- +1 day tolerates a visitor whose local date is ahead of UTC.
  IF v_purchase IS NULL OR v_purchase > current_date + 1 OR v_purchase < current_date - interval '25 years' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_purchase_date');
  END IF;
  IF v_install IS NOT NULL AND (v_install < v_purchase OR v_install > current_date + 1) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_install_date');
  END IF;
  IF coalesce((p->>'terms_accepted')::boolean, false) IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'error', 'terms_required'); END IF;

  v_key := public.vp_serial_key(v_make, v_serial);

  IF v_code_in IS NOT NULL THEN
    SELECT id, public_code INTO v_passport, v_passport_code
    FROM public.equipment_passports
    WHERE public_code = public.vp_normalize_code(v_code_in) AND status = 'active';
    IF v_passport IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'passport_not_found'); END IF;
    v_method := 'code';
  ELSIF v_key IS NOT NULL THEN
    SELECT id, public_code INTO v_passport, v_passport_code
    FROM public.equipment_passports
    WHERE serial_key = v_key AND status = 'active';
    IF v_passport IS NOT NULL THEN v_method := 'serial'; END IF;
  END IF;

  LOOP
    v_conf := 'WR-' || left(public.vp_generate_code(), 8);
    BEGIN
      INSERT INTO public.warranty_registrations
        (confirmation_code, passport_id, link_method, owner_name, owner_email, owner_phone, service_address,
         equipment_type, make, model, serial_number, serial_key, purchase_date, install_date,
         purchased_from, installer_name, terms_accepted)
      VALUES
        (v_conf, v_passport, v_method, v_name, v_email, v_phone, v_address,
         v_type, v_make, v_model, v_serial, v_key, v_purchase, v_install,
         v_from, v_installer, true)
      ON CONFLICT (serial_key, (lower(owner_email))) WHERE serial_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;           -- confirmation_code collision (astronomically rare)
      IF v_tries >= 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'try_again'); END IF;
    END;
  END LOOP;

  -- Same unit + same email already registered: idempotent, no new email.
  IF v_id IS NULL THEN
    SELECT r.id, r.confirmation_code INTO v_id, v_conf
    FROM public.warranty_registrations r
    WHERE r.serial_key = v_key AND lower(r.owner_email) = v_email;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', v_id, 'confirmation_code', v_conf,
                              'passport_code', v_passport_code, 'link_method', v_method, 'linked_claims', 0);
  END IF;

  IF v_passport IS NOT NULL THEN
    -- Owner registered via the QR code: one sanitised, idempotent history entry per passport.
    IF v_method = 'code' THEN
      BEGIN
        PERFORM public.vp_append_event(
          v_passport, 'warranty_event', 'Owner registered the warranty', NULL,
          jsonb_build_object('warranty', jsonb_build_object('owner_registered', true, 'purchase_date', v_purchase)),
          now(), NULL, NULL, 'warranty_registered:' || v_passport::text, 'public');
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'warranty registration passport event skipped: %', SQLERRM;  -- never block the registration
      END;
    END IF;

    IF v_key IS NOT NULL THEN
      UPDATE public.warranty_claims c
      SET registration_id = v_id
      WHERE c.registration_id IS NULL
        AND public.vp_serial_key(c.manufacturer, c.serial_number) = v_key
        AND c.user_id IN (
          SELECT l.user_id FROM public.equipment_passport_links l
          WHERE l.passport_id = v_passport AND l.status = 'active' AND l.verified);
      GET DIAGNOSTICS v_linked_claims = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'confirmation_code', v_conf,
                            'passport_code', v_passport_code, 'link_method', v_method, 'linked_claims', v_linked_claims);
END;
$$;

REVOKE ALL ON FUNCTION public.wr_rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_warranty(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wr_rate_limit_hit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_warranty(jsonb) TO service_role;
